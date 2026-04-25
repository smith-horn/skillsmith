# Vercel deploy hook → smoke-prod trigger

The smoke-prod workflow (`.github/workflows/smoke-prod.yml`) needs to fire
after Vercel finishes deploying the website. Vercel's webhook surface does
not natively trigger GitHub workflows, so we route through GitHub's
`repository_dispatch` API.

Plan: `docs/internal/implementation/smi-4459-smoke-prod-harness.md` § Q1
Linear: SMI-4459

## One-time setup

Two pieces, both manual:

### 1. GitHub fine-grained PAT for `repository_dispatch`

- Create a fine-grained PAT scoped to the `smith-horn/skillsmith`
  repository with **only** `Contents: read-only`, `Metadata: read-only`,
  and `Actions: read-and-write`. Expire after 90 days.
- Store the value in `gh secret set VERCEL_DEPLOY_HOOK_TOKEN` so the
  hook (whether a Vercel webhook or a GitHub Actions repository_dispatch
  caller) can authenticate. Note: the workflow itself does NOT consume
  this token; the secret exists only so the hook caller can be
  authenticated. GitHub's `repository_dispatch` API requires
  `Authorization: Bearer <PAT>` from the caller.

```bash
gh secret set VERCEL_DEPLOY_HOOK_TOKEN < /tmp/pat.txt
gh secret list  # verify it landed
```

### 2. Vercel deploy webhook

In the Vercel dashboard for the `skillsmith-website` project:

- Settings → Webhooks → Create Webhook.
- URL: a small Vercel Function (or a public Worker) that translates the
  Vercel webhook payload to a GitHub `repository_dispatch` POST. Sample
  curl the function should make:

  ```bash
  curl -fsS -X POST \
    -H "Authorization: Bearer ${GITHUB_PAT}" \
    -H "Accept: application/vnd.github+json" \
    https://api.github.com/repos/smith-horn/skillsmith/dispatches \
    -d '{"event_type":"vercel-prod-deployed","client_payload":{"sha":"<deployment.commitSha>"}}'
  ```

- Filter event: `deployment.succeeded` AND `target == production`.
- Confirm with a test deploy: a healthy run shows up in the Actions tab
  under "Smoke Prod" within ~30s of Vercel reporting the deploy
  succeeded.

## Failure modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Smoke workflow never fires after Vercel deploy | Webhook not configured or PAT expired | Verify webhook in Vercel dashboard; rotate PAT (`gh secret set ...`) |
| Smoke fires for staging deploys too | Webhook missing `target == production` filter | Tighten the filter |
| Smoke fires twice per merge | Both `Deploy Edge Functions` workflow_run AND vercel hook fired | Acceptable — `concurrency` group dedupes within a SHA window |

## Rotation

The PAT expires every 90 days. To rotate:

1. Generate a fresh fine-grained PAT with the same scopes.
2. Update the GitHub Actions secret: `gh secret set VERCEL_DEPLOY_HOOK_TOKEN`.
3. Update the Vercel webhook caller (Vercel Function env var) with the
   new PAT.
4. Trigger a no-op website redeploy and confirm smoke fires.

## Out of scope

- Multi-region Vercel deploys (each emits its own webhook; concurrency
  group dedupes).
- Preview deploys (only production triggers smoke; preview is gated by
  the existing `e2e-tests.yml` against the preview URL).
