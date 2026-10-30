import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const npmCli = process.env.npm_execpath
assert.ok(npmCli, 'Run this check through npm run test:package')
const temporary = await mkdtemp(join(tmpdir(), 'ai37-host-dsh-package-'))

const isolatedProbe = `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const esm = await import('./package/dist/dsh/index.js')
const cjs = createRequire(import.meta.url)('./package/dist/dsh/index.cjs')
for (const api of [esm, cjs]) {
  let starts = 0
  const runtime = new api.SingleHarnessRuntime(async () => {
    starts += 1
    return { close: async () => undefined }
  })
  assert.equal(starts, 0)
  assert.equal(await runtime.use(async () => 'ready'), 'ready')
  await runtime.close()
  assert.equal(starts, 1)
  assert.deepEqual(api.childPlatformEnvironment({ PATH: '/bin', LLM_KEY: 'private' }), { PATH: '/bin' })
  const bridge = new api.ScopedRequestBridge({ timeoutMs: 1000, dispatch: async () => ({}) })
  await bridge.close()
  assert.equal(typeof api.scopedAsyncIterable, 'function')
  assert.equal(typeof api.resumeStoredSession, 'function')
  assert.equal(typeof api.closeHarnessSession, 'function')
  assert.equal(typeof api.cancelHarnessSession, 'function')
}
`
const rootProbe = `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const esm = await import('@ai37/agent-host')
const cjs = createRequire(process.cwd() + '/package.json')('@ai37/agent-host')
for (const api of [esm, cjs]) {
  assert.equal(typeof api.createAgentHost, 'function')
  assert.equal('SingleHarnessRuntime' in api, false)
  // Модуль вложений — корневой экспорт: потребители импортируют его из '@ai37/agent-host'.
  for (const name of [
    'attachmentScope',
    'createAttachmentReaders',
    'readStoreWithinBudget',
    'readAttachmentContents',
    'extractFromAttachments',
  ])
    assert.equal(typeof api[name], 'function', name)
}
`

try {
  const packed = JSON.parse(
    execFileSync(
      process.execPath,
      [npmCli, 'pack', '--ignore-scripts', '--pack-destination', temporary, '--json'],
      {
        cwd: root,
        encoding: 'utf8',
      },
    ),
  )
  execFileSync('tar', ['-xf', join(temporary, packed[0].filename), '-C', temporary])
  const manifest = JSON.parse(await readFile(join(temporary, 'package/package.json'), 'utf8'))
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  }
  assert.equal(
    Object.keys(dependencies).some((name) => name.startsWith('@deepseek-ai/')),
    false,
  )
  await writeFile(join(temporary, 'probe.mjs'), isolatedProbe)
  // This consumer has no node_modules or inherited module/provider configuration.
  execFileSync(process.execPath, [join(temporary, 'probe.mjs')], {
    env: {},
    stdio: 'pipe',
    timeout: 30_000,
  })
  execFileSync(process.execPath, ['--input-type=module', '-e', rootProbe], {
    cwd: root,
    stdio: 'pipe',
    timeout: 30_000,
  })
  process.stdout.write('Packed /dsh ESM+CJS and existing root imports: PASS\n')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
