import tseslint from 'typescript-eslint'

export default [
  {
    files: [
      'src/dsh/**/*.ts',
      'test/dsh-*.test.ts',
      'scripts/check-dsh-package.mjs',
      'eslint.config.mjs',
    ],
    languageOptions: { parser: tseslint.parser },
    rules: {
      complexity: ['error', 10],
      'max-depth': ['error', 4],
      'max-params': ['error', 4],
      'max-lines-per-function': ['error', { max: 60, skipBlankLines: true, skipComments: true }],
    },
  },
]
