import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettierConfig from 'eslint-config-prettier'
import globals from 'globals'

// Global ignores - must be separate config object with ONLY ignores property
const globalIgnores = {
  ignores: [
    '**/dist/**',
    '**/node_modules/**',
    '**/coverage/**',
    '**/*.d.ts',
    '**/*.js',
    '**/*.cjs',
    '**/*.mjs',
    '!eslint.config.js',
    '**/vitest.config.integration.ts',
    // Website uses Astro with its own ESLint config - lint separately
    'packages/website/**',
    // TypeScript template files in .claude/templates/ should be linted
    '!.claude/templates/*.ts',
    // Git worktrees - lint separately within each worktree context
    '.worktrees/**',
    // Supabase edge functions use Deno runtime + are git-crypt encrypted in CI
    // Deno files have incompatible module semantics; lint them with deno lint instead
    'supabase/functions/**',
    'supabase/migrations/**',
  ],
}

const tsConfig = tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
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
  }
)

export default [globalIgnores, ...tsConfig]
