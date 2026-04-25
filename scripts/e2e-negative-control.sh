#!/usr/bin/env bash
# scripts/e2e-negative-control.sh
#
# SMI-4460 — negative-control mode for device-login round-trip e2e.
#
# Reverts the named bug-fix in-job and asserts the matching failure mode.
# Used once per fix to prove the test catches the regression. Run via the
# workflow_dispatch input `negative_control: b1|b2|b3`.
#
# Modes:
#   b1 — relative URL bug: revert PR #757 in packages/website/src/pages/device.astro.
#        Replace the ${API_BASE}/functions/v1/auth-device-{preview,approve}
#        URLs with the original (broken) relative '/functions/v1/...' literals,
#        then `npm run build` so Astro re-emits the broken page.
#   b2 — claim_device_token PL/pgSQL ambiguity: shipped as migration 083; the
#        only way to reproduce in-CI without running un-applied migrations is
#        to apply 083_revert.sql against staging — too risky to automate.
#        This mode prints the manual repro step and exits 1 (tester runs it
#        out-of-band). The migration drift preflight in the workflow already
#        asserts the post-fix body via `\df+`, so a missing 083 fails preflight.
#   b3 — nonexistent post-login command in CLI hint: edit
#        packages/cli/src/commands/login.ts to print 'Try it: skillsmith skills'
#        instead of 'Try it: skillsmith search mcp', then `npm run build` so
#        the spawned dist contains the broken hint.
#
# Output: the test is then expected to FAIL. The workflow's `negative-control`
# branch inverts the exit semantics: a passing test in negative-control mode is
# itself a failure (the test isn't catching what it claims).

set -eu

mode="${1:-}"
case "$mode" in
  b1)
    echo "[SMI-4460 neg-ctrl] b1 — reverting auth-device-preview/approve URLs to relative"
    sed -i.bak \
      -e "s|\\\${API_BASE}/functions/v1/auth-device-approve|/functions/v1/auth-device-approve|g" \
      -e "s|\\\${API_BASE}/functions/v1/auth-device-preview|/functions/v1/auth-device-preview|g" \
      packages/website/src/pages/device.astro
    rm -f packages/website/src/pages/device.astro.bak
    echo "[SMI-4460 neg-ctrl] b1 patch applied — rebuilding website"
    npm run build -w @skillsmith/website
    ;;
  b2)
    echo "[SMI-4460 neg-ctrl] b2 — claim_device_token ambiguity reproduction is migration-level."
    echo "[SMI-4460 neg-ctrl] To reproduce, apply scripts/sql/revert-migration-083.sql"
    echo "[SMI-4460 neg-ctrl] against staging via pooler-psql.sh, run the spec, then re-apply 083."
    echo "[SMI-4460 neg-ctrl] Out-of-band only — not automated to keep CI runners hands-off DDL."
    exit 1
    ;;
  b3)
    echo "[SMI-4460 neg-ctrl] b3 — replacing post-login hint with a nonexistent subcommand"
    sed -i.bak \
      -e "s|Try it: skillsmith search mcp|Try it: skillsmith skills list|g" \
      packages/cli/src/commands/login.ts
    rm -f packages/cli/src/commands/login.ts.bak
    echo "[SMI-4460 neg-ctrl] b3 patch applied — rebuilding cli"
    npm run build -w @skillsmith/cli
    ;;
  none|"")
    echo "[SMI-4460 neg-ctrl] no negative-control mode requested — skipping"
    exit 0
    ;;
  *)
    echo "[SMI-4460 neg-ctrl] unknown mode '$mode' (expected: none|b1|b2|b3)" >&2
    exit 2
    ;;
esac
