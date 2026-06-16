import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      'testing/index': 'src/testing/index.ts',
      dev: 'src/dev.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
  },
  {
    // CLI: ESM с shebang, без типов; собирается отдельной конфигурацией (без clean, чтобы не стирать lib).
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    dts: false,
    sourcemap: false,
    clean: false,
    splitting: false,
    banner: { js: '#!/usr/bin/env node' },
  },
])
