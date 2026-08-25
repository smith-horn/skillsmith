# Skillsmith API Proxy

Vercel Edge proxy that routes `api.skillsmith.app` to Supabase Edge Functions.

## Why a Proxy?

Supabase custom domains require a paid add-on ($10/month). Using Vercel as a proxy:
- Free custom domain support
- Edge caching capabilities
- CORS headers managed centrally
- Health check endpoint

**Not for signed webhooks.** This proxy is not fit for server-to-server webhook traffic whose own signature is the auth mechanism (Stripe, Resend). Two fidelity bugs drop the exact bytes a signature check needs: a hardcoded header allowlist (`forwardHeaders` at `api/proxy.ts:131`) silently discards any header not in the list — e.g. Resend's `svix-*` trio — and every non-`GET`/`HEAD` body is re-serialized via `JSON.stringify(req.body)` (`api/proxy.ts:150`), which does not byte-match the original payload an HMAC signature was computed over. Signed webhooks register the raw Supabase URL directly instead — see [ADR-132](../../docs/internal/adr/132-signed-webhooks-bypass-api-proxy.md) (SMI-6148).

## Architecture

```
Client Request
     │
     ▼
api.skillsmith.app (Vercel Edge)
     │
     ├─► /functions/v1/* → Supabase Edge Functions
     ├─► /rest/v1/*      → Supabase PostgREST API
     └─► /health         → Local health check
```

## Endpoints

| Path | Proxied To |
|------|------------|
| `/functions/v1/skills-search` | Supabase Edge Function |
| `/functions/v1/skills-get` | Supabase Edge Function |
| `/rest/v1/skills` | Supabase PostgREST |
| `/health` | Local Vercel function |

## Deployment

```bash
# Deploy to Vercel
cd apps/api-proxy
vercel --prod

# Add custom domain
vercel domains add api.skillsmith.app
```

## Local Development

```bash
vercel dev
# Access at http://localhost:3000
```
