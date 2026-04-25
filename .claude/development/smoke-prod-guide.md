# Smoke-prod harness — operator guide

Post-deploy smoke harness for verifying user-facing surfaces against real
prod after a merge. Implements layer 4 of the SMI-4454 trifecta gate stack
(R-1/R-2/R-3 are static-analysis backstops; R-4/runtime smoke is here).

Plan: `docs/internal/implementation/smi-4459-smoke-prod-harness.md`
Linear: SMI-4459

## What it does

After every merge to main, the workflow `.github/workflows/smoke-prod.yml`
runs `scripts/smoke-prod.sh` against real prod URLs. Each surface declared
in `scripts/smoke-prod/surfaces.json` whose `trigger_globs` match a changed
file is exercised end-to-end. Always-on canaries (e.g. `health`) run on
every PR's pre-ship CI gate plus every post-deploy run.

Total budget: 60s. Per-call HTTP timeout: 10s. Retry policy: single retry
with 2s backoff per call. Exit codes: `0` ok, `1` fail, `2` skipped.

## Surfaces covered

| ID | What it checks | Trigger |
|----|----------------|---------|
| `health` | `GET $SUPABASE_URL/functions/v1/health` returns 200 | always-on canary |
| `website-device-page` | `GET https://www.skillsmith.app/device` returns 200 + contains `data-smoke="device-input"` | `packages/website/src/pages/device.astro` change |
| `edge-fn-auth-device` | `auth-device-code` POST → 200/400 (NOT 404); `auth-device-preview` GET (no JWT) → 401 | `supabase/functions/auth-device-{code,preview,approve,token}/**` change |
| `cli-published` | `npx -y @skillsmith/cli@latest --help` exits 0 with a `Commands:` section; `--version` exits 0 | `packages/cli/**` change |
| `mcp-server-published` | `npx -y @skillsmith/mcp-server@latest --version` exits 0 | `packages/mcp-server/**` change |

## Adding a new surface

1. Pick a stable assertion target. For Astro pages, prefer
   `data-smoke="<id>"` HTML attributes — class names hash per build.
2. Append an entry to `scripts/smoke-prod/surfaces.json`:

   ```json
   {
     "id": "my-new-surface",
     "owner": "team-name",
     "trigger_globs": ["packages/website/src/pages/my-page.astro"],
     "script": "scripts/smoke-prod/website.sh",
     "checks": ["check_my_new_surface"]
   }
   ```

3. Add the check function to the referenced script. Convention:

   ```bash
   check_my_new_surface() {
     local url="${SMOKE_WEBSITE_URL}/my-page"
     local t0 status
     t0=$(now_ms)
     status=$(with_retry http_status GET "$url")
     if [ "$status" = "200" ]; then
       report_pass "my-new-surface" "check_my_new_surface" "$url" "$(($(now_ms) - t0))"
       return 0
     fi
     report_fail "my-new-surface" "check_my_new_surface" "$url" "200" "$status" "$(($(now_ms) - t0))"
     return 1
   }
   ```

4. Verify locally:

   ```bash
   varlock run -- ./scripts/smoke-prod.sh --surface=my-new-surface
   ```

5. The `audit:standards` Section 34 (R-4) will warn if a new edge function
   or website page lands without a corresponding entry. To intentionally
   omit, add the path to `scripts/smoke-prod/.surfaces-allowlist.txt`.

## Testing locally

```bash
# Dry-run — show which surfaces would fire for a synthetic file change.
SMOKE_CHANGED_FILES="packages/website/src/pages/device.astro" \
  ./scripts/smoke-prod.sh --dry-run --json

# Real canary against prod (~1s).
varlock run -- ./scripts/smoke-prod.sh --surface=health

# Full smoke against prod for the current HEAD vs HEAD~1.
varlock run -- ./scripts/smoke-prod.sh --since=HEAD~1 --json
```

## Failure triage

When the workflow fails it:

1. Opens (or comments on) a Linear-tracking GitHub issue titled
   `Smoke-prod failure on <short-sha>` labelled `ci-failure`,`smoke-failure`.
2. Posts an email to `support@smithhorn.ca` via the `alert-notify` edge
   function, describing the failed surfaces + URLs + status codes.

Triage steps:

1. **Open the run**: download the `smoke-report` artifact (JSON).
2. **Reproduce locally**: `varlock run -- ./scripts/smoke-prod.sh --surface=<id>`.
3. **Classify**:
   - HTTP 000 / curl error → transient blip; re-run via `gh workflow run smoke-prod.yml`.
   - HTTP wrong-status / body-fingerprint missing → real regression; revert
     or hotfix.
   - Assertion is wrong (smoke-harness bug) → fix the check function;
     deploy is fine.

## Skipping smoke for a PR

Add `[skip-smoke]` to the PR body OR the merge commit message. The smoke
workflow scans both. Use sparingly — docs-only PRs don't trigger most
surfaces anyway (changed-file globbing skips them).

## Manual setup steps

The workflow needs three GitHub Actions secrets, all already present in
the repo for adjacent jobs:

- `SUPABASE_URL` — used by the `smoke` job for read-only HTTP checks.
- `SUPABASE_ANON_KEY` — currently unused but reserved for future
  authenticated smoke (e.g., low-quota anon-key endpoint).
- `SUPABASE_SERVICE_ROLE_KEY` — used by the `alert` job ONLY (separate
  job for secret scoping; service-role key never enters the smoke job).

To enable Vercel-deploy-completion triggering, configure a Vercel deploy
hook that POSTs to GitHub `repository_dispatch` with `event_type:
vercel-prod-deployed`. See `vercel-deploy-hook.md` for the runbook.

## Phase rollout

- **Phase 1 (week 1)**: warning-only. Workflow runs, files Linear issue
  on failure, but does NOT post a commit status. Goal: collect 1 week of
  false-positive data before going load-bearing.
- **Phase 2 (week 2-3)**: posts `success`/`failure` commit status to the
  merge SHA so it surfaces visibly on the GitHub UI. No branch protection
  change (smoke runs after merge).
- **Phase 3 (later)**: pre-merge variant against staging. Tracked
  separately under a follow-up SMI per plan-review Q6.

## Telemetry

Every smoke run writes to `audit_logs` with `event_type='smoke:run'` (this
hook will be wired in a Phase 2 follow-up; current Phase 1 implementation
relies on the GitHub Actions run history).

The weekly `ops-report` cron will summarize catch rate vs. false-positive
rate after 4 weeks of data. Targets:

- Catch rate (smoke failure followed by a bugfix PR within 24h): > 0
  (zero means the harness scope is too shallow).
- False-positive rate (smoke failure closed as transient/no-fix): < 10%.
