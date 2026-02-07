# Email Skill Submission — Implementation Plan

## Wave Overview

| Wave | Theme | Issues | Risk |
|------|-------|--------|------|
| **Wave 0** | Foundation & Guards | 2 issues | LOW — config only, no behavior change |
| **Wave 1** | GitHub Crawler Core | 2 issues | MEDIUM — new shared module, pure functions |
| **Wave 2** | Email Processing Pipeline | 2 issues | HIGH — modifies live webhook handler |
| **Wave 3** | Integration & Hardening | 2 issues | MEDIUM — testing + edge cases |

**Total: 8 issues, 3 files modified, 1 file created**

---

## Wave 0 — Foundation & Guards

Zero behavior change. Configuration and compliance only. Unblocks all subsequent waves.

---

### SMI-XXXX: Add `email-inbound` to anonymous functions audit

**Priority:** High
**Type:** Config / Compliance
**Estimate:** S (< 1 hour)

#### Description

`email-inbound` is deployed but not registered in the anonymous functions audit system. This means `npm run audit:standards` doesn't verify its config.toml entry exists. Any subsequent changes to the function could silently break compliance.

Add `email-inbound` to:
1. `NO_VERIFY_JWT_FUNCTIONS` array in `scripts/audit-standards.mjs`
2. `[functions.email-inbound]` with `verify_jwt = false` in `supabase/config.toml`
3. Deploy command in CLAUDE.md anonymous functions section

#### Acceptance Criteria

- [ ] `docker exec skillsmith-dev-1 npm run audit:standards` passes with email-inbound included
- [ ] `supabase/config.toml` has `[functions.email-inbound]` section
- [ ] CLAUDE.md lists `npx supabase functions deploy email-inbound --no-verify-jwt`

#### Files

| File | Change |
|------|--------|
| `scripts/audit-standards.mjs` | Add `'email-inbound'` to `NO_VERIFY_JWT_FUNCTIONS` array (line ~323) |
| `supabase/config.toml` | Add `[functions.email-inbound]` section with `verify_jwt = false` |
| `CLAUDE.md` | Add to anonymous functions deploy list and edge function table |

#### Risks

- **Regression: audit:standards fails.** The audit script checks that every function in the array exists in BOTH config.toml AND CLAUDE.md. If we add to the array but miss one of the two files, CI fails. Mitigation: run audit locally before pushing.
- **Blocker: email-inbound not deployed.** Memory note says "email-inbound NOT in config.toml — verify deployment status before building on it." Must confirm the Resend webhook is configured and the function is reachable before Wave 2 depends on it.

#### Verification

```bash
docker exec skillsmith-dev-1 npm run audit:standards
```

---

### SMI-XXXX: Verify email-inbound deployment and Resend webhook

**Priority:** High
**Type:** Research / DevOps
**Estimate:** S (< 1 hour)

#### Description

Before building on `email-inbound`, confirm the function is actually deployed and receiving webhooks from Resend. The function exists in the codebase but may not be deployed to production.

#### Tasks

1. Check Supabase dashboard for `email-inbound` function deployment status
2. Check Resend dashboard for inbound webhook configuration pointing to `email-inbound`
3. If not deployed: deploy with `npx supabase functions deploy email-inbound --no-verify-jwt`
4. If no webhook: configure Resend inbound webhook for `support@skillsmith.app` → edge function URL
5. Send a test email to `support@skillsmith.app` and verify it forwards to `support@smithhorn.ca`

#### Acceptance Criteria

- [ ] `email-inbound` function is deployed and reachable
- [ ] Resend webhook is configured for inbound emails to `*@skillsmith.app`
- [ ] Test email sent to `support@skillsmith.app` arrives forwarded at `support@smithhorn.ca`
- [ ] Document the Resend webhook URL in `.env.schema` if not already present

#### Risks

- **Blocker: Resend plan doesn't support inbound.** Resend inbound email is a separate feature — verify the current plan includes it.
- **Blocker: DNS not configured.** Inbound email requires MX records pointing to Resend. Verify DNS config for `skillsmith.app`.

---

## Wave 1 — GitHub Crawler Core

New shared module with pure functions. No edge function changes yet. Fully testable in isolation.

**Depends on:** Nothing (independent of Wave 0)

---

### SMI-XXXX: Create `_shared/github.ts` — GitHub repo crawler

**Priority:** High
**Type:** Feature
**Estimate:** M (2-4 hours)

#### Description

Create a shared Deno module that discovers all skills within a GitHub repository using the Trees API, then fetches SKILL.md content for each discovered skill.

This module will be used by `email-inbound` in Wave 2, but is independently testable.

#### Interface

```typescript
/** A skill discovered within a GitHub repo */
interface DiscoveredSkill {
  name: string           // Derived from SKILL.md frontmatter or directory name
  path: string           // e.g. "skills/render-deploy"
  skillMdContent: string // Raw SKILL.md content
  repoUrl: string        // e.g. "https://github.com/render-oss/skills"
  skillUrl: string       // e.g. "https://github.com/render-oss/skills/tree/main/skills/render-deploy"
  bundleManifest: BundleFile[] // Sibling files in skill directory
}

interface BundleFile {
  path: string           // Relative to skill root, e.g. "references/blueprint-spec.md"
  size: number
  type: 'reference' | 'asset' | 'script' | 'code' | 'config'
}

/** Parse a GitHub URL into owner/repo/path components */
function parseGitHubUrl(url: string): { owner: string; repo: string; path?: string } | null

/** Check if a URL is a GitHub repo URL */
function isGitHubRepoUrl(url: string): boolean

/** Discover all skills in a GitHub repo using Trees API */
async function discoverSkillsInRepo(
  owner: string,
  repo: string,
  token: string,
  options?: { branch?: string; maxSkills?: number }
): Promise<DiscoveredSkill[]>

/** Fetch a single SKILL.md file from a known path */
async function fetchSkillMd(
  owner: string,
  repo: string,
  path: string,
  token: string
): Promise<string | null>
```

#### Implementation Details

1. **Trees API** (`GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1`):
   - Single API call returns ALL files in the repo
   - Find all files named `SKILL.md` (case-insensitive)
   - For each SKILL.md, compute the skill root directory
   - Collect sibling files as bundle manifest (no content fetch — just paths and sizes)

2. **Contents API** (`GET /repos/{owner}/{repo}/contents/{path}`):
   - Fetch SKILL.md content for validation (one call per skill)
   - Returns base64-encoded content — decode before returning

3. **Bundle manifest generation**:
   - From the tree listing, collect all files under the skill root directory
   - Classify by extension: `.md` → reference, `.sh/.bash` → script, `.ts/.js/.py/.rs` → code, etc.
   - Store paths and sizes only (content fetched at install time)

4. **Safety bounds**:
   - `maxSkills` default: 200 (prevents runaway on massive repos)
   - 10s timeout per Contents API call
   - Total function budget: ~60s for crawl phase (leaves 90s for processing + email)

#### Files

| File | Action |
|------|--------|
| `supabase/functions/_shared/github.ts` | Create |

#### Risks

- **GitHub API rate limiting.** 130 skills = 131 API calls (1 tree + 130 contents). At 5,000/hour this is fine. But if the token is shared with the indexer cron running simultaneously, we could approach limits. Mitigation: `maxSkills` cap + exponential backoff on 403.
- **Truncated tree response.** GitHub Trees API truncates at 100,000 files (returns `truncated: true`). microsoft/skills is well under this. Mitigation: check `truncated` flag and log warning.
- **Symlinks in tree.** microsoft/skills uses symlinks. The Trees API returns symlinks as `type: "blob"` with `mode: "120000"`. The content is the symlink target path, not the file content. Mitigation: detect mode `120000`, resolve symlink target path, fetch actual content.
- **Anti-pattern: Deno vs Node import.** This module runs in Deno (edge functions). Must use `fetch()` not `node:http`. No npm imports — only Deno-compatible code. The existing `_shared/` modules follow this pattern.

#### Testing

Unit tests for:
- `parseGitHubUrl()` with various URL formats (repo, tree, blob, with/without trailing slash)
- `isGitHubRepoUrl()` edge cases (gist URLs, org URLs, file URLs)
- Skill discovery from mock tree response (nested dirs, symlinks, multiple SKILL.md)
- Bundle manifest classification (reference, script, code, config, asset)

---

### SMI-XXXX: Create `_shared/url-extract.ts` — URL extraction from email

**Priority:** High
**Type:** Feature
**Estimate:** S (1-2 hours)

#### Description

Create a shared module that extracts URLs from email body text and HTML, resolves landing pages to GitHub repo URLs, and deduplicates results.

#### Interface

```typescript
/** Extract all URLs from email body text and/or HTML */
function extractUrls(text?: string, html?: string): string[]

/** Fetch a landing page and extract GitHub repo URLs from it */
async function resolveToGitHubRepos(url: string): Promise<string[]>

/** Classify a URL as github-repo, github-file, or landing-page */
function classifyUrl(url: string): 'github-repo' | 'github-file' | 'landing-page' | 'unknown'
```

#### Implementation Details

1. **URL extraction from text:**
   - Regex: `https?://[^\s<>"')\]]+` (handles most email body formats)
   - Strip trailing punctuation (periods, commas, parentheses)
   - Deduplicate
   - Filter out common non-skill URLs (unsubscribe links, tracking pixels, email client URLs)

2. **URL extraction from HTML:**
   - Regex: `href=["']([^"']+)["']` (extract from anchor tags)
   - Merge with text URLs, deduplicate

3. **Landing page resolution:**
   - Fetch page with 10s timeout
   - Extract all `github.com/{owner}/{repo}` URLs from HTML
   - Filter out non-repo URLs (`github.com/orgs/*`, `github.com/settings`, `github.com/login`)
   - Return unique repo URLs

4. **URL classification:**
   - `github.com/{owner}/{repo}` → `github-repo`
   - `github.com/{owner}/{repo}/blob/...` or `github.com/{owner}/{repo}/tree/...` → `github-file`
   - Everything else → `landing-page`

#### Files

| File | Action |
|------|--------|
| `supabase/functions/_shared/url-extract.ts` | Create |

#### Risks

- **SSRF via landing page fetch.** Fetching arbitrary URLs server-side is an SSRF vector. Internal IPs could be probed. Mitigation: validate URL scheme (HTTPS only), reject private IP ranges (10.x, 172.16-31.x, 192.168.x, 127.x, ::1), reject localhost. This is internal-only but still good practice.
- **Landing page returns huge response.** Some pages could be multi-MB. Mitigation: cap response body read at 1MB.
- **JavaScript-rendered pages.** Some landing pages render GitHub links via JavaScript (SPA). `fetch()` won't execute JS. Mitigation: for internal use, this is acceptable — team can submit the GitHub URL directly if the landing page doesn't have static links.

#### Testing

Unit tests for:
- URL extraction from plain text with various delimiters
- URL extraction from HTML with nested anchor tags
- Classification of GitHub URLs (repo, tree, blob, gist, org)
- Filtering of non-repo GitHub URLs
- SSRF protection (private IP rejection)

---

## Wave 2 — Email Processing Pipeline

Modifies the live `email-inbound` function. This is the highest-risk wave.

**Depends on:** Wave 0 (email-inbound must be deployed), Wave 1 (github.ts + url-extract.ts)

---

### SMI-XXXX: Add skill submission processing to `email-inbound`

**Priority:** High
**Type:** Feature
**Estimate:** L (4-8 hours)

#### Description

Extend the existing `email-inbound` edge function to detect URLs in inbound emails, crawl GitHub repos for skills, validate and upsert them through the indexer pipeline, and reply to the sender with a processing summary.

**Critical constraint:** The existing email forwarding behavior (forward to `support@smithhorn.ca`) MUST be preserved unconditionally. Skill processing must not block or break forwarding.

#### Implementation

```
Deno.serve(async (req) => {
  // ... existing CORS, method checks, API key validation ...

  const payload = JSON.parse(rawBody)

  // NEW: Skill submission processing (fire-and-forget, error-isolated)
  let submissionResult = null
  if (payload.type === 'email.received' && !payload.data.in_reply_to) {
    try {
      submissionResult = await processSkillSubmission(payload.data)
    } catch (err) {
      console.error('Skill submission processing failed:', err)
      // Never let this block forwarding
    }
  }

  // EXISTING: Forward to support (unchanged)
  if (payload.type === 'email.received') {
    const forwarded = await forwardEmail(payload.data, resendApiKey)
    // ...
  }

  // NEW: Send reply to sender (after forwarding)
  if (submissionResult) {
    try {
      await sendSubmissionReply(payload.data.from, submissionResult, resendApiKey)
    } catch (err) {
      console.error('Failed to send submission reply:', err)
    }
  }

  // ... existing response ...
})
```

#### Processing Logic (`processSkillSubmission`)

1. Extract URLs from email body (`url-extract.ts`)
2. Classify each URL (`github-repo`, `github-file`, `landing-page`)
3. For landing pages: resolve to GitHub repo URLs
4. For GitHub repos: discover skills using Trees API (`github.ts`)
5. For each discovered skill:
   a. Fetch SKILL.md content
   b. Validate with `validateSkillMdContent()` from `validation.ts`
   c. Categorize with `categorizeSkill()` from `categorization.ts`
   d. Check dedup against `skills` table (query by repo_url)
   e. Upsert to `skills` table with bundle manifest in metadata
   f. Write audit log entry
6. Return summary: `{ skillsFound: N, indexed: N, alreadyKnown: N, failed: N }`

#### Audit Log Events

Write to `audit_logs` table via Supabase client:
- `skill-submit:received` — when email with URLs arrives
- `skill-submit:indexed` — per skill successfully upserted
- `skill-submit:already-indexed` — per skill that was already known
- `skill-submit:reply-sent` — when reply email is sent

#### Files

| File | Change |
|------|--------|
| `supabase/functions/email-inbound/index.ts` | Major modification — add skill processing pipeline |

#### Risks

- **CRITICAL: Forwarding regression.** If skill processing throws an unhandled error and prevents forwarding, all inbound emails to support are silently dropped. Mitigation: wrap ALL skill processing in try/catch. Forwarding MUST execute regardless. Test this explicitly.
- **HIGH: 150s timeout.** For a 130-skill repo, processing takes ~14s for API calls + validation/categorization per skill + DB upserts + reply email. Total could approach 60-90s. Mitigation: cap `maxSkills` at 50 for initial release. Process first 50, note "N more skills found, submit repo URL directly for full indexing" in reply.
- **MEDIUM: Supabase client initialization.** The current `email-inbound` doesn't use the Supabase client — it only calls Resend directly. Adding DB operations requires initializing `createClient()` with service role key. Verify `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are available as env vars in this function.
- **MEDIUM: Import path conflicts.** Importing `validation.ts` and `categorization.ts` from the indexer function into email-inbound. Deno edge functions can import from `../indexer/validation.ts` but this creates a cross-function dependency. If the indexer module changes imports, email-inbound breaks. Mitigation: import only the pure functions (no Deno.env, no DB calls).
- **LOW: Email loop.** Reply from `noreply@skillsmith.app` to external sender won't trigger inbound webhook. Thread replies skipped via `in_reply_to` check.

#### Anti-Patterns to Avoid

1. **Don't import the entire indexer.** Only import the pure validation/categorization functions. Don't pull in DB clients, cron logic, or GitHub Search API code from the indexer.
2. **Don't store SKILL.md content in the database.** Store only metadata + bundle manifest in the JSONB column. Content is fetched at install time.
3. **Don't process URLs synchronously in sequence.** If multiple GitHub repos are found, process them concurrently with `Promise.allSettled()`.

---

### SMI-XXXX: Add submission reply email template to `_shared/email.ts`

**Priority:** Medium
**Type:** Feature
**Estimate:** S (1-2 hours)

#### Description

Add a reply email template for skill submission results. Two variants: skills found (with summary table) and no skills found.

#### Templates

**Skills Found:**

Subject: `Skillsmith: Indexed N skills from [repo-name]`

Body lists each skill with status (new/already indexed), plus bundle file count.

**No Skills Found:**

Subject: `Skillsmith: No skills found at submitted URL`

Body explains no SKILL.md was found, email has been forwarded for manual review.

#### Interface

```typescript
export function generateSubmissionReplyHtml(result: {
  repoName: string
  skills: Array<{ name: string; isNew: boolean; bundleFiles: number }>
  totalFound: number
  totalIndexed: number
  totalAlreadyKnown: number
}): string

export function generateSubmissionReplyText(result: /* same */): string

export function generateNoSkillsFoundHtml(url: string): string
export function generateNoSkillsFoundText(url: string): string
```

#### Files

| File | Change |
|------|--------|
| `supabase/functions/_shared/email.ts` | Add 4 new exported functions |

#### Risks

- **LOW: Email deliverability.** New templates must include plain text variant (already standard pattern in this file). HTML-only emails have lower deliverability.
- **LOW: File size.** `email.ts` is already 423 lines. Adding 4 templates could push it to ~550 lines. Still under the 500-line governance threshold if templates are concise. Mitigation: use minimal HTML (no full page layout for internal emails).

---

## Wave 3 — Integration & Hardening

Testing, edge cases, and production readiness.

**Depends on:** Wave 2

---

### SMI-XXXX: Test suite for email skill submission

**Priority:** High
**Type:** Testing
**Estimate:** M (2-4 hours)

#### Description

Unit and integration tests for the full email skill submission pipeline. Tests must be in Vitest-compatible locations per project conventions.

#### Test Files

| File | Tests |
|------|-------|
| `supabase/functions/indexer/url-extract.test.ts` | URL extraction, classification, SSRF protection |
| `supabase/functions/indexer/github-crawler.test.ts` | Tree parsing, skill discovery, bundle manifest, symlink handling |

Note: Using `supabase/functions/**/*.test.ts` pattern which is in the Vitest include list.

#### Test Cases

**URL Extraction:**
- Extract URLs from plain text email body
- Extract URLs from HTML email body with anchor tags
- Deduplicate URLs across text and HTML
- Strip trailing punctuation from URLs
- Filter out common non-skill URLs (unsubscribe, tracking)
- Classify GitHub repo vs file vs landing page URLs

**GitHub Crawler:**
- Parse GitHub URLs: `github.com/owner/repo`, `github.com/owner/repo/tree/main/path`
- Discover SKILL.md files from mock Trees API response
- Handle nested skill directories (microsoft/skills pattern)
- Handle flat skill directories (render-oss/skills pattern)
- Generate bundle manifest with correct file type classification
- Respect `maxSkills` cap
- Handle symlinks (mode `120000`) in tree response
- Handle truncated tree response gracefully
- Handle 404/403 from GitHub API

**Integration (mock HTTP):**
- Full flow: email body → URL extraction → GitHub crawl → validation → summary
- Landing page → GitHub repo resolution
- Dedup: skill already in skills table → marked as `alreadyKnown`
- Reply email generated with correct counts

#### Risks

- **MEDIUM: Mocking GitHub API in Deno tests.** The shared modules use `fetch()` for GitHub API calls. Tests need to mock `fetch()`. Vitest runs in Node.js, not Deno, so `Deno.env` calls in shared modules will fail. Mitigation: the shared modules should accept tokens as parameters (not read from `Deno.env`), making them testable in Node.js.
- **Conflict: Cross-function imports.** Tests importing from `_shared/github.ts` need the module to be Node.js compatible (no `Deno.*` APIs). The pure function pattern used by `validation.ts` and `categorization.ts` already handles this — follow the same approach.

---

### SMI-XXXX: Handle edge cases — large repos, non-standard skills, errors

**Priority:** Medium
**Type:** Hardening
**Estimate:** M (2-4 hours)

#### Description

Production hardening for edge cases discovered during architecture review.

#### Edge Cases

1. **Large monorepos (100+ skills):**
   - Cap at 50 skills per submission for timeout safety
   - Reply includes "Found N skills, indexed first 50. Submit directly for remaining."
   - Log full count in audit trail

2. **Non-standard skill naming:**
   - Case-insensitive SKILL.md matching (`skill.md`, `Skill.md`)
   - Look for `SKILL.md` in both root and common subdirectories (`skills/`, `.github/skills/`, `src/skills/`)

3. **Repos without any SKILL.md:**
   - Check for `AGENTS.md` as alternate skill indicator
   - Reply with "No SKILL.md found" message
   - Forward to support for manual review (already happens via existing forwarding)

4. **GitHub API errors:**
   - 404 (repo not found / private): reply "Repository not found or private"
   - 403 (rate limited): log warning, reply "GitHub API rate limited, try again later"
   - 500 (GitHub outage): reply "GitHub API unavailable"

5. **Malformed email (no body):**
   - Skip processing, forward only
   - Log `skill-submit:no-urls` audit event

6. **Multiple URLs in one email:**
   - Process all URLs, aggregate results in single reply
   - Cap total processing at 3 repos per email (timeout safety)

7. **Duplicate repo_url on upsert:**
   - For monorepo skills, `repo_url` is `{repo}/tree/main/{skill_path}` (unique per skill)
   - ON CONFLICT: update `indexed_at`, `quality_score`, `metadata` (refresh, don't duplicate)

#### Files

| File | Change |
|------|--------|
| `supabase/functions/email-inbound/index.ts` | Add error handling, caps, edge case branches |
| `supabase/functions/_shared/github.ts` | Add error handling for API failures, symlinks, truncation |

#### Risks

- **MEDIUM: `repo_url` uniqueness for monorepo skills.** The skills table has UNIQUE on `repo_url`. If we use `https://github.com/microsoft/skills/tree/main/skills/typescript/compute/playwright` as the `repo_url` for a monorepo skill, it's unique but doesn't match the pattern used by the existing indexer (which stores the repo root URL). This could cause the same skill to exist twice under different `repo_url` values. Mitigation: normalize `repo_url` to always point to the skill's subdirectory path for monorepo skills. Document this convention.
- **LOW: Validation.ts MAX_SKILL_CONTENT_SIZE.** Some SKILL.md files (like render-deploy at 2,800 lines) may exceed the max content size constant defined in `_shared/constants.ts`. Verify the constant value and adjust if needed for bundle-style skills.

---

## Dependency Graph

```
Wave 0:
  [email-inbound audit config]  ←  independent
  [verify deployment/webhook]   ←  independent

Wave 1:  (can run parallel with Wave 0)
  [_shared/github.ts]           ←  independent
  [_shared/url-extract.ts]      ←  independent

Wave 2:  (depends on Wave 0 + Wave 1)
  [email-inbound modification]  ←  depends on: github.ts, url-extract.ts, deployment verified
  [email reply templates]       ←  independent (but used by email-inbound)

Wave 3:  (depends on Wave 2)
  [test suite]                  ←  depends on: all Wave 1 + Wave 2 code
  [edge case hardening]         ←  depends on: email-inbound modification
```

## Risk Summary

| Risk | Severity | Issue | Mitigation |
|------|----------|-------|------------|
| Forwarding regression | CRITICAL | Wave 2: email-inbound | Error isolation, explicit test |
| 150s edge function timeout | HIGH | Wave 2: email-inbound | maxSkills=50, maxRepos=3 caps |
| email-inbound not deployed | BLOCKER | Wave 0: verify deployment | Check before Wave 2 starts |
| Resend inbound not configured | BLOCKER | Wave 0: verify webhook | Check before Wave 2 starts |
| GitHub API rate limits | MEDIUM | Wave 1: github.ts | Token auth, backoff, maxSkills cap |
| SSRF via landing page fetch | MEDIUM | Wave 1: url-extract.ts | HTTPS-only, private IP rejection |
| Cross-function import breakage | MEDIUM | Wave 2: validation.ts import | Import pure functions only |
| repo_url uniqueness for monorepos | MEDIUM | Wave 3: edge cases | Normalize to skill subdirectory path |
| Symlinks in GitHub trees | LOW | Wave 1: github.ts | Detect mode 120000, resolve target |
| email.ts file size | LOW | Wave 2: reply templates | Minimal templates for internal use |

## Checklist Before Shipping

- [ ] `docker exec skillsmith-dev-1 npm run preflight` passes
- [ ] `docker exec skillsmith-dev-1 npm run audit:standards` passes
- [ ] Manual test: email microsoft/skills URL → skills indexed, reply received
- [ ] Manual test: email render.com landing page → GitHub repo resolved → skills indexed
- [ ] Manual test: email invalid URL → forwarded to support, graceful reply
- [ ] Manual test: email with no URLs → forwarded to support, no reply sent
- [ ] Forwarding still works for normal support emails (no skill URLs)
