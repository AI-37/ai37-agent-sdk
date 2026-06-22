import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts', 'relay/index': 'src/relay/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  external: ['@ai37/agent-sdk'],
})
