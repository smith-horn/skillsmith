#!/usr/bin/env bash
# SMI-6949 - single source of truth for the production npm audit gate.
# Both pre-push CHECK 2 (scripts/pre-push-check.sh) and the CI `Security Audit`
# job (.github/workflows/ci.yml) call this file; neither spells the command.
# The flags below and the vulnerable-vs-could-not-run classification live here
# and NOWHERE ELSE. Callers keep their own policy for exit 11 (pre-push warns,
# CI fails); this helper only reports a classification.
#
# Usage: bash scripts/ci/npm-audit-gate.sh        (no arguments, no env knobs)
#   exit 0  CLEAN        npm exited 0
#   exit 10 VULNERABLE   npm exited non-zero AND printed a high/critical summary
#   exit 11 UNAVAILABLE  npm exited non-zero, no summary, and npm's own prefixed
#                        lines show a network/registry failure
#   exit 12 UNEXPECTED   any other non-zero npm exit (fail closed, visible)
# Codes avoid shell/grep/docker conventions (bash syntax error is 2, a missing
# docker container is 1); any code outside {0,10,11,12} means the helper itself
# broke and every caller must treat it as "not clean".
#
# Output: npm's combined stdout+stderr unchanged, then ONE final line on stdout:
#   npm-audit-gate: <CLEAN|VULNERABLE|UNAVAILABLE|UNEXPECTED> (npm exit <n>)
# The pre-push soft-pass reads that exact line; nothing else keys off the text.
#
# Compatibility: macOS /bin/bash 3.2 (the pre-push host fallback). No ${x,,},
# no mapfile, no associative arrays. ASCII only.
#
# Flags are constants, never overridable by env (an ambient env entry must not
# become policy). Each pin neutralises a MEASURED ambient-config path (SMI-6949
# Step 0):
#   --no-json --offline=false --prefer-offline=false   NPM_CONFIG_JSON/OFFLINE
#       gave a missing summary line / a false CLEAN "found 0 vulnerabilities"
#   --registry=https://registry.npmjs.org              redirected registry
#   --omit=dev --include=prod                          NPM_CONFIG_INCLUDE=dev
#       pulls dev advisories into the production gate (include beats omit)
#   --workspaces=true --include-workspace-root=true    restores the full root
#       graph: an ambient workspace= setting filtered the audit to a false CLEAN,
#       workspaces=true dropped the root, workspaces=false dropped the packages.
#       (--workspaces=false and --include-workspace-root=true alone were measured
#       and rejected; --workspaces=true fails closed with "No workspaces found"
#       on a tree that has none, which this repo's root does.)
#   --userconfig=/dev/null                             a user ~/.npmrc setting
#       workspace/offline/include/registry cannot reach the audit; a PROJECT
#       .npmrc workspace= has no flag that overrides it (it narrows, never
#       cleans, and the file is tracked)
# An ambient npm_config_workspace env var (any case) is unset below for the same
# reason: the singular `workspace` setting survives --workspaces=true.
set -euo pipefail

for AUDIT_GATE_VAR in $( (compgen -e | grep -iE '^npm_config_workspace$') || true ); do
  unset "$AUDIT_GATE_VAR"
done

# Guarded capture: under set -e a bare `x=$(npm audit ...)` with a non-zero npm
# exit would terminate this script before classification (MEASURED, SMI-6949).
if AUDIT_OUTPUT=$(npm audit --audit-level=high --omit=dev --include=prod \
  --no-json --offline=false --prefer-offline=false \
  --registry=https://registry.npmjs.org \
  --workspaces=true --include-workspace-root=true \
  --userconfig=/dev/null 2>&1); then
  NPM_STATUS=0
else
  NPM_STATUS=$?
fi

printf '%s\n' "$AUDIT_OUTPUT"

# Vulnerability test FIRST, then the network test, and the network test reads
# only npm's own prefixed lines: an advisory title can never be reclassified as
# "network unavailable" (SMI-6949 R-1).
if [ "$NPM_STATUS" -eq 0 ]; then
  CLASS=CLEAN
  CODE=0
elif printf '%s\n' "$AUDIT_OUTPUT" | grep -qE '^[0-9]+ (high|critical) severity vulnerabilit|^[0-9]+ vulnerabilities? \(.*[0-9]+ (high|critical)[,)]'; then
  CLASS=VULNERABLE
  CODE=10
elif printf '%s\n' "$AUDIT_OUTPUT" | grep -qiE '^npm (warn|error|ERR!) (.*(getaddrinfo|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|request to .* failed)|audit endpoint returned an error)'; then
  CLASS=UNAVAILABLE
  CODE=11
else
  CLASS=UNEXPECTED
  CODE=12
fi

printf 'npm-audit-gate: %s (npm exit %s)\n' "$CLASS" "$NPM_STATUS"
exit "$CODE"
