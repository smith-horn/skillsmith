#!/usr/bin/env bash
#
# verify-claude-md-extraction.sh - SMI-4828 byte-identical extraction verifier.
#
# Asserts that for each block moved out of CLAUDE.md during the SMI-4828 trim:
#   (1) the block's signature phrase is GONE from current CLAUDE.md, and
#   (2) the block's signature phrase is PRESENT in the named destination sub-doc.
# Also asserts that load-bearing phrases (Hard Constraints) remain inline.
#
# This makes the byte-identical extraction claim PR-reviewable rather than
# author-attested. Remove in a follow-up PR after merge.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

CLAUDE_MD="CLAUDE.md"
DEV_DIR=".claude/development"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m'

errors=0
checks=0

assert_moved() {
    local phrase="$1"
    local dest="$2"
    local description="$3"
    checks=$((checks + 1))
    if grep -qF "$phrase" "$CLAUDE_MD"; then
        echo -e "${RED}FAIL${NC} (still in CLAUDE.md): $description"
        echo "       phrase: $phrase"
        errors=$((errors + 1))
        return
    fi
    if [ ! -f "$dest" ]; then
        echo -e "${RED}FAIL${NC} (dest missing): $dest"
        errors=$((errors + 1))
        return
    fi
    if ! grep -qF "$phrase" "$dest"; then
        echo -e "${RED}FAIL${NC} (not in dest): $description"
        echo "       phrase: $phrase"
        echo "       expected in: $dest"
        errors=$((errors + 1))
        return
    fi
    echo -e "${GREEN}OK${NC}   moved → ${dest##*/}: $description"
}

assert_inline() {
    local phrase="$1"
    local description="$2"
    checks=$((checks + 1))
    if ! grep -qF "$phrase" "$CLAUDE_MD"; then
        echo -e "${RED}FAIL${NC} (load-bearing content missing): $description"
        echo "       phrase: $phrase"
        errors=$((errors + 1))
        return
    fi
    echo -e "${GREEN}OK${NC}   inline (load-bearing): $description"
}

echo -e "${BOLD}SMI-4828 CLAUDE.md extraction verifier${NC}"
echo

echo -e "${BOLD}1. Hard-constraint phrases must remain inline${NC}"
assert_inline "Wave branch stacking (SMI-2597)" "wave-stacking rule"
assert_inline "Risk-first wave ordering (SMI-2596)" "risk-first wave ordering"
assert_inline "support@smithhorn.ca" "alerts email (CI Check 17 silent gap protection)"
assert_inline "varlock run -- sh -c 'git-crypt unlock" "git-crypt unlock command (chicken-and-egg)"
assert_inline "skill_inventory_audit" "MCP tool table (check-doc-drift gate)"
assert_inline "packages/*/src/**/*.test.ts" "Test File Locations table"
assert_inline "After EVERY commit, run \`/governance\`" "behavioral reminders footer"

echo
echo -e "${BOLD}2. Extracted blocks must be in destination sub-docs${NC}"
assert_moved "If branch switched during pre-commit" "$DEV_DIR/branch-management.md" "auto-restore prose"
assert_moved "Direct-to-main commits (SMI-2598)" "$DEV_DIR/branch-management.md" "direct-to-main SQL rule"
assert_moved "Resolution path: \`SKILLSMITH_LICENSE_KEY\` env" "$DEV_DIR/mcp-tools-guide.md" "team-tool resolution chain"
assert_moved "scoped overrides only" "$DEV_DIR/ci-reference.md" "ajv override caveat"
assert_moved "scripts/verify-publish-deps.mjs --ci" "$DEV_DIR/ci-reference.md" "release-PR Package Validation carve-out"
assert_moved "SMI-3502 split rationale" "$DEV_DIR/ci-reference.md" "vitest split rationale"
assert_moved "SMI-4557 carve-out" "$DEV_DIR/ci-reference.md" "tree-sitter test carve-out"
assert_moved "Pre-commit hooks work in worktrees via tracked" "$DEV_DIR/git-crypt-guide.md" "worktree hook setup"
assert_moved "create-worktree.sh\` and \`repair-worktrees.sh\` emit per-package" "$DEV_DIR/git-crypt-guide.md" "worktree Docker bind-mount (SMI-4689)"
assert_moved "SKILLSMITH_PRE_PUSH_DOCKER=1" "$DEV_DIR/git-crypt-guide.md" "worktree pre-push (SMI-4767)"
assert_moved "Deprecated (SMI-4533)" "$DEV_DIR/publishing-guide.md" "local-fallback deprecation"

echo
echo -e "${BOLD}3. CI machine-readable pins must remain (positive assertions)${NC}"
deploy_count=$(grep -c 'npx supabase functions deploy.*--no-verify-jwt' "$CLAUDE_MD" || true)
checks=$((checks + 1))
if [ "$deploy_count" -lt 21 ]; then
    echo -e "${RED}FAIL${NC} deploy commands: expected ≥21, got $deploy_count"
    errors=$((errors + 1))
else
    echo -e "${GREEN}OK${NC}   deploy commands present: $deploy_count"
fi

checks=$((checks + 1))
if grep -F 'Alerts to' "$CLAUDE_MD" | grep -qF 'support@smithhorn.ca'; then
    echo -e "${GREEN}OK${NC}   alerts sentence with smithhorn.ca present"
else
    echo -e "${RED}FAIL${NC} alerts sentence missing or wrong recipient"
    errors=$((errors + 1))
fi

echo
echo -e "${BOLD}4. Line-count budget${NC}"
lines=$(wc -l < "$CLAUDE_MD")
checks=$((checks + 1))
if [ "$lines" -gt 295 ]; then
    echo -e "${RED}FAIL${NC} CLAUDE.md is $lines lines (budget: ≤295)"
    errors=$((errors + 1))
else
    echo -e "${GREEN}OK${NC}   CLAUDE.md is $lines lines (budget: ≤295)"
fi

echo
if [ $errors -gt 0 ]; then
    echo -e "${RED}${BOLD}FAILED${NC} ${errors}/${checks} checks"
    exit 1
fi
echo -e "${GREEN}${BOLD}PASSED${NC} all ${checks} checks"
