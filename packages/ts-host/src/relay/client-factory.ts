import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
} from '@a2a-js/sdk/client'

/**
 * Фабрика A2A-клиентов AI37 на `@a2a-js/sdk` 1.x с включённым compat 0.3 на резолвере карточки и на
 * транспортах. Клиент сам выбирает версию по карточке агента: интерфейс `1.0` — если он объявлен
 * (агенты на ts-host ≥ 0.2, python-host), иначе legacy-транспорт 0.3 (агенты на старом хосте,
 * внешние агенты пользователей). Поэтому compat на клиенте держим всегда.
 *
 * `fetchImpl` — свой fetch с исходящей авторизацией (форвард user-JWT, `outboundAuth` внешнего
 * агента). Он уходит и в резолвер карточки, и в транспорты. Заголовок `A2A-Version` такой fetch
 * перезаписывать не должен: по нему сервер 1.x выбирает обработчик.
 *
 * JSON-RPC предпочтительнее HTTP+JSON, если агент объявил обе привязки.
 */
export function createAi37ClientFactory(fetchImpl?: typeof fetch): ClientFactory {
  const legacyCompat = { enabled: true }
  const withFetch = fetchImpl ? { fetchImpl } : {}
  return new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      cardResolver: new DefaultAgentCardResolver({ ...withFetch, legacyCompat }),
      transports: [
        new JsonRpcTransportFactory({ ...withFetch, legacyCompat }),
        new RestTransportFactory({ ...withFetch, legacyCompat }),
      ],
      preferredTransports: ['JSONRPC', 'HTTP+JSON'],
    }),
  )
}
