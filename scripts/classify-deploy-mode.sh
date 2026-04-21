#!/usr/bin/env bash
# Classifies edge-function deploy scope by diffing HEAD~1..HEAD.
# Prints two lines to stdout (consumed by deploy-edge-functions.yml via
# `./scripts/classify-deploy-mode.sh >> "$GITHUB_OUTPUT"`):
#   mode=<all|changed|none>
#   functions=<comma-separated|empty>
#
# Priority order (MUST be preserved — prior layout silently partial-deployed
# mixed-scope PRs because _shared/ was a fallback, not a first-class branch):
#   1. _shared/ changed → mode=all  (fan out: shared code affects every caller)
#   2. specific fns     → mode=changed
#   3. nothing          → mode=none
set -euo pipefail

# Guard against non-squash merges. Branch protection enforces squash today,
# but drift is silent: a true merge commit has multiple parents, HEAD~1 picks
# one arbitrarily, and cross-lineage file changes fall off the detection radar.
parent_count=$(git log --pretty=%P -1 HEAD | wc -w | tr -d '[:space:]')
if [ "$parent_count" -gt 1 ]; then
  echo "::warning::Non-squash merge detected at HEAD ($parent_count parents); detection may be incomplete" >&2
fi

# Priority 1: _shared/ → full fanout
if git diff --name-only HEAD~1 HEAD -- 'supabase/functions/_shared/' | grep -q .; then
  echo "mode=all"
  echo "functions="
  echo "_shared/ changed — deploying ALL functions" >&2
  exit 0
fi

# Priority 2: specific fns changed. Priority 1 already ruled out _shared/, so
# the sed pipeline cannot emit '_shared' — no grep -v filter needed.
CHANGED=$(git diff --name-only HEAD~1 HEAD -- 'supabase/functions/' \
  | sed -n 's|supabase/functions/\([^/]*\)/.*|\1|p' \
  | sort -u \
  | paste -sd ',' -)
if [ -n "$CHANGED" ]; then
  echo "mode=changed"
  echo "functions=$CHANGED"
  echo "Changed functions: $CHANGED" >&2
  exit 0
fi

# Priority 3: nothing to deploy
echo "mode=none"
echo "functions="
echo "No function changes detected" >&2
