import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/*.test.ts'],
  },
  {
    files: ['packages/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: [
          './packages/core/tsconfig.json',
          './packages/server/tsconfig.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'warn',
    },
  },
);
