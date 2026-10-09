import type { Message, SendMessageRequest, StreamResponse, Task } from '@a2a-js/sdk'
import { TaskNotFoundError, UnsupportedOperationError } from '@a2a-js/sdk/errors'
import { DefaultRequestHandler, type ServerCallContext } from '@a2a-js/sdk/server'

/**
 * `DefaultRequestHandler` с одной поправкой для клиентов A2A 0.3.
 *
 * Сообщение в завершённую задачу обработчик 1.2+ отклоняет `UnsupportedOperationError` (-32004)
 * с «terminal state» в тексте. Relay оркестратора ловит это как «задача устарела» и повторяет ход
 * новым диалогом. Но клиент `@a2a-js/sdk` 0.3 превращает -32004 в `UnsupportedOperationError` со
 * своим текстом «This operation is not supported», текст сервера теряется, и relay 0.3 (ts-host
 * 0.1.x, на нём chat-backend до перехода) роняет ход вместо повтора. Сервер 0.3 в этом случае
 * отвечал ошибкой с текстом, и повтор работал.
 *
 * Поэтому запросу 0.3 (заголовок `A2A-Version` отсутствует или `0.3`) терминальная задача отдаётся
 * как `TaskNotFoundError` (-32001): её relay 0.3 узнаёт по коду. Клиент 1.x получает ошибку как есть.
 */
export class HostRequestHandler extends DefaultRequestHandler {
  override async sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Message | Task> {
    try {
      return await super.sendMessage(params, context)
    } catch (e) {
      throw forLegacyClient(e, context)
    }
  }

  override async *sendMessageStream(
    params: SendMessageRequest,
    context: ServerCallContext,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    try {
      yield* super.sendMessageStream(params, context)
    } catch (e) {
      throw forLegacyClient(e, context)
    }
  }
}

function forLegacyClient(err: unknown, context: ServerCallContext): unknown {
  const legacy = context.requestedVersion !== '1.0'
  if (legacy && err instanceof UnsupportedOperationError && /terminal state/i.test(err.message)) {
    return new TaskNotFoundError(err.message)
  }
  return err
}
