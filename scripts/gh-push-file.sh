#!/usr/bin/env bash
# gh-push-file.sh — Push a local file to a GitHub repo via gh api (macOS/Linux portable)
#
# Usage:
#   ./scripts/gh-push-file.sh <org/repo> <remote-path> <local-file> "<commit-message>" [<branch>]
#
# Examples:
#   ./scripts/gh-push-file.sh wrsmith108/linear-claude-skill .claude-plugin/plugin.json ./plugin.json "feat: add marketplace metadata"
#   ./scripts/gh-push-file.sh wrsmith108/linear-claude-skill .claude-plugin/plugin.json ./plugin.json "chore: bump version" main
#
# Notes:
#   - Uses Python base64 encoding (portable: macOS base64 -D ≠ Linux base64 -d)
#   - Auto-fetches current SHA when file already exists (required for updates)
#   - Validates JSON syntax for .json files before pushing
#   - Exits non-zero on 422 (SHA mismatch) with a helpful hint

set -euo pipefail

REPO="${1:-}"
REMOTE_PATH="${2:-}"
LOCAL_FILE="${3:-}"
COMMIT_MSG="${4:-}"
BRANCH="${5:-}"

# ── Validate args ────────────────────────────────────────────────────────────

if [[ -z "$REPO" || -z "$REMOTE_PATH" || -z "$LOCAL_FILE" || -z "$COMMIT_MSG" ]]; then
  echo "Usage: $0 <org/repo> <remote-path> <local-file> \"<commit-message>\" [<branch>]" >&2
  echo "" >&2
  echo "Examples:" >&2
  echo "  $0 wrsmith108/linear-claude-skill .claude-plugin/plugin.json ./plugin.json \"feat: add marketplace metadata\"" >&2
  exit 1
fi

if [[ ! -f "$LOCAL_FILE" ]]; then
  echo "❌ Local file not found: $LOCAL_FILE" >&2
  exit 1
fi

# ── JSON validation ──────────────────────────────────────────────────────────

if [[ "$LOCAL_FILE" == *.json || "$REMOTE_PATH" == *.json ]]; then
  if ! python3 -m json.tool "$LOCAL_FILE" > /dev/null 2>&1; then
    echo "❌ JSON validation failed for: $LOCAL_FILE" >&2
    echo "   Run: python3 -m json.tool $LOCAL_FILE" >&2
    exit 1
  fi
fi

# ── Encode content ───────────────────────────────────────────────────────────

ENCODED=$(python3 -c "import base64, sys; print(base64.b64encode(open('$LOCAL_FILE','rb').read()).decode())")

# ── Fetch current SHA (required if file already exists) ──────────────────────

SHA_FLAG=""
EXISTING=$(gh api "repos/${REPO}/contents/${REMOTE_PATH}" ${BRANCH:+--header "Accept: application/vnd.github+json" -F "ref=${BRANCH}"} 2>/dev/null || true)

if [[ -n "$EXISTING" ]]; then
  CURRENT_SHA=$(echo "$EXISTING" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('sha',''))" 2>/dev/null || true)
  if [[ -n "$CURRENT_SHA" ]]; then
    SHA_FLAG="-f sha=${CURRENT_SHA}"
    echo "📄 File exists (SHA: ${CURRENT_SHA:0:8}...) — updating"
  fi
else
  echo "📄 File does not exist — creating"
fi

# ── Push via gh api ──────────────────────────────────────────────────────────

PUSH_ARGS=(
  "repos/${REPO}/contents/${REMOTE_PATH}"
  -X PUT
  -f "message=${COMMIT_MSG}"
  -f "content=${ENCODED}"
)

if [[ -n "$SHA_FLAG" ]]; then
  PUSH_ARGS+=($SHA_FLAG)
fi

if [[ -n "$BRANCH" ]]; then
  PUSH_ARGS+=(-f "branch=${BRANCH}")
fi

RESPONSE=$(gh api "${PUSH_ARGS[@]}" 2>&1) || {
  EXIT_CODE=$?
  if echo "$RESPONSE" | grep -q "422\|SHA"; then
    echo "❌ Push failed (422 SHA mismatch)" >&2
    echo "   The file was likely updated by another commit between fetch and push." >&2
    echo "   Re-run this script to fetch the latest SHA and retry." >&2
  else
    echo "❌ Push failed:" >&2
    echo "$RESPONSE" >&2
  fi
  exit $EXIT_CODE
}

COMMIT_SHA=$(echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('commit',{}).get('sha','(unknown)')[:12])" 2>/dev/null || echo "(unknown)")

echo "✅ Pushed ${REMOTE_PATH} to ${REPO}"
echo "   Commit: ${COMMIT_SHA}"
