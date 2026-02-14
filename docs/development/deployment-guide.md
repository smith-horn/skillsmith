# Deployment Guide

Supabase Edge Function deployment, CORS configuration, and website deployment.

## Edge Function Deployment

```bash
npx supabase functions deploy <function-name> --no-verify-jwt  # Anonymous/internal auth
npx supabase functions deploy <function-name>                   # Gateway JWT validation
```

### Functions Requiring `--no-verify-jwt`

These functions bypass Supabase gateway JWT validation and handle auth internally:

```bash
# Anonymous functions (no auth required)
npx supabase functions deploy early-access-signup --no-verify-jwt
npx supabase functions deploy contact-submit --no-verify-jwt
npx supabase functions deploy stats --no-verify-jwt
npx supabase functions deploy skills-search --no-verify-jwt
npx supabase functions deploy skills-get --no-verify-jwt
npx supabase functions deploy skills-recommend --no-verify-jwt
npx supabase functions deploy stripe-webhook --no-verify-jwt
npx supabase functions deploy checkout --no-verify-jwt
npx supabase functions deploy events --no-verify-jwt

# Authenticated functions with internal JWT validation
npx supabase functions deploy generate-license --no-verify-jwt
npx supabase functions deploy regenerate-license --no-verify-jwt
npx supabase functions deploy create-portal-session --no-verify-jwt
npx supabase functions deploy list-invoices --no-verify-jwt
```

**Why `--no-verify-jwt`**: The Supabase gateway rejects user JWTs from the frontend auth flow. These functions validate tokens internally using `supabase.auth.getUser()`. See SMI-1906.

**Note**: `verify_jwt` is also configured in `supabase/config.toml` for local development. Production deployments require the `--no-verify-jwt` flag explicitly.

### Adding New Anonymous Functions (SMI-1900)

CI validates anonymous function configuration. When adding a new one:

1. Add `[functions.<name>]` with `verify_jwt = false` to `supabase/config.toml`
2. Add deploy command to the list above
3. Add function name to `ANONYMOUS_FUNCTIONS` array in `scripts/audit-standards.mjs`

CI will fail if any anonymous function is missing from `config.toml` or CLAUDE.md.

## CORS Configuration (SMI-1904)

Configured in `supabase/functions/_shared/cors.ts`:

| Origin Type | Handling |
|-------------|----------|
| Production domains | Always allowed (`skillsmith.app`, `skillsmith.dev`) |
| Vercel preview URLs | Auto-allowed via pattern (`*-smithhorngroup.vercel.app`) |
| Localhost | Always allowed for development |
| Custom domains | Add via `CORS_ALLOWED_ORIGINS` env var |

### Adding Custom Origins

Set in Supabase Dashboard (Edge Functions > Secrets):

```text
CORS_ALLOWED_ORIGINS=https://custom.example.com,https://staging.skillsmith.app
```

Or via CLI:

```bash
npx supabase secrets set CORS_ALLOWED_ORIGINS="https://custom.example.com"
```

## Website Deployment

```bash
cd packages/website && vercel --prod
```

Public docs at [skillsmith.app/docs](https://skillsmith.app/docs):

| Page | Path |
|------|------|
| Overview | `/docs` |
| Getting Started | `/docs/getting-started` |
| Quickstart | `/docs/quickstart` |
| CLI Reference | `/docs/cli` |
| MCP Server | `/docs/mcp-server` |
| API Reference | `/docs/api` |
| Security | `/docs/security` |
| Quarantine | `/docs/quarantine` |
| Trust Tiers | `/docs/trust-tiers` |

Contact form at `/contact` supports `?topic=` param. `/verify` redirects to `/contact?topic=verification`.

## MCP Registry

See [mcp-registry.md](mcp-registry.md) for publishing workflow, version bumping, and CI setup.

## Google Cloud Platform (SMI-2454, SMI-2509)

### Organization Structure

```text
smithhorn.ca (GCP Organization)
└── skillsmith (GCP Project)
    └── skillsmith-analytics (Service Account)
```

**All values stored in `.env`** via Varlock. Reference env var names — never hardcode values.

### Environment Variables

| Env Var | Description | Sensitive | Source |
|---------|-------------|-----------|--------|
| `GCP_PROJECT_ID` | GCP project identifier | No | GCP Console → Project Settings |
| `GCP_PROJECT_NUMBER` | GCP project number (used in WIF path) | No | GCP Console → Project Settings |
| `GCP_SERVICE_ACCOUNT` | Service account email | No | IAM & Admin → Service Accounts |
| `GCP_WIF_PROVIDER` | Full WIF provider resource name | No | IAM → Workload Identity Federation |
| `GA4_PROPERTY_ID` | GA4 property (format: `properties/NNNNN`) | No | GA4 Admin → Property Settings |
| `GA4_MEASUREMENT_ID` | GA4 web stream (format: `G-XXXXXXXXXX`) | No | GA4 Admin → Data Streams |
| `GA4_API_SECRET` | Measurement Protocol secret | **Yes** | GA4 Admin → Data Streams → API Secrets |

### Workload Identity Federation (WIF)

GitHub Actions authenticates to GCP without stored secrets. OIDC tokens are exchanged for short-lived credentials.

**Auth flow**: GitHub OIDC → WIF Pool (`github-actions`) → Provider (`github`) → Service Account impersonation → API access

**Security constraints**:

- WIF provider attribute condition: `assertion.repository == "smith-horn/skillsmith"`
- Only GitHub Actions from `smith-horn/skillsmith` can impersonate the service account

### Enabled APIs

| API | Purpose |
|-----|---------|
| Google Analytics Data API (`analyticsdata.googleapis.com`) | GA4 reporting queries |
| Google Search Console API (`searchconsole.googleapis.com`) | Index coverage, search performance |

### Service Account Permissions

| Service | Role | Granted Where |
|---------|------|---------------|
| GA4 | Viewer | GA4 Admin → Property Access Management |
| Google Search Console | Full / Restricted | GSC → Settings → Users and permissions |

### GitHub Repository Variables

Set via Settings → Secrets and variables → Actions → Variables:

| Variable | Maps to `.env` |
|----------|----------------|
| `GCP_PROJECT_ID` | `GCP_PROJECT_ID` |
| `GCP_WIF_PROVIDER` | `GCP_WIF_PROVIDER` |
| `GCP_SERVICE_ACCOUNT` | `GCP_SERVICE_ACCOUNT` |
| `GA4_PROPERTY_ID` | `GA4_PROPERTY_ID` |

### Google Search Console (SMI-2509)

**Property**: `skillsmith.app` (Domain property preferred) or `https://www.skillsmith.app/` (URL-prefix)

**Sitemap**: `https://www.skillsmith.app/sitemap-index.xml` (34 URLs, auto-generated by Astro)

- Referenced in `robots.txt` line 57
- Submitted via GSC → Sitemaps → Add

**Verification checklist**:

- [ ] Property verified (DNS or meta tag)
- [ ] Service account added as user in GSC
- [ ] Sitemap submitted and crawled
- [ ] Coverage report reviewed (check excluded/errored pages)
- [ ] Rich Results report reviewed (FAQ, Product, SoftwareApplication)

### Local Testing

```bash
# Install gcloud CLI (required for local API access)
brew install google-cloud-sdk

# Authenticate with service account impersonation
varlock run -- sh -c 'gcloud auth application-default login \
  --impersonate-service-account="$GCP_SERVICE_ACCOUNT" \
  --scopes="https://www.googleapis.com/auth/analytics.readonly,https://www.googleapis.com/auth/webmasters.readonly"'

# Test GA4 API query
varlock run -- sh -c 'curl -s -X POST \
  -H "Authorization: Bearer $(gcloud auth application-default print-access-token)" \
  -H "Content-Type: application/json" \
  -d "{\"dateRanges\":[{\"startDate\":\"7daysAgo\",\"endDate\":\"today\"}],\"metrics\":[{\"name\":\"sessions\"}]}" \
  "https://analyticsdata.googleapis.com/v1beta/$GA4_PROPERTY_ID:runReport"'

# Test GSC API — list sitemaps
varlock run -- sh -c 'curl -s \
  -H "Authorization: Bearer $(gcloud auth application-default print-access-token)" \
  "https://searchconsole.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fwww.skillsmith.app/sitemaps"'
```

### GCP Requirements Summary

- GCP project under `smithhorn.ca` organization
- Google Analytics Data API enabled
- Google Search Console API enabled
- Service account with GA4 Viewer role and GSC access
- WIF pool with GitHub OIDC provider (restricted to `smith-horn/skillsmith`)
- `roles/iam.workloadIdentityUser` granted to the WIF pool principal on the service account

## Staging Verification (ADR-108)

Preview deployments are protected by Vercel's deployment protection. To test staging programmatically:

1. **Generate bypass secret**: Vercel Dashboard > Project > Settings > Deployment Protection > Protection Bypass for Automation
2. **Store in `.env`**: `VERCEL_AUTOMATION_BYPASS_SECRET=<secret>` (already in `.env.schema`)
3. **First request includes bypass**: `?x-vercel-protection-bypass=SECRET&x-vercel-set-bypass-cookie=samesitenone`
4. **Subsequent requests**: Cookie auto-sent, no query param needed

### Dev-Browser Testing Pattern

```bash
cd ~/.claude/skills/dev-browser && \
  VERCEL_AUTOMATION_BYPASS_SECRET="$(grep '^VERCEL_AUTOMATION_BYPASS_SECRET=' /path/to/.env | cut -d= -f2-)" \
  bun x tsx <<'SCRIPT'
import { connect } from './src/client.ts';
const client = await connect('http://localhost:9222');
const page = await client.page('default');
await page.goto(`https://PREVIEW_URL/?x-vercel-protection-bypass=${process.env.VERCEL_AUTOMATION_BYPASS_SECRET}&x-vercel-set-bypass-cookie=samesitenone`, { waitUntil: 'networkidle0' });
// ... test assertions
SCRIPT
```

### Deploy + Verify Workflow

```bash
cd packages/website && npx vercel          # Deploy staging preview
# Test with dev-browser (bypass auth wall)
cd packages/website && vercel --prod       # Deploy to production after verification
```

## Monitoring & Alerts

### Scheduled Jobs

| Job | Schedule | Function |
|-----|----------|----------|
| Skill Indexer | Daily 2 AM UTC | `indexer` |
| Metadata Refresh | Hourly :30 | `skills-refresh-metadata` |
| Weekly Ops Report | Monday 9 AM UTC | `ops-report` |
| Weekly Analytics | Monday 9 AM UTC | `analytics-report` (GitHub Actions) |
| Billing Monitor | Monday 9 AM UTC | GitHub Actions only |

### Alert Notifications

Alerts sent to `support@skillsmith.app` via Resend when:

- Indexer workflow fails
- Metadata refresh workflow fails (scheduled runs only)
- Weekly ops report detects anomalies

### Manual Ops Report

```bash
varlock run -- bash -c 'curl -X POST \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"days\": 7, \"dryRun\": false}" \
  "$SUPABASE_URL/functions/v1/ops-report"'
```

### Audit Logs

All scheduled jobs log to the `audit_logs` table:

- `indexer:run` - Skill indexing results
- `refresh:run` - Metadata refresh results
- `ops-report:sent` - Weekly report sent
- `alert:sent` - Alert notification sent
