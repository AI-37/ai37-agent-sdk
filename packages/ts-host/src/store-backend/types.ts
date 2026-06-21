/**
 * Типы StoreBackend — структурно совместимы с deepagents `BackendProtocolV2`
 * (ls/read/grep/glob + write/edit). ts-host НЕ зависит от deepagents: `CompositeBackend` принимает
 * бэкенд по duck-typing, поэтому достаточно совпадения формы методов. Держать в синхроне с deepagents.
 */

type MaybePromise<T> = T | Promise<T>

/** Структурное описание файла/директории в виртуальной ФС бэкенда. */
export interface FileInfo {
  path: string
  is_dir?: boolean
  size?: number
  modified_at?: string
}

/** Совпадение grep по содержимому. */
export interface GrepMatch {
  path: string
  /** Номер строки/сообщения (1-indexed). */
  line: number
  text: string
}

export interface LsResult {
  error?: string
  files?: FileInfo[]
}

export interface GlobResult {
  error?: string
  files?: FileInfo[]
}

export interface ReadResult {
  error?: string
  content?: string | Uint8Array
  mimeType?: string
}

/**
 * Результат raw-чтения (deepagents `BackendProtocolV2.readRaw`). Наши бэкенды отдают markdown-ТЕКСТ
 * через `read` (с пагинацией), а raw-бинарь не поддерживают — `readRaw` возвращает ошибку. `data`
 * структурно совместим с deepagents `FileData` (мы его не импортируем — ts-host не зависит от deepagents).
 */
export interface ReadRawResult {
  error?: string
}

export interface GrepResult {
  error?: string
  matches?: GrepMatch[]
}

export interface WriteResult {
  error?: string
  path?: string
  /** Для внешних (не-checkpoint) бэкендов — null (уже персистнуто во внешнем хранилище). */
  filesUpdate?: null
  metadata?: Record<string, unknown>
}

export interface EditResult {
  error?: string
  path?: string
  filesUpdate?: null
  occurrences?: number
  metadata?: Record<string, unknown>
}

/**
 * Read-ориентированный backend для deepagents `CompositeBackend` (BackendProtocolV2-совместимый).
 * write/edit реализуются (контракт требует), но read-only бэкенды возвращают в них ошибку.
 */
export interface StoreBackend {
  ls(path: string): MaybePromise<LsResult>
  read(filePath: string, offset?: number, limit?: number): MaybePromise<ReadResult>
  /** raw-чтение (BackendProtocolV2). Наши бэкенды отдают текст через `read` → возвращают ошибку. */
  readRaw(filePath: string): MaybePromise<ReadRawResult>
  grep(pattern: string, path?: string | null, glob?: string | null): MaybePromise<GrepResult>
  glob(pattern: string, path?: string): MaybePromise<GlobResult>
  write(filePath: string, content: string): MaybePromise<WriteResult>
  edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): MaybePromise<EditResult>
}
