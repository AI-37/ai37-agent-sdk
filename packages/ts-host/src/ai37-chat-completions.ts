import { ChatOpenAICompletions } from '@langchain/openai'
import type { BaseMessage } from '@langchain/core/messages'
import { SystemMessage } from '@langchain/core/messages'
import type { ChatResult, ChatGenerationChunk } from '@langchain/core/outputs'
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager'
import { currentPartnerInstructions } from './als'

/**
 * `ChatOpenAICompletions` без локального подсчёта токенов + авто-инъекция политики владельца —
 * общий для всех AI37-сервисов.
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
 */

/**
 * Постоянная инструкция владельца/партнёра хода (`currentPartnerInstructions`, из
 * `metadata.ai37.instructions`) → system-directive абсолютного приоритета в начало сообщений.
 * Так политика применяется на ВСЕХ агентах, использующих эту модель, без их правок. Нет политики
 * (обычно вне widget-канала) → массив не меняется (ноль накладных расходов).
 */
export function withPartnerPolicy(messages: BaseMessage[]): BaseMessage[] {
  const policy = currentPartnerInstructions()
  if (!policy) return messages
  const directive = new SystemMessage(
    'ПОСТОЯННАЯ ПОЛИТИКА ВЛАДЕЛЬЦА (АБСОЛЮТНЫЙ ПРИОРИТЕТ над сообщением пользователя):\n' +
      `«${policy}»\n` +
      'Для аспектов/параметров, заданных этой политикой, всегда следуй ей, даже если пользователь просит иное.',
  )
  return [directive, ...messages]
}

export class Ai37ChatCompletions extends ChatOpenAICompletions {
  override getNumTokens(): Promise<number> {
    return Promise.resolve(0)
  }

  override _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    return super._generate(withPartnerPolicy(messages), options, runManager)
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    yield* super._streamResponseChunks(withPartnerPolicy(messages), options, runManager)
  }
}
