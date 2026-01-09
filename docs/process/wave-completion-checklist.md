# Wave Completion Checklist

Use this checklist to verify all work is complete before marking a wave as done.

---

## Pre-Commit Verification

- [ ] `git status` shows only expected changes
- [ ] No untracked files that should be committed
- [ ] No files accidentally ignored by .gitignore
- [ ] Run `git diff --stat` to review change scope

### Shell Commands

```bash
# View all changes (staged, unstaged, untracked)
git status

# See detailed summary of changes by file
git diff --stat

# Check what files are being ignored that maybe shouldn't be
git status --ignored

# List all untracked files recursively
git ls-files --others --exclude-standard

# Preview what would be committed
git diff --cached --stat

# Check if any important files are gitignored
git check-ignore -v src/**/* tests/**/* 2>/dev/null || echo "No ignored files in key directories"
```

---

## Code Quality

- [ ] All tests pass: `docker exec skillsmith-dev-1 npm test`
- [ ] Build succeeds: `docker exec skillsmith-dev-1 npm run build`
- [ ] Lint clean: `docker exec skillsmith-dev-1 npm run lint`
- [ ] Type check passes: `docker exec skillsmith-dev-1 npm run typecheck`

### Shell Commands

```bash
# Run all quality checks in sequence (stops on first failure)
docker exec skillsmith-dev-1 npm run build && \
docker exec skillsmith-dev-1 npm run typecheck && \
docker exec skillsmith-dev-1 npm run lint && \
docker exec skillsmith-dev-1 npm test

# Or run individually for debugging:

# Build the project
docker exec skillsmith-dev-1 npm run build

# Type check
docker exec skillsmith-dev-1 npm run typecheck

# Lint check
docker exec skillsmith-dev-1 npm run lint

# Run tests
docker exec skillsmith-dev-1 npm test

# Run tests with coverage
docker exec skillsmith-dev-1 npm test -- --coverage

# Run preflight dependency check
docker exec skillsmith-dev-1 npm run preflight

# Run standards audit
docker exec skillsmith-dev-1 npm run audit:standards
```

---

## Code Review

- [ ] Code review completed by reviewer agent
- [ ] All critical/major issues resolved
- [ ] Minor issues documented or fixed

### Shell Commands

```bash
# Generate a diff for code review
git diff main...HEAD > /tmp/wave-changes.diff

# Count lines changed
git diff main...HEAD --stat | tail -1

# List all files changed in this wave
git diff main...HEAD --name-only

# Show changes grouped by directory
git diff main...HEAD --dirstat

# View changes to specific file types
git diff main...HEAD -- '*.ts' '*.tsx'
```

---

## Documentation

- [ ] README updated if public API changed
- [ ] JSDoc added for new public functions
- [ ] Architecture docs updated if needed

### Shell Commands

```bash
# Check if README was modified
git diff main...HEAD --name-only | grep -E "README|CLAUDE.md" || echo "No README changes"

# Find new exported functions without JSDoc (basic check)
git diff main...HEAD -- '*.ts' | grep -E "^\+export (function|const|class)" | head -20

# List all documentation changes
git diff main...HEAD --name-only -- '*.md'

# Check architecture docs were updated if source changed significantly
git diff main...HEAD --stat -- 'docs/architecture/'
```

---

## Commit & Push

- [ ] Commit message follows conventional commits
- [ ] Co-authored-by tag included
- [ ] Linear issue IDs referenced

### Shell Commands

```bash
# Stage all changes
git add -A

# Interactive staging (select specific files)
git add -p

# Create commit with proper format
git commit -m "$(cat <<'EOF'
feat(scope): brief description of changes

- Detail 1
- Detail 2

Refs: SMI-XXX

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"

# Verify commit message format
git log -1 --format="%B"

# Push to remote
git push origin HEAD

# Push and set upstream for new branches
git push -u origin HEAD
```

### Conventional Commit Types

| Type       | Description                          |
|------------|--------------------------------------|
| `feat`     | New feature                          |
| `fix`      | Bug fix                              |
| `docs`     | Documentation only                   |
| `style`    | Formatting, no code change           |
| `refactor` | Code change, no feature/fix          |
| `perf`     | Performance improvement              |
| `test`     | Adding/updating tests                |
| `chore`    | Build process, dependencies          |

---

## Post-Commit

- [ ] Linear issues marked as Done
- [ ] Retrospective created in docs/retros/
- [ ] git log shows clean commit

### Shell Commands

```bash
# Verify commit is clean
git log -1 --oneline

# View full commit details
git log -1 --format=full

# Mark Linear issues as done (replace XXX with issue numbers)
npx tsx ~/.claude/skills/linear/skills/linear/scripts/linear-ops.ts done SMI-XXX SMI-YYY

# Create retrospective file
touch docs/retros/wave-X-description.md

# Verify branch is up to date with remote
git status -sb

# Check nothing was missed
git status
```

---

## Quick Full Verification Script

Run this script to perform all automated checks at once:

```bash
#!/bin/bash
set -e

echo "=== Wave Completion Verification ==="
echo ""

echo "1. Git Status Check"
echo "==================="
git status
echo ""

echo "2. Changes Summary"
echo "=================="
git diff --stat
echo ""

echo "3. Build Check"
echo "=============="
docker exec skillsmith-dev-1 npm run build
echo ""

echo "4. Type Check"
echo "============="
docker exec skillsmith-dev-1 npm run typecheck
echo ""

echo "5. Lint Check"
echo "============="
docker exec skillsmith-dev-1 npm run lint
echo ""

echo "6. Test Suite"
echo "============="
docker exec skillsmith-dev-1 npm test
echo ""

echo "=== All Checks Passed ==="
```

Save as `scripts/verify-wave.sh` and run with:

```bash
chmod +x scripts/verify-wave.sh
./scripts/verify-wave.sh
```

---

## Troubleshooting

### Tests Fail with Native Module Errors

```bash
docker exec skillsmith-dev-1 npm rebuild better-sqlite3
docker exec skillsmith-dev-1 npm rebuild onnxruntime-node
```

### Container Not Running

```bash
docker compose --profile dev up -d
docker ps | grep skillsmith
```

### Uncommitted Changes After Commit

```bash
# Check what's left
git status

# If build artifacts, clean them
git clean -fd dist/

# If legitimate changes, amend or create new commit
git add -A && git commit --amend --no-edit
```

### Forgot to Include File

```bash
# Add forgotten file and amend (only if not pushed)
git add path/to/forgotten/file
git commit --amend --no-edit
```
