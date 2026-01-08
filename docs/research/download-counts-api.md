# Research: Download Counts API Availability

> **Navigation**: [Documentation Index](../index.md) > [Research](./index.md) > Download Counts API
>
> **Related Documents**:
> - [Research: Quality Scoring](./quality-scoring.md)
> - [Technical: Data Sync Strategy](../technical/data/sync-strategy.md)

---

> **Question**: Can we get download counts via API from claude-plugins.dev or other sources?
>
> **Date**: December 26, 2025
> **Status**: Research Complete
> **Recommendation**: Build hybrid approach using multiple data sources

---

## Executive Summary

**Finding**: No public API exists for Claude skill download counts. However, multiple alternative data sources can approximate popularity metrics.

**Recommendation**: Implement a tiered data collection strategy:
1. **Primary**: GitHub API for stars/forks (reliable, rate-limited)
2. **Secondary**: Scrape claude-plugins.dev for displayed download counts
3. **Tertiary**: Build our own telemetry for install tracking
4. **Exploratory**: Partner with claude-plugins.dev for data access

---

## 1. claude-plugins.dev Analysis

### 1.1 Architecture Overview

| Component | Details |
|-----------|---------|
| **Backend** | Val Town serverless functions |
| **API Endpoint** | `api.claude-plugins.dev/api/resolve/[identifier]` |
| **Source Code** | [github.com/Kamalnrf/claude-plugins](https://github.com/Kamalnrf/claude-plugins) |
| **Indexing** | Auto-discovers GitHub plugins every 10 minutes |
| **Scale** | 1,200+ plugins indexed |

### 1.2 Available API

The only documented API is the **resolution endpoint**:

```bash
# Resolves plugin identifier to installation URL
GET https://api.claude-plugins.dev/api/resolve/@author/marketplace/plugin
```

**Returns**: Plugin metadata for installation, NOT usage statistics.

### 1.3 Download Counts Display

The website displays download counts (e.g., "48.8k") but:
- **No documented API** for retrieving these counts
- **Source unknown** — not clear if these are:
  - Actual npm download counts
  - CLI installation tracking
  - Estimated from GitHub activity
  - Manually entered

### 1.4 Data Access Options

| Option | Feasibility | Risk |
|--------|-------------|------|
| **Scrape website** | High | ToS violation risk, fragile to UI changes |
| **Reverse-engineer API** | Medium | May break, not officially supported |
| **Fork & self-host** | High | Requires maintenance, may diverge |
| **Contact maintainer** | Medium | Depends on response |
| **Contribute API feature** | Low-Medium | Requires PR acceptance |

---

## 2. Alternative Data Sources

### 2.1 GitHub API (Primary)

**Availability**: ✅ Public, documented, reliable

```bash
# Get repository metrics
GET https://api.github.com/repos/{owner}/{repo}

# Response includes:
{
  "stargazers_count": 3,
  "forks_count": 1,
  "watchers_count": 3,
  "open_issues_count": 0,
  "subscribers_count": 1
}
```

**Rate Limits**:
- Unauthenticated: 60 requests/hour
- Authenticated: 5,000 requests/hour
- GitHub App: 15,000 requests/hour

**Pros**:
- Official, stable API
- Rich metadata (commits, contributors, releases)
- Historical data via Events API

**Cons**:
- Stars ≠ Downloads (different signal)
- Rate limits require caching strategy

### 2.2 quemsah/awesome-claude-plugins (Secondary)

**What it is**: Community project tracking Claude plugin adoption metrics.

**Data Available**:
- Repository stars
- Subscriber counts
- Plugin counts per repository
- 1,673 repositories indexed

**Access**: Website at `claude-plugins.22.deno.net`

**Limitation**: No documented API; would require scraping or forking.

### 2.3 SkillsMP.com (Secondary)

**Data Available**:
- Skills indexed: 34,400+
- Categories and tags
- GitHub stars (mirrored)

**Access**: No documented API; web scraping only.

### 2.4 npm Download Counts (If Applicable)

Some plugins are distributed via npm. For those:

```bash
# npm registry API
GET https://api.npmjs.org/downloads/point/last-month/{package}

# Response:
{
  "downloads": 12345,
  "start": "2025-11-26",
  "end": "2025-12-26",
  "package": "package-name"
}
```

**Limitation**: Only works for npm-distributed plugins, not GitHub-only skills.

### 2.5 Our Own Telemetry (Tertiary)

Build install tracking into our plugin:

```typescript
// When user installs a skill via our recommendation
async function trackInstall(skillId: string, userId: string) {
  await analytics.track({
    event: 'skill_installed',
    properties: {
      skill_id: skillId,
      source: 'recommendation',
      timestamp: new Date().toISOString()
    },
    userId: anonymize(userId)  // GDPR compliant
  });
}
```

**Pros**:
- First-party data, high accuracy
- Can track full funnel (impression → install → activation)
- Builds competitive moat over time

**Cons**:
- Cold start (no historical data)
- Only tracks installs via our plugin
- Requires user consent

---

## 3. Data Quality Comparison

| Source | Signal Type | Reliability | Coverage | Freshness |
|--------|-------------|-------------|----------|-----------|
| GitHub Stars | Popularity proxy | High | 100% | Real-time |
| GitHub Forks | Usage intent | High | 100% | Real-time |
| claude-plugins.dev | Downloads (unclear) | Medium | ~1,200 | 10-min lag |
| SkillsMP.com | GitHub mirror | Medium | ~34,000 | Daily |
| npm Downloads | Actual installs | High | npm only | Daily |
| Our Telemetry | Actual installs | Highest | Our users | Real-time |

---

## 4. Recommended Implementation

### 4.1 Phase 1: MVP (GitHub-Only)

```python
class PopularityScorer:
    """
    MVP: Use GitHub metrics as popularity proxy.
    """

    def __init__(self, github_token: str):
        self.github = GitHubAPI(token=github_token)
        self.cache = Redis()  # 1-hour TTL

    async def get_popularity_score(self, repo: str) -> float:
        # Check cache first
        cached = await self.cache.get(f"popularity:{repo}")
        if cached:
            return float(cached)

        # Fetch from GitHub
        data = await self.github.get_repo(repo)

        # Normalize to 0-1 (log scale)
        stars_norm = min(1.0, log10(data['stars'] + 1) / 4)
        forks_norm = min(1.0, log10(data['forks'] + 1) / 3)

        score = 0.6 * stars_norm + 0.4 * forks_norm

        # Cache for 1 hour
        await self.cache.set(f"popularity:{repo}", score, ex=3600)

        return score
```

### 4.2 Phase 2: Add Scraped Data

```python
class EnhancedPopularityScorer(PopularityScorer):
    """
    Phase 2: Augment with scraped download counts.
    """

    def __init__(self, github_token: str):
        super().__init__(github_token)
        self.scraper = MarketplaceScraper()

    async def get_popularity_score(self, repo: str) -> float:
        github_score = await super().get_popularity_score(repo)

        # Try to get download counts
        downloads = await self.scraper.get_downloads(repo)

        if downloads:
            downloads_norm = min(1.0, log10(downloads + 1) / 5)
            # Blend: 50% GitHub, 50% downloads
            return 0.5 * github_score + 0.5 * downloads_norm

        return github_score
```

### 4.3 Phase 3: First-Party Telemetry

```python
class TelemetryPopularityScorer(EnhancedPopularityScorer):
    """
    Phase 3: Incorporate our own install tracking.
    """

    def __init__(self, github_token: str, db: Database):
        super().__init__(github_token)
        self.db = db

    async def get_popularity_score(self, repo: str) -> float:
        base_score = await super().get_popularity_score(repo)

        # Get our install counts (last 30 days)
        our_installs = await self.db.query("""
            SELECT COUNT(*) as count
            FROM skill_interactions
            WHERE skill_repo = $1
              AND install_at > NOW() - INTERVAL '30 days'
        """, repo)

        if our_installs['count'] > 10:  # Minimum threshold
            our_score = min(1.0, log10(our_installs['count'] + 1) / 3)
            # Blend: 40% GitHub, 30% marketplace, 30% our data
            return 0.4 * base_score + 0.3 * our_score

        return base_score
```

---

## 5. Partnership Opportunity

### 5.1 Contact claude-plugins.dev Maintainer

**Proposal**: Reach out to [@Kamalnrf](https://github.com/Kamalnrf) with:

1. **Offer**: Contribute API endpoint for download counts back to the project
2. **Ask**: Access to raw download data or partnership for data sharing
3. **Benefit to them**: More utility for their platform, community goodwill

**Email Template**:

```
Subject: Collaboration: Download Counts API for claude-plugins.dev

Hi Kamal,

I'm building a Claude skill recommendation plugin and would love to incorporate
download counts from claude-plugins.dev to help users discover quality skills.

Would you be open to:
1. A data partnership where we can access download metrics?
2. Me contributing a public API endpoint for download counts?

Happy to discuss and contribute back to the project.

Best,
[Name]
```

---

## 6. Legal & Ethical Considerations

| Concern | Mitigation |
|---------|------------|
| **Scraping ToS** | Check robots.txt; rate-limit requests; cache aggressively |
| **Data accuracy** | Clearly label data sources; show confidence intervals |
| **Gaming** | Detect anomalies; weight multiple signals |
| **Attribution** | Credit data sources in UI |

---

## 7. Decision Matrix

| Approach | Effort | Data Quality | Risk | Recommendation |
|----------|--------|--------------|------|----------------|
| GitHub API only | Low | Medium | Low | ✅ Start here |
| + Scraping | Medium | Medium-High | Medium | ✅ Phase 2 |
| + Own telemetry | High | High | Low | ✅ Phase 3 |
| Partnership | Low | High | Low | ⭐ Pursue in parallel |

---

## 8. Next Steps

| Action | Owner | Timeline |
|--------|-------|----------|
| Implement GitHub-based scoring | Engineering | Week 1 |
| Contact claude-plugins.dev maintainer | Product | Week 1 |
| Build scraper for marketplace data | Engineering | Week 2 |
| Design telemetry schema | Engineering | Week 2 |
| Implement consent flow | Engineering | Week 3 |

---

## Sources

- [claude-plugins.dev](https://claude-plugins.dev/) - Community plugin registry
- [Kamalnrf/claude-plugins](https://github.com/Kamalnrf/claude-plugins) - Source code
- [quemsah/awesome-claude-plugins](https://github.com/quemsah/awesome-claude-plugins) - Adoption metrics
- [GitHub REST API](https://docs.github.com/en/rest) - Official documentation
- [npm Registry API](https://github.com/npm/registry/blob/master/docs/download-counts.md) - Download counts

---

*Document generated: December 26, 2025*
