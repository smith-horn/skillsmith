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
    // Vitest configs import from ../../vitest.preset (outside package rootDir)
    // which tsc/eslint cannot resolve. Vitest uses vite resolution at runtime.
    '**/vitest.config.ts',
    '**/vitest.config.*.ts',
    'vitest.preset.ts',
    // Website uses Astro with its own ESLint config - lint separately
    'packages/website/**',
    // TypeScript template files in .claude/templates/ should be linted
    '!.claude/templates/*.ts',
    // Git worktrees - lint separately within each worktree context.
    // Both the dot-prefix `.worktrees/` (canonical, created by create-worktree.sh)
    // and the no-dot `worktrees/` (ad-hoc parallel sessions; SMI-4777) are ignored.
    '.worktrees/**',
    'worktrees/**',
    // Supabase edge functions use Deno runtime + are git-crypt encrypted in CI
    // Deno files have incompatible module semantics; lint them with deno lint instead
    'supabase/functions/**',
    'supabase/migrations/**',
    // Git-crypt encrypted .ts files: dependabot PRs don't get GIT_CRYPT_KEY secret,
    // so encrypted blobs reach ESLint as binary garbage and fail with "Parsing error:
    // Invalid character". Encryption scope per CLAUDE.md: .claude/skills/, .claude/plans/,
    // .claude/hive-mind/. Main branch CI sees plaintext via the unlock step. SMI-4785.
    '.claude/skills/**/*.ts',
    '.claude/plans/**/*.ts',
    '.claude/hive-mind/**/*.ts',
    // VS Code extension integration tests use @vscode/test-electron and Mocha globals
    // that aren't represented in the TS project graph; they're executed by the VS Code
    // test runner, not Vitest. Lint them separately if needed.
    'packages/vscode-extension/src/__tests__/integration/**',
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
          './packages/doc-retrieval-mcp/tsconfig.json',
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
