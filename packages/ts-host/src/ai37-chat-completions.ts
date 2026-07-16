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
 * Зачем глушим getNumTokens: базовый (из `@langchain/core`) тянет BPE-таблицы с
 * `https://tiktoken.pages.dev` (`js-tiktoken/lite` их не бандлит) → виснет на IPv6-egress из
 * кластера (~100с, ETIMEDOUT) перед каждым стриминговым ходом → запрос не доходит, UI отдаёт
 * "network error". Реальный usage берём из ответа litellm (`usage_metadata`) — возвращаем 0.
 *
 * Партнёрскую инструкцию (`metadata.ai37.instructions`) сюда НЕ подмешиваем: это делается ВИДИМО в
 * когниции агента — `withPartnerInstructions(systemPrompt)` дописывает её отдельной секцией в конец
 * системного промпта ДО `invoke`, поэтому она попадает и в реальный запрос, и в Langfuse-трейс.
 */
export class Ai37ChatCompletions extends ChatOpenAICompletions {
  override getNumTokens(): Promise<number> {
    return Promise.resolve(0)
  }
}
