# Supabase Edge Function Patterns

Best practices and gotchas for writing Supabase Edge Functions (Deno runtime).

## Supabase Client Error Handling

### Query Builder Pattern

Supabase query builders are **not Promises** - they don't support `.then()` or `.catch()`.

```typescript
// ❌ WRONG - .catch() is not a function on query builders
await supabase
  .from('table')
  .insert({ data })
  .catch((err) => console.error(err))  // TypeError!

// ✅ CORRECT - Destructure error from response
const { data, error } = await supabase
  .from('table')
  .insert({ data })

if (error) {
  console.error('Insert failed:', error.message)
}
```

### Pattern for Optional Tables

When inserting into tables that may not exist in all environments:

```typescript
// ✅ CORRECT - Graceful handling
const { error } = await supabase.from('audit_logs').insert({
  action: 'user_signup',
  resource_id: userId,
})

if (error) {
  // Log but don't fail - table may not exist
  console.debug('Audit log skipped:', error.message)
}

// Continue with main logic...
```

---

## Deno vs Node.js Differences

### Crypto APIs

| Operation | Node.js | Deno |
|-----------|---------|------|
| HMAC signing | `crypto.createHmac()` | `crypto.subtle.sign()` |
| Timing-safe compare | `crypto.timingSafeEqual()` | Web Crypto equivalent |
| Random UUID | `crypto.randomUUID()` | `crypto.randomUUID()` ✅ |

**Impact:** Libraries that use Node.js crypto (like Stripe's sync webhook verification) won't work.

### File System

```typescript
// ❌ Node.js style - won't work
import fs from 'fs'
fs.readFileSync('./config.json')

// ✅ Deno style
const config = await Deno.readTextFile('./config.json')
```

### Environment Variables

```typescript
// ❌ Node.js style
process.env.MY_SECRET

// ✅ Deno style
Deno.env.get('MY_SECRET')
```

---

## Third-Party Library Imports

### ESM Imports

Edge Functions use ESM imports from URLs:

```typescript
// Supabase client
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.47.0'

// Stripe
import Stripe from 'https://esm.sh/stripe@20'

// With Deno target (sometimes needed)
import Stripe from 'https://esm.sh/stripe@20?target=deno'
```

### Version Pinning

Always pin versions to avoid breaking changes:

```typescript
// ✅ Pinned version
import { z } from 'https://esm.sh/zod@3.22.4'

// ❌ Unpinned - may break
import { z } from 'https://esm.sh/zod'
```

---

## Error Response Patterns

### Structured Error Responses

```typescript
// Include details for debugging (but not sensitive data)
return new Response(
  JSON.stringify({
    error: 'Processing failed',
    details: error instanceof Error ? error.message : String(error)
  }),
  {
    status: 500,
    headers: { 'Content-Type': 'application/json' }
  }
)
```

### Error Logging

```typescript
// Structured logging for observability
const errorMessage = error instanceof Error ? error.message : String(error)
const errorStack = error instanceof Error ? error.stack : undefined

console.error('Operation failed:', {
  message: errorMessage,
  stack: errorStack,
  requestId: getRequestId(req.headers)
})
```

---

## Deployment Checklist

### Anonymous vs Authenticated Functions

| Function Type | Deploy Command | Use Case |
|---------------|----------------|----------|
| Anonymous | `--no-verify-jwt` | Webhooks, public APIs |
| Authenticated | (default) | User-specific operations |

```bash
# Anonymous access (webhooks, public endpoints)
npx supabase functions deploy my-webhook --no-verify-jwt

# Authenticated (default)
npx supabase functions deploy my-function
```

### Required Secrets

Before deploying, ensure all secrets are set:

```bash
# List current secrets (shows hashes, not values)
npx supabase secrets list

# Set a secret
npx supabase secrets set MY_SECRET=value

# Set multiple secrets
npx supabase secrets set KEY1=val1 KEY2=val2
```

### Verify Deployment

```bash
# List deployed functions
npx supabase functions list

# Test endpoint is reachable (expect 400/401, not 404)
curl -s -o /dev/null -w "%{http_code}" \
  -X POST https://PROJECT.supabase.co/functions/v1/my-function
```

---

## Common Issues

### "X is not a function"

Usually means you're using a Node.js API pattern in Deno:

| Error | Cause | Fix |
|-------|-------|-----|
| `.catch is not a function` | Supabase query builder | Destructure `{ error }` |
| `crypto.createHmac is not a function` | Node.js crypto | Use Web Crypto or async alternative |
| `fs.readFileSync is not a function` | Node.js fs | Use `Deno.readTextFile()` |

### 401 Unauthorized

Function was deployed without `--no-verify-jwt` but caller doesn't have auth token.

### 500 with No Logs

Check that all required environment variables are set:

```typescript
const secret = Deno.env.get('MY_SECRET')
if (!secret) {
  console.error('MY_SECRET not configured')
  return new Response('Configuration error', { status: 500 })
}
```

---

## External-fetch parsers: the implausible-count guard

When an edge function parses HTML, CSV, or other markup fetched from an
external service (anything you don't control end-to-end), assert that the
parsed row/record count falls within a plausible band BEFORE acting on it.
A markup change that silently drops your selector returns `parseCount = 0`
(or `1`, or `N << expected`), and the downstream "scan everything we got"
loop quietly does nothing.

Caught twice in one week: SMI-4961 (`leaderboard-coverage.test.ts` skill-list
parser) and SMI-4963 (`coverage-report` weekly leaderboard fetch) — both
would have shipped silent no-ops to prod without the guard.

```typescript
const PLAUSIBLE_MIN = 100   // raise the floor; this is a sanity check, not a target
const PLAUSIBLE_MAX = 2000  // ceiling; raise as the population grows

const rows = parseLeaderboard(html)
if (rows.length < PLAUSIBLE_MIN || rows.length > PLAUSIBLE_MAX) {
  console.warn(
    `[parser] Implausible row count ${rows.length} ` +
      `(expected ${PLAUSIBLE_MIN}-${PLAUSIBLE_MAX}) — treating as parse failure`
  )
  return { rows: [], fetchFailed: true }
}
```

Pair with a unit test that feeds the parser HTML with a deliberately-broken selector and asserts the implausible-count branch fires (`leaderboard-fetch.test.ts` has the canonical pattern). The guard is an active asset, not a defensive nicety — leave it on, raise the floor over time, and treat any "implausible" warning in prod logs as an incident, not noise.

---

## Testing Edge Functions with Vitest

### The Module-Load-Time Problem

Edge Functions often access `Deno.env.get()` at module load time (via IIFE or top-level code):

```typescript
// In trial-limiter.ts
const TRIAL_SALT = (() => {
  const salt = Deno.env.get('TRIAL_SALT')  // Runs at import time!
  if (!salt) console.warn('TRIAL_SALT not set')
  return salt || 'default'
})()
```

**Problem:** Standard Vitest mocking (`vi.stubGlobal` in `beforeAll`) runs *after* the module loads, so `Deno` is undefined when the IIFE executes.

### Solution: `vi.hoisted()`

Use `vi.hoisted()` to stub globals *before* any imports:

```typescript
// ✅ CORRECT - Stub runs before module loads
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockRpc } = vi.hoisted(() => {
  // This runs BEFORE any imports
  const mockGet = (key: string) => {
    if (key === 'TRIAL_SALT') return 'test-salt'
    return undefined
  }
  ;(globalThis as Record<string, unknown>).Deno = {
    env: { get: mockGet },
  }
  return { mockRpc: vi.fn() }
})

// Mock dependencies with factory functions
vi.mock('./supabase.ts', () => ({
  createSupabaseAdminClient: () => ({ rpc: mockRpc }),
}))

// NOW import the module under test
import { checkTrialLimit } from './trial-limiter.ts'

describe('checkTrialLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should check trial limit', async () => {
    mockRpc.mockResolvedValue({
      data: [{ allowed: true, used: 1, remaining: 9 }],
      error: null,
    })

    const req = new Request('https://example.com')
    const result = await checkTrialLimit(req)

    expect(result.allowed).toBe(true)
  })
})
```

### Why Other Approaches Fail

| Approach | Why It Fails |
|----------|--------------|
| `vi.stubGlobal('Deno', ...)` in `beforeAll` | Runs after module loads |
| `vi.mock` with inline Deno stub | Mock factory runs after imports |
| Dynamic `import()` in each test | Verbose, cache issues |

### Pattern Summary

1. **Use `vi.hoisted()`** for Deno global stub
2. **Return mock functions** from the hoisted block for later access
3. **Use factory functions** in `vi.mock()` calls
4. **Import module under test** after all mocks are set up
5. **Clear mocks** in `beforeEach`

**Reference:** SMI-1872, SMI-1874 - Auth module unit tests

---

## Function Auth Matrix

Authoritative auth/JWT-verification table for every edge function. CLAUDE.md keeps the deploy-command block inline (CI-pinned) but extracts the full table here. (SMI-4828)

| Function | Auth | `--no-verify-jwt` |
|----------|------|--------------------|
| `early-access-signup`, `contact-submit`, `stats`, `checkout`, `stripe-webhook`, `events` | Anonymous | Yes |
| `skills-search`, `skills-get`, `skills-recommend` | API Key | Yes |
| `health` | Anonymous (health check) | Yes |
| `email-inbound` | Anonymous (Resend webhook) | Yes |
| `generate-license`, `regenerate-license`, `create-portal-session`, `list-invoices` | Authenticated (internal JWT) | Yes |
| `skills-outreach-preferences` | Authenticated (User JWT, handler-level) | Yes |
| `admin-grant-subscription` | Authenticated (Admin JWT) | Yes |
| `webhook-dlq` | Authenticated (User JWT, gateway-verified for RLS) | No |
| `update-seat-count` | Authenticated | No |
| `indexer`, `skills-refresh-metadata`, `ops-report`, `alert-notify`, `coverage-report` | Service Role | No |
| `process-pending-subscription` | Service Role | No |
| `expire-complimentary` | Service Role (daily 3 AM UTC cron) | No |
| `quota-monitor` | Service Role (every 30 min cron) | Yes |
| `skills-outreach` | Service Role | No |
| `advance-notice-email` | Service Role | Yes |
| `auth-device-code` | Anonymous (RFC 8628 device auth) | Yes |
| `auth-device-token` | Anonymous (RFC 8628 token poll) | Yes |
| `auth-device-approve` | Authenticated (User JWT, gateway-verified) | No |
| `auth-device-preview` | Authenticated (User JWT, gateway-verified) | No |
| `indexer-dispatch` | Service Role (explicit bearer check + `verify_jwt=true`); invoked from cron/manual operator curl. Mints GitHub App installation token and POSTs `repository_dispatch` to GHA `indexer.yml`. (SMI-4852) | No |

**Adding anonymous functions** (CI validates): Add to `supabase/config.toml` with `verify_jwt = false`, add to `NO_VERIFY_JWT_FUNCTIONS` in `scripts/audit-standards.mjs`, and add deploy command to `CLAUDE.md` (the deploy block is CI-pinned via `audit-standards.mjs:472` + `validate-anonymous-functions.ts`). `audit:standards` Check 47 (SMI-4963) additionally enforces that every function appears in EXACTLY ONE of `deploy-edge-functions.sh`'s `NO_VERIFY_JWT_FUNCTIONS` / `VERIFY_JWT_FUNCTIONS` AND EXACTLY ONE of `validate-edge-functions.sh`'s `ANONYMOUS_FUNCTIONS` / `AUTHENTICATED_FUNCTIONS` / `SERVICE_ROLE_FUNCTIONS`, AND that `NO_VERIFY_JWT_FUNCTIONS` members carry a matching `[functions.<name>] verify_jwt = false` in `config.toml`.

**In-handler bearer checks**: use the canonical `isServiceRoleCaller` helper from `supabase/functions/_shared/auth.ts` (reads the gateway-verified bearer's `role` claim). Never raw-string-compare against `` `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}` `` — the GHA-secret value and the platform-injected edge-function env value are both service-role JWTs but need not be byte-identical (different signing rounds, independent rotation), so a string-equality check can 401 a legitimate caller. The SMI-4963 dry-run smoke surfaced exactly this: a raw compare 401'd the coverage-report workflow caller because the two values diverged by one byte.

**Consumer-list convention (SMI-5004)**: every edge function that calls `isServiceRoleCaller` MUST be declared in the `@consumers` tag of `supabase/functions/_shared/auth.ts` (single line, comma-separated bare directory names, alphabetically sorted). `audit:standards` Check 47 predicate 5 enforces set equality between the tag and the grep-derived consumer set across `supabase/functions/`. Drift fails CI with one of three messages: (a) "`<fn>` calls `isServiceRoleCaller(...)` but is not declared in `@consumers`" (forward — new consumer added without updating the tag); (b) "`@consumers` declares `<fn>`, but no `isServiceRoleCaller(` call found in `supabase/functions/<fn>/index.ts`" (reverse — consumer removed without pruning the tag); (c) "`@consumers` list is not alphabetically sorted" (formatting; alphabetical order makes append-without-sort merge conflicts deterministic at the same line range). Exclusions: own file (`_shared/auth.ts`), own tests, sibling `*.test.ts`. If the consumer list grows past ~10 names, revisit format (multi-line bulleted JSDoc + line-accumulating parser).

## Project Refs (Prod vs Staging)

**Project refs — do not confuse (SMI-4252 retro 2026-04-17)**:

| Ref | Role | Used for |
|-----|------|----------|
| `vrcnzpmndtroqxxoqkzy` | **Prod** | `.env` `SUPABASE_URL` / `SUPABASE_PROJECT_REF`; all `supabase functions deploy`; `audit_logs` / `v_indexer_health` / `/functions/v1/stats` when validating prod |
| `ovhcifugwqnzoebwfuku` | Staging | Low-cadence — data lags prod; never curl this when verifying a prod deploy |

When verifying a prod edge function via `curl`, always use `$SUPABASE_URL` (under `varlock run --`) or the literal `https://vrcnzpmndtroqxxoqkzy.supabase.co`. Hardcoding `ovhcifugwqnzoebwfuku` will make a healthy prod deploy look stale — a 2026-04-17 session burned ~7 minutes on this.

## Auto-deploy

Edge functions are automatically deployed to **both** prod (`vrcnzpmndtroqxxoqkzy`) and staging (`ovhcifugwqnzoebwfuku`) when changes to `supabase/functions/**` are merged to main. The `deploy-edge-functions.yml` workflow detects changed functions and runs `deploy-prod` and `deploy-staging` jobs in parallel; failure of one does not block the other. `_shared/` changes trigger a full deploy of all 32 functions to both refs. Manual full deploy: `gh workflow run deploy-edge-functions.yml -f deploy_all=true`. (SMI-4528)

## Scan-all-of-X: edge function vs GHA-runner

Supabase edge functions cap at a **150-second wall clock** (`IDLE_TIMEOUT`).
Any "scan all of X" pattern — every repo, every skill, every license probe,
every leaderboard row — eventually crosses that wall as the population grows.
When it crosses, the function times out, the cron silently produces no data,
and the next iteration starts from the same too-large work-set.

Lineage of this lesson in Skillsmith:

| SMI | Symptom | Fix |
|-----|---------|-----|
| SMI-4843 | Indexer started missing repos at scale | Investigated — capacity bounded |
| SMI-4846 | Edge-function `indexer` hit 150s ceiling at ~7k skills | Diagnostic dry-run + page caps |
| SMI-4852 | `indexer-dispatch` shim → moves `indexer` to GHA-runner (no wall clock) | Tier-2 GHA workflow + repository_dispatch |
| SMI-4963 | `coverage-report` 150s wall (license-probe storm × 27 repos) | Soften + instrument; concurrency cap |
| SMI-4997 | Same wall as 4963 persists post-mitigation | Pending: license-probe retry storm vs `repo_url` index vs GHA-runner |

Decision checklist BEFORE picking edge-function for a scan-all workload:

1. **Does N × per-item cost plausibly exceed 30s today?** (Budget: 30s gives 5× headroom against the 150s ceiling for tail variance + retries.)
2. **Will N grow?** (Skills, repos, users, ecosystems — count anything that's been added monotonically for >6 months.)
3. **Does the per-item op require external HTTP / retries?** (Per-item retry storms eat seconds fast; observed in SMI-4963: 3 retries × 270ms × 27 repos = 22s just for retries.)

**Two or more "yes" answers** → choose the GHA-runner path from the start
(repository_dispatch + GHA workflow + `indexer-dispatch`-style trigger
shim). Retrofitting an edge function to a GHA runner is feasible but
costly (3 fully-merged PRs minimum: trigger shim, GHA workflow, deploy
plumbing); building it as GHA from day one is one PR.

For Tier-2 GHA-runner pattern reference see `supabase/functions/indexer-dispatch/index.ts` + `.github/workflows/indexer.yml`.

## Related Documentation

- [Supabase Edge Functions Guide](https://supabase.com/docs/guides/functions)
- [Deno Manual](https://deno.land/manual)
- [Stripe Testing](stripe-testing.md) - Webhook-specific patterns
