# Skillsmith Website Deployment Guide

This document describes the deployment configuration for the Skillsmith website across three environments.

## Environments Overview

| Environment | Domain | Branch | Purpose |
|-------------|--------|--------|---------|
| Production | www.skillsmith.app | `main` | Live customer-facing site |
| Staging | staging.skillsmith.app | `staging` | Pre-production testing |
| Preview | *.vercel.app | Feature branches | PR preview deployments |

## Domain Configuration

### Production
- **Primary**: `www.skillsmith.app`
- **Apex redirect**: `skillsmith.app` → `www.skillsmith.app` (301 permanent, configured in vercel.json)

### Staging
- **Domain**: `staging.skillsmith.app`
- **Branch**: Deployments from `staging` branch only

### Preview
- **Domain**: Auto-generated `<project>-<hash>-<team>.vercel.app`
- **Branch**: Any branch with open PR

## Environment Variables

### Required for All Environments

| Variable | Description | Example |
|----------|-------------|---------|
| `PUBLIC_SUPABASE_URL` | Supabase project URL | `https://xxx.supabase.co` |
| `PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous key | `eyJ...` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-side only) | `eyJ...` |

### Environment-Specific Variables

| Variable | Production | Staging | Preview |
|----------|------------|---------|---------|
| `SITE_ENV` | `production` | `staging` | `preview` |
| `PUBLIC_SITE_URL` | `https://www.skillsmith.app` | `https://staging.skillsmith.app` | `https://<auto>.vercel.app` |

### Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PUBLIC_STRIPE_PUBLISHABLE_KEY` | Stripe public key | - |
| `STRIPE_SECRET_KEY` | Stripe secret key | - |
| `RESEND_API_KEY` | Resend email API key | - |

## Manual Vercel Dashboard Setup

### Step 1: Create Staging Environment

1. Go to **Vercel Dashboard** → **Project Settings** → **Environments**
2. Click **Add Environment**
3. Configure:
   - **Name**: `staging`
   - **Branch**: `staging`
   - **Type**: Preview (with branch filter)

### Step 2: Configure Staging Domain

1. Go to **Project Settings** → **Domains**
2. Click **Add Domain**
3. Enter: `staging.skillsmith.app`
4. Select **Git Branch**: `staging`
5. Vercel will provide DNS records to configure

### Step 3: DNS Configuration (Cloudflare/DNS Provider)

Add the following DNS record:

```
Type: CNAME
Name: staging
Target: cname.vercel-dns.com
Proxy: OFF (DNS only, gray cloud)
TTL: Auto
```

**Important**: Disable Cloudflare proxy (orange cloud) for Vercel domains to allow proper SSL certificate issuance.

### Step 4: Set Environment Variables

1. Go to **Project Settings** → **Environment Variables**
2. For each variable, set the appropriate value per environment:

**Staging-specific settings:**
```
SITE_ENV = staging
PUBLIC_SITE_URL = https://staging.skillsmith.app
```

3. Ensure staging uses the same Supabase project or a dedicated staging Supabase project

### Step 5: Configure Branch Protection

1. Go to **Project Settings** → **Git**
2. Under **Ignored Build Step**, optionally add:
   ```bash
   if [ "$VERCEL_GIT_COMMIT_REF" = "staging" ] || [ "$VERCEL_GIT_COMMIT_REF" = "main" ]; then exit 1; else exit 0; fi
   ```
   (This builds only staging and main branches, skipping other branches unless they have open PRs)

## Deployment Workflow

### Production Deployment

```bash
# Merge to main triggers automatic deployment
git checkout main
git merge staging
git push origin main
```

### Staging Deployment

```bash
# Push to staging branch triggers automatic deployment
git checkout staging
git merge feature/my-feature
git push origin staging
```

### Preview Deployment

Preview deployments are automatically created for:
- Any push to a branch with an open PR
- Manual deployments via Vercel Dashboard

## Security Headers

The following security headers are applied to all routes (configured in `vercel.json`):

| Header | Value | Purpose |
|--------|-------|---------|
| `X-Frame-Options` | `DENY` | Prevents clickjacking attacks |
| `X-Content-Type-Options` | `nosniff` | Prevents MIME type sniffing |

## Troubleshooting

### Staging domain not resolving

1. Verify DNS CNAME record is set correctly
2. Ensure Cloudflare proxy is disabled (gray cloud)
3. Wait up to 48 hours for DNS propagation
4. Check Vercel Dashboard for SSL certificate status

### Environment variables not applied

1. Verify variable is set for the correct environment scope
2. Redeploy after changing environment variables
3. Check variable names match exactly (case-sensitive)

### Build failures on staging

1. Check build logs in Vercel Dashboard
2. Verify all required environment variables are set
3. Ensure `staging` branch is up-to-date with `main`

## Related Documentation

- [Vercel Environment Variables](https://vercel.com/docs/concepts/projects/environment-variables)
- [Vercel Custom Domains](https://vercel.com/docs/concepts/projects/domains)
- [Astro on Vercel](https://vercel.com/docs/frameworks/astro)
