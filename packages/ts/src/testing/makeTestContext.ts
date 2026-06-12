import { AgentContext } from '../context'
import type { BillingClient, BillingRuntimeState } from '../billing/types'
import type { Claims } from '../auth/types'
import { FakeJwtVerifier, InMemoryBillingClient } from './fakes'
import { fixtures } from './fixtures'

/** Собирает AgentContext без сети: FakeJwtVerifier + InMemoryBillingClient. */
export async function makeTestContext(opts: {
  claims: Claims
  billing?: BillingClient
  runtimeState?: BillingRuntimeState
}): Promise<AgentContext> {
  const billing =
    opts.billing ??
    new InMemoryBillingClient({
      runtimeState: opts.runtimeState ?? fixtures.runtimeState.active(),
    })

  return AgentContext.fromRequest(
    { authorization: 'Bearer test.token' },
    {
      auth: { issuer: 'test', audience: 'test', required: true },
      billing: { baseUrl: 'http://billing.test', appsAuthToken: 'test' },
    },
    { verifier: new FakeJwtVerifier(opts.claims), billingClient: billing },
  )
}
