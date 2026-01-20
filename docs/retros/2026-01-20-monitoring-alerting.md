# Retrospective: Monitoring & Alerting Implementation

**Date**: January 20, 2026
**Issue**: SMI-1617
**Duration**: ~2 hours
**Status**: Complete

## Summary

Implemented comprehensive monitoring and alerting infrastructure for Skillsmith's scheduled jobs, including a new metadata refresh system and weekly operations reports with email notifications.

## What We Built

### 1. Skill Metadata Refresh System
- **Problem**: Skills indexed via topic search never got metadata updates (stars, quality_score) after initial indexing. Skills like `linear-claude-skill` showed 4 stars in DB but had 21 on GitHub.
- **Solution**: New `skills-refresh-metadata` Edge Function that queries existing skills and fetches fresh GitHub metadata.
- **Schedule**: Hourly at :30 (100 skills/batch = full refresh every 6 days for 14k skills)

### 2. Weekly Operations Report
- **Function**: `ops-report` Edge Function
- **Schedule**: Mondays 9 AM UTC
- **Content**: Indexer stats, refresh stats, database counts, automated alerts
- **Delivery**: Email to support@skillsmith.app via Resend

### 3. Alert Notifications
- **Function**: `alert-notify` Edge Function
- **Triggers**: Workflow failures (indexer, refresh)
- **Delivery**: Immediate email to support@skillsmith.app

### 4. Shared GitHub Auth
- Extracted GitHub App authentication to `_shared/github-auth.ts`
- Reduced code duplication between indexer and refresh functions

## What Went Well

1. **Incremental Development**: Built and tested each component before moving to the next
2. **Reuse of Existing Infrastructure**: Leveraged existing Resend email setup
3. **Comprehensive Audit Logging**: All operations logged to `audit_logs` table
4. **Dry Run Support**: Both refresh and ops-report support `dryRun` mode for testing

## What We Learned

### Email Domain Mismatch
- **Issue**: Emails weren't sending despite RESEND_API_KEY being configured
- **Root Cause**: Code defaulted to `noreply@skillsmith.dev` but Resend only had `skillsmith.app` verified
- **Fix**: Updated FROM_EMAIL to use `skillsmith.app`
- **Lesson**: When email fails silently, check domain verification first

### Resend Inbound Webhook Loop
- **Issue**: Ops report emails arrived with "No content" in the body
- **Root Cause**: Sending to `support@skillsmith.app` triggered Resend's inbound webhook, which forwarded to `support@smithhorn.ca`, but Resend doesn't include body content in the webhook payload for self-sent emails
- **Fix**: Changed operational emails (ops-report, alert-notify) to send directly to `support@smithhorn.ca`
- **Lesson**: Avoid sending emails through inbound webhooks when you control both sender and recipient

### Batch Size Limits
- **Issue**: Batch size of 500 caused Edge Function timeout
- **Root Cause**: 150ms delay × 500 calls = 75 seconds minimum, plus GitHub API latency
- **Fix**: Kept batch size at 100 (reliable within timeout)
- **Lesson**: Edge Functions have 150-second timeout; plan batch sizes accordingly

### Hourly vs Daily Scheduling
- **Decision**: Changed refresh from daily to hourly
- **Rationale**: With 14k skills and 100/batch, daily would take 140 days for full refresh
- **Trade-off**: More GitHub API calls but ensures fresh data

## Metrics

| Metric | Value |
|--------|-------|
| Skills in Database | 14,231 |
| Verified Skills | 18 |
| Community Skills | 9,889 |
| Experimental Skills | 3,748 |
| Refresh Rate | 100 skills/hour |
| Full Refresh Cycle | ~6 days |

## Files Changed

### Created
- `supabase/functions/skills-refresh-metadata/index.ts`
- `supabase/functions/ops-report/index.ts`
- `supabase/functions/alert-notify/index.ts`
- `supabase/functions/_shared/github-auth.ts`
- `.github/workflows/refresh-metadata.yml`
- `.github/workflows/ops-report.yml`

### Modified
- `supabase/functions/indexer/index.ts` (use shared auth)
- `supabase/functions/_shared/email.ts` (fix domain)
- `.github/workflows/indexer.yml` (add failure alerts)
- `CLAUDE.md` (document monitoring)

## Follow-up Items

1. **Monitor Skip Rate**: High skip rate (>20%) indicates many deleted repos - may need cleanup job
2. **Adjust Alert Thresholds**: Current thresholds may need tuning based on actual patterns
3. **Add PostHog Integration**: Consider adding analytics for ops metrics
4. **Dashboard Visibility**: Consider adding monitoring dashboard to admin UI

## Commits

```
feat(api): add skill metadata refresh Edge Function (SMI-1617)
chore: increase metadata refresh to hourly (SMI-1617)
feat(monitoring): add weekly ops report and alert notifications (SMI-1617)
fix(email): use verified domain skillsmith.app instead of skillsmith.dev
fix(email): update dashboard/docs URLs to skillsmith.app
docs: add skills-refresh-metadata to Edge Functions table (SMI-1617)
fix(email): send operational emails directly to avoid inbound webhook loop (SMI-1617)
```
