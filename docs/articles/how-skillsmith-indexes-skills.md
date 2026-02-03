---
title: "From GitHub to Search Results: How Skillsmith Indexes and Curates Skills"
description: "A behind-the-scenes look at how Skillsmith discovers, scores, and indexes Claude Code skills—and how to optimize your skills for discovery"
author: "Skillsmith Team"
date: 2026-02-02
category: "Engineering"
tags: ["indexer", "search", "embeddings", "github", "scoring", "developers"]
featured: true
ogImage: "/blog/images/indexer-pipeline-hero.png"
---

<!--
IMAGE REQUIREMENT: indexer-pipeline-hero.png
- Hero image showing the skill discovery pipeline
- Visual flow: GitHub repos → Skillsmith Indexer → Search/MCP
- Style: Clean technical diagram with Skillsmith brand colors
- Include icons for: GitHub, database, vector embeddings, magnifying glass
- Dimensions: 1200x630 (OpenGraph standard)
-->

# From GitHub to Search Results: How Skillsmith Indexes and Curates Skills

You've built a Claude Code skill. It works great locally. But how does it get discovered by the thousands of developers searching for skills like yours?

This guide walks you through Skillsmith's indexing pipeline—from the moment we discover your skill on GitHub to when it appears in search results. Understanding this process helps you optimize your skills for discovery and explains why some skills rank higher than others.

---

## The Big Picture

Before diving into details, here's what happens when Skillsmith indexes a skill:

<!--
IMAGE REQUIREMENT: indexer-overview-flow.png
- Horizontal flowchart with 5 stages
- Stage 1: "Discovery" (GitHub icon) - "Crawl GitHub for SKILL.md files"
- Stage 2: "Validation" (checkmark icon) - "Parse and validate skill metadata"
- Stage 3: "Security Scan" (shield icon) - "Run static analysis checks"
- Stage 4: "Scoring" (star icon) - "Calculate quality, popularity, maintenance scores"
- Stage 5: "Indexing" (database icon) - "Store in SQLite + generate embeddings"
- Use arrows connecting each stage
- Add small timing annotations: "Daily sync", "< 2 seconds", "< 5 seconds"
- Style: Light background, clear icons, minimal text
-->

**The journey in five steps:**

1. **Discovery** — We crawl GitHub daily, looking for repositories with `SKILL.md` files
2. **Validation** — We parse your skill's metadata and verify it meets our schema
3. **Security Scan** — We run static analysis to detect potential security issues
4. **Scoring** — We calculate quality, popularity, and maintenance scores
5. **Indexing** — We store everything in our database and generate semantic embeddings

The entire process takes seconds per skill, but we've designed each step carefully to balance speed with accuracy.

---

## Step 1: Discovery — Finding Skills in the Wild

Skillsmith doesn't wait for you to submit your skill. We actively search for skills across GitHub.

### What We Look For

Our GitHub indexer searches for repositories containing:

- A `SKILL.md` file in the root or `.claude/skills/` directory
- Valid YAML frontmatter with required fields
- Public visibility (we don't index private repos)

```typescript
// Simplified view of our search query
const SEARCH_QUERIES = [
  'filename:SKILL.md path:.claude/skills',
  'filename:SKILL.md "claude" "skill"',
  'topic:claude-skill',
  'topic:claude-code-skill',
];
```

### The Crawl Schedule

| Source | Frequency | Coverage |
|--------|-----------|----------|
| GitHub Search API | Daily | New skills, trending repos |
| Known skill repos | Every 6 hours | Updates to existing skills |
| Community registries | Daily | Curated skill collections |

<!--
IMAGE REQUIREMENT: discovery-sources.png
- Diagram showing three input sources flowing into Skillsmith
- Left side: Three boxes labeled "GitHub Search", "Known Repos", "Registries"
- Center: Funnel or merge point labeled "Discovery Queue"
- Right side: Single box "Skillsmith Indexer"
- Include small numbers showing typical volume: "~50 new/day", "~500 updates/day"
- Style: Clean, shows data flow direction with arrows
-->

### How to Get Discovered Faster

Want your skill indexed sooner? Here's what helps:

1. **Add the `claude-skill` topic** to your GitHub repository
2. **Use a descriptive repository name** that includes "skill" or "claude"
3. **Ensure your `SKILL.md` is in a standard location** (root or `.claude/skills/`)

---

## Step 2: Validation — Parsing Your Skill

Once we find a potential skill, we validate its structure. This isn't just bureaucracy—proper metadata makes your skill searchable and trustworthy.

### Required Frontmatter

Your `SKILL.md` must include YAML frontmatter with these fields:

```yaml
---
name: "my-awesome-skill"
description: "A brief description of what this skill does"
version: "1.0.0"
author: "your-github-username"
---
```

### Optional But Recommended

These fields improve your skill's discoverability and ranking:

```yaml
---
name: "my-awesome-skill"
description: "A brief description of what this skill does"
version: "1.0.0"
author: "your-github-username"

# Recommended fields
tags: ["testing", "react", "automation"]
category: "development"
triggers:
  - "when I ask about testing"
  - "when working with React components"
examples:
  - "Help me write tests for this component"
  - "Set up Jest configuration"
---
```

### What Happens on Validation Failure

If your skill fails validation, it enters a "pending" state:

| Issue | Result | How to Fix |
|-------|--------|------------|
| Missing `name` | Not indexed | Add name to frontmatter |
| Missing `description` | Not indexed | Add description (min 10 chars) |
| Invalid YAML | Not indexed | Check YAML syntax |
| Empty SKILL.md body | Indexed with warning | Add content below frontmatter |

We don't penalize you for validation issues—we simply can't index what we can't parse. Fix the issue, and we'll pick it up on the next crawl.

---

## Step 3: Security Scan — Building Trust

Every skill passes through our security scanner before indexing. This protects users and determines your skill's trust tier.

<!--
IMAGE REQUIREMENT: security-scan-pipeline.png
- Vertical flowchart showing security checks
- Input: "SKILL.md Content"
- Check 1: "Jailbreak Pattern Detection" with examples
- Check 2: "URL/Domain Analysis"
- Check 3: "Sensitive File References"
- Check 4: "Entropy Analysis (obfuscation)"
- Check 5: "Permission Keyword Scan"
- Output splits into: "Pass → Index" or "Fail → Quarantine"
- Use red/green color coding for pass/fail paths
- Style: Security-focused, professional
-->

### What We Scan For

| Check | What It Detects | Severity |
|-------|-----------------|----------|
| Jailbreak patterns | "Ignore previous instructions", "bypass safety" | Critical |
| Suspicious URLs | Links to non-allowlisted domains | High |
| Sensitive file access | References to `.env`, credentials, keys | High |
| High entropy content | Possible obfuscated/encoded payloads | Medium |
| Dangerous keywords | `rm -rf`, `eval`, `curl` to unknown hosts | Medium |

### The Allowlist

We maintain an allowlist of trusted domains. URLs pointing elsewhere get flagged:

```typescript
const ALLOWED_DOMAINS = [
  'github.com',
  'githubusercontent.com',
  'anthropic.com',
  'claude.ai',
  // Community-verified domains added over time
];
```

### Scan Results

After scanning, your skill receives a recommendation:

- **Safe** — No issues detected, proceeds to indexing
- **Review** — Minor issues flagged, indexed with warnings
- **Block** — Critical issues detected, not indexed

> **Note:** A "Review" result doesn't prevent indexing—it adds context for users deciding whether to install your skill. See our [Security Blog](/blog/security-quarantine-safe-installation) for details on trust tiers.

---

## Step 4: Scoring — How We Rank Skills

Not all skills are equal. Our scoring algorithm balances three factors to surface the best skills first.

### The Formula

```
Final Score = (0.30 × Quality) + (0.35 × Popularity) + (0.35 × Maintenance)
```

Each component produces a score between 0.0 and 1.0.

<!--
IMAGE REQUIREMENT: scoring-weights-pie.png
- Pie chart or donut chart showing the three weights
- Quality: 30% (blue)
- Popularity: 35% (green)
- Maintenance: 35% (orange)
- Clean, minimal design
- Include the percentage labels
-->

### Quality Score (30%)

We assess the craftsmanship of your skill:

| Factor | Weight | What We Check |
|--------|--------|---------------|
| SKILL.md quality | 30% | Length, structure, description clarity |
| README quality | 25% | Sections, code examples, installation guide |
| Has license | 20% | MIT, Apache-2.0, etc. |
| Has tests | 15% | Test files present |
| Has examples | 10% | Usage examples included |

**Pro tip:** A well-written `SKILL.md` with clear descriptions and examples can significantly boost your quality score.

### Popularity Score (35%)

Community signals matter:

| Factor | Weight | Normalization |
|--------|--------|---------------|
| GitHub stars | 50% | Logarithmic (10 stars = 0.25, 100 = 0.50, 1000 = 0.75) |
| Forks | 30% | Logarithmic |
| Downloads | 20% | If available from npm/registry |

We use logarithmic normalization so a skill with 100 stars isn't crushed by one with 10,000—both can rank well.

### Maintenance Score (35%)

Active maintenance signals reliability:

| Factor | Weight | Scoring |
|--------|--------|---------|
| Recency | 50% | Updated in last 30 days = 1.0, 90 days = 0.8, 180 days = 0.5 |
| Commit frequency | 30% | 4+ commits/month = 1.0 |
| Issue responsiveness | 20% | Avg close time < 7 days = 1.0 |

<!--
IMAGE REQUIREMENT: maintenance-decay-curve.png
- Line graph showing score decay over time
- X-axis: "Days since last update" (0 to 365+)
- Y-axis: "Maintenance Score" (0.0 to 1.0)
- Key points marked: 30 days (1.0), 90 days (0.8), 180 days (0.5), 365 days (0.3)
- Shows gradual decay, not cliff
- Style: Clean line chart, single color
-->

### Example Score Breakdown

Here's how a real skill might score:

```
Skill: community/react-test-helper

Quality:    0.75 (good SKILL.md, has tests, MIT license)
Popularity: 0.45 (85 stars, 12 forks)
Maintenance: 0.90 (updated 5 days ago, active commits)

Final: (0.30 × 0.75) + (0.35 × 0.45) + (0.35 × 0.90)
     = 0.225 + 0.158 + 0.315
     = 0.698

Trust Tier: Community (score > 0.4, scan passed)
```

---

## Step 5: Indexing — Making Skills Searchable

The final step stores your skill in our database and makes it searchable through two complementary systems.

### Dual Search Architecture

We combine traditional keyword search with semantic understanding:

<!--
IMAGE REQUIREMENT: hybrid-search-architecture.png
- Split diagram showing two search paths
- Left path: "Keyword Search" → "SQLite FTS5" → "Exact matches"
- Right path: "Semantic Search" → "Vector Embeddings" → "Meaning matches"
- Both paths merge into: "Hybrid Ranking" → "Search Results"
- Include example: Query "help with tests" matches both "testing" (keyword) and "Jest helper for React components" (semantic)
- Style: Technical but accessible
-->

#### Keyword Search (FTS5)

SQLite's full-text search finds exact and partial matches:

```sql
-- Your skill is searchable by name, description, and tags
CREATE VIRTUAL TABLE skills_fts USING fts5(
    name,
    description,
    search_text,  -- Concatenated searchable content
    content='skills'
);
```

When someone searches "react testing", we find skills with those exact words.

#### Semantic Search (Vector Embeddings)

But what if someone searches "help me write component tests"? That's where embeddings shine.

We generate a 384-dimensional vector for each skill using the `all-MiniLM-L6-v2` model:

```typescript
// Simplified embedding generation
const embedding = await embeddingService.embed(
  `${skill.name} ${skill.description}`
);

// Store for similarity search
await db.storeEmbedding(skill.id, embedding);
```

When you search, we:
1. Generate an embedding for your query
2. Find skills with similar embeddings (cosine similarity)
3. Combine with keyword results for final ranking

### The Skill Record

Here's what we store for each indexed skill:

```typescript
interface IndexedSkill {
  // Identity
  id: string;              // "author/skill-name"
  name: string;
  description: string;
  author: string;
  repo_url: string;

  // GitHub metrics
  stars: number;
  forks: number;
  license: string;
  updated_at: string;

  // Computed scores
  quality_score: number;
  popularity_score: number;
  maintenance_score: number;
  final_score: number;

  // Trust and security
  trust_tier: 'official' | 'verified' | 'community' | 'unverified';
  security_scan_status: 'passed' | 'review' | 'blocked';

  // Search
  embedding_id: number;    // Link to vector embedding
  indexed_at: string;
}
```

---

## How to Optimize Your Skill for Discovery

Now that you understand the pipeline, here's a checklist for maximizing your skill's visibility:

### The Essentials

- [ ] **Add `claude-skill` topic** to your GitHub repo
- [ ] **Write a clear description** (50+ characters) in your frontmatter
- [ ] **Include relevant tags** that match common search terms
- [ ] **Add a license** (MIT or Apache-2.0 recommended)

### Quality Boosters

- [ ] **Write examples** in your SKILL.md showing real usage
- [ ] **Add a comprehensive README** with installation and usage sections
- [ ] **Include tests** to demonstrate reliability
- [ ] **Use trigger phrases** that match how users naturally ask for help

### Maintenance Signals

- [ ] **Commit regularly** (even small improvements count)
- [ ] **Respond to issues** within a week when possible
- [ ] **Keep dependencies updated** to show active maintenance

### Semantic Optimization

Think about how developers search:

```yaml
# Instead of:
description: "A skill for tests"

# Write:
description: "Helps write Jest unit tests for React components with mocking and snapshot testing support"
```

The second description will match searches for: "Jest", "React", "unit tests", "mocking", "snapshots", and semantic queries like "help me test my components."

---

## What Happens After Indexing

Once indexed, your skill:

1. **Appears in search results** — Users can find it via the MCP `search` tool
2. **Gets a detail page** — The `get_skill` tool shows full metadata
3. **Can be installed** — Users install via `install_skill`
4. **Receives ongoing updates** — We re-index every 6 hours for changes

### Monitoring Your Skill

You can verify your skill's index status:

```
"Check if my skill community/my-skill is indexed"
```

Claude will use the `get_skill` tool to show your current scores and trust tier.

---

## Technical Reference

For developers who want to dive deeper:

| Resource | Description |
|----------|-------------|
| [Skill Index Schema](/docs/technical/components/skill-index.md) | Full database schema |
| [Scoring Algorithm](/docs/technical/scoring/algorithm.md) | Detailed scoring math |
| [Embedding Service](/packages/core/src/embeddings/) | Vector embedding implementation |
| [ADR-009](/docs/adr/009-embedding-service-fallback.md) | Embedding fallback strategy |

---

## Summary

Skillsmith's indexer transforms your GitHub repository into a discoverable, searchable skill through five stages:

1. **Discovery** — Daily GitHub crawls find your SKILL.md
2. **Validation** — We parse and verify your frontmatter
3. **Security Scan** — Static analysis builds trust
4. **Scoring** — Quality + Popularity + Maintenance = Final Score
5. **Indexing** — SQLite + embeddings enable hybrid search

The best way to rank higher? Build a genuinely useful skill, document it well, and maintain it actively. The algorithm rewards exactly what users want: quality, popularity, and reliability.

---

## Next Steps

- **Read the security deep-dive** — [Security, Quarantine, and Safe Skill Installation](/blog/security-quarantine-safe-installation)
- **Explore the source** — [Skillsmith Core Package](https://github.com/smith-horn/skillsmith/tree/main/packages/core)
- **Join the community** — Share your skills and get feedback from other developers

---

*Have questions about indexing? Open an issue on [GitHub](https://github.com/smith-horn/skillsmith/issues) or reach out to the team.*
