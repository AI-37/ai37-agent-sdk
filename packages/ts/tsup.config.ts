import { defineConfig } from 'tsup'

export default defineConfig({
  // WP0b: пока собираем только основной вход. testing/index и cli добавятся при их реализации.
  entry: {
    index: 'src/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
})
