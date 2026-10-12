#!/usr/bin/env bash
# SMI-6949 - single source of truth for the production npm audit gate.
# Both pre-push CHECK 2 (scripts/pre-push-check.sh) and the CI `Security Audit`
# job (.github/workflows/ci.yml) call this file; neither spells the command.
# The flags below and the vulnerable-vs-could-not-run classification live here
# and NOWHERE ELSE. Callers keep their own policy for exit 11 (pre-push warns,
# CI fails); this helper only reports a classification.
#
# Usage: bash scripts/ci/npm-audit-gate.sh        (no arguments, no env knobs)
#   exit 0  CLEAN        npm exited 0 and printed no high/critical summary
#   exit 10 VULNERABLE   npm exited exactly 1 AND printed a high/critical summary
#   exit 11 UNAVAILABLE  npm exited exactly 1, no summary, and npm's own prefixed
#                        lines show a network/registry failure
#   exit 12 UNEXPECTED   anything else (fail closed, visible): npm exit 0 WITH a
#                        high/critical summary, any non-zero npm status other than
#                        1 (a killed npm is 137/143, never "network"), or a
#                        workspace list that could not be derived
# Codes avoid shell/grep/docker conventions (bash syntax error is 2, a missing
# docker container is 1); any code outside {0,10,11,12} means the helper itself
# broke and every caller must treat it as "not clean".
#
# Output: npm's combined stdout+stderr unchanged, then ONE final line on stdout:
#   npm-audit-gate: <CLEAN|VULNERABLE|UNAVAILABLE|UNEXPECTED> (npm exit <n>)
# The pre-push soft-pass reads that exact line; nothing else keys off the text.
#
# Compatibility: macOS /bin/bash 3.2 (the pre-push host fallback). No ${x,,},
# no mapfile, no associative arrays. ASCII only. Classification greps read the
# output through a here-string, never `printf | grep -q`: under pipefail the
# early-exiting grep SIGPIPEs the writer (141) on large output and the arm
# misclassifies (measured, SMI-6949 review round 1).
#
# Flags are constants, never overridable by env (an ambient env entry must not
# become policy). Each pin neutralises a MEASURED ambient-config path (SMI-6949
# Step 0 and review round 1):
#   --no-json --offline=false --prefer-offline=false   NPM_CONFIG_JSON/OFFLINE
#       gave a missing summary line / a false CLEAN "found 0 vulnerabilities"
#   --registry=https://registry.npmjs.org              redirected registry
#   --omit=dev --include=prod                          NPM_CONFIG_INCLUDE=dev
#       pulls dev advisories into the production gate (include beats omit)
#   --color=false                                      NPM_CONFIG_COLOR=always /
#       a project color=always wraps the severity word in ANSI codes, the
#       summary regex stops matching and a real advisory reads as UNEXPECTED
#   --workspaces=true --include-workspace-root=true    restores the full root
#       graph; --workspaces=true is NOT redundant with the explicit list below
#       (measured: an ambient workspaces=false with only the explicit list is an
#       npm error, with both it audits correctly)
#   --workspace=<dir> for EVERY workspace directory    a project .npmrc
#       workspace=a, a user/global config or NPM_CONFIG_WORKSPACE narrowed the
#       audit to workspace a only and a tree vulnerable only in workspace b
#       reported CLEAN (measured, high severity). A command-line array replaces
#       config-file values, so the explicit list defeats every config source.
#       The list is read from the root package.json `workspaces` globs below.
#   --userconfig=/dev/null                             a user ~/.npmrc setting
#       workspace/offline/include/registry cannot reach the audit
# An ambient npm_config_workspace / npm_config_globalconfig env var (any case) is
# unset below as well: belt and braces beside the explicit list.
set -euo pipefail

for AUDIT_GATE_VAR in $( (compgen -e | grep -iE '^npm_config_(workspace|globalconfig)$') || true ); do
  unset "$AUDIT_GATE_VAR"
done

# Workspace directories from ./package.json `workspaces` (array or {packages}).
# Supports `dir` and `dir/*` (one level, directories holding a package.json);
# any other glob syntax is refused rather than guessed (fail closed, exit 12).
# Prints one directory per line; prints nothing on stdout and exits 1 on refusal.
AUDIT_WS_JS='
const fs = require("fs");
const fail = (m) => { process.stderr.write("npm-audit-gate: cannot derive workspaces: " + m + "\n"); process.exit(1); };
let pkg;
try { pkg = JSON.parse(fs.readFileSync("package.json", "utf8")); } catch (e) { fail("package.json: " + e.message); }
const w = pkg.workspaces;
const patterns = Array.isArray(w) ? w : (w && Array.isArray(w.packages) ? w.packages : null);
if (!patterns || patterns.length === 0) fail("package.json declares no workspaces");
const has = (d) => { try { return fs.statSync(d + "/package.json").isFile(); } catch (e) { return false; } };
const dirs = [];
for (const raw of patterns) {
  if (typeof raw !== "string" || /[!{}()\[\]?]|\*\*/.test(raw)) fail("unsupported workspace pattern " + JSON.stringify(raw));
  const pat = raw.replace(/^\.\//, "").replace(/\/+$/, "");
  const star = pat.indexOf("*");
  if (star === -1) { if (has(pat)) dirs.push(pat); continue; }
  if (!pat.endsWith("/*") || pat.slice(0, -2).includes("*")) fail("unsupported workspace pattern " + JSON.stringify(raw));
  const base = pat.slice(0, -2);
  let names = [];
  try { names = fs.readdirSync(base); } catch (e) { names = []; }
  for (const n of names.sort()) if (n !== "node_modules" && has(base + "/" + n)) dirs.push(base + "/" + n);
}
const uniq = [...new Set(dirs)];
if (uniq.length === 0) fail("the workspace patterns match no directory with a package.json");
process.stdout.write(uniq.join("\n") + "\n");
'

AUDIT_WS_ARGS=()
if AUDIT_WS_LIST=$(node -e "$AUDIT_WS_JS"); then
  while IFS= read -r AUDIT_WS_DIR; do
    [ -n "$AUDIT_WS_DIR" ] && AUDIT_WS_ARGS+=("--workspace=$AUDIT_WS_DIR")
  done <<<"$AUDIT_WS_LIST"
else
  printf 'npm-audit-gate: UNEXPECTED (npm exit not-run)\n'
  exit 12
fi

# Guarded capture: under set -e a bare `x=$(npm audit ...)` with a non-zero npm
# exit would terminate this script before classification (MEASURED, SMI-6949).
if AUDIT_OUTPUT=$(npm audit --audit-level=high --omit=dev --include=prod \
  --no-json --offline=false --prefer-offline=false --color=false \
  --registry=https://registry.npmjs.org \
  --workspaces=true "${AUDIT_WS_ARGS[@]}" --include-workspace-root=true \
  --userconfig=/dev/null 2>&1); then
  NPM_STATUS=0
else
  NPM_STATUS=$?
fi

printf '%s\n' "$AUDIT_OUTPUT"

AUDIT_SUMMARY_RE='^[0-9]+ (high|critical) severity vulnerabilit|^[0-9]+ vulnerabilities? \(.*[0-9]+ (high|critical)[,)]'
AUDIT_NETWORK_RE='^npm (warn|error|ERR!) (.*(getaddrinfo|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|request to .* failed)|audit endpoint returned an error)'

# The summary test comes before every other arm, including CLEAN: npm exit 0
# with a high/critical summary contradicts itself and is never "clean". Only
# npm status exactly 1 may become VULNERABLE or UNAVAILABLE; a killed npm
# (137/143) or any other status is UNEXPECTED even with a network-looking line.
# The network test reads only npm's own prefixed lines: an advisory title can
# never be reclassified as "network unavailable" (SMI-6949 R-1).
if [ "$NPM_STATUS" -eq 0 ]; then
  if grep -qE "$AUDIT_SUMMARY_RE" <<<"$AUDIT_OUTPUT"; then
    CLASS=UNEXPECTED
    CODE=12
  else
    CLASS=CLEAN
    CODE=0
  fi
elif [ "$NPM_STATUS" -ne 1 ]; then
  CLASS=UNEXPECTED
  CODE=12
elif grep -qE "$AUDIT_SUMMARY_RE" <<<"$AUDIT_OUTPUT"; then
  CLASS=VULNERABLE
  CODE=10
elif grep -qiE "$AUDIT_NETWORK_RE" <<<"$AUDIT_OUTPUT"; then
  CLASS=UNAVAILABLE
  CODE=11
else
  CLASS=UNEXPECTED
  CODE=12
fi

printf 'npm-audit-gate: %s (npm exit %s)\n' "$CLASS" "$NPM_STATUS"
exit "$CODE"
