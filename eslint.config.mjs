import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * The same rules the full project uses, reduced to what these modules need.
 *
 * Style is left to review; a linter that argues about quotes trains people to
 * run it with --fix and stop reading the output. What is enabled here catches
 * things that change behaviour: a caught error thrown away silently, a `==`
 * that coerces, code left behind by a change that was not finished.
 */
export default tseslint.config(
  {
    ignores: ['node_modules/**', 'coverage/**']
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: 'module'
      }
    },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-implicit-coercion': 'error',
      'no-return-await': 'error',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none'
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off'
    }
  },

  {
    // Tests reach into internals and construct partial objects on purpose.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-expressions': 'off'
    }
  }
);
