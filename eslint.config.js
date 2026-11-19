import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import importX from 'eslint-plugin-import-x';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '.sandbox/**',
      'src/public/**',
      '*.config.js',
      '**/*.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { project: ['./tsconfig.test.json'], tsconfigRootDir: import.meta.dirname },
    },
    plugins: { 'import-x': importX },
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'import-x/no-cycle': 'error',
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/notifications/email/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [{ name: 'nodemailer', message: 'Only notifications/email may import nodemailer.' }] },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/modules/sourceData/**', 'src/database/**', 'src/compositionRoot.ts', 'src/server.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/database/sourceDb*'],
              message: 'Only modules/sourceData may use the Source DB client.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.ts', 'tests/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  prettier,
);
