// Маскировка секретов в логах агентов. Правила живут здесь, а не в каждом агенте: новый тип секрета
// добавляется в SDK и доезжает до агентов бампом.
//
// Два способа на двух уровнях (docs plans/agent-log-secret-redaction.md):
// - по имени поля — здесь, в процессе: ловит секрет любого формата, включая будущие;
// - по виду значения широко (сотни правил gitleaks) — в сборщике логов кластера (Alloy
//   loki.secretfilter). Здесь только три дешёвые регулярки как страховка.

export const REDACTED = '[REDACTED]'

/**
 * Имя поля, строковое значение которого в лог не попадает. Только строки: числа вроде
 * `remainingTotalTokens` и `maxTokens` остаются, иначе логи биллинга теряют смысл.
 */
export const SECRET_KEY_PATTERN =
  /token|secret|passw|pwd|api[-_]?key|llm[-_]?key|private[-_]?key|access[-_]?key|authorization|cookie|credential/i

const VALUE_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // JWT: три base64url-части, первые две начинаются с eyJ ({"…).
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, REDACTED],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`],
  // Ключи LiteLLM / OpenAI-совместимых шлюзов.
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
]

/** Глубже этого уровня объект в лог не разворачивается — защита от огромных и вложенных структур. */
const MAX_DEPTH = 10

/** Секреты, узнаваемые по виду, в произвольной строке (в том числе в тексте сообщения лога). */
export function redactSecretsInText(text: string): string {
  let out = text
  for (const [pattern, replacement] of VALUE_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/**
 * Копия ошибки того же класса: pino применяет `formatters.log` до сериализатора `err`, и тот берёт
 * `type` из конструктора — plain object превратился бы в `type: "Object"`.
 */
function redactError(error: Error, depth: number, seen: WeakSet<object>): Error {
  const copy = Object.create(Object.getPrototypeOf(error) as object) as Error
  for (const [key, value] of Object.entries(error)) {
    ;(copy as unknown as Record<string, unknown>)[key] = redactEntry(key, value, depth, seen)
  }
  Object.defineProperty(copy, 'message', {
    value: redactSecretsInText(error.message),
    enumerable: false,
  })
  if (error.stack) {
    Object.defineProperty(copy, 'stack', {
      value: redactSecretsInText(error.stack),
      enumerable: false,
    })
  }
  return copy
}

function redactEntry(key: string, value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string' && SECRET_KEY_PATTERN.test(key)) return REDACTED
  return walk(value, depth + 1, seen)
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactSecretsInText(value)
  if (value === null || typeof value !== 'object') return value
  if (depth > MAX_DEPTH) return '[MaxDepth]'
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (value instanceof Error) return redactError(value, depth, seen)
  if (value instanceof Date || ArrayBuffer.isView(value)) return value
  const toJSON = (value as { toJSON?: unknown }).toJSON
  if (typeof toJSON === 'function') return walk(toJSON.call(value), depth, seen)
  if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, seen))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) out[key] = redactEntry(key, item, depth, seen)
  return out
}

/**
 * Копия значения для лога: строковые значения полей с «секретным» именем заменены на
 * `[REDACTED]` на любой глубине, JWT / Bearer / `sk-…` вырезаны из всех строк. Исходник не меняется.
 */
export function redactForLog<T>(value: T): T {
  return walk(value, 0, new WeakSet()) as T
}

/** Минимальная форма опций pino, без зависимости SDK от pino. */
export interface AgentLoggerOptions {
  level?: string
  name?: string
  formatters: {
    log(object: Record<string, unknown>): Record<string, unknown>
  }
  hooks: {
    logMethod(this: unknown, args: unknown[], method: (...args: unknown[]) => void): void
  }
  [option: string]: unknown
}

/**
 * Опции pino для логгера агента: `pino(agentLoggerOptions({ level, name }))`. Маскирует объект
 * записи по имени поля и по виду значения, а строковые аргументы (текст сообщения) — по виду
 * значения. Остальные опции передаются как есть.
 *
 * Не покрывает bindings дочернего логгера: pino 9 не пропускает `logger.child({...})` через
 * форматтеры. Секреты в `child()` не кладите (агенты из шаблона `child` не используют).
 */
export function agentLoggerOptions(
  base: { level?: string; name?: string; [option: string]: unknown } = {},
): AgentLoggerOptions {
  return {
    ...base,
    formatters: {
      log: (object) => redactForLog(object),
    },
    hooks: {
      logMethod(args, method) {
        const safe = args.map((arg) => (typeof arg === 'string' ? redactSecretsInText(arg) : arg))
        method.apply(this, safe)
      },
    },
  }
}
