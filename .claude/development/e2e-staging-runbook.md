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
