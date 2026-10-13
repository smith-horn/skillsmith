#!/usr/bin/env bash
# SMI-7112 (R3-1): the autochain's authoritative pre-dispatch read.
#
# Exit 0 ONLY when a successful GitHub API read of the repo variable
# BACKFILL_AUTOCHAIN_DISABLE returns EXACTLY "0" (enabled). Every other outcome
# exits 1 with an ::error:: naming the cause, so the caller's job goes red and
# no dispatch happens:
#   "1"  disabled              ""  / " 0" / anything else   malformed
#   404  variable missing      403  token lacks Variables: read
#   any other gh failure (network, 5xx, rate limit)
#
# The `vars` context is NOT used as a re-read: it cannot tell "enabled" from
# "unreadable". Credential: ONLY the fine-grained PAT secret
# BACKFILL_VARIABLE_READ_PAT (Variables: read, this repo only), passed in as
# GH_TOKEN by the caller. GITHUB_TOKEN and the GitHub App cannot read variables
# (measured, W0-7). A missing/expired PAT therefore fails closed.
#
# 401 is classified explicitly (PAT expired or revoked) and still fails closed.
# `--verify-read` (verify-only autochain runs) exits 0 when the PAT can read the
# variable and it is exactly "0" or "1"; it never authorises a dispatch.
#
# Env: GH_TOKEN (the PAT), GITHUB_REPOSITORY (owner/repo).
set -uo pipefail

VERIFY_READ=0
case "${1:-}" in
  "") ;;
  --verify-read) VERIFY_READ=1 ;;
  *) echo "::error::autochain-read-enable: unknown argument '$1'"; exit 1 ;;
esac

REPO="${GITHUB_REPOSITORY:-}"
if [ -z "$REPO" ]; then
  echo "::error::autochain-read-enable: GITHUB_REPOSITORY is not set -- refusing to dispatch."
  exit 1
fi
if [ -z "${GH_TOKEN:-}" ]; then
  echo "::error::autochain-read-enable: BACKFILL_VARIABLE_READ_PAT is not provisioned (empty token) -- refusing to dispatch."
  exit 1
fi

WORK="$(mktemp -d)" || { echo "::error::autochain-read-enable: mktemp failed"; exit 1; }
trap 'rm -rf "$WORK"' EXIT

gh api "repos/${REPO}/actions/variables/BACKFILL_AUTOCHAIN_DISABLE" --jq .value >"$WORK/out" 2>"$WORK/err"
RC=$?
if [ "$RC" -ne 0 ]; then
  if grep -q 'HTTP 404' "$WORK/err"; then
    CAUSE="the variable BACKFILL_AUTOCHAIN_DISABLE does not exist (404); it must be set to 0 or 1 and is never deleted"
  elif grep -q 'HTTP 401' "$WORK/err"; then
    CAUSE="the token was rejected (401); BACKFILL_VARIABLE_READ_PAT is expired or revoked -- rotate it"
  elif grep -q 'HTTP 403' "$WORK/err"; then
    CAUSE="the token cannot read repo variables (403); BACKFILL_VARIABLE_READ_PAT needs Variables: read"
  else
    CAUSE="the API read failed (gh exit $RC)"
  fi
  echo "::error::autochain-read-enable: $CAUSE -- refusing to dispatch."
  exit 1
fi

# --verify-read (verify-only autochain runs): proves the PAT can READ the variable
# and that it holds a well-formed value ("0" or "1"). It never authorises a
# dispatch -- the dispatch step runs this script WITHOUT the flag.
if [ "$VERIFY_READ" -eq 1 ]; then
  VGOT="$(cat "$WORK/out"; printf x)"
  if [ "$VGOT" = "0"$'\n'"x" ] || [ "$VGOT" = "1"$'\n'"x" ]; then
    echo "verify-read: BACKFILL_AUTOCHAIN_DISABLE is readable with this PAT and well-formed (no dispatch authorised)."
    exit 0
  fi
  echo "::error::autochain-read-enable: BACKFILL_AUTOCHAIN_DISABLE is readable but not exactly \"0\" or \"1\" (malformed)."
  exit 1
fi

# Exact match: jq prints the raw string plus ONE newline; the sentinel `x`
# keeps trailing newlines/whitespace in the value from being stripped away.
GOT="$(cat "$WORK/out"; printf x)"
WANT="0"$'\n'"x"
if [ "$GOT" != "$WANT" ]; then
  echo "::error::autochain-read-enable: BACKFILL_AUTOCHAIN_DISABLE is not exactly \"0\" (autochain is disabled or the value is malformed) -- refusing to dispatch."
  exit 1
fi

echo "BACKFILL_AUTOCHAIN_DISABLE read back as exactly \"0\" -- autochain enabled."
exit 0
