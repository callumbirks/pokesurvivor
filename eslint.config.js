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
    // The simulation must run headless in Node and in a Web Worker, and be deterministic: all
    // randomness from the seeded RNG in its state, all time from its fixed tick.
    files: ['packages/sim/src/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...['window', 'document', 'navigator', 'localStorage', 'requestAnimationFrame'].map(
          (name) => ({ name, message: 'packages/sim must not touch the DOM or browser APIs.' }),
        ),
        ...[
          'performance',
          'setTimeout',
          'setInterval',
          'setImmediate',
          'clearTimeout',
          'clearInterval',
          'queueMicrotask',
          'cancelAnimationFrame',
        ].map((name) => ({
          name,
          message: 'packages/sim is deterministic: use the fixed tick (state.tick / state.time).',
        })),
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'packages/sim is deterministic: use the seeded RNG (ctx.rand).',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'packages/sim is deterministic: use the fixed tick (state.tick / state.time).',
        },
        { object: 'performance', property: 'now', message: 'Use the fixed tick.' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'packages/sim is deterministic: no wall-clock time.',
        },
      ],
    },
  },
  prettier,
);
