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
          // The browser-side MCP App: excluded from the server project (different libs and
          // module resolution, bundled by Vite), but still lintable — and a .ts file under
          // packages/ that belongs to no project is an ESLint parsing ERROR, not a skip.
          './packages/server/tsconfig.ui.json',
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
