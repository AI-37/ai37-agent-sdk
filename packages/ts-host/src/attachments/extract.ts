import { Ai37ChatCompletions } from '../ai37-chat-completions'
import { currentLangfuseCallbacks } from '../als'
import type { AttachmentContent } from './contents'

/**
 * Извлечение данных из файлов хода одним LLM-вызовом. Доменную часть (что извлекать, в каком виде)
 * задаёт агент системным промптом, здесь только сборка запроса и разбор ответа.
 *
 * Почему не deepagent с виртуальной ФС: в elevator он проходил около 25 итераций на ход и не
 * укладывался в 60 секунд ingress. Тексты уже лежат в chat-backend готовым markdown, так что их
 * проще прочитать кодом (`readAttachmentContents`) и отдать модели за один раз.
 */

export interface ExtractFromAttachmentsOptions {
  /** Ключ LiteLLM хода (`ctx.llmKey`). */
  llmKey: string
  /** Эндпоинт LiteLLM. */
  baseUrl: string
  model: string
  /** Доп. поля тела запроса LiteLLM, например прижатие reasoning. */
  modelKwargs?: Record<string, unknown>
  /**
   * Доменная инструкция. Должна велеть ответить ровно «нет данных», если в файлах нужного нет:
   * такой ответ превращается в null.
   */
  systemPrompt: string
  /** Запрос пользователя этого хода. */
  query: string
  contents: readonly AttachmentContent[]
  /** Потолок на сам вызов. По умолчанию 300 с. */
  timeoutMs?: number
  /**
   * Потолок ответа в токенах. Через `modelKwargs.max_tokens` его не задать: LangChain перезаписывает
   * поле своим `maxTokens`.
   */
  maxTokens?: number
}

const NO_DATA = /^нет данных\.?$/i

/**
 * Возвращает текст ответа модели или null, если файлов нет, ответ пуст или модель ответила
 * «нет данных». Ошибки вызова не глотает: продолжать ли ход без файлов, решает агент.
 */
export async function extractFromAttachments(
  opts: ExtractFromAttachmentsOptions,
): Promise<string | null> {
  if (opts.contents.length === 0) return null
  const model = new Ai37ChatCompletions({
    model: opts.model,
    apiKey: opts.llmKey,
    temperature: 0,
    configuration: { baseURL: opts.baseUrl },
    ...(opts.modelKwargs ? { modelKwargs: opts.modelKwargs } : {}),
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
  })
  const response = await model.invoke(
    [
      { role: 'system', content: opts.systemPrompt },
      { role: 'user', content: extractionRequest(opts.query, opts.contents) },
    ],
    {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
      // Langfuse-обработчик хода из request-scope хоста; без LANGFUSE_* это no-op.
      callbacks: currentLangfuseCallbacks() as never,
    },
  )
  const text = messageText(response).trim()
  return !text || NO_DATA.test(text) ? null : text
}

/** Запрос пользователя и тексты файлов блоками с именами. */
export function extractionRequest(query: string, contents: readonly AttachmentContent[]): string {
  const blocks = contents
    .map((file) => {
      const cut = file.truncated ? ' обрезан="да"' : ''
      return `<файл имя="${file.name}"${cut}>\n${file.content}\n</файл>`
    })
    .join('\n\n')
  return `Запрос пользователя: "${query}".\n\nСодержимое приложенных файлов:\n\n${blocks}`
}

/**
 * Текст ответа модели. Пустой content — смотрим `reasoning_content`: адаптер deepseek в LiteLLM при
 * выключенном thinking кладёт туда весь ответ (поймано на живом ходе thermal).
 */
export function messageText(message: unknown): string {
  const content = (message as { content?: unknown })?.content
  if (typeof content === 'string' && content.length > 0) return content
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof part === 'string' ? part : ((part as { text?: string })?.text ?? '')))
      .join('')
    if (joined.length > 0) return joined
  }
  const reasoning = (message as { additional_kwargs?: { reasoning_content?: unknown } })
    ?.additional_kwargs?.reasoning_content
  return typeof reasoning === 'string' ? reasoning : ''
}
