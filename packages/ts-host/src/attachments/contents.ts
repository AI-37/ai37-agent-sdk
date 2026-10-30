import { attachmentFailureReason, type AttachmentReaders } from './readers'

/**
 * Тексты всех файлов хода в общий бюджет символов: для агентов, которые отдают документ модели
 * целиком (извлечь исходные данные расчёта, проверить документ пользователя). Ошибка одного файла
 * не роняет остальные, но возвращается вызывающему с причиной: в логе нужен адрес и статус, а не
 * слово «не прочитан».
 */

export interface AttachmentContent {
  ref: string
  name: string
  content: string
  /** Текст обрезан по бюджету: ответ по нему неполный, и об этом надо сказать. */
  truncated: boolean
}

export interface AttachmentReadFailure {
  ref: string
  scope: 'chat' | 'project'
  reason: 'access_denied' | 'unavailable' | 'reader_failed'
  /** Текст ошибки бэкенда: в нём fileId и HTTP-статус. Имени файла здесь нет, у клиента это ПДн. */
  detail: string
}

export interface AttachmentContentsResult {
  contents: AttachmentContent[]
  failures: AttachmentReadFailure[]
}

export interface ReadAttachmentContentsOptions {
  /** Сколько символов всего может уйти в модель за ход. По умолчанию без потолка. */
  budgetChars?: number
}

/** Пустые файлы (скан без текстового слоя) в результат не попадают: в них нечего читать. */
export async function readAttachmentContents(
  readers: AttachmentReaders,
  opts: ReadAttachmentContentsOptions = {},
): Promise<AttachmentContentsResult> {
  const contents: AttachmentContent[] = []
  const failures: AttachmentReadFailure[] = []
  let budget = opts.budgetChars ?? Number.POSITIVE_INFINITY

  for (const file of readers.scope.files) {
    if (budget <= 0) break
    const read = await readers.readWithinBudget(file.ref, budget)
    if (read.error) {
      failures.push({
        ref: file.ref,
        scope: file.scope,
        reason: attachmentFailureReason(read.error),
        detail: read.error,
      })
      continue
    }
    const content = read.content.trim()
    if (!content) continue
    contents.push({ ref: file.ref, name: file.name, content, truncated: read.truncated })
    budget -= content.length
  }
  return { contents, failures }
}
