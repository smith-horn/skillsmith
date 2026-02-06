# Email-Based Skill Submission Architecture

## Overview

Add a new entry point for skill discovery: users email `support@skillsmith.app` with a URL, and Skillsmith automatically extracts the skill, queues it for indexing, runs security/quality checks, and replies to the sender with a contextual status email.

## Motivation

The current skill indexer discovers skills via scheduled GitHub Search API queries. This misses:

- Skills hosted outside GitHub (npm packages, docs pages, self-hosted repos)
- Skills published after the last indexer run but before the next
- Skills users discover organically and want to contribute

Email submission provides a low-friction, zero-signup entry point for community contributions.

## Current System (No Changes)

```
GitHub Search (daily 2 AM UTC cron)
  → indexer edge function
  → validation (SKILL.md parsing, frontmatter, quality gates)
  → categorization (7 categories)
  → trust tier assignment
  → upsert to skills table
  → quarantine if flagged by security scanner
```

## Proposed System (Additive)

```
Inbound email (Resend webhook)
  → email-inbound edge function (modified)
  → URL extraction + thread detection
  → POST to skill-submit edge function (new)
  → dedup check against skill_submissions table (new)
  → fetch URL content
  → reuse indexer validation + categorization pipeline
  → upsert to skills table
  → send contextual reply email to sender
  → audit log
  → always: forward original email to support (existing behavior preserved)
```

## Component Architecture

### 1. Modified: `email-inbound/index.ts` (Webhook Router)

The existing function receives all inbound emails to `*@skillsmith.app` via Resend webhooks and forwards them to `support@smithhorn.ca`.

**Changes:**

- Add URL extraction from email body (text + HTML)
- Add thread detection (skip URL extraction for replies to existing threads)
- Route submissions to `skill-submit` edge function via internal HTTP POST
- **Preserve existing forwarding behavior unconditionally**

```
email-inbound receives Resend webhook
  → check: is this a reply? (in_reply_to / thread_id present → skip extraction)
  → extract URLs from email body
  → if URLs found:
      → fire-and-forget POST to /functions/v1/skill-submit
  → always: forward to support@smithhorn.ca (existing behavior)
```

The skill-submit POST must NOT block or affect the forwarding flow. Use fire-and-forget pattern with error isolation.

### 2. New: `skill-submit/index.ts` (Core Processing)

Called by `email-inbound` (internal) or directly via HTTP (future API/web form expansion).

#### Processing Steps

| Step | Action | Failure Mode |
|------|--------|--------------|
| 1 | Validate URL format | Reply with "invalid URL" |
| 2 | Rate limit check (sender + global) | Reply with "rate limited" or silent drop |
| 3 | Dedup check against `skill_submissions` | If exists: increment count, reply "already known" |
| 4 | Check `skills` table by URL | If exists: reply "already indexed" |
| 5 | Insert `skill_submissions` row (status: pending) | - |
| 6 | Fetch URL content (10s timeout) | Mark as pending for retry |
| 7 | Detect URL type (GitHub repo, npm, docs page) | - |
| 8 | For GitHub: fetch SKILL.md via API | Mark as failed if no SKILL.md |
| 9 | Run validation (reuse `validation.ts`) | Mark as rejected |
| 10 | Run categorization (reuse `categorization.ts`) | Default to uncategorized |
| 11 | Upsert to `skills` table | - |
| 12 | Update `skill_submissions` (status: indexed, link skill_id) | - |
| 13 | Send reply email to sender | Log failure but don't block |
| 14 | Write audit log | - |

#### Reply Email Branches

**Branch A - New skill discovered:**

> Thank you for contributing to Skillsmith! You found a new skill that was not yet indexed. It's now being reviewed and will be available shortly in the MCP registry.

**Branch B - Already indexed (popular):**

> Thank you for contributing to Skillsmith! [Skill Name] must be popular from user submissions received. It's already available in the Skillsmith MCP registry.

**Branch C - Invalid/no skill found:**

> Thank you for reaching out to Skillsmith! We weren't able to find a valid Claude Code skill at the URL you provided. Our team will review your submission manually.

### 3. New Database Table: `skill_submissions`

```sql
CREATE TABLE skill_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,       -- URL without fragment, normalized
  sender_email TEXT NOT NULL,
  email_id TEXT,                      -- Resend email ID for threading
  status TEXT NOT NULL DEFAULT 'pending',
  skill_id TEXT REFERENCES skills(id),
  skill_name TEXT,
  submission_count INTEGER DEFAULT 1,
  rejection_reason TEXT,
  processed_at TIMESTAMPTZ,
  reply_sent BOOLEAN DEFAULT FALSE,
  reply_sent_at TIMESTAMPTZ,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Statuses: pending, processing, indexed, duplicate, rejected, failed

CREATE UNIQUE INDEX idx_skill_submissions_url ON skill_submissions(normalized_url);
CREATE INDEX idx_skill_submissions_status ON skill_submissions(status);
CREATE INDEX idx_skill_submissions_sender ON skill_submissions(sender_email);
CREATE INDEX idx_skill_submissions_created ON skill_submissions(created_at DESC);
```

**RLS:** Service role only (no public access).

### 4. Email Templates (in `_shared/email.ts`)

Three new exported functions:

- `sendSkillSubmissionNewEmail(to, skillName, url)`
- `sendSkillSubmissionDuplicateEmail(to, skillName, submissionCount)`
- `sendSkillSubmissionRejectedEmail(to, reason)`

**From:** `Skillsmith <noreply@skillsmith.app>`
**Reply-to:** `support@skillsmith.app`

Templates follow existing HTML + plain text pattern for deliverability.

### 5. URL Type Detection Strategy

| URL Type | Detection Pattern | Processing |
|----------|-------------------|------------|
| GitHub repo | `github.com/{owner}/{repo}` | Fetch SKILL.md via GitHub API |
| GitHub file | `github.com/.../SKILL.md` | Fetch file directly |
| npm package | `npmjs.com/package/@scope/name` | Extract from package metadata |
| Docs page | Any other HTTP(S) URL | Phase 1: queue for manual review. Phase 2: heuristic extraction |
| Raw markdown | URL ending in `.md` | Fetch and validate as SKILL.md |

#### Phase 1 (MVP): GitHub-Only Auto-Processing

Auto-process GitHub repo URLs through the full pipeline. All other URLs get stored in `skill_submissions` with `status: pending` and forwarded to support for manual triage. Sender receives Branch C reply.

#### Phase 2: Heuristic Page Scraping

For docs pages, fetch content and look for:

- MCP server configuration JSON blocks (`"mcpServers"`)
- `npx` / `npm install` commands
- SKILL.md-like frontmatter patterns
- Page title and meta description for skill name/description

#### Phase 3: LLM-Assisted Extraction

Use Claude API to analyze arbitrary web pages and extract structured skill metadata.

### 6. Configuration Changes

| File | Change |
|------|--------|
| `supabase/config.toml` | Add `[functions.skill-submit]` with `verify_jwt = false` |
| `supabase/config.toml` | Add `[functions.email-inbound]` with `verify_jwt = false` (if not present) |
| `scripts/audit-standards.mjs` | Add `skill-submit` and `email-inbound` to `ANONYMOUS_FUNCTIONS` |
| `CLAUDE.md` | Add `skill-submit` to edge function table |

### 7. Audit Trail

| Event Type | Trigger |
|------------|---------|
| `skill-submit:received` | Email with URL arrives |
| `skill-submit:duplicate` | URL already submitted before |
| `skill-submit:already-indexed` | URL matches existing skill |
| `skill-submit:processing` | Starting URL fetch/validation |
| `skill-submit:indexed` | Skill successfully added to registry |
| `skill-submit:rejected` | URL invalid or no skill found |
| `skill-submit:reply-sent` | Confirmation email sent to sender |
| `skill-submit:rate-limited` | Sender exceeded rate limit |

## Sequence Diagram

```
User                  Resend           email-inbound        skill-submit         Database
  |                     |                   |                    |                   |
  |-- email + URL ----->|                   |                    |                   |
  |                     |-- webhook POST -->|                    |                   |
  |                     |                   |-- extract URLs     |                   |
  |                     |                   |-- forward to support (always)          |
  |                     |                   |-- POST ----------->|                   |
  |                     |                   |                    |-- rate limit ---->|
  |                     |                   |                    |<-- ok ------------|
  |                     |                   |                    |-- dedup check --->|
  |                     |                   |                    |<-- not found -----|
  |                     |                   |                    |-- insert row ---->|
  |                     |                   |                    |-- fetch URL       |
  |                     |                   |                    |-- validate        |
  |                     |                   |                    |-- categorize      |
  |                     |                   |                    |-- upsert skill -->|
  |                     |                   |                    |-- update status ->|
  |                     |                   |                    |-- audit log ----->|
  |<-- reply email -----|<--- send ---------|<--- reply ---------|                   |
```

## Security Considerations

### Spam / Abuse Prevention

| Control | Implementation |
|---------|----------------|
| Per-sender rate limit | 5 submissions per email per 24 hours |
| Global rate limit | 50 submissions per hour |
| No URL reflection | Don't echo submitted URLs in reply emails |
| Thread detection | Skip URL extraction for email replies |
| Audit logging | All submissions logged for forensics |

### Email Loop Prevention

- Reply emails sent FROM `noreply@skillsmith.app` TO external sender — won't trigger inbound webhook
- Inbound replies detected via `in_reply_to` / `thread_id` — skipped for URL extraction
- Alert emails sent to `support@smithhorn.ca` (not @skillsmith.app) per existing pattern

### PII Retention

- `sender_email` stored in `skill_submissions`
- 90-day retention policy via pg_cron cleanup job (matches `trial_usage` pattern)
- After 90 days: hash email, delete raw value

### Malicious URL Protection

- URLs are fetched server-side — SSRF risk
- Mitigation: validate URL scheme (HTTPS only), reject private IP ranges, 10s timeout
- Fetched content runs through existing security scanner before indexing

## Risks and Mitigations

### HIGH: Edge Function Timeout (150s)

URL fetching + validation + email reply could exceed timeout.

**Mitigation:** 10s fetch timeout. If processing exceeds budget, mark as `pending` and let a scheduled retry job process it. MVP uses synchronous approach; add pg_cron retry if needed.

### HIGH: Non-GitHub URL Processing

Current indexer assumes GitHub repos with SKILL.md. Arbitrary URLs require different extraction logic.

**Mitigation:** Phase 1 auto-processes GitHub URLs only. Non-GitHub URLs queued for manual review with human-in-the-loop.

### MEDIUM: Dual Indexing Paths

Same skill could be discovered by both cron indexer and email submission.

**Mitigation:** `skills` table has `UNIQUE` on `repo_url`. Upserts handle dedup naturally. Email submissions set `source: 'user_submission'` for attribution.

### LOW: Existing email-inbound Regression

Modifying the function could break forwarding.

**Mitigation:** URL extraction wrapped in try/catch. Forwarding always executes regardless of extraction outcome. Integration tests verify forwarding still works.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `supabase/functions/skill-submit/index.ts` | Create | Core submission processing |
| `supabase/functions/email-inbound/index.ts` | Modify | Add URL extraction + routing |
| `supabase/functions/_shared/email.ts` | Modify | Add submission reply templates |
| `supabase/migrations/NNNN_skill_submissions.sql` | Create | New table + indexes + RLS |
| `supabase/config.toml` | Modify | Add function configs |
| `scripts/audit-standards.mjs` | Modify | Add to anonymous functions list |
| `CLAUDE.md` | Modify | Document new edge function |

## Testing Strategy

| Test Type | Scope |
|-----------|-------|
| Unit | URL extraction from email body |
| Unit | URL type detection (GitHub, npm, docs) |
| Unit | Rate limiting logic |
| Unit | Dedup logic |
| Integration | email-inbound → skill-submit flow |
| Integration | skill-submit → skills table upsert |
| Integration | Reply email template rendering |
| E2E | Full email → indexed skill → reply flow |

## Open Questions

1. Should Phase 1 MVP auto-process only GitHub URLs, or attempt all URLs?
2. Should replies be immediate or batched/delayed (for abuse prevention)?
3. Should senders be verified as registered Skillsmith users?
4. Is `email-inbound` currently deployed with a Resend webhook configured?
5. Expected submission volume (handful/week vs. high volume)?
6. For non-skill docs pages (like Render's LLM docs), should these be treated as skills or flagged for human review?
