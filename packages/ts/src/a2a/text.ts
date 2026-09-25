/**
 * Shared sanitiser for Agent Card extension strings. Card text travels from an agent we do not
 * control straight to the registry and, for the showcase profile, to a rendered page — so control
 * characters and angle brackets are stripped and whitespace is collapsed before anything else.
 */
export function compactText(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127 ? ' ' : character
  })
    .join('')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
