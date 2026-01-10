# Git Hooks Guide

> SMI-1342, SMI-727: Git hook configuration for code quality and safety

## Overview

This project uses [Husky](https://typicode.github.io/husky/) to manage Git hooks that enforce code quality, security, and safety standards. Hooks run automatically at key points in the Git workflow.

## Active Hooks

| Hook         | Trigger           | Purpose                                  |
| ------------ | ----------------- | ---------------------------------------- |
| `pre-commit` | Before commit     | TypeScript checking, linting, formatting |
| `post-commit`| After commit      | Linear issue status sync                 |
| `pre-push`   | Before push       | Uncommitted changes warning, security    |

## Pre-Push Hook (SMI-727, SMI-1342)

The pre-push hook runs two phases of checks before allowing code to be pushed.

### Phase 1: Uncommitted Changes Warning (SMI-1342)

**Why this exists:** During Wave 7 development, a `git reset` accidentally lost the main implementation commit because it hadn't been pushed. This check prevents similar incidents by warning developers when they have uncommitted work.

**What it checks:**

1. **Staged changes** - Files added to index but not committed
2. **Unstaged changes** - Modified files not yet staged
3. **Untracked files** - New files not added to Git (excluding common patterns like `node_modules/`, `.env`, `dist/`)

**Behavior:**

- If working directory is clean: proceeds silently
- If uncommitted changes exist: displays warning and prompts for confirmation
- In CI/non-interactive mode: proceeds with warning (no prompt)

**Example output:**

```
📋 Checking for uncommitted changes...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  WARNING: You have uncommitted changes
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Unstaged changes (2 files):
  📄 src/services/search.ts
  📄 packages/core/src/index.ts

ℹ️  Why this matters:
   These changes exist only on your local machine. If you run
   commands like 'git reset' or 'git checkout', they could be lost.
   Consider committing important changes before pushing.

Options:
  y - Yes, push anyway (changes will remain local)
  n - No, abort push (to commit changes first)
  c - Show git status for more details

Do you want to proceed with push? [y/n/c]:
```

### Phase 2: Security Checks (SMI-727)

**What it checks:**

1. **Security test suite** - Runs `packages/core/tests/security/` tests
2. **npm audit** - Checks for high-severity vulnerabilities in production dependencies
3. **Hardcoded secrets** - Scans for API keys, tokens, passwords in code

**Behavior:**

- All checks must pass for push to proceed
- Failures block the push with detailed error messages

## Pre-Commit Hook (SMI-1346, SMI-1348)

Runs before each commit to ensure code quality with early lint error detection.

### What It Checks

| Phase | Check | Purpose |
| ----- | ----- | ------- |
| 0 | Build cache clear (`tsc --build --clean`) | Prevents stale type errors |
| 1 | TypeScript (`npm run typecheck`) | Catches type errors |
| 2 | ESLint + Prettier (`lint-staged`) | Catches lint errors and formats code |

### Phase 0: Build Cache Clearing (SMI-1348)

**Why this exists:** TypeScript's incremental build cache (`.tsbuildinfo` files) can become stale after git operations (merge, cherry-pick) or when type definitions change in dependent packages. This can cause false positive type errors that don't actually exist in the code.

**What it does:** Runs `tsc --build --clean` to clear all build artifacts before typecheck, ensuring a fresh type analysis.

### Two-Phase Lint Check

The lint-staged configuration (see `lint-staged.config.js`) runs a two-phase lint check:

```javascript
'*.{ts,tsx,js,jsx}': [
  'eslint --fix',        // Phase 1: Auto-fix what can be fixed
  'eslint --max-warnings=0',  // Phase 2: Verify no errors remain
  'prettier --write',    // Phase 3: Format
]
```

**Why two phases?** The `eslint --fix` command auto-fixes issues like formatting but returns success even when it cannot fix certain errors (unused imports, unused variables). The second `eslint` run catches these unfixable errors before they reach CI.

### Common Errors and Fixes

When the pre-commit hook fails with lint errors, you'll see helpful guidance:

**Unused imports:**
```typescript
// Error: 'ParseResult' is defined but never used
import { ParseResult } from './types';  // Remove this line

// Or prefix with underscore if intentionally unused
import { _ParseResult } from './types';
```

**Unused variables:**
```typescript
// Error: 'adapter' is assigned but never used
const adapter = createAdapter();  // Remove or use the variable

// Or prefix with underscore
const _adapter = createAdapter();
```

**Unnecessary regex escapes:**
```typescript
// Error: Unnecessary escape character: \)
const regex = /\(/;  // ✓ Correct - ( needs escaping
const regex = /\)/;  // ✗ Error - ) doesn't need escaping in this context
const regex = /)/;   // ✓ Fixed
```

### Quick Fix Commands

```bash
# Auto-fix what can be fixed
npm run lint:fix

# See remaining errors that need manual fixing
npm run lint

# Run typecheck to verify types
npm run typecheck
```

### Example Output

**Success:**
```
=== Pre-Commit Checks ===

[0/2] Clearing TypeScript build cache...
  ✓ Build cache cleared
[1/2] Running TypeScript type check...
  ✓ TypeScript check passed
[2/2] Running lint and format on staged files...
  ✓ Lint and format passed

=== All Pre-Commit Checks Passed ===
```

**Failure:**
```
=== Pre-Commit Checks ===

[0/2] Clearing TypeScript build cache...
  ✓ Build cache cleared
[1/2] Running TypeScript type check...
  ✓ TypeScript check passed
[2/2] Running lint and format on staged files...

/path/to/file.ts
  3:10  error  'ParseResult' is defined but never used  @typescript-eslint/no-unused-vars

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✗ Lint Errors Found
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Common issues and fixes:

  Unused imports:
    - Remove: import { UnusedType } from './module'
    - Or prefix with underscore: import { _UnusedType } from './module'

  Quick fix:
    npm run lint:fix    # Auto-fix what can be fixed
    npm run lint        # See remaining errors

  Emergency bypass: git commit --no-verify
```

## Post-Commit Hook

Syncs Linear issue status based on commit messages:

```bash
# Automatically updates Linear issues mentioned in commits
# e.g., "fix: resolve login bug (SMI-123)" -> marks SMI-123 as done
```

## Bypassing Hooks

For emergencies, hooks can be bypassed:

```bash
# Skip all hooks on a single command
git commit --no-verify -m "emergency fix"
git push --no-verify

# NOT RECOMMENDED for regular use - hooks exist for safety
```

**When bypass is acceptable:**

- True emergencies requiring immediate hotfix
- CI/CD systems that run checks separately
- Hooks failing due to infrastructure issues (not code issues)

**When NOT to bypass:**

- To skip failing tests
- To avoid fixing lint errors
- To push code with security warnings

## Troubleshooting

### Hook not running

```bash
# Verify husky is installed
npm run prepare

# Check hook is executable
ls -la .husky/pre-push

# Make executable if needed
chmod +x .husky/pre-push
```

### Docker container not available for security checks

The security checks require the Docker dev container:

```bash
# Start the container
docker compose --profile dev up -d

# Verify it's running
docker ps | grep skillsmith
```

### Hook takes too long

Security checks run in Docker and may take 30-60 seconds. If this is problematic:

1. Ensure Docker container is already running (avoids startup time)
2. Use `--no-verify` sparingly for time-critical pushes
3. Consider running checks locally first: `npm run test -- packages/core/tests/security/`

### Uncommitted changes check prompts in CI

The check detects non-interactive mode and proceeds automatically in CI. If you're seeing prompts in CI:

- Ensure stdin is not being piped or redirected
- Check that the CI runner properly handles non-TTY environments

## Adding New Hooks

To add a new hook:

1. Create the hook file:
   ```bash
   echo '#!/bin/sh\n# Your hook script' > .husky/pre-merge-commit
   chmod +x .husky/pre-merge-commit
   ```

2. For complex logic, create a script in `scripts/` and call it from the hook:
   ```bash
   # .husky/pre-merge-commit
   bash "$(dirname "$0")/../scripts/pre-merge-check.sh"
   ```

3. Document the hook in this guide

## Related Files

| File                                    | Purpose                              |
| --------------------------------------- | ------------------------------------ |
| `.husky/pre-push`                       | Pre-push hook entry point            |
| `.husky/pre-commit`                     | Pre-commit hook entry point          |
| `.husky/post-commit`                    | Post-commit hook entry point         |
| `lint-staged.config.js`                 | Lint-staged configuration (SMI-1346) |
| `scripts/pre-push-check.sh`             | Security check implementation        |
| `scripts/pre-push-uncommitted-check.sh` | Uncommitted changes check            |
| `package.json`                          | Husky setup (`"prepare": "husky"`)   |

## Related Documentation

- [Engineering Standards](../architecture/standards.md) - Code quality policies
- [Varlock Security](../../CLAUDE.md#varlock-security-mandatory) - Secret management
- [Docker Setup](../../CLAUDE.md#docker-first-development) - Container requirements
