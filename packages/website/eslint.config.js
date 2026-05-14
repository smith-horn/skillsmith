import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import eslintPluginAstro from 'eslint-plugin-astro'
import globals from 'globals'
// SMI-4904: custom rule banning raw window.<global> reads outside producer.
import noRawWindowGlobal from './eslint-rules/no-raw-window-global.js'

// Get Astro flat config
const astroFlatConfig = eslintPluginAstro.configs['flat/recommended']

// SMI-4904: local plugin namespace for project-specific rules.
const skillsmithLocal = {
  rules: {
    'no-raw-window-global': noRawWindowGlobal,
  },
}

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
      'skillsmith-local': skillsmithLocal,
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
      // SMI-4904: ban raw window.<banned-global> reads outside producer.
      'skillsmith-local/no-raw-window-global': 'error',
    },
  },
  // Astro files - disable problematic rules for templates
  // MUST come after astroFlatConfig to override its rules
  {
    files: ['**/*.astro'],
    plugins: {
      'skillsmith-local': skillsmithLocal,
    },
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
      // SMI-4904: apply the no-raw-window-global rule to .astro <script> blocks.
      'skillsmith-local/no-raw-window-global': 'error',
    },
  },
  // Virtual JS files from <script is:inline> blocks
  // SMI-4904: include skillsmith-local plugin so no-raw-window-global fires
  // on virtual *.astro/*.js files (is:inline scripts are parsed as JS blocks,
  // not as *.astro directly; without explicit plugin registration the rule is
  // silently absent for this virtual-file namespace).
  {
    files: ['**/*.astro/*.js'],
    plugins: {
      'skillsmith-local': skillsmithLocal,
    },
    rules: {
      'prefer-rest-params': 'off',
      'no-unused-vars': 'off',
      'no-empty': 'off',
      'skillsmith-local/no-raw-window-global': 'error',
    },
  },
  // Virtual TS files from <script> blocks
  // SMI-4904: same plugin registration required — virtual *.astro/*.ts files
  // are a separate flat-config namespace from *.astro and *.ts.
  // SMI-4902 retro: override parserOptions.project = null. Virtual files live
  // outside tsconfig.json's include, so the TS parser bails with "file not in
  // project" and the rule never runs. The rule is syntax-only (AST visitor on
  // MemberExpression) and does not need TS type info — disabling project
  // lookups lets the parser succeed and the rule fire.
  {
    files: ['**/*.astro/*.ts'],
    plugins: {
      'skillsmith-local': skillsmithLocal,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: null,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': 'off',
      'no-empty': 'off',
      'skillsmith-local/no-raw-window-global': 'error',
    },
  },
]
