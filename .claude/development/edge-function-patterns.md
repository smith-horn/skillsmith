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
| `indexer`, `skills-refresh-metadata`, `ops-report`, `alert-notify` | Service Role | No |
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

**Adding anonymous functions** (CI validates): Add to `supabase/config.toml` with `verify_jwt = false`, add to `NO_VERIFY_JWT_FUNCTIONS` in `scripts/audit-standards.mjs`, and add deploy command to `CLAUDE.md` (the deploy block is CI-pinned via `audit-standards.mjs:472` + `validate-anonymous-functions.ts`).

## Project Refs (Prod vs Staging)

**Project refs — do not confuse (SMI-4252 retro 2026-04-17)**:

| Ref | Role | Used for |
|-----|------|----------|
| `vrcnzpmndtroqxxoqkzy` | **Prod** | `.env` `SUPABASE_URL` / `SUPABASE_PROJECT_REF`; all `supabase functions deploy`; `audit_logs` / `v_indexer_health` / `/functions/v1/stats` when validating prod |
| `ovhcifugwqnzoebwfuku` | Staging | Low-cadence — data lags prod; never curl this when verifying a prod deploy |

When verifying a prod edge function via `curl`, always use `$SUPABASE_URL` (under `varlock run --`) or the literal `https://vrcnzpmndtroqxxoqkzy.supabase.co`. Hardcoding `ovhcifugwqnzoebwfuku` will make a healthy prod deploy look stale — a 2026-04-17 session burned ~7 minutes on this.

## Auto-deploy

Edge functions are automatically deployed to **both** prod (`vrcnzpmndtroqxxoqkzy`) and staging (`ovhcifugwqnzoebwfuku`) when changes to `supabase/functions/**` are merged to main. The `deploy-edge-functions.yml` workflow detects changed functions and runs `deploy-prod` and `deploy-staging` jobs in parallel; failure of one does not block the other. `_shared/` changes trigger a full deploy of all 32 functions to both refs. Manual full deploy: `gh workflow run deploy-edge-functions.yml -f deploy_all=true`. (SMI-4528)

## Related Documentation

- [Supabase Edge Functions Guide](https://supabase.com/docs/guides/functions)
- [Deno Manual](https://deno.land/manual)
- [Stripe Testing](stripe-testing.md) - Webhook-specific patterns
