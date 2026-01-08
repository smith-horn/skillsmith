# Phase 6A Implementation - Wave Execution Guide

## Progress Status

| Wave | Status | Completed | Notes |
|------|--------|-----------|-------|
| 0 | ✅ Complete | Jan 8, 2026 | Supabase, Vercel, PostHog, Cloudflare configured |
| 1 | ⏳ Pending | - | Schema deployment |
| 2 | ⏳ Pending | - | Data migration |
| 3 | ⏳ Pending | - | Edge Functions |
| 4 | 🔶 Partial | Jan 8, 2026 | SMI-1182 ✅ Domain; SMI-1183 ⏳ npm integration |
| 5 | ⏳ Pending | - | Telemetry + Indexer |
| 6 | ⏳ Pending | - | v0.2.0 release |

### Completed Items

- ✅ **Supabase CLI** linked to project `vrcnzpmndtroqxxoqkzy`
- ✅ **Vercel CLI** authenticated (org: smithhorngroup)
- ✅ **PostHog SDK** configured with `POSTHOG_KEY`
- ✅ **api.skillsmith.app** live via Vercel API Proxy ([ADR-016](/skillsmith/docs/adr/016-vercel-api-proxy.md))
- ✅ **13,602 skills** accessible via REST API

### Verified Endpoints

```bash
# Health check
curl https://api.skillsmith.app/health
# → {"status":"ok","service":"skillsmith-api-proxy","version":"1.0.0"}

# Skills count
curl https://api.skillsmith.app/rest/v1/skills?select=count \
  -H "apikey: $SUPABASE_ANON_KEY"
# → [{"count":13602}]
```

---

## Quick Start

### Wave 0: Manual Prerequisites (Human - 10 min)

Only **2 steps** required before Claude can automate everything:

1. **Get Supabase Access Token**: [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens)
2. **Create `.env.registry`** with the token (see [wave-1-prompt.md](./wave-1-prompt.md#wave-0-manual-prerequisites))

### Execute Waves 1-6 (Claude Sessions)

Each wave runs in a separate terminal session:

```bash
# Wave 1: Infrastructure (~15K tokens, 15 min)
claude --print "$(cat docs/implementation/wave-1-prompt.md)"

# Wave 2: Migration (~25K tokens, 30 min)
claude --print "$(cat docs/implementation/wave-2-prompt.md)"

# Wave 3: API Development (~50K tokens, 60 min)
claude --print "$(cat docs/implementation/wave-3-prompt.md)"

# Wave 4: Integration (~40K tokens, 45 min)
claude --print "$(cat docs/implementation/wave-4-prompt.md)"

# Wave 5: Observability (~30K tokens, 30 min)
claude --print "$(cat docs/implementation/wave-5-prompt.md)"

# Wave 6: Release (~15K tokens, 20 min)
claude --print "$(cat docs/implementation/wave-6-prompt.md)"
```

## Wave Summary

| Wave | Issues | Tokens | Time | Focus |
|------|--------|--------|------|-------|
| 0 | Manual | - | 10m | Access token only |
| 1 | SMI-1179 | 15K | 15m | Supabase project + schema (CLI automated) |
| 2 | SMI-1181 | 25K | 30m | Data migration |
| 3 | SMI-1180 | 50K | 60m | Edge Functions |
| 4 | SMI-1182, 1183 | 40K | 45m | Domain + npm |
| 5 | SMI-1184, 1185 | 30K | 30m | Telemetry + Indexer |
| 6 | SMI-1186 | 15K | 20m | v0.2.0 release |

**Total: ~175K tokens, ~4 hours**

## Files

| File | Purpose |
|------|---------|
| [phase-6a-implementation-plan.md](./phase-6a-implementation-plan.md) | Master plan with architecture |
| [wave-1-prompt.md](./wave-1-prompt.md) | Supabase infrastructure |
| [wave-2-prompt.md](./wave-2-prompt.md) | Database migration |
| [wave-3-prompt.md](./wave-3-prompt.md) | API development |
| [wave-4-prompt.md](./wave-4-prompt.md) | Domain + npm integration |
| [wave-5-prompt.md](./wave-5-prompt.md) | Telemetry + indexer |
| [wave-6-prompt.md](./wave-6-prompt.md) | Release v0.2.0 |

## Dependencies

```
Wave 0 (Manual)
    ↓
Wave 1 (Schema) ──→ Wave 2 (Migration)
                         ↓
                   Wave 3 (API)
                         ↓
                   Wave 4 (Integration)
                         ↓
                   Wave 5 (Observability)
                         ↓
                   Wave 6 (Release)
```

## Gate Criteria

| Wave | Gate Check |
|------|------------|
| 1 | `supabase db push` succeeds |
| 2 | Row count = 9,717 |
| 3 | All endpoints return 200 |
| 4 | api.skillsmith.app responds |
| 5 | Events in PostHog |
| 6 | npm packages @ 0.2.0 |

## Related Documents

- [PRD-V4](/docs/prd-v4.md) - Product requirements
- [Infrastructure Comparison](/docs/reports/infrastructure-comparison-render-vs-supabase-vercel.md) - Why Supabase + Vercel
- [Linear Project](https://linear.app/smith-horn-group/project/skillsmith-phase-6a-critical-path-to-live-40f0780c7e1f) - Issue tracking
