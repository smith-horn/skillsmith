# scripts/lib/docs-only-patterns.sh
# SMI-6260 Wave 1 — canonical docs-only file classification.
#
# Extracted from scripts/pre-push-check.sh's inline SAFE_REGEX (and the
# duplicated _HOOK_SAFE_REGEX copy in scripts/lib/hook-docker-detect.sh) so
# both existing bash callers, plus a new third caller
# (scripts/pre-push-coverage-check.sh) and .husky/pre-push's own
# submodule-pointer wiring, share one tightened definition instead of
# drifting independently.
#
# Sourced by:
#   scripts/pre-push-check.sh
#   scripts/lib/hook-docker-detect.sh (indirectly, via the caller-provided
#     DETECT_LIB/HOOK_DETECT_LIB path — see that file's own sourcing block)
#   scripts/pre-push-coverage-check.sh
#   .husky/pre-push (submodule-pointer step)
#
# POSIX sh — no `local`, no `[[ ]]`, no bash arrays. This file is sourced
# from both bash scripts (pre-push-check.sh, pre-push-coverage-check.sh) and
# POSIX-sh contexts (hook-docker-detect.sh, .husky/pre-push itself, which
# husky's own launcher runs via `sh -e`, not bash — see
# .husky/_/h). Every caller-visible name is prefixed to avoid clobbering the
# sourcing script's own variables.
#
# CONTRACT:
#   DOCS_ONLY_SAFE_REGEX / DOCS_ONLY_UNSAFE_OVERRIDE — the two grep -E
#     patterns, exposed for callers that want to inspect them directly.
#   is_docs_only() — reads a newline-separated file list on stdin, returns
#     0 (true, docs-only) or 1 (false, not docs-only or nothing to check).
#     Empty stdin returns 1 (matches the pre-SMI-6260 callers' own default:
#     "no changed files" never set DOCS_ONLY=1 — a diff that resolves to
#     nothing to compare is treated conservatively as "run the full checks",
#     never as an implicit skip).
#
# SAFE_REGEX matches files that cannot introduce production deps or
# activate a gated test:
#   - docs/**, **/*.md (including a submodule pointer bump under docs/, and
#     a bare .gitmodules bump for docs/internal or a strategy mount)
#   - .claude/development/**, .claude/templates/**
#   - LICENSE, .github/ISSUE_TEMPLATE/**, .github/CODEOWNERS, PR template
#   - .gitmodules (submodule pointer bumps only)
#
# UNSAFE_OVERRIDE vetoes an otherwise-safe match. POSIX ERE (grep -E — the
# only flavor every caller here uses) has no negative lookahead, so
# "*.md, but not under packages/**" cannot be expressed in one pattern.
# Two passes instead: a positive SAFE_REGEX match, then a negative
# UNSAFE_OVERRIDE veto — both remain portable POSIX ERE. Never reach for
# `grep -P` as a shortcut: macOS's stock /usr/bin/grep (this repo's
# documented host platform) doesn't support -P at all, and that would
# silently break every host run.
#   - packages/**/*.md — SMI-4961 hazard: a new .md at an
#     existsSync/skipIf-gated fixture path would otherwise be misclassified
#     as docs-only and skip the very tests it activates.
#   - **/tests/**, **/fixtures/** — same hazard class, non-.md fixture
#     files (e.g. a new JSON/YAML fixture under a gated tests/ directory).
#
# Drift note (inherited from the pre-SMI-6260 SAFE_REGEX comment): CI
# mirrors similar logic in scripts/ci/classify-changes.ts. Kept in bash here
# (no tsx dependency for git hooks). Worst case of drift is a false-positive
# full run on a docs-only push (safe; never a false-negative skip).

DOCS_ONLY_SAFE_REGEX='^(docs/|\.claude/development/|\.claude/templates/|\.github/(ISSUE_TEMPLATE/|CODEOWNERS|PULL_REQUEST_TEMPLATE\.md)|LICENSE$|.*\.md$|\.gitmodules$)'
DOCS_ONLY_UNSAFE_OVERRIDE='packages/.*\.md$|.*/tests/.*|.*/fixtures/.*'

is_docs_only() {
    _DOP_FILES="$(cat)"
    if [ -z "$_DOP_FILES" ]; then
        return 1
    fi

    _DOP_UNSAFE=$(printf '%s\n' "$_DOP_FILES" | grep -vE "$DOCS_ONLY_SAFE_REGEX" || true)
    if [ -n "$_DOP_UNSAFE" ]; then
        return 1
    fi

    _DOP_OVERRIDDEN=$(printf '%s\n' "$_DOP_FILES" | grep -E "$DOCS_ONLY_UNSAFE_OVERRIDE" || true)
    if [ -n "$_DOP_OVERRIDDEN" ]; then
        return 1
    fi

    return 0
}
