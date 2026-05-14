# Concurrency Patterns Reference

Pattern-to-incident-to-canonical-fix index for the five `concurrency-auditor` patterns. Use this when:

- You see a `concurrency-audit-pr.yml` hit in CI and want to know "what does Pattern N really mean here?"
- You're drafting a P-5 matrix and want a real prior PR to model your row on.
- A reviewer flagged a shared-state concern and you want the canonical fix (not abstract guidance).

Each row links to the **real PR that fixed the motivating incident** — grep the diff, copy the shape, don't re-derive from memory.

## The five patterns at a glance

| # | Pattern | Real incident | Canonical fix PR |
|---|---------|---------------|------------------|
| 1 | Browser global read outside producer | SMI-4895 (device-login race) | [#1109](https://github.com/smith-horn/skillsmith/pull/1109) |
| 2 | `astro:page-load` bind accumulation | SMI-4896 (post-approve state rollback); SMI-4893 (LoginButton, open) | [#1109](https://github.com/smith-horn/skillsmith/pull/1109) (device); follow-up for SMI-4893 |
| 3 | In-memory cache with computed key | SMI-4861 (tree-hash cache key-shape mismatch) | [#1089](https://github.com/smith-horn/skillsmith/pull/1089) |
| 4 | New SQL column on multi-write table | SMI-4887 (skip-gate path missed) | [#1100](https://github.com/smith-horn/skillsmith/pull/1100) |
| 5 | New async producer / consumer | _Advisory; no captured Skillsmith incident as of plan date._ Drop this row if no incident lands within 60 days (per `NEVER say "consider for future"` rule). | — |

The detector signatures, mitigation playbooks, and false-positive marker conventions live in `.claude/skills/concurrency-auditor/patterns/README.md`. This doc points at the *incidents and PRs*, not the rules.

## Pattern 1 — Browser global read outside producer

**Incident: SMI-4895 — device-login race (2026-05-13)**

`packages/website/src/pages/device.astro` read `window.__SUPABASE_CLIENT__` directly. `packages/website/src/layouts/BaseLayout.astro` was the only writer, and wrote inside its own `astro:page-load` handler. Both handlers fired on the same event tick in bundler-emit order. When BaseLayout lost the race, `device.astro`'s `getAccessToken()` returned `null` and the page bounced to `/login` even though a valid Supabase session existed.

**Canonical fix** ([#1109](https://github.com/smith-horn/skillsmith/pull/1109)): replace every raw `window.__SUPABASE_CLIENT__` read with `getSupabaseClient()` from `packages/website/src/lib/supabase-client.ts`. The lazy helper creates the singleton synchronously on first call, so order-of-mount no longer matters.

```ts
// WRONG — order-dependent on BaseLayout having mounted first
const client = window.__SUPABASE_CLIENT__
if (!client) { /* bounce to /login */ }

// RIGHT — lazy helper guarantees a client exists for this tick
import { getSupabaseClient } from '@lib/supabase-client'
const client = getSupabaseClient()
```

**Why it shipped to production**: lazy-helper-vs-raw-global was a *convention*, not a *gate*. `LoginButton.astro` and `callback.astro` both used the helper; `device.astro` was the outlier and only got caught at QA. Wave 2 of SMI-4902 lands the ESLint rule `no-raw-window-global` that catches this at lint time.

**Where the single producer lives**: `packages/website/src/lib/supabase-client.ts:18-25`. This is the **only** file authorized to read or write `window.__SUPABASE_CLIENT__`. The ESLint rule's `BANNED_GLOBALS.__SUPABASE_CLIENT__.allowedFiles` list contains exactly `['supabase-client.ts']` — adding `BaseLayout.astro` (or any other consumer) to that list re-introduces the multi-writer smell this rule exists to prevent. BaseLayout calls `getSupabaseClient()`; it does NOT read or write the raw global directly.

## Pattern 2 — `astro:page-load` bind accumulation

**Incident A: SMI-4896 — post-approve state rollback (2026-05-13)**

After the user clicked **Approve** on `/device`, an `astro:page-load` re-fire (e.g. from a ClientRouter view transition on the same page) re-ran `init()`. Without an idempotency guard, `init()` re-checked the device-code state and clobbered the visible `approved` state back to `preview`. The user saw their approval visually undone.

**Canonical fix** ([#1109](https://github.com/smith-horn/skillsmith/pull/1109)): a two-layer guard.

```ts
function init() {
  // Layer 1: window-scoped idempotency flag (survives module re-eval on hard nav)
  if (window.__deviceInited) return
  window.__deviceInited = true
  // bind handlers, register listeners once
}

// Inside the body, if it mutates user-visible state:
if (window.__deviceState !== 'input') return // do not regress from approved

document.addEventListener('astro:page-load', init)
```

Both flags live on `window` (not module scope) so they survive a hard navigation, where the module re-evaluates and module-scoped state is lost.

**Incident B: SMI-4893 — LoginButton handler accumulation (open as of plan date)**

Same shape, different page. Tracked separately; will land a 1-commit PR after Wave 2's ESLint rule + `assertNoHandlerAccumulation` helper are on `main`. The helper from `packages/website/tests/e2e/astro-helpers.ts` is the regression test pattern: synthesize N re-fires, click M times, assert exactly M route hits (NOT M × N, NOT M + N, exactly M).

## Pattern 3 — In-memory cache with computed key

**Incident: SMI-4861 — tree-hash cache key-shape mismatch (2026-05-12)**

The tree-hash cache prefetch populated entries keyed on a per-skill URL `…/tree/<branch>/<skillPath>`. The lookup side looked up entries keyed on the bare repo URL. Two different key shapes. The cache was a runtime no-op for every multi-skill repo.

79 pure-helper unit tests passed — they used arbitrary consistent strings on both sides. The bug shipped because the tests didn't exercise the actual production key-derivation. Governance review caught it post-merge.

**Canonical fix** ([#1089](https://github.com/smith-horn/skillsmith/pull/1089)): a shared `deriveKey()` function used by populator and consumer alike, plus a round-trip test that exercises real shapes:

```ts
// Shared key fn — single source of truth
function deriveKey(repo: RepoRef): string { ... }

// Test asserts populator-shape and consumer-shape produce the same key
expect(deriveKey(populatorInput)).toBe(deriveKey(consumerInput))
```

If you add a cache, write the round-trip test before any pure-helper tests. The pure-helper tests will pass either way; only the round-trip test catches shape mismatch.

## Pattern 4 — New SQL column on multi-write table

**Incident: SMI-4887 — skip-gate path missed (2026-05-12)**

A new `tree_hash` column was added to the `skills` table. Wave 1 wired the column through `repositoryToSkill()` — the main upsert path. The SMI-4846 `minimalSkillPayload` skip-gate path (covering 89% of indexer traffic for unchanged repos) was missed. Cache hit ratio asymptoted to ~1% instead of the modeled 80%.

**Canonical fix** ([#1100](https://github.com/smith-horn/skillsmith/pull/1100)): before touching the column shape, enumerate every write site:

```bash
grep -rnE 'INSERT INTO skills|UPDATE skills|upsert.*skills' \
  packages/core/src/ packages/mcp-server/src/ supabase/functions/
```

For each hit, the plan documents either **cover** (this path writes the new column) or **skip** (one-sentence rationale: why is it safe to leave the column NULL/default here?). `scan-diff.sh` Pattern 4 emits this enumeration automatically for any table touched in the diff.

**Rule of thumb**: a column that is logically "computed from inputs at upsert time" must be set on every path that upserts those inputs — even paths that look like fast-paths or skip-gates.

## Pattern 5 — New async producer / consumer (advisory only)

**Status: advisory until a real incident gives it a sharper edge.**

The detector reports any `export async function` in a shared-surface module (`packages/core/src/services/`, `packages/website/src/lib/`, `packages/website/src/layouts/`) as informational-only. It never blocks. Shipping a stricter regex without a calibrating incident would flood reviewers with false positives.

**SLA**: 60 days from 2026-05-14. If no incident lands by 2026-07-13, drop this pattern from the auditor and from this doc (per `NEVER say "consider for future"`). Tracking issue: SMI-pending-pattern-5-incident-or-drop (filed alongside this doc; the issue itself sets the calendar reminder).

If you've got a real incident that fits the pattern shape — async helper exported from a shared module, awaited by some consumers and bypassed by others — file a Linear issue under the **Plan-to-Code Verification** project and link this doc. That's how the pattern graduates from advisory to blocking.

## Related

- Auditor skill: `.claude/skills/concurrency-auditor/` (Mode A: plan-audit, Mode B: diff-audit).
- Pattern detector signatures + false-positive marker convention: `.claude/skills/concurrency-auditor/patterns/README.md`.
- Plan template P-5 section: `.claude/templates/implementation-plan.md` § Shared-State / Coordination Audit.
- Playwright helpers for Pattern 2 regression tests: `packages/website/tests/e2e/astro-helpers.ts`.
- ESLint rule for Pattern 1 (Wave 2 of SMI-4902): `packages/website/eslint-rules/no-raw-window-global.js`.
- CI workflow (Wave 2 of SMI-4902): `.github/workflows/concurrency-audit-pr.yml`.
- Plan-review-skill v1.4.0 auto-populator (Wave 3 of SMI-4902): `.claude/skills/plan-review-skill/agent-prompt.md`.
- Opt-out marker in PR body: `[concurrency-audit-ack]` (boolean shape; reason as prose paragraph in PR body).
