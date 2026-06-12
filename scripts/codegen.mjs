#!/usr/bin/env node
// Кодоген из contract/feature-codes.json → codes.ts (TS) и codes.py (Python).
// Гарантирует идентичность BillingFeatureCode/BillingPrivilegeCode в обоих пакетах.
// Использование: node scripts/codegen.mjs   (или `make codegen`)
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const contract = JSON.parse(
  readFileSync(join(root, 'contract', 'feature-codes.json'), 'utf8'),
)

const features = contract.features ?? []
const privileges = contract.privileges ?? []

const tsEnum = (name, items) =>
  `export enum ${name} {\n` +
  items.map((i) => `  ${i.constant} = '${i.code}',`).join('\n') +
  `\n}\n`

const ts =
  `// СГЕНЕРИРОВАНО scripts/codegen.mjs из contract/feature-codes.json. НЕ редактировать вручную.\n\n` +
  tsEnum('BillingFeatureCode', features) +
  `\n` +
  tsEnum('BillingPrivilegeCode', privileges)

writeFileSync(join(root, 'packages', 'ts', 'src', 'codes.ts'), ts)

const pyEnum = (name, items) =>
  `class ${name}(str, Enum):\n` +
  items.map((i) => `    ${i.constant} = "${i.code}"`).join('\n') +
  `\n`

const py =
  `# СГЕНЕРИРОВАНО scripts/codegen.mjs из contract/feature-codes.json. НЕ редактировать вручную.\n` +
  `from enum import Enum\n\n` +
  pyEnum('BillingFeatureCode', features) +
  `\n\n` +
  pyEnum('BillingPrivilegeCode', privileges)

writeFileSync(
  join(root, 'packages', 'python', 'src', 'ai37_agent_sdk', 'codes.py'),
  py,
)

console.log('codegen: codes.ts + codes.py обновлены')
