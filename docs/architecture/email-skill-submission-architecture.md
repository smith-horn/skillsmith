# Email-Based Skill Submission Architecture

## Scope: Internal Use Only

Internal tool for the Skillsmith team. Team members email `support@skillsmith.app` with a URL to submit skills for indexing. No public access, no spam prevention, no rate limiting.

## Motivation

The current indexer discovers skills via scheduled GitHub Search API queries. This misses:

- Skills published on landing pages (e.g., `render.com/docs/llm-support`)
- Multi-skill monorepos (e.g., `github.com/microsoft/skills` with 130+ skills)
- Skills with bundled code, references, and assets beyond a single SKILL.md
- Skills discovered organically by the team between indexer runs

## Real-World Skill Structures

### Pattern 1: Multi-Skill Monorepo (microsoft/skills)

```
microsoft/skills/
├── skills/
│   ├── typescript/
│   │   ├── compute/
│   │   │   └── playwright/        ← individual skill (symlinked)
│   │   ├── data/
│   │   ├── frontend/
│   │   └── ...
│   ├── python/                    ← 41 skills
│   ├── dotnet/                    ← 29 skills
│   ├── java/                      ← 26 skills
│   └── rust/                      ← 7 skills
├── .github/skills/                ← flat skill directory (agent install target)
├── Agents.md
└── README.md
```

**Key traits:** 130 skills, nested by language/category, symlinks, no single root SKILL.md.

### Pattern 2: Multi-Skill Product Repo (render-oss/skills)

```
render-oss/skills/
├── skills/
│   ├── render-deploy/
│   │   ├── SKILL.md               ← 2,800 lines
│   │   ├── references/            ← 10 companion markdown files
│   │   │   ├── blueprint-spec.md
│   │   │   ├── codebase-analysis.md
│   │   │   ├── troubleshooting-basics.md
│   │   │   └── ...
│   │   └── assets/                ← templates, static resources
│   ├── render-debug/
│   └── render-monitor/
├── hooks/                         ← auto-approval hooks
│   ├── hooks.json
│   └── auto-approve-render.sh
├── scripts/
│   └── install.sh                 ← multi-tool installer
└── .mcp.json
```

**Key traits:** 3 skills, each with SKILL.md + references/ + assets/. Shell scripts bundled. Repo-level hooks and installer.

### Pattern 3: Landing Page → GitHub Repo

```
User submits: https://render.com/docs/llm-support#install
  → page contains link to: https://github.com/render-oss/skills
  → repo contains 3 skills with bundled code
```

**Key traits:** Submitted URL is NOT the repo. Must crawl page to find GitHub link.

### Implication: Skills Are Bundles, Not Single Files

The current indexer treats skills as single SKILL.md files with metadata. Real-world skills are **bundles**:

| Component | Example | Must Index? |
|-----------|---------|-------------|
| SKILL.md | Core skill definition | Yes |
| references/*.md | Companion docs (specs, guides, troubleshooting) | Yes |
| assets/* | Templates, configs, static files | Yes |
| scripts/*.sh | Installers, automation | Yes (security scan) |
| hooks/ | Auto-approval, lifecycle hooks | Yes (security scan) |
| *.ts / *.py / *.rs | Implementation code | Yes (security scan) |

**If we only index SKILL.md, we miss most of the skill's value.** A 2,800-line SKILL.md references 10 companion files — without those, the skill is incomplete.

## Proposed System

```
Team member emails support@skillsmith.app with a URL
  → email-inbound edge function (modified)
  → URL extraction
  → URL resolution (landing page → GitHub repo)
  → Repo crawl (discover all skills in repo)
  → Per-skill: validate, categorize, index full bundle
  → Reply to sender with summary
  → Forward to support (existing behavior preserved)
```

## Component Architecture

### 1. Modified: `email-inbound/index.ts`

Add URL extraction and inline processing. No separate edge function needed for internal use.

```
email-inbound receives Resend webhook
  → skip if reply thread (in_reply_to / thread_id present)
  → extract URLs from email body (text + HTML)
  → for each URL:
      → resolve URL type (GitHub repo, landing page, other)
      → if landing page: crawl for GitHub repo links
      → if GitHub repo: crawl for skills
      → for each skill found: validate, categorize, upsert
  → reply to sender with processing summary
  → always: forward to support@smithhorn.ca
```

### 2. URL Resolution Pipeline

```
resolveUrl(url)
  │
  ├─ isGitHubRepo(url)?          → crawlGitHubRepo(owner, repo)
  │   e.g. github.com/microsoft/skills
  │
  ├─ isGitHubSkillFile(url)?     → fetchSingleSkill(owner, repo, path)
  │   e.g. github.com/.../SKILL.md
  │
  └─ isLandingPage(url)?         → fetchPage(url)
      e.g. render.com/docs/...       → extractGitHubLinks(html)
                                      → for each: crawlGitHubRepo(owner, repo)
```

### 3. GitHub Repo Crawler

Discovers all skills within a repo, regardless of nesting depth.

```typescript
interface DiscoveredSkill {
  name: string
  path: string                    // e.g. "skills/render-deploy"
  skillMd: string                 // SKILL.md content
  bundledFiles: BundledFile[]     // references/, assets/, scripts/
  repoUrl: string                 // full repo URL
  skillUrl: string                // repo URL + path to this skill
}

interface BundledFile {
  path: string                    // relative to skill directory
  content: string
  type: 'reference' | 'asset' | 'script' | 'code' | 'config'
}
```

**Discovery algorithm:**

1. Use GitHub Trees API: `GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1`
2. Find all `SKILL.md` files in the tree (any depth)
3. For each SKILL.md, identify its parent directory as the skill root
4. Collect sibling files and subdirectories (references/, assets/, scripts/, *.ts, *.py, etc.)
5. Fetch content for SKILL.md and all bundled files via GitHub Contents API

**Why Trees API?** Single API call returns entire repo structure. Avoids N+1 requests for deeply nested repos. The microsoft/skills repo has 130+ skills — we need this to be efficient.

**Rate limiting:** GitHub API allows 5,000 requests/hour with authentication. A single Trees API call + batch Contents API fetches for a repo like microsoft/skills would use ~140 requests (1 tree + ~130 SKILL.md + ~10 reference files per skill is too many — see Optimization below).

**Optimization for large repos:** For repos with 100+ skills, fetch only SKILL.md files on initial pass. Fetch bundled files on-demand when a skill is installed (lazy loading). Store the tree structure in `metadata` JSONB for later retrieval.

### 4. Landing Page Crawler

For non-GitHub URLs, fetch the page and extract GitHub links.

```typescript
async function extractGitHubRepos(url: string): Promise<string[]> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  const html = await response.text()

  // Extract all GitHub repo URLs from page content
  const githubPattern = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+/g
  const matches = [...new Set(html.match(githubPattern) || [])]

  // Filter out non-repo URLs (github.com/orgs/*, github.com/settings, etc.)
  return matches.filter(isRepoUrl)
}
```

**10-second timeout** on all external fetches (edge function 150s budget).

### 5. Per-Skill Processing

For each discovered skill, reuse the existing indexer pipeline:

| Step | Module | Notes |
|------|--------|-------|
| Validate SKILL.md | `validation.ts` | parseYamlFrontmatter, validateSkillMdContent |
| Categorize | `categorization.ts` | Tags + description keyword matching |
| Dedup check | `skills` table | UNIQUE on `repo_url` — use `skillUrl` as key |
| Security scan | Existing scanner | Flag scripts, hooks, code files for review |
| Upsert | `skills` table | Set `source: 'email_submission'` |
| Store bundle manifest | `metadata` JSONB | List of bundled files with paths and sizes |

**Bundle storage strategy:**

The `skills` table stores skill metadata. Bundled file contents are NOT stored in the database — they're fetched from GitHub at install time. The `metadata` JSONB column stores the **manifest** (list of files, paths, sizes) so the install tool knows what to fetch.

```jsonc
// skills.metadata JSONB
{
  "source": "email_submission",
  "submitted_by": "team-member@smithhorn.ca",
  "bundle": {
    "root": "skills/render-deploy",
    "files": [
      { "path": "SKILL.md", "size": 45000 },
      { "path": "references/blueprint-spec.md", "size": 12000 },
      { "path": "references/codebase-analysis.md", "size": 8000 },
      { "path": "assets/template.yaml", "size": 2000 }
    ]
  }
}
```

### 6. Reply Email

Two branches (internal, simple):

**Skills found and indexed:**

> Processed your submission. Found N skills in [repo-name]:
>
> - render-deploy (new — indexed)
> - render-debug (new — indexed)
> - render-monitor (already indexed)
>
> Each skill includes bundled references and assets. Available in Skillsmith shortly.

**No skills found:**

> Received your URL. No SKILL.md files found at this location. Forwarded to the team for manual review.

### 7. Audit Trail

Write to existing `audit_logs` table (no new table needed):

| Event Type | Metadata |
|------------|----------|
| `skill-submit:received` | `{ url, sender, email_id }` |
| `skill-submit:resolved` | `{ original_url, github_repos_found: [...] }` |
| `skill-submit:crawled` | `{ repo, skills_found: N, total_files: N }` |
| `skill-submit:indexed` | `{ skill_name, skill_id, is_new, bundle_files: N }` |
| `skill-submit:reply-sent` | `{ to, skills_indexed: N }` |

## Sequence Diagram

```
Team Member          Resend           email-inbound                    GitHub API        Database
  |                    |                   |                              |                |
  |-- email + URL ---->|                   |                              |                |
  |                    |-- webhook POST -->|                              |                |
  |                    |                   |-- extract URLs               |                |
  |                    |                   |-- is landing page?           |                |
  |                    |                   |   yes: fetch page            |                |
  |                    |                   |   extract github.com links   |                |
  |                    |                   |                              |                |
  |                    |                   |-- GET trees API ------------>|                |
  |                    |                   |<-- full repo tree -----------|                |
  |                    |                   |-- find all SKILL.md          |                |
  |                    |                   |                              |                |
  |                    |                   |-- for each skill:            |                |
  |                    |                   |   GET SKILL.md content ----->|                |
  |                    |                   |   <-- content ---------------|                |
  |                    |                   |   validate + categorize      |                |
  |                    |                   |   collect bundle manifest    |                |
  |                    |                   |   dedup check --------------->|               |
  |                    |                   |   upsert skill --------------->|              |
  |                    |                   |   audit log ------------------>|              |
  |                    |                   |                              |                |
  |                    |                   |-- reply to sender            |                |
  |<-- summary email --|<-- send ----------|                              |                |
  |                    |                   |-- forward to support         |                |
```

## Configuration Changes

| File | Change |
|------|--------|
| `supabase/config.toml` | Add `[functions.email-inbound]` with `verify_jwt = false` (if missing) |
| `scripts/audit-standards.mjs` | Add `email-inbound` to `ANONYMOUS_FUNCTIONS` (if missing) |

**No new edge function.** No new database table. No config.toml entry for `skill-submit`. Processing happens inline in `email-inbound`.

## What Was Cut (Internal-Only Scope)

| Removed | Reason |
|---------|--------|
| `skill_submissions` table | No need to track submissions — internal team |
| `skill-submit` edge function | Inline processing in email-inbound is sufficient |
| Rate limiting | Trusted senders |
| Spam / abuse prevention | Internal only |
| PII retention / GDPR | Internal emails |
| Sender verification | Known team members |
| Phased rollout | Ship complete for internal use |

## Risks and Mitigations

### HIGH: Edge Function 150s Timeout vs Large Repos

microsoft/skills has 130 skills. Fetching all SKILL.md files + bundled content could easily exceed 150 seconds.

**Mitigation:** Two-tier approach:
1. **Metadata-only pass:** Use Trees API (single call) to discover all skills and store manifests. Upsert skill rows with name, path, repo_url, and bundle manifest. Do NOT fetch all file contents.
2. **Content fetch on demand:** SKILL.md content is fetched for validation/categorization. Bundled reference files are fetched at install time, not at submission time.

For a 130-skill repo, this means: 1 Trees API call + 130 Contents API calls for SKILL.md files. At ~100ms each, that's ~14 seconds. Fits within 150s budget.

### HIGH: GitHub API Rate Limiting

5,000 requests/hour with token. A single microsoft/skills submission uses ~130 requests. Sustainable for internal use (team would need to submit 38 monorepos/hour to hit limits).

**Mitigation:** Use `GITHUB_TOKEN` env var (already available from indexer). Add backoff on 403 responses.

### MEDIUM: Repo Without SKILL.md

Some skill repos may use different conventions (AGENTS.md, plugin.json, .claude-plugin/). The microsoft/skills repo uses a flat `.github/skills/` directory with skill files that may not be named SKILL.md.

**Mitigation:** Expand discovery to look for:
1. `SKILL.md` (primary)
2. `skill.md` (case-insensitive)
3. Files matching `*.skill.md` pattern
4. Directories containing both a markdown file and code files (heuristic)

### MEDIUM: Bundle Size Explosion

render-deploy's SKILL.md alone is 2,800 lines. With 10 reference files, total content could be 50KB+ per skill. For 130 skills, that's 6.5MB of content to process.

**Mitigation:** Don't store file contents in the database. Store only the manifest (paths + sizes) in `metadata` JSONB. Fetch content at install time from GitHub.

### LOW: Email Loop

Reply sent FROM `noreply@skillsmith.app` TO team member. Won't trigger inbound webhook. Replies from team member detected via `in_reply_to`.

### LOW: Duplicate Submissions

`skills` table has UNIQUE on `repo_url`. For monorepos, each skill gets a distinct `repo_url` (e.g., `github.com/render-oss/skills/tree/main/skills/render-deploy`). Upserts handle naturally.

## Files to Modify

| File | Action | Purpose |
|------|--------|---------|
| `supabase/functions/email-inbound/index.ts` | Modify | Add URL extraction, repo crawling, skill indexing, reply |
| `supabase/functions/_shared/email.ts` | Modify | Add submission reply template |
| `supabase/functions/_shared/github.ts` | Create | GitHub Trees API, Contents API, repo crawler utilities |

## Testing Strategy

| Test | Scope |
|------|-------|
| Unit | URL extraction from email body text/HTML |
| Unit | GitHub repo URL detection and parsing |
| Unit | Landing page GitHub link extraction |
| Unit | SKILL.md discovery from tree listing |
| Unit | Bundle manifest generation |
| Integration | Full flow: URL → crawl → validate → upsert → reply |
| Manual | Submit microsoft/skills URL, verify 130 skills indexed |
| Manual | Submit render.com landing page, verify 3 skills indexed |
