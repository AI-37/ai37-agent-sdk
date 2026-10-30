import {
  ArtifactsStoreBackend,
  type ArtifactMetaDto,
} from '../store-backend/artifacts-store-backend'
import { contextFilePath } from '../store-backend/file-context'
import type { AttachmentFile } from './turn-files'

/**
 * Артефакты, которые агент может читать в ходе: свои артефакты треда и артефакты проекта. По ADR 13
 * оркестратор их в ход не кладёт; агент монтирует корпус сам, и это он и есть (план
 * project-knowledge-bridge, срез 2). Список загружается один раз, а читатели (`createAttachmentReaders`
 * с `artifacts`) отдают только артефакты из него.
 */

export interface ArtifactScopeOptions {
  /** База REST chat-backend. */
  chatBackendUrl: string
  /** Тред хода: его артефакты на полке чата. */
  contextId: string
  /** Проект хода (`project:<id>`); без него артефакты проекта не загружаются. */
  projectId?: string
  /** user-JWT для chat-backend. По умолчанию `currentBearer` из request-scope хоста. */
  bearer?: () => string | undefined
  fetchImpl?: typeof fetch
}

export interface ArtifactScope {
  contextId: string
  projectId?: string
  /** Артефакты треда, затем проекта; у каждого `kind: 'artifact'`. */
  files: AttachmentFile[]
  /**
   * Ошибки загрузки списков (`chat-backend /api/artifacts → HTTP 403`). Список, который не
   * загрузился, просто пуст: читать из него нечего, а остальные файлы хода работают.
   */
  errors: string[]
}

export async function artifactScope(opts: ArtifactScopeOptions): Promise<ArtifactScope> {
  const common = { baseUrl: opts.chatBackendUrl, bearer: opts.bearer, fetchImpl: opts.fetchImpl }
  const corpora: Array<{ shelf: AttachmentFile['scope']; scope: ArtifactCorpus }> = [
    { shelf: 'chat', scope: { contextId: opts.contextId } },
  ]
  if (opts.projectId) corpora.push({ shelf: 'project', scope: { projectId: opts.projectId } })

  const lists = await Promise.all(
    corpora.map(({ scope }) => new ArtifactsStoreBackend({ ...common, scope: () => scope }).list()),
  )
  const files: AttachmentFile[] = []
  const errors: string[] = []
  lists.forEach((list, index) => {
    if ('error' in list) errors.push(list.error)
    else files.push(...list.artifacts.map((meta) => artifactFile(meta, corpora[index].shelf)))
  })
  return {
    contextId: opts.contextId,
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    files,
    errors,
  }
}

type ArtifactCorpus = { contextId: string } | { projectId: string }

const REF_PREFIX: Record<AttachmentFile['scope'], string> = {
  chat: 'artifact:',
  project: 'project-artifact:',
}

function artifactFile(meta: ArtifactMetaDto, shelf: AttachmentFile['scope']): AttachmentFile {
  const ref = `${REF_PREFIX[shelf]}${meta.id}`
  const file: AttachmentFile = {
    ref,
    path: contextFilePath(ref) ?? `/${meta.id}`,
    name: meta.name || ref,
    scope: shelf,
    kind: 'artifact',
  }
  if (meta.summary) file.summary = meta.summary
  if (meta.isLarge) file.isLarge = true
  return file
}
