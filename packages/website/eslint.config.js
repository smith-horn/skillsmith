import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import eslintPluginAstro from 'eslint-plugin-astro'
import globals from 'globals'

// Get Astro flat config
const astroFlatConfig = eslintPluginAstro.configs['flat/recommended']

export default [
  // Global ignores - must be separate config object with ONLY ignores property
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '.astro/**',
      '.vercel/**',
      // Exclude Astro type declaration files
      'src/env.d.ts',
      // Files with complex template patterns that trigger parser errors
      // These use valid Astro syntax (JSON.stringify in <script>, nested ternaries)
      // but astro-eslint-parser has known limitations with these patterns
      'src/pages/blog/index.astro',
      'src/pages/signup.astro',
    ],
  },
  // Astro flat config - sets up parser and Astro-specific rules
  ...astroFlatConfig,
  // TypeScript files configuration
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      ...eslint.configs.recommended.rules,
      ...tseslint.configs.recommended[1]?.rules,
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  // Astro files - disable problematic rules for templates
  // MUST come after astroFlatConfig to override its rules
  {
    files: ['**/*.astro'],
    languageOptions: {
      globals: {
        ...globals.browser,
        Astro: 'readonly',
      },
    },
    rules: {
      // Disable unused vars - frontmatter vars are used in templates
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': 'off',
      // Disable prefer-rest-params - Google Analytics uses 'arguments'
      'prefer-rest-params': 'off',
      // Disable empty block warnings - common for graceful degradation
      'no-empty': 'off',
      // Disable escape warnings - false positives in template strings
      'no-useless-escape': 'off',
    },
  },
  // Virtual JS files from <script is:inline> blocks
  {
    files: ['**/*.astro/*.js'],
    rules: {
      'prefer-rest-params': 'off',
      'no-unused-vars': 'off',
      'no-empty': 'off',
    },
  },
  // Virtual TS files from <script> blocks
  {
    files: ['**/*.astro/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': 'off',
      'no-empty': 'off',
    },
  },
]
