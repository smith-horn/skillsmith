# Skillsmith API Proxy

Vercel Edge proxy that routes `api.skillsmith.app` to Supabase Edge Functions.

## Why a Proxy?

Supabase custom domains require a paid add-on ($10/month). Using Vercel as a proxy:
- Free custom domain support
- Edge caching capabilities
- CORS headers managed centrally
- Health check endpoint

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
