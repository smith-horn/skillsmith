# Git Hooks

Custom git hooks for Skillsmith development to prevent common issues.

## Available Hooks

### `pre-commit-check-src.sh`

Warns about untracked files in `packages/*/src/` directories before each commit.

**Why this exists:** During Wave 4/5 development, a `.gitignore` bug caused source files in `packages/*/src/` to be accidentally ignored, leading to missing files in commits. This hook provides an early warning to prevent similar issues.

**Behavior:**
- Scans `packages/*/src/` for untracked files
- Displays a warning if any are found
- **Non-blocking:** The commit proceeds regardless (warning only)

## Installation

### Option 1: Manual Installation

```bash
# Copy the hook to .git/hooks/
cp scripts/git-hooks/pre-commit-check-src.sh .git/hooks/pre-commit

# Make it executable
chmod +x .git/hooks/pre-commit
```

### Option 2: Symlink (recommended for updates)

```bash
# Create a symlink so updates are automatic
ln -sf ../../scripts/git-hooks/pre-commit-check-src.sh .git/hooks/pre-commit

# Make it executable
chmod +x .git/hooks/pre-commit
```

## Verification

After installation, verify the hook works:

```bash
# Check the hook exists and is executable
ls -la .git/hooks/pre-commit

# Test by creating an untracked file in packages/*/src/
touch packages/core/src/test-untracked.ts
git commit --allow-empty -m "test hook"  # Should show warning
rm packages/core/src/test-untracked.ts   # Clean up
```

## Uninstallation

```bash
rm .git/hooks/pre-commit
```

## Combining with Other Hooks

If you have other pre-commit hooks (like husky or lint-staged), you can call this script from your main hook:

```bash
# In your existing pre-commit hook, add:
./scripts/git-hooks/pre-commit-check-src.sh
```

## Notes

- The hook is **non-blocking** by design to avoid disrupting workflows
- It only checks files in `packages/*/src/` directories
- Files that are intentionally in `.gitignore` will still trigger the warning; use your judgment
