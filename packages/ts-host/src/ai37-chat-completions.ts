import { AsyncCaller, type FailedAttemptHandler } from '@langchain/core/utils/async_caller'
import { ChatOpenAICompletions } from '@langchain/openai'

/** Таймаут одной попытки по умолчанию: шлюз при 429 ждёт `Retry-After` до 2 × 60 с, плюс сам ответ. */
export const AI37_LLM_TIMEOUT_MS = 180_000
/** Повторов по умолчанию: один — на обрыв сети и 5xx. 429 повторяет шлюз, см. {@link ai37FailedAttemptHandler}. */
export const AI37_LLM_MAX_RETRIES = 1

type Fields = ConstructorParameters<typeof ChatOpenAICompletions>[0]

// Стандартный обработчик берём у AsyncCaller установленной версии @langchain/core, а не копируем:
// он сам решает про AbortError, 4xx и квоту, и его поведение меняется вместе с версией пакета.
const langchainDefaultHandler = (new AsyncCaller({}) as unknown as { onFailedAttempt: FailedAttemptHandler })
  .onFailedAttempt

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const e = error as { status?: unknown; response?: { status?: unknown } }
  const status = typeof e.status === 'number' ? e.status : e.response?.status
  return typeof status === 'number' ? status : undefined
}

/**
 * Обработчик неудачной попытки для LLM-голов за шлюзом LiteLLM: 429 сразу пробрасывается наверх.
 *
 * 429 до клиента доходит, только когда шлюз уже выждал `Retry-After` провайдера и сдался
 * (`model_group_retry_policy` в infra). Повтор отсюда снова встанет в ту же очередь лимита и
 * продлит окно у провайдера. Остальные ошибки решает стандартный обработчик LangChain.
 */
export const ai37FailedAttemptHandler: FailedAttemptHandler = (error) => {
  if (statusOf(error) === 429) throw error
  return langchainDefaultHandler(error)
}

/**
 * `ChatOpenAICompletions` без локального подсчёта токенов — общий для всех AI37-сервисов.
 *
 * ВАЖНО: расширяем именно `ChatOpenAICompletions`, а НЕ фасад `ChatOpenAI`. В `@langchain/openai`
 * v1 `ChatOpenAI` — это роутер: в конструкторе создаёт `new ChatOpenAICompletions(fields)` (и
 * `…Responses`) и при `invoke` ДЕЛЕГИРУЕТ генерацию внутреннему инстансу. Override `getNumTokens`
 * на сабклассе фасада НЕ виден — `_getEstimatedTokenCountFromPrompt` бежит на внутреннем
 * `ChatOpenAICompletions` с базовым методом. Расширяем сам impl-класс (для litellm / Chat
 * Completions это ровно тот путь, что фасад и так выбирает) — отсюда и имя `Ai37ChatCompletions`.
 *
 * Зачем глушим getNumTokens: базовый (из `@langchain/core`) тянет BPE-таблицы с
 * `https://tiktoken.pages.dev` (`js-tiktoken/lite` их не бандлит) → виснет на IPv6-egress из
 * кластера (~100с, ETIMEDOUT) перед каждым стриминговым ходом → запрос не доходит, UI отдаёт
 * "network error". Реальный usage берём из ответа litellm (`usage_metadata`) — возвращаем 0.
 *
 * Повторы и таймаут: без явных значений LangChain повторяет до 6 раз (и 429 тоже), а OpenAI SDK
 * ждёт ответа 600 с. Дефолты здесь — одна попытка сверху, 180 с на попытку и без повтора 429;
 * явно переданные `maxRetries` / `timeout` / `onFailedAttempt` побеждают.
 *
 * Партнёрскую инструкцию (`metadata.ai37.instructions`) сюда НЕ подмешиваем: это делается ВИДИМО в
 * когниции агента — `withPartnerInstructions(systemPrompt)` дописывает её отдельной секцией в конец
 * системного промпта ДО `invoke`, поэтому она попадает и в реальный запрос, и в Langfuse-трейс.
 */
export class Ai37ChatCompletions extends ChatOpenAICompletions {
  constructor(fields?: Fields) {
    super({
      ...fields,
      maxRetries: fields?.maxRetries ?? AI37_LLM_MAX_RETRIES,
      timeout: fields?.timeout ?? AI37_LLM_TIMEOUT_MS,
      onFailedAttempt: fields?.onFailedAttempt ?? ai37FailedAttemptHandler,
    })
  }

  override getNumTokens(): Promise<number> {
    return Promise.resolve(0)
  }
}
