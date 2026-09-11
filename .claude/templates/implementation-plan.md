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

## Shared-State / Coordination Audit (P-5)

_Required when the plan touches any of: browser/Node globals (window.\*, module singletons); event listeners on shared targets (`document`, `window`, broadcast channels, postMessage, signals); caches keyed by computed values (in-memory Map, Redis, KV, file-system caches); row-shape extensions (new column, new field on an interface with multiple persisters); new async producers feeding existing async consumers (or vice versa); async chains whose completion callback writes shared UI/render state that a separately-triggered handler also writes (SMI-6428)._

For each piece of shared mutable state introduced or extended:

| State | Producers (file:line) | Consumers (file:line) | Coordination invariant | Test |
|-------|------------------------|------------------------|------------------------|------|
| Example: `window.__SUPABASE_CLIENT__` | `BaseLayout.astro:136` (eager init) + `supabase-client.ts:24` (lazy fallback) | `LoginButton.astro:247`, `callback.astro:*`, `device.astro:*` | Every consumer reads via `getSupabaseClient()`, not the raw global; lazy-init guarantees a client exists for the consumer's tick. | `LoginButton.test.ts` covers cold-load case |
| Example: skills-page results region (`showState()` + `#results-count`) | `skills/index.astro:916` (init chain terminal write) + `:593`, `:636`, `:692`, `:778`, `:824` (searchSkills paths) | same functions; `skills-filter.spec.ts:24` `waitForResults` | Exactly one logical owner per page load: every `searchSkills()` entry advances `resultsGeneration`; any write after an `await` re-checks it; the init chain's featured write runs only when no query/filter intent is live. | `skills-filter.spec.ts` SMI-6428 describe (delayed-fetch stomp repro) |

**Producers** are every write site, found via `grep -rn` against the codebase — not from memory. **Consumers** are every read site. The **coordination invariant** is one sentence stating the rule that must hold. The **test** is a specific case (file:test-name), not "tests pass".

**Convention check before novelty**:

```bash
grep -rn "<shared-state-name>" packages/
# Confirm every existing access uses the canonical pattern (lazy helper, idempotency guard, key-derivation fn, etc.)
```

If the audit surfaces a producer/consumer pair without an explicit invariant, **stop and fix the invariant before writing more of the plan.** This is the same rule the cache roundtrip (SMI-4861) and upsert-paths (SMI-4887) retros codified — make it visible at plan time, not retro time. The `concurrency-auditor` skill (`/concurrency-audit`) automates this matrix.

## State-Flip Assertion Audit (P-7)

_Required when the plan adds or removes a package (`Dockerfile`, `package.json`), deploys or retires a surface, or flips an existing default (shadow to live, guard on to off). A change that makes a previously-absent thing present, or a previously-present thing absent, invalidates every existing assertion about the old state. See SMI-6514._

Name the noun that flipped and run the scanner against the pre-flip tree:

```bash
bash .claude/skills/plan-review-skill/scripts/scan-state-flip.sh <noun> [--ref <pre-flip-tree>]
```

Paste the noun, the exact command, the STEP-1 denominator, and STEP-2's full output. STEP-2 (noun times absence-vocabulary) is the mandated output. STEP-3 is a narrower reading-order subset only, not a substitute for STEP-2, since it is measured to miss real casualties.

For each STEP-2 hit, name its category and give it a disposition:

| Category | Failure mode |
|---|---|
| 1. Test whose premise is the old state | Fails loudly; cheap; usually already caught |
| 2. Comment or doc asserting the old state | Silent; misleads the next reader |
| 3. Diagnostic or error text naming the old state | Silent; wrong remediation ships while CI stays green |
| 4. Catch block written when the old state was the only possible failure | Silent; miscategorizes a genuinely new failure |

| Hit (file:line) | Category | Disposition | Notes |
|---|---|---|---|
| Example: `scripts/tests/git-crypt-shims.ts:18` | 2 | FIX-NOW | Comment asserted git-crypt is not installed in the dev container; it is, as of SMI-6491 |

Disposition is one of: `FIX-NOW` (stale, fixed in this PR), `STILL-TRUE` (assertion survives the flip unchanged), `FALSE-POSITIVE` (matched the vocabulary but asserts something else), or `OUT-OF-SCOPE` (stale but owned elsewhere; requires an owner and an `SMI-NNNN`, never bare).

**A STEP-1 denominator of 0 is not a pass.** It means the noun does not appear anywhere in the scanned paths. Check that the noun grepped is the one that actually flipped before recording a clean result.

**Severity**: missing P-7 on a qualifying trigger, or a P-7 section that cites no noun, no command, or no STEP-1 count, is Critical. A newly added flag or guard that does not flip an existing default is Medium. A category 3 or 4 hit left without a disposition is High.

## Verification

- [ ] `docker exec skillsmith-dev-1 npm run preflight`
- [ ] [Manual testing steps specific to this change]
- [ ] Linear issue(s) updated with commit SHA
- [ ] Surface grounding (P-1, P-2): every cross-surface reference has a canonical source + verification command
- [ ] PL/pgSQL name-collision audit (P-3) completed _if_ plan touches a `RETURNS TABLE` function
- [ ] Smoke path (P-4) specified and run post-deploy (or `scripts/smoke-prod.sh` invoked once it exists)
- [ ] Shared-state audit (P-5) completed _if_ plan touches browser/Node globals, event listeners on shared targets, computed-key caches, row-shape extensions, new async producer/consumer pairs, or async chains whose completion callback writes shared UI/render state that a separately-triggered handler also writes
- [ ] State-flip assertion audit (P-7) completed _if_ plan adds/removes a package, deploys/retires a surface, or flips an existing default; scanner run with the noun, command, STEP-1 denominator, and STEP-2 output pasted, and every STEP-2 hit given a disposition
- [ ] If this plan includes a genuine architecture decision (not just an implementation detail), flag it and confirm whether it warrants its own `docs/internal/adr/` entry — `plan-review-skill`'s VP Engineering rubric checks for this (standing rule since 2026-08-24, see CLAUDE.md § Infrastructure Change Policy)
- [ ] **If this change targets a non-Docker CI workflow** (e.g. `post-merge-verify.yml`,
      any workflow running on `ubuntu-latest` without the Docker dev container):
      verify in a clean-install environment — `npm ci` in a fresh clone or after
      `docker volume rm skillsmith_node_modules`. Do NOT rely on a pre-built Docker
      volume where native modules (better-sqlite3, onnxruntime-node) are already
      compiled. The pre-built state masks `--ignore-scripts` and similar install
      flag errors. (Lesson: SMI-4221/SMI-4239)
