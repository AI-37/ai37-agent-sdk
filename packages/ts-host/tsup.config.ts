import { defineConfig } from 'tsup'

// dist чистит `npm run build` (`clean` перед tsup): два конфига собираются параллельно, и `clean`
// одного стёр бы выход другого.
export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      'relay/index': 'src/relay/index.ts',
      'skills/index': 'src/skills/index.ts',
      // Postgres-стор: kysely/pg — optional peers, грузятся только этим subpath.
      'task-store/index': 'src/task-store/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: false,
    splitting: false,
    // task-store ищет CLI a2a-db через createRequire(import.meta.url) — нужен и в CJS-сборке.
    shims: true,
    external: ['@ai37/agent-sdk'],
  },
  {
    // CLI ai37-agent-host-task-store (bin): только ESM, с shebang.
    entry: { 'cli/task-store': 'src/cli/task-store-bin.ts' },
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: false,
    splitting: false,
    banner: { js: '#!/usr/bin/env node' },
    external: ['@ai37/agent-sdk'],
  },
])
