// Root ESLint config. Enforces Master Context rule #12: no `any`, ever.
/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'import'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  env: {
    node: true,
    es2022: true,
  },
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    // Stylistic import rules are auto-fixed by lint-staged; keep them off in CI
    // lint so `--max-warnings=0` reflects only substantive issues.
    '@typescript-eslint/consistent-type-imports': 'off',
    'import/order': 'off',
    'no-console': ['warn', { allow: ['warn', 'error'] }],
  },
  ignorePatterns: [
    'node_modules',
    'dist',
    '.next',
    'coverage',
    '**/*.config.js',
    '**/*.config.cjs',
    'packages/db/prisma/migrations/**',
  ],
  overrides: [
    {
      files: ['*.test.ts', '*.spec.ts', '**/seed/**', '**/scripts/**'],
      rules: {
        'no-console': 'off',
      },
    },
  ],
};
