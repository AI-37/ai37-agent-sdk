/**
 * Разбор политики, объявленной переменной окружения.
 *
 * Общее у таких гейтов — не состояния, а разбор: прочитать значение из произвольно названной
 * переменной, свести отсутствие, пустую строку и нераспознанное к одному и тому же исходу и взять
 * дефолт от вызывающего. Набор состояний у каждого гейта свой (маршрут к модели, доступ оператора,
 * канал вложений), поэтому он передаётся, а не зашит.
 *
 * Пустую строку обязан обрабатывать именно разбор, а не схема окружения: сервисы читают
 * `process.env` напрямую, и `''` из ConfigMap до дефолта схемы не доезжает.
 */

export interface PolicyStateOptions<S extends string> {
  /** Допустимые состояния. */
  readonly states: readonly S[]
  /** Что взять, когда значения нет, оно пустое или не распознано. Обычно — закрытая сторона. */
  readonly fallback: S
}

/** Разбор уже прочитанного значения. */
export function parsePolicyState<S extends string>(
  raw: unknown,
  options: PolicyStateOptions<S>,
): S {
  if (typeof raw !== 'string') return options.fallback
  const value = raw.trim()
  if (!value) return options.fallback
  return options.states.includes(value as S) ? (value as S) : options.fallback
}

/** Разбор значения переменной окружения. Имя переменной принадлежит вызывающему. */
export function readPolicyState<S extends string>(
  envName: string,
  options: PolicyStateOptions<S>,
  env: Record<string, string | undefined> = process.env,
): S {
  return parsePolicyState(env[envName], options)
}
