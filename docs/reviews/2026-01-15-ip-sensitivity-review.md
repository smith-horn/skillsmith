# IP Sensitivity Review: Repository Content Classification

**Date:** January 15, 2026
**Reviewer:** IP/Risk Assessment
**Branch:** `review/ip-sensitivity-audit`
**Status:** DECISIONS MADE - Implementation In Progress

---

## Decisions Made

| Item | Decision |
|------|----------|
| Repository strategy | **Option B**: Single repo with .gitignore |
| Enterprise package | **Split** to private repo (`skillsmith-enterprise`) |
| ADRs 013, 014, 017 | **Add to .gitignore** (reveal business strategy) |
| Git history | **Must scrub** before going public |

---

## Executive Summary

This review classifies repository content by sensitivity level and recommends visibility controls to protect competitive intelligence while maintaining the open-source spirit of Elastic License 2.0.

**Key Finding:** Approximately 40% of the `/docs` folder contains strategic planning, GTM strategy, competitive analysis, and internal decision-making that provides significant competitive intelligence. This content should NOT be publicly visible.

**Recommendation:** Implement a two-repository strategy OR use `.gitignore` patterns to exclude sensitive directories from the public repository.

---

## Risk Matrix

| Content Type | Public Risk | Competitor Benefit | Recommendation |
|--------------|-------------|-------------------|----------------|
| Revenue projections/pricing models | HIGH | Direct pricing intelligence | **PRIVATE** |
| GTM strategy & channels | HIGH | Market entry playbook | **PRIVATE** |
| Competitive positioning analysis | HIGH | Know our weaknesses | **PRIVATE** |
| Internal retrospectives | MEDIUM | Process intelligence | **PRIVATE** |
| Product roadmap with dates | MEDIUM | Timing intelligence | **PRIVATE** |
| Risk registers | MEDIUM | Know our vulnerabilities | **PRIVATE** |
| User personas & research | MEDIUM | Market segmentation intel | **PRIVATE** |
| ADRs (technical) | LOW | General best practices | PUBLIC |
| API documentation | LOW | Helps users | PUBLIC |
| Technical guides | LOW | Helps users | PUBLIC |
| Security docs (threat model) | LOW | Industry standard | PUBLIC |

---

## Detailed Classification

### 🔴 HIGH SENSITIVITY (Must Be Private)

These folders contain strategic intelligence that directly benefits competitors:

#### 1. `docs/strategy/` - CRITICAL
- `go-to-market-analysis.md` - Complete GTM playbook with Shreyas Doshi framework analysis
- `ROADMAP.md` - 12-month roadmap with revenue projections ($654K ARR target), team growth plans, break-even analysis
- `free-tier-pricing-strategy.md` - Pricing rationale and conversion assumptions
- `protective-licensing-options.md` - Our licensing strategy considerations
- `repository-visibility-strategy.md` - This very analysis (meta-risk)

**Risk:** Competitors gain our entire commercial playbook.

#### 2. `docs/gtm/` - CRITICAL
- `strategy-overview.md` - Complete GTM strategy with growth loops
- `channels/` - Launch channels, partnership channels, sustainable channels
- `funnel/` - Awareness, retention, referral strategies
- `experiments.md` - A/B test plans
- `metrics.md` - KPI targets
- `risks.md` - Business risks we've identified

**Risk:** Competitors can copy our entire go-to-market approach.

#### 3. `docs/execution/` - HIGH
- `artifacts/risk-register.md` - Technical and business risks with mitigation status
- `09-milestones-sprints.md` - Sprint planning with business metrics
- `hive-mind-waves-phase5-6-7.md` - Detailed execution planning
- Revenue projections embedded throughout

**Risk:** Competitors understand our timeline, priorities, and vulnerabilities.

#### 4. `docs/research/` - HIGH
- `product-fit-matrix.md` - Market analysis and segmentation
- `layers/` - 6-layer research framework with competitive analysis
- User research findings
- Feature prioritization research

**Risk:** Competitors gain our market research without the investment.

### 🟡 MEDIUM SENSITIVITY (Case-by-Case Review)

#### 5. `docs/retros/` - MEDIUM-HIGH
Contains 35+ retrospectives revealing:
- What went wrong and why
- Team capacity and velocity
- Internal decision rationale
- Process improvements

**Risk:** Reveals organizational learning and potential weaknesses.

**Recommendation:** Move to private OR redact commercially sensitive details.

#### 6. `docs/reviews/` - MEDIUM
Contains internal reviews including:
- VP Engineering reviews
- VP Product reviews
- Design Director reviews
- Growth Engineer reviews

**Risk:** Internal quality assessments visible externally.

#### 7. `docs/backlog/` - MEDIUM
- `mcp-vs-skill/` - Internal capability analysis
- `skill-optimizations/` - Future feature research
- `visualization-skills/` - R&D planning

**Risk:** Reveals unannounced features and R&D direction.

#### 8. `docs/waves/` - MEDIUM
Phased rollout planning with internal priorities.

#### 9. `scripts/prompts/` - MEDIUM
Internal prompt engineering for AI-assisted development.

#### 10. `docs/design/personas/` - MEDIUM
User personas reveal market segmentation strategy:
- Explorer, Optimizer, Skeptic, Overwhelmed, Standardizer, Creator
- Pain points and messaging per segment

### 🟢 LOW SENSITIVITY (Can Be Public)

These support developer adoption and are standard for open-source projects:

| Folder | Content | Status |
|--------|---------|--------|
| `docs/api/` | API documentation | ✅ PUBLIC |
| `docs/ci/` | CI/CD documentation | ✅ PUBLIC |
| `docs/deployment/` | Deployment guides | ✅ PUBLIC |
| `docs/guides/` | Usage guides | ✅ PUBLIC |
| `docs/technical/` | Technical docs | ✅ PUBLIC (review `decisions.md`) |
| `docs/security/` | Security docs, threat model | ✅ PUBLIC |
| `docs/adr/` | Technical ADRs | ⚠️ REVIEW (some reveal strategy) |
| `docs/enterprise/` | Enterprise package docs | ✅ PUBLIC |
| `docs/legal/` | Privacy, Terms | ✅ PUBLIC |
| `docs/publishing/` | npm publishing guides | ✅ PUBLIC |
| `docs/templates/` | Issue templates | ✅ PUBLIC |
| `docs/testing/` | Testing guides | ✅ PUBLIC |
| `docs/runbooks/` | Operational runbooks | ✅ PUBLIC |
| `docs/skills/` | Skill documentation | ✅ PUBLIC |

---

## ADR-Specific Review

Architecture Decision Records require individual review:

| ADR | Topic | Sensitivity | Reason |
|-----|-------|-------------|--------|
| 001-012 | Technical decisions | LOW | Standard technical docs |
| **013** | Open Core Licensing | **MEDIUM** | Reveals licensing strategy |
| **014** | Enterprise Package | **MEDIUM** | Reveals monetization approach |
| 015 | Audit Log Storage | LOW | Technical |
| 016 | API Proxy | LOW | Technical |
| **017** | Quota Enforcement | **MEDIUM** | Reveals pricing mechanics |
| 100-102 | Technical | LOW | Standard |

**Recommendation:** Keep 001-012, 015-016, 100-102 public. Review 013, 014, 017 for redaction or move to private.

---

## Options Analysis

### Option A: Split Repository (Recommended)

**Description:** Create separate public and private repositories.

```
skillsmith/ (PUBLIC - Apache 2.0 / ELv2)
├── packages/core/
├── packages/mcp-server/
├── packages/cli/
├── docs/api/
├── docs/guides/
├── docs/technical/
├── docs/security/
├── docs/adr/ (reviewed subset)
└── README.md

skillsmith-internal/ (PRIVATE)
├── packages/enterprise/
├── docs/strategy/
├── docs/gtm/
├── docs/research/
├── docs/execution/
├── docs/retros/
├── docs/reviews/
├── docs/backlog/
├── docs/waves/
└── scripts/prompts/
```

**Pros:**
- Clean separation
- Industry standard (PostHog, Docker)
- No risk of accidental exposure
- Different access controls per repo

**Cons:**
- Sync complexity between repos
- Two CI/CD pipelines
- Contributor friction

### Option B: Expanded .gitignore (Simpler)

**Description:** Keep single repo but gitignore sensitive directories.

Add to `.gitignore`:
```
# Internal planning and strategy (not for public)
docs/strategy/
docs/gtm/
docs/research/
docs/execution/
docs/retros/
docs/reviews/
docs/backlog/
docs/waves/
scripts/prompts/
scripts/phases/
```

**Pros:**
- Simpler to maintain
- Single repo workflow
- Files exist locally but not on GitHub

**Cons:**
- Files already in git history (need rewrite)
- Easy to accidentally commit
- Requires discipline from contributors

### Option C: Private Branch Strategy

**Description:** Keep `main` public, use private branch for internal docs.

**Pros:**
- All history preserved internally

**Cons:**
- Complex merge workflow
- Easy to accidentally expose
- Not recommended for sensitive content

### Option D: Directory-Level GitHub Permissions (NOT POSSIBLE)

GitHub does not support per-directory visibility. Entire repo must be public or private.

---

## Recommended Approach: Option A (Split Repository)

Given the volume of sensitive content (40% of docs), splitting repositories is the cleanest solution.

### Implementation Steps

1. **Create `skillsmith-internal` private repository**
2. **Move sensitive directories** to internal repo
3. **Update `repository-visibility-strategy.md`** to reflect decision
4. **Rewrite git history** to remove sensitive content from public repo
5. **Update CI/CD** to handle both repos
6. **Document process** for cross-repo references

### Git History Consideration

If going public, you MUST scrub git history of sensitive files. Tools:
- `git filter-repo` - Recommended
- `BFG Repo-Cleaner` - Faster but less flexible

---

## Clarifying Questions

Before finalizing recommendations, please clarify:

1. **Timeline:** When do you plan to make the repository public?
   - If imminent: History scrubbing is critical
   - If later: Can be planned carefully

2. **IP Files:** The ROADMAP.md mentions gitignored IP assessment files (`/docs/IP/ip-assessment.md`, etc.). Are these actually gitignored? I didn't find them in the repository.

3. **Archive Folder:** `docs/archive/` contains old PRDs and GTM strategies. Should these be:
   - A) Deleted entirely
   - B) Moved to private repo
   - C) Left in archive (still visible if public)

4. **Enterprise Package:** `packages/enterprise/` is listed as proprietary but is currently in the monorepo. Should it be:
   - A) Split to separate private repo (recommended per `repository-visibility-strategy.md`)
   - B) Gitignored from public distribution
   - C) Kept as-is with license headers only

5. **Scripts:** Some scripts in `scripts/` contain internal URLs, Linear issue references, and planning. Should all of `scripts/` be reviewed?

---

## Immediate Actions (If Going Public Soon)

1. **DO NOT** make repo public until git history is scrubbed
2. **Audit** for any hardcoded secrets, API keys, internal URLs
3. **Remove** or redact Linear issue links that reveal roadmap
4. **Review** all README files for internal references
5. **Check** code comments for sensitive notes

---

## Summary Table

| Folder | Current | Recommendation | Priority |
|--------|---------|---------------|----------|
| `docs/strategy/` | In repo | **PRIVATE** | P0 |
| `docs/gtm/` | In repo | **PRIVATE** | P0 |
| `docs/research/` | In repo | **PRIVATE** | P0 |
| `docs/execution/` | In repo | **PRIVATE** | P1 |
| `docs/retros/` | In repo | **PRIVATE** | P1 |
| `docs/reviews/` | In repo | **PRIVATE** | P2 |
| `docs/backlog/` | In repo | **PRIVATE** | P2 |
| `docs/waves/` | In repo | **PRIVATE** | P2 |
| `scripts/prompts/` | In repo | **PRIVATE** | P2 |
| `docs/api/` | In repo | PUBLIC | - |
| `docs/guides/` | In repo | PUBLIC | - |
| `docs/technical/` | In repo | PUBLIC | - |
| `packages/enterprise/` | In repo | **Separate Repo** | P1 |

---

## Decision Made

**Selected: Option B** - Single repo with .gitignore

### Implementation Status

- [x] Added sensitive directories to `.gitignore`
- [ ] Git history scrubbing (REQUIRED before going public)
- [ ] Remove files from tracking
- [ ] Force push to rewrite history

---

## CRITICAL: Git History Scrubbing

**⚠️ WARNING:** Adding folders to `.gitignore` only prevents FUTURE commits. The sensitive files are STILL in git history and will be visible if the repo goes public.

### Before Going Public, You MUST:

```bash
# 1. Backup current state
git clone --mirror git@github.com:wrsmith108/skillsmith.git skillsmith-backup.git

# 2. Use git-filter-repo to remove sensitive directories from ALL history
# Install: pip install git-filter-repo

git filter-repo --invert-paths \
  --path docs/strategy/ \
  --path docs/gtm/ \
  --path docs/research/ \
  --path docs/execution/ \
  --path docs/retros/ \
  --path docs/reviews/ \
  --path docs/backlog/ \
  --path docs/waves/ \
  --path docs/archive/ \
  --path scripts/prompts/ \
  --path scripts/phases/

# 3. Force push to rewrite remote history
git push origin --force --all
git push origin --force --tags
```

### Alternative: BFG Repo-Cleaner (Faster)

```bash
# Remove directories from history
java -jar bfg.jar --delete-folders "{strategy,gtm,research,execution,retros,reviews,backlog,waves,archive}" .
java -jar bfg.jar --delete-folders "{prompts,phases}" .

git reflog expire --expire=now --all
git gc --prune=now --aggressive
git push --force
```

### What Happens If You Skip This?

Anyone can run:
```bash
git log --all --full-history -- docs/strategy/
git show <commit-hash>:docs/strategy/ROADMAP.md
```

And see your complete GTM strategy, revenue projections, and competitive analysis.

---

*Review prepared in worktree: `../worktrees/ip-review`*
*Branch: `review/ip-sensitivity-audit`*
