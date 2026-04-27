# E2E Staging Secrets — `device-login-roundtrip` Workflow

SMI-4460 — secret rotation runbook + Docker-policy carve-out justification for
the `Device Login Round-Trip E2E` workflow
(`.github/workflows/device-login-roundtrip.yml`).

## Why this workflow holds a Supabase service-role key

Existing service-role keys in CI live only in backend cron jobs (`indexer.yml`,
`ops-report.yml`, `expire-complimentary.yml`). This is the **first test
workflow** in the repo to hold one. It is required because:

- The spec asserts on `device_codes` rows (RLS = `auth.role() = 'service_role'`
  per migration 081 line 74) — the test reads them via service-role to confirm
  `consumed_at IS NOT NULL` post-claim.
- The spec asserts on `audit_logs` rows (also service-role for cross-user reads).
- The seed script (`scripts/seed-e2e-device-login-user.ts`) uses
  `auth.admin.createUser` + `profiles` upsert — both require service-role.

## Required secrets (GitHub Environment `e2e-staging`)

All scoped to the `e2e-staging` environment. Other workflows cannot read them.

| Secret | Source | Purpose |
|---|---|---|
| `STAGING_SUPABASE_URL` | Supabase project page (staging) | `https://ovhcifugwqnzoebwfuku.supabase.co` |
| `STAGING_SUPABASE_ANON_KEY` | Supabase project API settings (staging) | Page-side supabase-js init + sign-in |
| `STAGING_SUPABASE_SERVICE_ROLE_KEY` | Supabase project API settings (staging) | Test reads of `device_codes` / `audit_logs` + seed |
| `STAGING_DB_PASSWORD` | Supabase project Database settings (staging) | `psql` for migration drift preflight + defensive cleanup |
| `E2E_TEST_USER_PASSWORD` | Generate via `openssl rand -base64 32` | Sign-in for the dedicated test user |
| `E2E_TEST_USER_ID` | Output of `seed-e2e-device-login-user.ts --emit-id` | Asserted by spec to confirm correct user claimed the code |
| `VERCEL_TOKEN` | <https://vercel.com/account/tokens> ("skillsmith-e2e-staging") | `vercel pull` + `vercel build` + `vercel dev` auth (SMI-4508) |
| `VERCEL_ORG_ID` | `team_ClhT43du6FnDx4SUW4JB7lcS` (`packages/website/.vercel/project.json`) | Tells `vercel pull` which team to scope to |
| `VERCEL_PROJECT_ID` | `prj_NJbrm61yTXjo4IJPXDHqAg7XFCCd` (`packages/website/.vercel/project.json`) | Tells `vercel pull` which project to bind |

## One-time setup

1. Create the GitHub Environment `e2e-staging` in Settings → Environments.
   Do not enable required reviewers (CI-only workflow).
2. Add each secret above (no environment-level deployment branch policy needed).
3. Locally, run the seed once to provision the test user and capture the user_id:

   ```bash
   varlock run -- env \
     STAGING_SUPABASE_URL="https://ovhcifugwqnzoebwfuku.supabase.co" \
     STAGING_SUPABASE_SERVICE_ROLE_KEY="<staging service role>" \
     E2E_TEST_USER_PASSWORD="<32-char random>" \
     npx tsx scripts/seed-e2e-device-login-user.ts --emit-id
   ```

   Store the printed UUID as the `E2E_TEST_USER_ID` secret.
4. Verify by manually triggering the workflow:
   `gh workflow run device-login-roundtrip.yml -f negative_control=none`.

## Rotation cadence

90 days, aligned with the existing PAT rotation policy
(`VSCE_PAT`, GitHub fine-grained tokens). Rotate by:

1. Supabase: regenerate `service_role` and `anon` keys, regenerate the database
   password.
2. Update each secret in the `e2e-staging` GitHub Environment.
3. Trigger the workflow once to confirm green:
   `gh workflow run device-login-roundtrip.yml`.

## Defensive controls (in workflow YAML)

- `permissions: contents: read` only — no `actions: write`, no
  `pull-requests: write`.
- No `set -x` or `echo` of secret-bearing commands. GitHub Actions log masking
  redacts the keys themselves but env vars in `set -x` traces can still leak
  surface (e.g. URL host paths). Never trace.
- Artifact upload allowlist: `playwright-report/`, `test-results/cli-*.log`,
  `test-results/preview.log`. Never `*.env`, never the bare `test-results/**`
  glob.
- Prod-ref grep gate: workflow refuses to run if
  `vrcnzpmndtroqxxoqkzy` appears anywhere in the test surface.
- Migration drift preflight: refuses to run if the staging
  `claim_device_token` body still has the B2 ambiguity (the post-fix uses
  `dc.user_id`).

## Docker-policy carve-out

CLAUDE.md mandates "all code execution MUST happen in Docker", but this
workflow runs on `ubuntu-latest` outside the dev container.

Carve-out justified because:

1. **No native modules in the spec surface.** Playwright + Astro preview +
   supabase-js are all pure JS. None of `better-sqlite3` / `onnxruntime-node`
   are imported by the helpers, the spec, the seed script, or the CLI's
   device-login code path.
2. **Docker would add ~6 min wallclock** per run for zero correctness benefit
   (the native-module compilation chain is bypassed entirely).
3. **Precedent**: `vscode-extension` (ADR-113) carves out from Docker on the
   same grounds.

If a future change adds a native-module import (e.g. CLI `search` command
imports `better-sqlite3`), the carve-out invalidates and the workflow MUST
migrate into Docker.

## Failure routing

- PR runs: workflow comment on the PR with the failure summary
  (`continue-on-error: true` until Phase 3 promotion — see plan §Wave 5).
- Nightly runs: auto-create a Linear issue under SMI-4460's parent project
  with the failure fingerprint. Dedup by error fingerprint matches
  `e2e-tests.yml` pattern.

## Cleanup cron

`device-login-roundtrip-cleanup.yml` runs Sundays 04:00 UTC and deletes
`audit_logs` rows older than 7 days for the test user. Without it, the
test user dominates the staging audit-event distribution after ~6 months.

## Vercel runtime (SMI-4508)

The workflow runs `vercel build` + `vercel dev` instead of a static
`http-server` so SSR-only pages (`device.astro`, `login.astro`,
`signup.astro`, `complete-profile.astro`, `pricing.astro`,
`return-to-cli.astro`, `check-email.astro`) render correctly. http-server
returned 404 for `/device` (SSR handler emitted to `dist/server/`, not
`dist/client/`), causing the round-trip to fail with a 15s
`#state-preview` locator timeout — even though every other layer of the
test was healthy. See plan: SMI-4508 (Vercel CLI runtime).

### Why not `astro preview`

`packages/website/astro.config.mjs` sets `adapter: vercel()`. Astro's
preview server expects routing through `.vercel/output/`; with the
default `output: 'static'` layout the build splits into
`dist/client/` (static) + `dist/server/` (SSR handler), and `astro
preview` 404s every request. PR #799 run 24969528005 captured the
diagnostic. `vercel dev` reads from `.vercel/output/` directly and
runs the same edge runtime as prod, giving us prod-parity SSR locally.

### Required secrets

`VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` (see table above).
The token must be scoped read + deploy for the
`team_ClhT43du6FnDx4SUW4JB7lcS` team — narrower scopes (read-only,
project-only) reject `vercel build`'s upload phase.

### Token rotation cadence

90 days, aligned with the `VSCE_PAT` / fine-grained-PAT pattern.
Rotate by:

1. Visit <https://vercel.com/account/tokens>, generate a fresh token
   named `skillsmith-e2e-staging-YYYYMM`.
2. Update `VERCEL_TOKEN` in the `e2e-staging` GitHub Environment.
3. Trigger the workflow:
   `gh workflow run device-login-roundtrip.yml`. Confirm the
   "Vercel link + build website" step exits 0.
4. Revoke the prior token in the Vercel UI.

`VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` are not secret in the
cryptographic sense (visible in `packages/website/.vercel/project.json`
locally) but kept in the environment for parity with `VERCEL_TOKEN`.
They only rotate if the team or project ID changes.

### Cache strategy

The workflow caches `~/.vercel/cache/` keyed on the website source
hash + `vercel.json`. Warm hits save ~20s/run on `vercel build`. The
global `vercel` binary (installed via `npm install -g vercel@latest`)
is intentionally not cached — it's small (~50 MB) and pinning to
`@latest` keeps us aligned with current edge runtime fixes.

### Failure-mode runbook

| Symptom | Likely cause | Fix |
|---|---|---|
| `Error: Vercel CLI v… requires authentication` | `VERCEL_TOKEN` missing or expired | Re-add or rotate the token (see above) |
| `No Project Settings found locally` after `vercel pull` | `VERCEL_ORG_ID` or `VERCEL_PROJECT_ID` mismatch, or token doesn't have access to the team | Verify env vars against `packages/website/.vercel/project.json` locally; ensure the token's account is a member of the team |
| `vercel build` exits with `module not found` for an Astro integration | Astro deps drift between `package.json` and Vercel's expected version | Run `npm install` in `packages/website/` locally and commit the lockfile delta |
| `wait-on http://127.0.0.1:4321/ -t 90000` timeout | `vercel dev` cold-start exceeded 90s | Check `test-results/preview.log` artifact for `Ready! Available at …`; if startup is consistently > 90s, raise the timeout |
| `Content-Security-Policy` blocks `connect-src` to staging Supabase | `vercel.json` CSP regression | `grep connect-src packages/website/vercel.json` should include `*.supabase.co`; if missing, restore it (P-1 surface check) |
| 4xx/5xx from `/device?user_code=…` in `preview.log` | Staging supabase down or migration drift | Check `audit_logs` via pooler-psql; verify `claim_device_token` body (drift preflight should have already failed) |
