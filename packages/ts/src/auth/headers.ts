/** Достаёт Bearer-токен из заголовков (Headers, объект или Record). Регистронезависимо. */
export function extractBearer(
  headers: Headers | Record<string, string | string[] | undefined> | undefined,
): string | undefined {
  if (!headers) return undefined

  let raw: string | undefined
  if (typeof (headers as Headers).get === 'function') {
    raw = (headers as Headers).get('authorization') ?? undefined
  } else {
    const rec = headers as Record<string, string | string[] | undefined>
    const key = Object.keys(rec).find((k) => k.toLowerCase() === 'authorization')
    const val = key ? rec[key] : undefined
    raw = Array.isArray(val) ? val[0] : val
  }

  if (!raw) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim())
  return match ? match[1] : undefined
}
