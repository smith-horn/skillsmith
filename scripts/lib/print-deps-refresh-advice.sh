#!/bin/sh
# scripts/lib/print-deps-refresh-advice.sh
# SMI-6606 / SMI-6614 (ADR-158): the ONE shared, ordered refresh sequence
# printed by every consumer that needs a human to run a real dependency
# refresh — the deps-freshness guard's blocking check mode
# (check-node-modules-fresh.sh), .husky/post-merge, and .husky/post-checkout.
#
# Output-only — never runs docker/git/npm itself, so every consumer prints
# IDENTICAL text and the three can't drift apart from one another
# (scripts/tests/post-checkout-worktree-guard.test.ts case (d) already pins
# post-checkout vs post-merge parity; scripts/tests/print-deps-refresh-advice.test.ts
# pins this file directly).
#
# Usage: print-deps-refresh-advice.sh <main-checkout-path>
#
# Never prints a bare `npm install` or a bare `docker compose --profile dev
# up -d` (SMI-4298) — every step below names the SCRIPT that does the actual
# work, not the underlying npm/docker primitive, so nobody copy-pastes the
# unattended-install trap this plan exists to remove. The container recreate
# in step 0 deliberately keeps `--force-recreate dev`, matching CLAUDE.md's
# own SMI-4298-safe form.
#
# POSIX sh — no `local`, no `[[ ]]`, no arrays.

MAIN="${1:?usage: print-deps-refresh-advice.sh <main-checkout-path>}"

printf '  0. Confirm the main container'\''s own mounts (root + every packages/*/node_modules, round-2b):\n'
printf '       docker exec -w /app skillsmith-dev-1 sh scripts/lib/node-modules-mount-gate.sh\n'
printf '     If that fails, recreate it first (this restarts both MCP servers\n'
printf '     for every session), then re-check:\n'
printf '       ( cd "%s" && docker compose --profile dev up -d --force-recreate dev )\n' "$MAIN"
printf '     ./scripts/regen-lockfile.sh (step 3 below) enforces this same check itself.\n'
printf '\n'
printf '  1. Stop any running WORKTREE containers first (never skillsmith-dev-1):\n'
printf "       docker ps --format '{{.Names}}' | grep -- '-dev-1\$' | grep -vx 'skillsmith-dev-1'\n"
printf '     Stop each one listed, from its own worktree.\n'
printf '\n'
printf '  2. Clear SMI-6034'\''s deny-delete ACLs (run from the MAIN checkout — see\n'
printf '     CLAUDE.md'\''s SMI-6034 troubleshooting row for the full chmod -N recipe).\n'
printf '\n'
printf '  3. Regenerate the lockfile + sync node_modules + heal native modules:\n'
printf '       ( cd "%s" && ./scripts/regen-lockfile.sh )\n' "$MAIN"
printf '\n'
printf '  4. Recreate the Tier-B mount sources a host install just pruned (SMI-6546):\n'
printf '       ( cd "%s" && ./scripts/repair-worktrees.sh )\n' "$MAIN"
printf '\n'
printf '  5. Restart each worktree container you stopped in step 1:\n'
printf '       ./scripts/worktree-docker.sh start   # from that worktree\n'
printf '\n'
printf '  6. Re-run the freshness check — expect exit 0:\n'
printf '       sh scripts/lib/check-node-modules-fresh.sh\n'
printf '\n'
printf '  Scripted, locked version tracked in SMI-6627.\n'
