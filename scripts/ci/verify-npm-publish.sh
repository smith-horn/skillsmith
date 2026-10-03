#!/usr/bin/env bash
# SMI-6497 - single source of truth for "is this version live on npmjs?".
# Policy rationale (budget, the four flags, the final probe): keep the SMI-6493
# comment block here and NOWHERE ELSE. Callers pass package + version only.
#
# Usage: bash scripts/ci/verify-npm-publish.sh <package> <version>
#   exit 0 - the version is live on npmjs (in-loop hit, or final-probe rescue)
#   exit 1 - not live after the full budget; an ::error:: line is emitted first
#
# ASCII only (SMI-6497 D-5). The three pre-extraction copies emitted U+2713,
# U+2026 and U+2014; the fourth emitted OK / ... / -. Nothing consumes the text
# (SMI-6497 M-5), so one spelling wins and it is the ASCII one.
#
# Invoked as `bash scripts/ci/...`, so it does NOT inherit -e from the calling
# step and must set its own flags. -u turns a MISSING argument into a loud
# failure; it does not catch an EMPTY one (SMI-6655 / SMI-6497 FT-5, preserved
# here deliberately - see SMI-6497 D-4).
set -euo pipefail

PKG="$1"
VERSION="$2"

# SMI-6493: npm's publish-time malware scan makes a new version
# take "typically around five minutes" to become available, and npm
# tells automation to tolerate that delay. The old 5 x 6s = 30s budget
# red-failed two successful publishes (runs 33994465930, 34393376220).
# Budget: 30 x 10s ~= 300s, fixed interval. `npm view` sets preferOnline
# internally (npm/cli v11.9.0 lib/commands/view.js) but does NOT clear
# `offline` or `preferOffline`, and npm's fetch layer checks those two
# FIRST -- which is why every probe below pins them explicitly. Do not
# remove those flags: doing so restores a confirmed false-red under
# NPM_CONFIG_OFFLINE=true on a cold runner cache.
#
# Both constants are assigned UNCONDITIONALLY and must never take an ambient
# default. Under `:-` defaulting, any workflow-, job- or step-level `env:`
# entry naming either variable silently becomes the publish retry policy, and
# the failure that produces is a red job on a publish that already succeeded --
# precisely the outcome this budget exists to prevent. Tests get their speed
# from stubbing `sleep`, not from overriding these.
VERIFY_MAX_ATTEMPTS=30
VERIFY_INTERVAL=10

for attempt in $(seq 1 "$VERIFY_MAX_ATTEMPTS"); do
  LIVE=$(npm view "${PKG}@${VERSION}" version --no-json --offline=false --prefer-offline=false --registry=https://registry.npmjs.org 2>/dev/null || echo '')
  if [ "$LIVE" = "$VERSION" ]; then
    echo "OK ${PKG}@${VERSION} verified live on npm (attempt ${attempt})"
    exit 0
  fi
  echo "... ${PKG}@${VERSION} not yet visible (attempt ${attempt}/${VERIFY_MAX_ATTEMPTS}); waiting ${VERIFY_INTERVAL}s"
  sleep "$VERIFY_INTERVAL"
done
# Four flags pin THIS `npm view` PROBE's own registry lookup against
# environment config that would otherwise false-negative a live package
# (see the flag-by-flag rationale below). This does NOT guarantee which
# registry `npm publish` actually used: npm resolves a scoped
# `@skillsmith:registry` override (package-level or npm-config-level)
# BEFORE the global --registry/registry setting is ever consulted, and
# the `npm publish` commands in publish.yml carry no --registry flag at
# all. Asserting the actual effective registry pre-publish is SMI-6511's
# scope, not this probe's.
#   --no-json               JSON output prints "1.2.3" WITH quotes, so the
#                           exact-equality test never matches.
#   --offline=false         `offline` selects only-if-cached; on a cold
#                           runner cache every probe fails without ever
#                           reaching npmjs.
#   --prefer-offline=false  `prefer-offline` selects force-cache, which can
#                           serve a packument predating the publish through
#                           all 31 probes.
#   --registry=...npmjs.org Without it, a redirected NPM_CONFIG_REGISTRY is
#                           honoured by BOTH the publish and this probe, so
#                           they agree with each other and the run goes green
#                           while npmjs never received the release. Pinning
#                           the intended destination is what makes this step
#                           evidence about npmjs specifically.
# `view.js` sets preferOnline internally but does NOT clear offline or
# preferOffline, and npm's fetch layer checks those two first.
# Final authoritative probe. The version can become visible during the last
# interval, so consume that probe instead of discarding it. stderr is
# deliberately NOT redirected here: it flows straight to the step log, so a
# registry outage, DNS failure or auth error is visible, while $FINAL captures
# stdout only. No temp file, no redirection target, nothing that can fail and
# abort the step before the probe runs.
echo "Final probe for ${PKG}@${VERSION} - any npm output follows:"
FINAL=$(npm view "${PKG}@${VERSION}" version --no-json --offline=false --prefer-offline=false --registry=https://registry.npmjs.org) || true
if [ "$FINAL" = "$VERSION" ]; then
  echo "OK ${PKG}@${VERSION} verified live on npm (final probe)"
  exit 0
fi
echo "Final probe stdout was: ${FINAL:-<empty>}"
echo "::error::${PKG}@${VERSION} is not live on npm after ${VERIFY_MAX_ATTEMPTS} attempts over $((VERIFY_MAX_ATTEMPTS * VERIFY_INTERVAL))s - failing the job."
exit 1
