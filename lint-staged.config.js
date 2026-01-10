/**
 * lint-staged configuration
 *
 * SMI-1346: Enhanced pre-commit hooks with early lint error detection
 *
 * This configuration runs a two-phase lint check:
 * 1. eslint --fix: Auto-fix what can be fixed
 * 2. eslint: Verify no errors remain (catches unused imports/variables)
 *
 * This prevents commits with lint errors that eslint --fix cannot auto-resolve.
 */

export default {
  // TypeScript/JavaScript files: two-phase lint + format
  '*.{ts,tsx,js,jsx}': [
    // Phase 1: Auto-fix what can be fixed
    'eslint --fix',
    // Phase 2: Verify no errors remain (catches unfixable issues like unused imports)
    'eslint --max-warnings=0',
    // Phase 3: Format
    'prettier --write',
  ],

  // Config and documentation files: format only
  '*.{json,md,yml,yaml}': ['prettier --write'],
}
