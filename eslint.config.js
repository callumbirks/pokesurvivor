import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['legacy/**', '**/dist/**', '**/coverage/**', 'apps/server/drizzle/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: false },
    },
  },
  {
    // The simulation must run headless in Node and in a Web Worker.
    files: ['packages/sim/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...['window', 'document', 'navigator', 'localStorage', 'requestAnimationFrame'].map(
          (name) => ({ name, message: 'packages/sim must not touch the DOM or browser APIs.' }),
        ),
      ],
    },
  },
  prettier,
);
