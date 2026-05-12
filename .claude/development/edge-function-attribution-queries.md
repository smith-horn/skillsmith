# Edge Function Attribution Queries

Canonical pooler queries for monitoring edge function invocation rates and attribution. Use these for ad-hoc investigation and as the basis for any scheduled alarm cron.

**Linear**: [SMI-4118](https://linear.app/smith-horn-group/issue/SMI-4118) (umbrella) → [SMI-4366](https://linear.app/smith-horn-group/issue/SMI-4366) (Wave 4 attribution sub-umbrella) → [SMI-4370](https://linear.app/smith-horn-group/issue/SMI-4370) (this doc)
**Background**: [Wave 4a retro](../../docs/internal/retros/2026-04-20-smi-4367-edge-attribution-wave4a.md)

## Purpose

The `_shared/attribution.ts` helper (SMI-4367 / Wave 4a) writes per-request attribution into `audit_logs.metadata->'attribution'` for `search:metrics`, plus the Wave 4b sibling functions (`skills-get`, `skills-recommend`, `stats`, `events`). The queries below let you:

1. Track 7-day / 14-day rolling invocation rates against the 1.8M/mo budget.
2. Identify heavy callers by IP `/24` or User-Agent.
3. Detect day-over-day spikes (alarm input).
4. Compare result-count distribution to flag unfiltered/monolithic query patterns.
5. Spot scrapers that shift from one edge function to another.

Output of each query is a `psql` table; capture as text for paste into Linear or pipe to `jq`/`awk` for further processing.

## When to run

| Query | When | Frequency |
|-------|------|-----------|
| 1. Daily volume trend | Decision-gate review, post-mitigation verification, monthly billing reconciliation | Weekly + ad-hoc |
| 2. Top-N IP /24 | Whenever volume exceeds expected ceiling, or quarterly hygiene | On alarm + quarterly |
| 3. Top-N User-Agent | Same triggers as #2; useful for distinguishing browser vs SDK vs scraper | On alarm + quarterly |
| 4. Auth-tier split | Weekly — confirms anon-rate-limit (PR #688) is still pinning the curve | Weekly |
| 5. Day-over-day delta alarm | Scheduled cron consumer (>20% delta = alert) | Daily 00:15 UTC (suggested) |
| 6. Result-count distribution | Suspected programmatic/monolithic source (Wave 4a diagnostic pattern) | On alarm |
| 7. Cross-function comparison | Confirming a scraper hasn't shifted to a sibling function after `skills-search` mitigation | Weekly + post-mitigation |

## Required permissions

All queries are SELECT-only against `audit_logs`. Run via the prod pooler — PostgREST's 8s `statement_timeout` will reject several of these (especially #6's histogram).

```bash
docker exec skillsmith-dev-1 varlock run -- ./scripts/pooler-psql.sh -c "<query>"
```

The pooler routes to the prod project (`vrcnzpmndtroqxxoqkzy`) per `SUPABASE_PROJECT_REF` in `.env`. **Never run these against staging** (`ovhcifugwqnzoebwfuku`) — data lags and you'll mis-diagnose. See [edge-function-patterns.md](edge-function-patterns.md) for the project-ref matrix.

## auth_tier reference

The `auth_tier` value in `metadata->'attribution'->>'auth_tier'` reflects the request's resolved tier as set by `_shared/attribution.ts`:

| Value | Meaning |
|-------|---------|
| `trial` | No auth or unauthenticated request (default) |
| `community` | Authenticated, free tier |
| `individual` | Paid `$9.99/mo` tier |
| `team` | Paid `$25/user/mo` tier |
| `enterprise` | Paid `$55/user/mo` tier |
| `authenticated` | Fallback when middleware indicates `authenticated=true` but no specific tier |

`auth_method` is one of: `api_key`, `jwt`, `anon_key`, `none`.

The Wave 4a investigation initially used `'anonymous'` / `'api_key'` as the working enum hypothesis; the implementation landed with the values above. Use these values when filtering — `'anonymous'` will silently match zero rows.

---

## 1. Daily volume trend (last 14 days, with tier split)

```sql
SELECT
  date_trunc('day', created_at)::date AS day,
  event_type,
  COUNT(*) AS rows,
  COUNT(*) FILTER (WHERE metadata->'attribution'->>'auth_tier' = 'trial')      AS trial,
  COUNT(*) FILTER (WHERE metadata->'attribution'->>'auth_tier' = 'community')  AS community,
  COUNT(*) FILTER (WHERE metadata->'attribution'->>'auth_tier' = 'individual') AS individual,
  COUNT(*) FILTER (WHERE metadata->'attribution'->>'auth_tier' = 'team')       AS team,
  COUNT(*) FILTER (WHERE metadata->'attribution'->>'auth_tier' = 'enterprise') AS enterprise,
  COUNT(*) FILTER (WHERE metadata->'attribution'->>'auth_tier' IS NULL)        AS no_attribution
FROM audit_logs
WHERE event_type = 'search:metrics'
  AND created_at >= NOW() - INTERVAL '14 days'
GROUP BY 1, 2
ORDER BY 1 DESC;
```

**Interpretation**: `no_attribution` rows are pre-Wave-4a entries (before SMI-4367 deploy 2026-04-20) or rows from a function that hasn't yet been wired in Wave 4b. After the Wave 4b fanout completes for all sibling functions, `no_attribution` should approach zero for `event_type IN ('search:metrics', 'get:metrics', 'recommend:metrics', 'stats:metrics', 'events:metrics')` rows newer than the deploy.

**Goal**: total daily `rows` should average ≤ 60,000 (≈ 1.8M/mo). As of 2026-05-11 the 14-day average is ~10,970/day (~349k/mo), 5.2x under target.

## 2. Top-N IP /24 (last 24h)

```sql
SELECT
  metadata->'attribution'->>'ip_prefix' AS ip_prefix,
  COUNT(*) AS rows,
  COUNT(DISTINCT metadata->>'request_id') AS distinct_requests,
  MIN(created_at) AS first_seen,
  MAX(created_at) AS last_seen
FROM audit_logs
WHERE event_type = 'search:metrics'
  AND created_at >= NOW() - INTERVAL '24 hours'
  AND metadata->'attribution'->>'ip_prefix' IS NOT NULL
GROUP BY 1
ORDER BY rows DESC
LIMIT 20;
```

**Interpretation**: Wave 4a found ~15 AWS `/24` subnets across 5 regions accounting for the bulk of traffic. A row with `distinct_requests` ≈ `rows` and continuous `first_seen`/`last_seen` ≈ 24h spread is a programmatic source. The `anonymous:<hash>` rows (no IP header) are the rate-limiter fallback bucket — a single hash dominating the top-N is a sign one client is hitting from many IPs without leaking them.

## 3. Top-N User-Agent (last 24h)

```sql
SELECT
  COALESCE(NULLIF(metadata->'attribution'->>'user_agent', ''), '<empty>') AS user_agent,
  COUNT(*) AS rows,
  COUNT(DISTINCT metadata->'attribution'->>'ip_prefix') AS distinct_ip_prefixes,
  COUNT(DISTINCT metadata->'attribution'->>'auth_tier')  AS distinct_tiers
FROM audit_logs
WHERE event_type = 'search:metrics'
  AND created_at >= NOW() - INTERVAL '24 hours'
GROUP BY 1
ORDER BY rows DESC
LIMIT 20;
```

**Interpretation**: A single UA string with high `distinct_ip_prefixes` is a fleet (scraper or distributed SDK). UA `<empty>` traffic is suspicious unless tied to known headless infra. UAs containing `axios/`, `node-fetch/`, `python-requests/`, `Go-http-client/` are programmatic; `Mozilla/...` with a real browser fingerprint is the website. The `@skillsmith/core` SDK sends a UA prefixed with `skillsmith-cli/`.

## 4. Auth-tier split (last 7 days, with percentage)

```sql
WITH totals AS (
  SELECT COUNT(*)::numeric AS total
  FROM audit_logs
  WHERE event_type = 'search:metrics'
    AND created_at >= NOW() - INTERVAL '7 days'
)
SELECT
  COALESCE(metadata->'attribution'->>'auth_tier', '<no_attribution>') AS auth_tier,
  COALESCE(metadata->'attribution'->>'auth_method', '<no_attribution>') AS auth_method,
  COUNT(*) AS rows,
  ROUND(COUNT(*)::numeric / NULLIF((SELECT total FROM totals), 0) * 100, 2) AS pct
FROM audit_logs
WHERE event_type = 'search:metrics'
  AND created_at >= NOW() - INTERVAL '7 days'
GROUP BY 1, 2
ORDER BY rows DESC;
```

**Interpretation**: Healthy steady-state should be majority `trial` / `none` (community-tier anonymous SDK users), with single-digit percentages for `community` / `individual` / `team`. As of 2026-05-11 the 14-day window is ~99.5% community-tier (trial + community combined). A sudden swing to `api_key` dominance signals either (a) a paid customer's CI exploding, or (b) a scraper having stolen a key — cross-reference with #2 to determine which.

## 5. Day-over-day delta alarm (returns row if delta > 20%)

```sql
WITH daily AS (
  SELECT
    date_trunc('day', created_at)::date AS day,
    COUNT(*) AS rows
  FROM audit_logs
  WHERE event_type = 'search:metrics'
    AND created_at >= NOW() - INTERVAL '3 days'
    AND created_at <  date_trunc('day', NOW())
  GROUP BY 1
),
pair AS (
  SELECT
    day                                                         AS today,
    LAG(day)                  OVER (ORDER BY day)               AS prev_day,
    rows                                                         AS today_rows,
    LAG(rows)                 OVER (ORDER BY day)               AS prev_rows
  FROM daily
)
SELECT
  today,
  prev_day,
  today_rows,
  prev_rows,
  ROUND((today_rows - prev_rows)::numeric / NULLIF(prev_rows, 0) * 100, 1) AS pct_change
FROM pair
WHERE prev_rows IS NOT NULL
  AND ABS((today_rows - prev_rows)::numeric / NULLIF(prev_rows, 0)) > 0.20
ORDER BY today DESC
LIMIT 1;
```

**Interpretation**: Empty result = no alarm. One row = yesterday's volume diverged > ±20% vs the day before. Wire to a cron consumer that pages on non-empty output. Threshold (20%) is conservative; tighten once steady-state variance is characterized.

The query intentionally compares two **complete** UTC days (excludes today's partial bucket via `created_at < date_trunc('day', NOW())`).

## 6. Result-count distribution (Wave 4a diagnostic)

```sql
SELECT
  CASE
    WHEN (metadata->>'result_count')::int = 0          THEN '00_zero'
    WHEN (metadata->>'result_count')::int BETWEEN 1 AND 9   THEN '01_1-9'
    WHEN (metadata->>'result_count')::int BETWEEN 10 AND 19 THEN '02_10-19'
    WHEN (metadata->>'result_count')::int = 20         THEN '03_exactly_20'
    WHEN (metadata->>'result_count')::int BETWEEN 21 AND 49 THEN '04_21-49'
    WHEN (metadata->>'result_count')::int = 50         THEN '05_exactly_50'
    WHEN (metadata->>'result_count')::int = 100        THEN '06_exactly_100'
    ELSE '07_other'
  END AS bucket,
  COUNT(*) AS rows,
  ROUND(COUNT(*)::numeric / SUM(COUNT(*)) OVER () * 100, 1) AS pct
FROM audit_logs
WHERE event_type = 'search:metrics'
  AND created_at >= NOW() - INTERVAL '24 hours'
  AND metadata ? 'result_count'
GROUP BY 1
ORDER BY 1;
```

**Interpretation**: Healthy traffic produces a long tail across buckets (users explore varied queries). The diagnostic pattern from Wave 4a was **near-100% in one specific bucket** (e.g. all `exactly_20` or all `exactly_50`) indicating a programmatic source paginating with a fixed limit. Bucket boundaries match the SDK's default `limit` values. If a single bucket exceeds 70%, run #2 + #3 to identify the source.

## 7. Cross-function comparison (last 7 days)

```sql
SELECT
  event_type,
  COUNT(*) AS rows,
  COUNT(DISTINCT metadata->'attribution'->>'ip_prefix') AS distinct_ip_prefixes,
  COUNT(*) FILTER (WHERE metadata->'attribution'->>'auth_tier' IN ('trial', 'community')) AS community_rows,
  ROUND(
    COUNT(*) FILTER (WHERE metadata->'attribution'->>'auth_tier' IN ('trial', 'community'))::numeric
    / NULLIF(COUNT(*), 0) * 100,
    1
  ) AS community_pct,
  COUNT(*) FILTER (WHERE metadata->'attribution' IS NULL) AS no_attribution
FROM audit_logs
WHERE event_type IN (
        'search:metrics',
        'get:metrics',
        'recommend:metrics',
        'stats:metrics',
        'events:metrics'
      )
  AND created_at >= NOW() - INTERVAL '7 days'
GROUP BY 1
ORDER BY rows DESC;
```

**Interpretation**: After a mitigation lands on one function (e.g. PR #688 anon-rate-limit on `skills-search`), watch this table for traffic shifting to a sibling. If `skills-get` or `skills-recommend` row counts jump while `search:metrics` drops, the scraper has adapted — file a follow-up to extend the same mitigation. The `no_attribution` column flags Wave 4b coverage gaps.

The exact `event_type` values for `skills-get`, `skills-recommend`, `stats`, `events` should match the audit-write call in each function's `index.ts`. Check `grep -n "event_type:" supabase/functions/{skills-get,skills-recommend,stats,events}/index.ts` if a column is unexpectedly empty.

---

## Output interpretation cheat-sheet

| Symptom | Likely cause | Next query |
|---------|--------------|------------|
| Daily total > 60k for 3+ days | New scraper or paid-customer CI explosion | #2 + #4 |
| Single IP /24 > 30% of 24h traffic | Fleet from one cloud region | #3 to confirm UA fingerprint |
| Single UA string > 50% of traffic | Programmatic SDK without UA randomization | #4 to check tier |
| `auth_tier='trial'` jumps from ~99% to <80% | Paid customer or stolen API key | #2 cross-referenced to that tier |
| #5 returns a row | Day-over-day variance broke the threshold | Triage with #2 + #3 + #6 |
| Single result-count bucket > 70% | Monolithic query pattern (programmatic) | #2 to identify the source |
| `skills-search` drops + sibling spikes | Scraper adapted post-mitigation | Plan mitigation fanout (Wave 4b pattern) |

## Adding a new attributed function

When a new edge function adopts attribution (per `_shared/attribution.ts`), add its `event_type` to query #7's `IN (...)` list and update the corresponding row in the cheat-sheet. The query will continue to work for existing functions even if the new event_type is misspelled — just expect a zero row for the new function until its event_type matches what `index.ts` writes.

## See also

- [Wave 4a retro](../../docs/internal/retros/2026-04-20-smi-4367-edge-attribution-wave4a.md) — investigation methodology, the 5-min ROI lesson
- [edge-function-patterns.md](edge-function-patterns.md) — function-auth matrix, project refs
- [deployment-guide.md](deployment-guide.md) — scheduled jobs, monitoring & alerts
- [supabase-migration-safety.md](supabase-migration-safety.md) — pooler discipline, statement_timeout rationale
- `supabase/functions/_shared/attribution.ts` — source of truth for `auth_tier` / `auth_method` enum values
