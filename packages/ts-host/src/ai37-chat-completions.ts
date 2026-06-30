import { ChatOpenAICompletions } from '@langchain/openai'

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
 * Зачем глушим: базовый `getNumTokens` (из `@langchain/core`) тянет BPE-таблицы с
 * `https://tiktoken.pages.dev` (`js-tiktoken/lite` их не бандлит) → виснет на IPv6-egress из
 * кластера (~100с, ETIMEDOUT) перед каждым стриминговым ходом → запрос не доходит, UI отдаёт
 * "network error". Для не-OpenAI модели (deepseek) счёт всё равно идёт по чужому словарю
 * (фоллбэк gpt-2). Реальный usage берём из ответа litellm (`usage_metadata`); считать локально
 * не нужно — возвращаем 0.
 */
export class Ai37ChatCompletions extends ChatOpenAICompletions {
  override getNumTokens(): Promise<number> {
    return Promise.resolve(0)
  }
}
