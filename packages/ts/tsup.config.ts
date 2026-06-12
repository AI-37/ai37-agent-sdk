import { defineConfig } from 'tsup'

export default defineConfig({
  // cli добавится при реализации dev-серверов (WP0b).
  entry: {
    index: 'src/index.ts',
    'testing/index': 'src/testing/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
})
