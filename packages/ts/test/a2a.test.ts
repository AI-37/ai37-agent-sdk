import { describe, expect, it, vi } from 'vitest'
import { A2A_PROTOCOL_VERSION, buildA2AAuthHeaders, forwardAuthFetch } from '../src'

describe('a2a forward', () => {
  it('buildA2AAuthHeaders ставит Authorization и A2A-Version', () => {
    const h = buildA2AAuthHeaders('jwt-123')
    expect(h.Authorization).toBe('Bearer jwt-123')
    expect(h['A2A-Version']).toBe(A2A_PROTOCOL_VERSION)
  })

  it('forwardAuthFetch добавляет заголовки и сохраняет тело/метаданные', async () => {
    const base = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('{}', { status: 200 }),
    )
    const f = forwardAuthFetch('jwt-xyz', { fetch: base as unknown as typeof fetch })

    await f('https://agent.test/a2a/v1', {
      method: 'POST',
      body: JSON.stringify({ message: { metadata: { ai37: { app_id: 'sp-ai' } } } }),
    })

    expect(base).toHaveBeenCalledOnce()
    const init = (base.mock.calls[0][1] ?? {}) as RequestInit
    const headers = init.headers as Headers
    expect(headers.get('authorization')).toBe('Bearer jwt-xyz')
    expect(headers.get('a2a-version')).toBe(A2A_PROTOCOL_VERSION)
    expect(init.body).toContain('metadata') // тело проброшено без изменений
  })
})
