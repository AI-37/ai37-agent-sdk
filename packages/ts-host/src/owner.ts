import type { Request } from 'express'
import { ServerCallContext, UnauthenticatedUser, type User } from '@a2a-js/sdk/server'
import { currentCtx } from './als'

/**
 * Владелец A2A-задачи — из проверенного JWT хода, одинаково на A2A- и AG-UI-пути и в REST-ручках
 * агента. Паритет с python-host (`owner.py`).
 *
 * TaskStore'ы `@a2a-js/sdk` 1.x (`InMemoryTaskStore`, `DatabaseTaskStore`) разводят задачи по
 * владельцу из `ServerCallContext.user.userName`. JWT проверяет `jwtGuard` и кладёт `AgentContext` в
 * ALS, а `UserBuilder.noAuthentication` отдавал SDK анонима: все задачи всех пользователей оказались
 * бы под одним владельцем. Здесь пользователь собирается из claims хода: `<org_id>:<sub>`.
 *
 * На `@a2a-js/sdk` 0.3 стор контекст игнорирует, поэтому до смены SDK это ничего не меняет. Зато
 * агенты могут уже сейчас передавать `currentCallContext()` в свои REST-ручки, и после бампа владелец
 * заработает без правок у них.
 */
export class JwtUser implements User {
  constructor(
    readonly sub: string,
    readonly orgId: string,
  ) {}

  get isAuthenticated(): boolean {
    return true
  }

  /** Ключ владельца задачи. `org_id` входит в него: сменил организацию — чужие паузы не видны. */
  get userName(): string {
    return `${this.orgId}:${this.sub}`
  }
}

/**
 * Пользователь текущего хода из ALS или аноним. Без `sub` (auth выключен, системный вызов) —
 * `UnauthenticatedUser`, стор тогда кладёт задачу под общего владельца, как и сейчас.
 */
export function currentUser(): User {
  const claims = currentCtx()?.claims
  const sub = typeof claims?.sub === 'string' ? claims.sub : ''
  if (!sub) return new UnauthenticatedUser()
  const orgId = typeof claims?.org_id === 'string' ? claims.org_id : ''
  return new JwtUser(sub, orgId)
}

/**
 * `ServerCallContext` для прямых обращений к TaskStore: AG-UI-путь хоста и REST-ручки агента
 * (`taskStore.load(taskId, currentCallContext())`). Вызывать внутри запроса за `jwtGuard`, иначе
 * владелец будет анонимным.
 */
export function currentCallContext(): ServerCallContext {
  return new ServerCallContext(undefined, currentUser())
}

/**
 * `userBuilder` для `jsonRpcHandler`: тот же пользователь, что у `currentCallContext()`. Читает
 * только ALS, JWT здесь заново не проверяется (это работа `jwtGuard`, он стоит перед обработчиком).
 */
export const hostUserBuilder = (_req: Request): Promise<User> => Promise.resolve(currentUser())
