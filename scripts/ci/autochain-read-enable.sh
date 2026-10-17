#!/usr/bin/env bash
# SMI-7112 (R3-1) / SMI-7121 (G2): the autochain's authoritative pre-dispatch read.
#
# Two reads, in this order, by ONE command so both stay immediately before
# `gh workflow run` with nothing between them and the dispatch:
#   1. BACKFILL_AUTOCHAIN_DISABLE must read back EXACTLY "0" (enabled).
#   2. BACKFILL_KILL_SWITCH must NOT read back "1" (engaged).
# Exit 0 ONLY when both pass. Every other outcome exits 1 with an ::error:: naming the
# cause, so the caller's job goes red and no dispatch happens:
#   disable: "1" disabled; "" / " 0" / anything else malformed; 404 missing (it is never
#            deleted); 403 token lacks Variables: read; 401 PAT expired/revoked; any
#            other gh failure (network, 5xx, rate limit)
#   kill switch: "1" engaged; 403 / 401 / any other gh failure. A 404 means the variable
#            is UNSET, which is not engaged: the same PAT has just read the first
#            variable of this repo, so a 404 here cannot be a hidden access failure, and
#            indexer-backfill.yml itself treats only "1" as engaged.
#
# The `vars` context is NOT used as a re-read: it cannot tell "enabled" from
# "unreadable". Credential: ONLY the fine-grained PAT secret
# BACKFILL_VARIABLE_READ_PAT (Variables: read, this repo only), passed in as
# GH_TOKEN by the caller. GITHUB_TOKEN and the GitHub App cannot read variables
# (measured, W0-7). A missing/expired PAT therefore fails closed.
#
# `--verify-read` (verify-only autochain runs) exits 0 when the PAT can read
# BACKFILL_AUTOCHAIN_DISABLE and it is exactly "0" or "1", and BACKFILL_KILL_SWITCH is
# readable (or unset); it reports both and never authorises a dispatch.
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

# read_var NAME -> sets RC and GOT (raw value plus the sentinel `x`, so trailing
# newlines/whitespace in the value survive command substitution); the stderr of a
# failed read is left in $WORK/err.
read_var() {
  gh api "repos/${REPO}/actions/variables/$1" --jq .value >"$WORK/out" 2>"$WORK/err"
  RC=$?
  GOT="$(cat "$WORK/out"; printf x)"
}

# cause_of NAME -> the classified reason for a failed read (404 handled by the caller).
cause_of() {
  if grep -q 'HTTP 401' "$WORK/err"; then
    echo "the token was rejected reading $1 (401); BACKFILL_VARIABLE_READ_PAT is expired or revoked -- rotate it"
  elif grep -q 'HTTP 403' "$WORK/err"; then
    echo "the token cannot read $1 (403); BACKFILL_VARIABLE_READ_PAT needs Variables: read"
  else
    echo "the API read of $1 failed (gh exit $RC)"
  fi
}

# 1. BACKFILL_AUTOCHAIN_DISABLE
read_var BACKFILL_AUTOCHAIN_DISABLE
if [ "$RC" -ne 0 ]; then
  if grep -q 'HTTP 404' "$WORK/err"; then
    CAUSE="the variable BACKFILL_AUTOCHAIN_DISABLE does not exist (404); it must be set to 0 or 1 and is never deleted"
  else
    CAUSE="$(cause_of BACKFILL_AUTOCHAIN_DISABLE)"
  fi
  echo "::error::autochain-read-enable: $CAUSE -- refusing to dispatch."
  exit 1
fi
DISABLE_GOT="$GOT"

# 2. BACKFILL_KILL_SWITCH (only reached after read 1 proved this PAT can read this repo)
read_var BACKFILL_KILL_SWITCH
if [ "$RC" -ne 0 ]; then
  if grep -q 'HTTP 404' "$WORK/err"; then
    KILL_STATE="unset"
  else
    echo "::error::autochain-read-enable: $(cause_of BACKFILL_KILL_SWITCH) -- refusing to dispatch."
    exit 1
  fi
elif [ "$GOT" = "1"$'\n'"x" ]; then
  KILL_STATE="engaged"
else
  KILL_STATE="not engaged"
fi

# --verify-read: proves both reads work and the enable value is well formed. It never
# authorises a dispatch -- the dispatch step runs this script WITHOUT the flag.
if [ "$VERIFY_READ" -eq 1 ]; then
  if [ "$DISABLE_GOT" = "0"$'\n'"x" ] || [ "$DISABLE_GOT" = "1"$'\n'"x" ]; then
    echo "verify-read: BACKFILL_AUTOCHAIN_DISABLE is readable with this PAT and well-formed; BACKFILL_KILL_SWITCH is $KILL_STATE (no dispatch authorised)."
    exit 0
  fi
  echo "::error::autochain-read-enable: BACKFILL_AUTOCHAIN_DISABLE is readable but not exactly \"0\" or \"1\" (malformed)."
  exit 1
fi

# Exact match: jq prints the raw string plus ONE newline.
if [ "$DISABLE_GOT" != "0"$'\n'"x" ]; then
  echo "::error::autochain-read-enable: BACKFILL_AUTOCHAIN_DISABLE is not exactly \"0\" (autochain is disabled or the value is malformed) -- refusing to dispatch."
  exit 1
fi
if [ "$KILL_STATE" = "engaged" ]; then
  echo "::error::autochain-read-enable: BACKFILL_KILL_SWITCH is \"1\" (engaged) -- refusing to dispatch."
  exit 1
fi

echo "BACKFILL_AUTOCHAIN_DISABLE read back as exactly \"0\" and BACKFILL_KILL_SWITCH is $KILL_STATE -- autochain enabled."
exit 0
