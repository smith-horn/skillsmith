import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettierConfig from 'eslint-config-prettier'
import eslintPluginAstro from 'eslint-plugin-astro'
import globals from 'globals'

export default tseslint.config(
  // Global ignores - must be first
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.d.ts',
      // Ignore .js files except in website package (Astro needs them)
      'packages/core/**/*.js',
      'packages/mcp-server/**/*.js',
      'packages/cli/**/*.js',
      'packages/enterprise/**/*.js',
      '.claude/**/*.js',
      'tests/**/*.js',
      '**/*.mjs',
      '!eslint.config.js',
      '**/vitest.config.integration.ts',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  // Astro recommended config
  ...eslintPluginAstro.configs.recommended,
  {
    files: ['packages/**/*.ts', 'packages/**/*.tsx'],
    ignores: ['packages/website/**'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        // Exclude website - it uses Astro's tsconfig which requires Astro installed
        project: [
          './packages/core/tsconfig.json',
          './packages/mcp-server/tsconfig.json',
          './packages/cli/tsconfig.json',
          './packages/enterprise/tsconfig.json',
          './packages/vscode-extension/tsconfig.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  // Astro files in website package
  {
    files: ['packages/website/**/*.astro'],
    languageOptions: {
      parser: eslintPluginAstro.parser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.astro'],
      },
    },
  }
)
