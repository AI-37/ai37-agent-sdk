// CLI ai37-agent-sdk: dev-jwks | make-token | dev-billing. ТОЛЬКО для разработки/тестов.
import { loadOrCreateDevKey } from './devKey'
import { startDevJwks } from './devJwks'
import { startDevBilling, type FixtureName } from './devBilling'

const DEV_WARNING =
  '⚠  ai37-agent-sdk DEV TOOL — небезопасно, НЕ использовать в production.'

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        out[key] = next
        i++
      } else {
        out[key] = 'true'
      }
    }
  }
  return out
}

const USAGE = `ai37-agent-sdk — dev/testing CLI

  dev-jwks     [--port N] [--key-file PATH]      Локальный JWKS-сервер (реальная верификация)
  make-token   --claims '{json}' [--key-file P]  Подписать dev-JWT (для того же ключа, что dev-jwks)
  dev-billing  [--port N] [--fixture NAME]        Стаб billing-сервиса (active|no_resources|trial|feature_allowed|feature_denied)
`

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv
  const flags = parseFlags(rest)

  switch (command) {
    case 'dev-jwks': {
      const s = await startDevJwks({
        port: flags.port ? Number(flags.port) : undefined,
        keyFile: flags['key-file'],
      })
      process.stderr.write(`${DEV_WARNING}\n`)
      process.stderr.write(`dev-jwks: ${s.url}\n`)
      return // держим процесс живым
    }
    case 'dev-billing': {
      const s = await startDevBilling({
        port: flags.port ? Number(flags.port) : undefined,
        fixture: (flags.fixture as FixtureName) ?? 'active',
      })
      process.stderr.write(`${DEV_WARNING}\n`)
      process.stderr.write(
        `dev-billing: ${s.baseUrl} (fixture=${flags.fixture ?? 'active'})\n`,
      )
      return
    }
    case 'make-token': {
      const claims = flags.claims ? JSON.parse(flags.claims) : {}
      const key = await loadOrCreateDevKey(flags['key-file'])
      const token = await key.sign(claims)
      process.stdout.write(`${token}\n`)
      return
    }
    case 'help':
    case undefined:
      process.stdout.write(USAGE)
      return
    default:
      process.stderr.write(`Неизвестная команда: ${command}\n\n${USAGE}`)
      process.exitCode = 1
  }
}
