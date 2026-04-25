# [ISSUE-ID]: [Title]

## Review Summary

Reviewed: YYYY-MM-DD | Reviewers: VP Product, VP Engineering, VP Design

### Changes Applied

| # | Change |
|---|--------|
| 1 | [Change from plan review] |

---

## Context

[Problem background — what's broken/needed and why. Include the root cause, impact, and what prompted this work.]

## What Changes

### 1. [First change area]

**Problem**: [What's wrong or missing]

**Solution**: [How it's fixed]

**Files**:

- `path/to/file.ts` — [what changes]

### 2. [Second change area]

**Problem**: [What's wrong or missing]

**Solution**: [How it's fixed]

**Files**:

- `path/to/file.ts` — [what changes]

## Wave 1: [Title]

_Use waves only for multi-step implementations. Single-wave work can omit this section and list steps directly under "What Changes"._

### Step 1: [Action]

[Details with file paths and line numbers]

### Step 2: [Action]

[Details with file paths and line numbers]

## Wave 2: [Title]

_Add additional waves as needed. Order by risk: database migrations and production behavior changes first (SMI-2596)._

### Step 1: [Action]

[Details]

## Surface Grounding (SMI-4454 P-1, P-2)

_Required when the plan hardcodes any string referring to another surface — URL path, RPC name, CLI command, env var, table column, edge function, etc._

For each cross-surface reference, name its canonical source and a verification command:

| Reference (in plan) | Canonical source | Verification |
|---|---|---|
| Example: `Try it: skillsmith search mcp` | `packages/cli/src/index.ts` Commander.js registrations | `skillsmith --help \| grep -E '^\s*search\b'` |
| Example: `${API_BASE}/functions/v1/auth-device-preview` | `supabase/config.toml` + canonical pattern from PR #757 | `grep -rn "/functions/v1/auth-device-" packages/website/src/pages/` (every hit should use `${API_BASE}/...`) |

**Convention check before novelty**: before introducing a new pattern (URL shape, error code, RPC return shape, CSS class naming), include the existing-pattern survey:

```bash
grep -rn "<pattern-prefix>" packages/<surface>/src/
# → <N> existing call sites; all use <canonical-form>. New code MUST match.
```

The static-analysis backstops (SMI-4456 R-1, SMI-4457 R-2) catch CLI-hint and edge-fn-URL drift in `audit:standards`. P-1/P-2 are the upstream prevention.

## PL/pgSQL Name-Collision Audit (SMI-4454 P-3)

_Required when the plan adds or modifies a PL/pgSQL function with `RETURNS TABLE(...)`._

```text
TABLE() output columns: <list, e.g. status TEXT, user_id UUID>
DECLARE block variables:  <list>
RETURNING / WHERE / SELECT identifiers used in body: <list>

Verified no overlap between TABLE columns and DECLARE vars.
All RETURNING/WHERE references are schema-qualified (alias.column) or distinguished from output names.
```

PL/pgSQL treats `RETURNS TABLE(...)` columns as implicit OUT parameters. An unqualified `RETURNING <col>` in the body is ambiguous if `<col>` shadows a TABLE output name — Postgres raises at call time only, so unit tests with mocked RPCs miss it. SMI-4458 R-3 in `audit:standards` is the static-analysis backstop; the plan-level audit catches it earlier.

## Smoke vs CI (SMI-4454 P-4)

Distinguish:

- **Pre-ship verification** (CI, mocked tests): green ≠ working. CI tests are necessary but not sufficient — they prove the code parses and the units agree with their fixtures. They do NOT prove the integration works against real prod.
- **Post-ship smoke path**: an explicit list of `<step>` + `<expected user-visible output>` that a human or scripted test can run against prod after deploy.

| Step | Expected output |
|---|---|
| Example: `skillsmith login` from a fresh terminal | Browser opens; after Approve, CLI prints `Logged in successfully` and the post-login hint |
| Example: paste API key from `/account/cli-token` to `~/.skillsmith/config.json` | `skillsmith whoami` reports the email associated with the key |

If a SMOKE test cannot fire automatically post-deploy, name the human runner and the cadence. SMI-4459 (`scripts/smoke-prod.sh`) is the planned CI-side automation; for now, the plan owner is responsible for triggering smoke after a feature-PR merges.

## Verification

- [ ] `docker exec skillsmith-dev-1 npm run preflight`
- [ ] [Manual testing steps specific to this change]
- [ ] Linear issue(s) updated with commit SHA
- [ ] Surface grounding (P-1, P-2): every cross-surface reference has a canonical source + verification command
- [ ] PL/pgSQL name-collision audit (P-3) completed _if_ plan touches a `RETURNS TABLE` function
- [ ] Smoke path (P-4) specified and run post-deploy (or `scripts/smoke-prod.sh` invoked once it exists)
- [ ] **If this change targets a non-Docker CI workflow** (e.g. `post-merge-verify.yml`,
      any workflow running on `ubuntu-latest` without the Docker dev container):
      verify in a clean-install environment — `npm ci` in a fresh clone or after
      `docker volume rm skillsmith_node_modules`. Do NOT rely on a pre-built Docker
      volume where native modules (better-sqlite3, onnxruntime-node) are already
      compiled. The pre-built state masks `--ignore-scripts` and similar install
      flag errors. (Lesson: SMI-4221/SMI-4239)
