# Integration Architecture

> **Navigation**: [Technical Overview](../technical/overview.md) | [PRD v3](../prd-v3.md) | [Layer 2 Ecosystem](../research/layers/layer-2-synthesis.md)

**Version:** 1.0
**Last Updated:** December 26, 2025
**Author:** Integration Architect
**Status:** Design Phase

---

## Executive Summary

This document defines the integration architecture for Claude Discovery Hub, covering all external touchpoints: data source aggregation, Claude Code integration, IDE extensions, web interfaces, and the Anthropic partnership pathway. The design prioritizes reliability, rate limit management, graceful degradation, and future extensibility.

### Key Design Principles

| Principle | Description | Rationale |
|-----------|-------------|-----------|
| **Aggregation-First** | Pull from all sources, normalize to common schema | No single source has complete data |
| **Graceful Degradation** | System works with partial data | External services will fail |
| **Rate Limit Aware** | Budget-based API consumption | GitHub has 5K/hr limit |
| **Cache-Aggressive** | Local-first with smart invalidation | Reduce external dependencies |
| **Schema-Stable** | Internal schema evolves independently | External formats change unpredictably |

---

## Table of Contents

1. [External Data Source Integrations](#1-external-data-source-integrations)
2. [Claude Code Integration](#2-claude-code-integration)
3. [IDE Integrations](#3-ide-integrations)
4. [Web Integration](#4-web-integration)
5. [Anthropic Partnership Path](#5-anthropic-partnership-path)
6. [Integration Monitoring](#6-integration-monitoring)
7. [Appendix: API Reference](#appendix-api-reference)

---

## 1. External Data Source Integrations

### 1.1 Integration Architecture Overview

```
+============================================================================+
|                    EXTERNAL DATA SOURCE INTEGRATION                         |
+============================================================================+

                          +-------------------+
                          |   Sync Scheduler  |
                          | (Node.js Cron)    |
                          +-------------------+
                                   |
         +-------------------------+-------------------------+
         |                         |                         |
         v                         v                         v
+------------------+    +------------------+    +------------------+
|  GitHub Adapter  |    | SkillsMP Adapter |    |  Plugins Adapter |
|                  |    |                  |    |                  |
| - REST API       |    | - Scraper        |    | - Scraper        |
| - GraphQL API    |    | - API (if avail) |    | - RSS Feed       |
| - Events API     |    |                  |    |                  |
+------------------+    +------------------+    +------------------+
         |                         |                         |
         v                         v                         v
+------------------+    +------------------+    +------------------+
|   Rate Limiter   |    |   Rate Limiter   |    |   Rate Limiter   |
| - Token rotation |    | - Delay queue    |    | - Delay queue    |
| - Backoff        |    | - 10 req/min     |    | - 10 req/min     |
+------------------+    +------------------+    +------------------+
         |                         |                         |
         +-------------------------+-------------------------+
                                   |
                                   v
                    +----------------------------+
                    |     Normalizer Pipeline    |
                    | - Schema mapping           |
                    | - Deduplication            |
                    | - Quality scoring          |
                    | - Trust tier assignment    |
                    +----------------------------+
                                   |
                                   v
                    +----------------------------+
                    |     SQLite Skill Index     |
                    | - FTS5 for search          |
                    | - Embeddings (external)    |
                    +----------------------------+
```

---

### 1.2 GitHub API Integration

#### Overview

GitHub is the primary data source, hosting the majority of skills and providing rich metadata (stars, forks, activity, license, etc.).

#### API Strategy

| Endpoint | Purpose | Rate Limit | Strategy |
|----------|---------|------------|----------|
| `GET /search/repositories` | Skill discovery | 30 req/min | Batch queries, cache results |
| `GET /repos/{owner}/{repo}` | Metadata fetch | 5,000/hr | Conditional requests (ETag) |
| `GET /repos/{owner}/{repo}/contents` | SKILL.md content | 5,000/hr | Selective fetch |
| `GET /events` | Incremental updates | 60 req/hr | Replace full sync |
| GraphQL API | Batch metadata | 5,000 points/hr | Complex queries |

#### Authentication Strategy

```typescript
interface GitHubAuthConfig {
  // Personal Access Tokens (PAT) rotation
  tokens: string[];
  current_index: number;

  // GitHub App for higher limits (15K/hr)
  app: {
    app_id: string;
    installation_id: string;
    private_key: string;
  } | null;

  // Fallback to unauthenticated (60/hr)
  allow_unauthenticated: boolean;
}

class GitHubRateLimiter {
  private tokens: TokenBucket[];
  private current: number = 0;

  async getToken(): Promise<string> {
    const bucket = this.tokens[this.current];

    if (bucket.remaining < 100) {
      // Rotate to next token
      this.current = (this.current + 1) % this.tokens.length;

      if (this.allExhausted()) {
        await this.waitForReset();
      }
    }

    return bucket.token;
  }

  async trackUsage(response: Response): Promise<void> {
    const remaining = parseInt(response.headers.get('x-ratelimit-remaining') || '0');
    const reset = parseInt(response.headers.get('x-ratelimit-reset') || '0');

    this.tokens[this.current].remaining = remaining;
    this.tokens[this.current].reset_at = new Date(reset * 1000);
  }
}
```

#### Search Queries

```typescript
const SKILL_DISCOVERY_QUERIES = [
  // Topic-based discovery
  'topic:mcp-server',
  'topic:claude-skill',
  'topic:claude-code-skill',
  'topic:anthropic-skills',

  // File-based discovery
  'filename:SKILL.md',
  'filename:skill.md',
  'filename:mcp.json',

  // Description-based discovery
  'claude code skill in:description',
  'mcp server in:description',
];

async function discoverSkills(): Promise<Skill[]> {
  const skills: Skill[] = [];

  for (const query of SKILL_DISCOVERY_QUERIES) {
    const results = await github.searchRepositories({
      q: query,
      sort: 'updated',
      per_page: 100,
    });

    skills.push(...results.items.map(normalizeGitHubRepo));
  }

  return deduplicateByUrl(skills);
}
```

#### Incremental Sync with Events API

```typescript
interface IncrementalSyncConfig {
  // Use Events API for efficient updates
  events_endpoint: '/events';

  // Relevant event types
  event_types: [
    'PushEvent',        // Code updates
    'CreateEvent',      // New repos/tags
    'ReleaseEvent',     // New releases
    'WatchEvent',       // Stars
    'ForkEvent',        // Forks
  ];

  // Polling interval
  poll_interval_minutes: 15;

  // Track last seen event
  last_event_id: string | null;
}

async function incrementalSync(): Promise<SyncResult> {
  const state = await getLastSyncState();

  // Fetch new events since last sync
  const events = await github.getEvents({
    since: state.last_event_id,
    per_page: 100,
  });

  const relevantRepos = events
    .filter(e => RELEVANT_EVENT_TYPES.includes(e.type))
    .map(e => e.repo.name)
    .filter(unique);

  // Batch update only changed repos
  for (const repo of relevantRepos) {
    await updateSkillFromRepo(repo);
  }

  return { updated: relevantRepos.length };
}
```

#### Rate Limit Budget Calculator

```
Daily Budget Calculation (with 3 PAT tokens):
----------------------------------------------
Base limit per token:     5,000 req/hr
Tokens available:         3
Total hourly capacity:    15,000 req/hr
Daily capacity:           360,000 req/day

Estimated daily needs:
- Full sync (50K skills):     500 req (batched)
- Incremental sync (24x):     2,400 req
- User-triggered refreshes:   500 req
- Metadata updates:           1,000 req
----------------------------------------------
Total estimated:              4,400 req/day
Headroom:                     355,600 req/day (98.8%)
```

---

### 1.3 SkillsMP Integration

#### Overview

SkillsMP (skillsmp.com) indexes 25,000+ skills with cross-platform aggregation. No official API exists, requiring web scraping.

#### Integration Strategy

| Aspect | Approach | Rationale |
|--------|----------|-----------|
| Method | Web Scraping + Potential API | No official API documented |
| Frequency | Daily (off-peak hours) | Minimize server load |
| Rate Limit | 10 requests/minute | Respectful scraping |
| Fallback | Cached data (7-day TTL) | Graceful degradation |

#### Scraper Architecture

```typescript
interface SkillsMPScraperConfig {
  base_url: 'https://skillsmp.com';

  rate_limit: {
    requests_per_minute: 10;
    min_delay_ms: 6000; // 6 seconds between requests
  };

  // Respect robots.txt
  respect_robots: true;
  user_agent: 'ClaudeDiscoveryHub/1.0 (+https://discoveries.dev)';

  // Retry configuration
  retry: {
    max_attempts: 3;
    backoff_strategy: 'exponential';
    initial_delay_ms: 5000;
  };

  // Cache configuration
  cache_ttl_hours: 24;
}

interface SkillsMPSkill {
  id: string;
  name: string;
  description: string;
  author: string;
  url: string;
  category: string;
  tags: string[];
  platform: 'claude' | 'cursor' | 'other';
  indexed_at: string;
}

class SkillsMPScraper {
  async fetchSkillsDirectory(): Promise<SkillsMPSkill[]> {
    // Check robots.txt first
    const robotsAllowed = await this.checkRobotsTxt('/skills');
    if (!robotsAllowed) {
      logger.warn('SkillsMP robots.txt disallows scraping');
      return this.getFallbackCache();
    }

    const skills: SkillsMPSkill[] = [];
    let page = 1;

    while (true) {
      await this.rateLimit();

      const response = await fetch(
        `${this.config.base_url}/skills?page=${page}`,
        { headers: this.getHeaders() }
      );

      if (!response.ok) {
        throw new ScraperError(`HTTP ${response.status}`);
      }

      const html = await response.text();
      const pageSkills = this.parseSkillsPage(html);

      if (pageSkills.length === 0) break;

      skills.push(...pageSkills);
      page++;
    }

    return skills;
  }

  private parseSkillsPage(html: string): SkillsMPSkill[] {
    // Use cheerio for HTML parsing
    const $ = cheerio.load(html);
    const skills: SkillsMPSkill[] = [];

    $('.skill-card').each((_, element) => {
      skills.push({
        id: $(element).attr('data-skill-id'),
        name: $(element).find('.skill-name').text().trim(),
        description: $(element).find('.skill-description').text().trim(),
        author: $(element).find('.skill-author').text().trim(),
        url: $(element).find('a.skill-link').attr('href'),
        category: $(element).find('.skill-category').text().trim(),
        tags: $(element).find('.skill-tag').map((_, t) => $(t).text()).get(),
        platform: this.detectPlatform($(element)),
        indexed_at: new Date().toISOString(),
      });
    });

    return skills;
  }
}
```

#### API Discovery and Migration Path

```typescript
// If SkillsMP exposes an API, migrate to it
interface SkillsMPAPIClient {
  // Potential API endpoints (speculative)
  endpoints: {
    list: '/api/v1/skills';
    search: '/api/v1/skills/search';
    detail: '/api/v1/skills/:id';
  };

  // Authentication (if required)
  auth: {
    type: 'api_key' | 'oauth' | 'none';
    key?: string;
  };
}

async function getSkillsMPClient(): Promise<SkillsMPScraper | SkillsMPAPIClient> {
  // Probe for API availability
  try {
    const apiCheck = await fetch('https://skillsmp.com/api/v1/health');
    if (apiCheck.ok) {
      return new SkillsMPAPIClient();
    }
  } catch {
    // Fall back to scraper
  }

  return new SkillsMPScraper();
}
```

---

### 1.4 claude-plugins.dev Integration

#### Overview

claude-plugins.dev indexes 8,412+ plugins/skills with download counts and categories.

#### Integration Architecture

```typescript
interface ClaudePluginsConfig {
  base_url: 'https://claude-plugins.dev';

  // Data sources
  sources: {
    // Primary: RSS/Atom feed (if available)
    rss_feed: '/feed.xml';

    // Secondary: API (if available)
    api: '/api/plugins';

    // Tertiary: Web scraping
    scraper: true;
  };

  rate_limit: {
    requests_per_minute: 10;
    min_delay_ms: 6000;
  };

  cache_ttl_hours: 24;
}

interface ClaudePlugin {
  id: string;
  name: string;
  description: string;
  author: string;
  repo_url: string;
  download_count: number;
  category: string;
  has_agent_skills: boolean;
  last_updated: string;
}

class ClaudePluginsAdapter {
  async fetchPlugins(): Promise<ClaudePlugin[]> {
    // Try RSS first (most efficient)
    try {
      return await this.fetchFromRSS();
    } catch {
      logger.info('RSS not available, trying API');
    }

    // Try API
    try {
      return await this.fetchFromAPI();
    } catch {
      logger.info('API not available, falling back to scraper');
    }

    // Fall back to scraping
    return await this.scrapeDirectory();
  }

  private async fetchFromRSS(): Promise<ClaudePlugin[]> {
    const response = await fetch(`${this.config.base_url}/feed.xml`);
    const xml = await response.text();
    const feed = await parseRSSFeed(xml);

    return feed.items.map(this.rssItemToPlugin);
  }

  private async scrapeDirectory(): Promise<ClaudePlugin[]> {
    const plugins: ClaudePlugin[] = [];
    let page = 1;

    while (true) {
      await this.rateLimit();

      const html = await this.fetchPage(`/plugins?page=${page}`);
      const pagePlugins = this.parsePluginsPage(html);

      if (pagePlugins.length === 0) break;

      plugins.push(...pagePlugins);
      page++;
    }

    return plugins;
  }
}
```

---

### 1.5 mcp.so Integration

#### Overview

mcp.so is the largest MCP registry with 17,237+ servers indexed.

#### Integration Strategy

```typescript
interface MCPSoConfig {
  base_url: 'https://mcp.so';

  // API endpoints (if available)
  api: {
    servers: '/api/servers';
    search: '/api/search';
    categories: '/api/categories';
  };

  rate_limit: {
    requests_per_hour: 100;
  };

  // Focus on Claude-compatible servers
  filters: {
    platforms: ['claude', 'universal'];
    categories: ['development', 'productivity', 'utilities'];
  };
}

class MCPSoAdapter {
  async fetchServers(): Promise<MCPServer[]> {
    // mcp.so may have an API - check first
    const apiAvailable = await this.checkAPIAvailability();

    if (apiAvailable) {
      return this.fetchFromAPI();
    }

    return this.scrapeDirectory();
  }

  private async fetchFromAPI(): Promise<MCPServer[]> {
    const servers: MCPServer[] = [];
    let cursor: string | null = null;

    do {
      const response = await fetch(
        `${this.config.base_url}/api/servers?cursor=${cursor || ''}`
      );
      const data = await response.json();

      servers.push(...data.servers);
      cursor = data.next_cursor;
    } while (cursor);

    return servers;
  }
}
```

---

### 1.6 npm Registry Integration

#### Overview

npm Registry provides metadata for skills published as npm packages.

#### Integration Architecture

```typescript
interface NpmRegistryConfig {
  registry_url: 'https://registry.npmjs.org';

  // Search for relevant packages
  search_queries: [
    'keywords:claude-skill',
    'keywords:mcp-server',
    'keywords:claude-code',
  ];

  // Rate limits (generous)
  rate_limit: {
    requests_per_minute: 60;
  };

  // Weekly sync (npm packages change less frequently)
  sync_frequency: 'weekly';
}

interface NpmPackage {
  name: string;
  version: string;
  description: string;
  author: string | { name: string; email?: string };
  repository: { url: string };
  keywords: string[];
  downloads: {
    weekly: number;
    monthly: number;
  };
}

class NpmRegistryAdapter {
  async searchPackages(): Promise<NpmPackage[]> {
    const packages: NpmPackage[] = [];

    for (const query of this.config.search_queries) {
      const response = await fetch(
        `${this.config.registry_url}/-/v1/search?text=${encodeURIComponent(query)}&size=250`
      );
      const data = await response.json();

      for (const result of data.objects) {
        packages.push({
          name: result.package.name,
          version: result.package.version,
          description: result.package.description,
          author: result.package.author,
          repository: result.package.links.repository,
          keywords: result.package.keywords || [],
          downloads: await this.fetchDownloads(result.package.name),
        });
      }
    }

    return packages;
  }

  private async fetchDownloads(packageName: string): Promise<Downloads> {
    const response = await fetch(
      `https://api.npmjs.org/downloads/point/last-week/${packageName}`
    );
    const data = await response.json();

    return {
      weekly: data.downloads,
      monthly: data.downloads * 4, // Estimate
    };
  }
}
```

---

### 1.7 Data Normalization Pipeline

#### Unified Skill Schema

```typescript
interface UnifiedSkill {
  // Identity
  id: string;                    // Canonical ID: "{source}/{author}/{name}"
  name: string;
  description: string;

  // Authorship
  author: string;
  author_url: string;

  // Source tracking
  sources: SkillSource[];        // Can come from multiple sources
  primary_source: string;        // Canonical source

  // Repository info
  repo_url: string;
  repo_platform: 'github' | 'gitlab' | 'bitbucket' | 'other';

  // Metrics (aggregated from all sources)
  stars: number;
  forks: number;
  downloads: number;

  // Quality indicators
  quality_score: number;         // 0.0 - 1.0
  trust_tier: TrustTier;

  // Content analysis
  has_skillmd: boolean;
  skillmd_quality: number;
  has_tests: boolean;
  has_examples: boolean;
  license: string | null;

  // Classification
  categories: string[];
  technologies: string[];
  tags: string[];

  // Temporal
  created_at: string;
  updated_at: string;
  indexed_at: string;
  last_scored_at: string;
}

interface SkillSource {
  source: 'github' | 'skillsmp' | 'claude-plugins' | 'mcp.so' | 'npm';
  source_id: string;
  source_url: string;
  last_synced: string;
  metadata: Record<string, any>;
}
```

#### Normalization Pipeline

```
Raw Data (GitHub)     Raw Data (SkillsMP)    Raw Data (Plugins)
       |                      |                      |
       v                      v                      v
+-------------+        +-------------+        +-------------+
|  GitHub     |        |  SkillsMP   |        |  Plugins    |
|  Normalizer |        |  Normalizer |        |  Normalizer |
+-------------+        +-------------+        +-------------+
       |                      |                      |
       +----------------------+----------------------+
                              |
                              v
                    +-------------------+
                    |   Deduplicator    |
                    | (by repo_url)     |
                    +-------------------+
                              |
                              v
                    +-------------------+
                    |   Merger          |
                    | (combine sources) |
                    +-------------------+
                              |
                              v
                    +-------------------+
                    |  Quality Scorer   |
                    +-------------------+
                              |
                              v
                    +-------------------+
                    |  Trust Tier       |
                    |  Assigner         |
                    +-------------------+
                              |
                              v
                    +-------------------+
                    |  SQLite Writer    |
                    +-------------------+
```

#### Deduplication Logic

```typescript
function deduplicateSkills(skills: UnifiedSkill[]): UnifiedSkill[] {
  const byRepoUrl = new Map<string, UnifiedSkill[]>();

  // Group by normalized repo URL
  for (const skill of skills) {
    const normalizedUrl = normalizeRepoUrl(skill.repo_url);
    const existing = byRepoUrl.get(normalizedUrl) || [];
    existing.push(skill);
    byRepoUrl.set(normalizedUrl, existing);
  }

  // Merge duplicates
  const merged: UnifiedSkill[] = [];

  for (const [url, duplicates] of byRepoUrl) {
    if (duplicates.length === 1) {
      merged.push(duplicates[0]);
    } else {
      merged.push(mergeSkillDuplicates(duplicates));
    }
  }

  return merged;
}

function mergeSkillDuplicates(duplicates: UnifiedSkill[]): UnifiedSkill {
  // Take the most complete record as base
  const base = duplicates.reduce((a, b) =>
    completenessScore(a) > completenessScore(b) ? a : b
  );

  return {
    ...base,
    sources: duplicates.flatMap(d => d.sources),
    // Aggregate metrics
    stars: Math.max(...duplicates.map(d => d.stars)),
    downloads: duplicates.reduce((sum, d) => sum + d.downloads, 0),
    // Merge classifications
    categories: [...new Set(duplicates.flatMap(d => d.categories))],
    technologies: [...new Set(duplicates.flatMap(d => d.technologies))],
    tags: [...new Set(duplicates.flatMap(d => d.tags))],
  };
}
```

---

## 2. Claude Code Integration

### 2.1 MCP Protocol Integration

#### Architecture Overview

```
+============================================================================+
|                      CLAUDE CODE INTEGRATION                                |
+============================================================================+

    +-------------------+
    |   Claude Code     |
    |   Terminal        |
    +-------------------+
            |
            | MCP Protocol (JSON-RPC over stdio)
            v
    +-------------------+
    |   MCP Transport   |
    |   Layer           |
    +-------------------+
            |
            +---------------------------+
            |                           |
            v                           v
    +---------------+           +---------------+
    | discovery-    |           |   learning    |
    | core MCP      |           |   MCP Server  |
    +---------------+           +---------------+
            |
            +---------------------------+
            |                           |
            v                           v
    +---------------+           +---------------+
    | SQLite Index  |           | External APIs |
    +---------------+           +---------------+
```

#### MCP Server Registration

```json
// ~/.claude/mcp_servers.json
{
  "mcpServers": {
    "discovery-core": {
      "command": "node",
      "args": ["/path/to/discovery-core/dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}",
        "DB_PATH": "~/.claude-discovery/index/skills.db"
      }
    },
    "learning": {
      "command": "node",
      "args": ["/path/to/learning/dist/index.js"],
      "env": {
        "PROGRESS_PATH": "~/.claude-discovery/docs/learning/progress.md"
      }
    }
  }
}
```

#### MCP Tool Implementation

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new Server(
  {
    name: 'discovery-core',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'search',
      description: 'Search the skill index for skills matching a query',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          filters: {
            type: 'object',
            properties: {
              categories: { type: 'array', items: { type: 'string' } },
              trust_tier: { type: 'array', items: { type: 'string' } },
              min_score: { type: 'number' },
            },
          },
          limit: { type: 'number', default: 10 },
        },
        required: ['query'],
      },
    },
    // ... other tools
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case 'search':
      return await handleSearch(request.params.arguments);
    case 'get_skill':
      return await handleGetSkill(request.params.arguments);
    case 'recommend_skills':
      return await handleRecommendSkills(request.params.arguments);
    case 'install_skill':
      return await handleInstallSkill(request.params.arguments);
    case 'audit_activation':
      return await handleAuditActivation(request.params.arguments);
    default:
      throw new Error(`Unknown tool: ${request.params.name}`);
  }
});

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
```

---

### 2.2 Skill Attribution Mechanism

#### The Challenge

Claude Code auto-invokes skills silently, making capabilities invisible to users. This is the "Invisibility Problem" from Layer 1 research.

#### Solution Architecture: Dual-Path Strategy

```
+==========================================================================+
|                    SKILL ATTRIBUTION ARCHITECTURE                         |
+==========================================================================+

PATH A: Workaround (Independent)        PATH B: Native (Partnership)
+------------------------------+        +------------------------------+
|                              |        |                              |
|  Post-Response Attribution   |        |  Claude Code Integration     |
|                              |        |                              |
|  +------------------------+  |        |  +------------------------+  |
|  | Claude generates       |  |        |  | Claude Code natively   |  |
|  | response               |  |        |  | shows:                 |  |
|  +------------------------+  |        |  |                        |  |
|             |                |        |  | "Using: TDD Skill"     |  |
|             v                |        |  | [inline in terminal]   |  |
|  +------------------------+  |        |  +------------------------+  |
|  | Discovery Hub MCP      |  |        |                              |
|  | appends attribution:   |  |        |  Requires Anthropic          |
|  |                        |  |        |  partnership agreement       |
|  | "Skills used: TDD"     |  |        |                              |
|  +------------------------+  |        +------------------------------+
|                              |
+------------------------------+
```

#### Path A: Workaround Implementation

##### Option 1: Post-Response Hook

```typescript
// Hook into Claude Code output via MCP
interface SkillAttributionHook {
  // Monitor skill invocations
  onSkillInvoked(skill: SkillInfo): void;

  // Append attribution to output
  appendAttribution(skills: SkillInfo[]): string;
}

class AttributionManager {
  private invokedSkills: SkillInfo[] = [];

  trackInvocation(skill: SkillInfo): void {
    this.invokedSkills.push(skill);
  }

  getAttributionMessage(): string {
    if (this.invokedSkills.length === 0) {
      return '';
    }

    const skillNames = this.invokedSkills.map(s => s.name).join(', ');
    return `\n---\nSkills used in this response: ${skillNames}`;
  }

  reset(): void {
    this.invokedSkills = [];
  }
}
```

##### Option 2: SKILL.md Injection

```markdown
<!-- In SKILL.md -->
# TDD Skill

## Instructions

When using this skill, always prefix your response with:
"[Using: TDD Skill]"

Then proceed with the task...
```

##### Option 3: MCP Notification Channel

```typescript
// Use MCP to send notifications about skill usage
interface SkillUsageNotification {
  type: 'skill_invoked';
  skill_id: string;
  skill_name: string;
  timestamp: string;
  context: {
    task_type: string;
    files_involved: string[];
  };
}

// Discovery Hub MCP server listens for these
server.setRequestHandler(NotificationSchema, async (notification) => {
  if (notification.type === 'skill_invoked') {
    await logSkillUsage(notification);
    await updateUserDashboard(notification);
  }
});
```

#### Path B: Native Integration Requirements

For Anthropic partnership, propose:

```typescript
interface NativeSkillAttributionAPI {
  // Claude Code surfaces skill usage in terminal
  terminal: {
    // Inline indicator during response
    showInlineIndicator: boolean;  // "[Using: TDD Skill]"

    // Summary at end of response
    showSummary: boolean;          // "Skills used: TDD, Testing"

    // Styling
    style: 'subtle' | 'prominent';
  };

  // API for Discovery Hub to query usage
  api: {
    // Get skills invoked in current session
    getSessionSkillUsage(): SkillUsage[];

    // Get historical skill usage
    getSkillUsageHistory(options: QueryOptions): SkillUsage[];

    // Subscribe to real-time usage events
    onSkillInvoked(callback: (usage: SkillUsage) => void): Subscription;
  };
}
```

---

### 2.3 Terminal Output Integration

#### Output Formatting

```typescript
interface TerminalOutputFormatter {
  // Format search results for terminal display
  formatSearchResults(results: SearchResults): string;

  // Format skill details
  formatSkillDetail(skill: SkillDetail): string;

  // Format recommendations
  formatRecommendations(recommendations: Recommendation[]): string;

  // Format audit report
  formatAuditReport(report: AuditReport): string;
}

class TerminalFormatter implements TerminalOutputFormatter {
  formatSearchResults(results: SearchResults): string {
    const lines = [
      `Found ${results.total} skills matching your query:\n`,
    ];

    for (const skill of results.results) {
      lines.push(this.formatSkillSummary(skill));
    }

    if (results.has_more) {
      lines.push(`\n... and ${results.total - results.results.length} more.`);
      lines.push(`Use \`/discover search "${results.query}" --offset ${results.results.length}\` to see more.`);
    }

    return lines.join('\n');
  }

  private formatSkillSummary(skill: SkillSummary): string {
    const trustBadge = this.getTrustBadge(skill.trust_tier);
    const scoreBar = this.getScoreBar(skill.final_score);

    return `
${trustBadge} ${skill.name}
   ${skill.description.substring(0, 80)}...
   Score: ${scoreBar} (${(skill.final_score * 100).toFixed(0)}%)
   Stars: ${skill.stars} | Install: \`/discover install ${skill.id}\`
`;
  }

  private getTrustBadge(tier: TrustTier): string {
    const badges = {
      official: '[OFFICIAL]',
      verified: '[VERIFIED]',
      community: '[COMMUNITY]',
      unverified: '[UNVERIFIED]',
    };
    return badges[tier];
  }

  private getScoreBar(score: number): string {
    const filled = Math.round(score * 10);
    const empty = 10 - filled;
    return '[' + '='.repeat(filled) + ' '.repeat(empty) + ']';
  }
}
```

---

## 3. IDE Integrations

### 3.1 VS Code Extension Architecture

#### Extension Structure

```
claude-discovery-vscode/
+-- package.json              # Extension manifest
+-- src/
|   +-- extension.ts          # Entry point
|   +-- providers/
|   |   +-- skill-browser.ts  # Sidebar webview provider
|   |   +-- suggestions.ts    # Context-aware suggestions
|   |   +-- hover.ts          # Skill info on hover
|   +-- services/
|   |   +-- mcp-client.ts     # Communication with MCP servers
|   |   +-- context.ts        # File context analysis
|   |   +-- cache.ts          # Local caching
|   +-- views/
|   |   +-- sidebar/          # React components for sidebar
|   |   +-- webview.html      # Webview template
+-- media/
    +-- icons/                # Skill icons, badges
    +-- styles/               # CSS
```

#### Extension Manifest

```json
{
  "name": "claude-discovery",
  "displayName": "Claude Discovery Hub",
  "description": "Discover and manage Claude Code skills",
  "version": "1.0.0",
  "engines": {
    "vscode": "^1.85.0"
  },
  "categories": ["Other"],
  "activationEvents": [
    "onStartupFinished"
  ],
  "main": "./dist/extension.js",
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        {
          "id": "claude-discovery",
          "title": "Claude Discovery",
          "icon": "media/icons/discovery.svg"
        }
      ]
    },
    "views": {
      "claude-discovery": [
        {
          "type": "webview",
          "id": "claude-discovery.skillBrowser",
          "name": "Skill Browser"
        },
        {
          "id": "claude-discovery.recommendations",
          "name": "Recommendations"
        },
        {
          "id": "claude-discovery.installed",
          "name": "Installed Skills"
        }
      ]
    },
    "commands": [
      {
        "command": "claude-discovery.search",
        "title": "Search Skills",
        "category": "Claude Discovery"
      },
      {
        "command": "claude-discovery.recommend",
        "title": "Get Recommendations",
        "category": "Claude Discovery"
      },
      {
        "command": "claude-discovery.install",
        "title": "Install Skill",
        "category": "Claude Discovery"
      }
    ],
    "configuration": {
      "title": "Claude Discovery",
      "properties": {
        "claudeDiscovery.showSuggestions": {
          "type": "boolean",
          "default": true,
          "description": "Show skill suggestions based on open files"
        },
        "claudeDiscovery.suggestionFrequency": {
          "type": "string",
          "enum": ["always", "daily", "weekly", "never"],
          "default": "daily",
          "description": "How often to show skill suggestions"
        },
        "claudeDiscovery.mcpServerPath": {
          "type": "string",
          "description": "Path to discovery-core MCP server"
        }
      }
    }
  }
}
```

### 3.2 Communication with MCP Servers

#### MCP Client for VS Code

```typescript
import { spawn, ChildProcess } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

class MCPClientService {
  private client: Client | null = null;
  private process: ChildProcess | null = null;

  async connect(serverPath: string): Promise<void> {
    // Spawn MCP server process
    this.process = spawn('node', [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Create transport
    const transport = new StdioClientTransport({
      reader: this.process.stdout!,
      writer: this.process.stdin!,
    });

    // Create client
    this.client = new Client(
      { name: 'vscode-extension', version: '1.0.0' },
      { capabilities: {} }
    );

    await this.client.connect(transport);
  }

  async search(query: string, filters?: SearchFilters): Promise<SearchResults> {
    if (!this.client) {
      throw new Error('MCP client not connected');
    }

    const result = await this.client.callTool('search', {
      query,
      filters,
    });

    return result.content as SearchResults;
  }

  async recommendForFile(filePath: string): Promise<Recommendation[]> {
    if (!this.client) {
      throw new Error('MCP client not connected');
    }

    const result = await this.client.callTool('recommend_skills', {
      path: filePath,
      max_results: 5,
      include_reasons: true,
    });

    return result.content.recommendations;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }

    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }
}
```

### 3.3 Context-Aware Suggestion Mechanism

#### File Context Analysis

```typescript
interface FileContext {
  language: string;
  framework: string | null;
  libraries: string[];
  patterns: string[];   // e.g., 'testing', 'api', 'ui'
}

class ContextAnalyzer {
  private languageDetectors: Map<string, LanguageDetector>;

  async analyzeFile(document: vscode.TextDocument): Promise<FileContext> {
    const language = document.languageId;
    const content = document.getText();
    const fileName = path.basename(document.fileName);

    return {
      language,
      framework: this.detectFramework(content, language),
      libraries: this.detectLibraries(content, language),
      patterns: this.detectPatterns(content, fileName),
    };
  }

  private detectFramework(content: string, language: string): string | null {
    const detectors: Record<string, RegExp[]> = {
      typescript: [
        /from ['"]react['"]/,     // React
        /from ['"]vue['"]/,       // Vue
        /from ['"]@angular/,      // Angular
        /from ['"]next['"]/,      // Next.js
        /from ['"]@nestjs/,       // NestJS
      ],
      python: [
        /from flask import/,      // Flask
        /from django import/,     // Django
        /from fastapi import/,    // FastAPI
      ],
    };

    // Match against patterns
    for (const [name, patterns] of Object.entries(detectors[language] || [])) {
      if (patterns.some(p => p.test(content))) {
        return name;
      }
    }

    return null;
  }

  private detectPatterns(content: string, fileName: string): string[] {
    const patterns: string[] = [];

    // Test files
    if (/\.(test|spec)\.[jt]sx?$/.test(fileName)) {
      patterns.push('testing');
    }

    // API routes
    if (/api|route|controller/.test(fileName.toLowerCase())) {
      patterns.push('api');
    }

    // Components
    if (/component|view|page/.test(fileName.toLowerCase())) {
      patterns.push('ui');
    }

    return patterns;
  }
}
```

#### Suggestion Provider

```typescript
class SkillSuggestionProvider {
  private mcpClient: MCPClientService;
  private contextAnalyzer: ContextAnalyzer;
  private lastSuggestionTime: Date | null = null;

  async getSuggestionsForDocument(
    document: vscode.TextDocument
  ): Promise<Suggestion[]> {
    // Check if we should show suggestions
    if (!this.shouldShowSuggestions()) {
      return [];
    }

    // Analyze document context
    const context = await this.contextAnalyzer.analyzeFile(document);

    // Get recommendations from MCP server
    const recommendations = await this.mcpClient.recommendForFile(
      document.fileName
    );

    // Filter and rank based on context
    const relevant = recommendations.filter(r =>
      this.isRelevantToContext(r, context)
    );

    // Convert to suggestions
    return relevant.map(r => ({
      skill: r.skill,
      reason: this.formatReason(r, context),
      confidence: r.score,
      actions: [
        { label: 'Install', command: 'claude-discovery.install', args: [r.skill.id] },
        { label: 'More Info', command: 'claude-discovery.showInfo', args: [r.skill.id] },
        { label: 'Dismiss', command: 'claude-discovery.dismiss', args: [r.skill.id] },
      ],
    }));
  }

  private shouldShowSuggestions(): boolean {
    const config = vscode.workspace.getConfiguration('claudeDiscovery');
    const frequency = config.get<string>('suggestionFrequency');

    if (frequency === 'never') return false;
    if (frequency === 'always') return true;

    if (!this.lastSuggestionTime) return true;

    const now = new Date();
    const hoursSince = (now.getTime() - this.lastSuggestionTime.getTime()) / (1000 * 60 * 60);

    if (frequency === 'daily') return hoursSince >= 24;
    if (frequency === 'weekly') return hoursSince >= 168;

    return true;
  }
}
```

---

## 4. Web Integration

### 4.1 Static Site Architecture

#### Technology Stack

| Layer | Technology | Rationale |
|-------|------------|-----------|
| Framework | Astro | Static-first, great SEO, partial hydration |
| Styling | Tailwind CSS | Utility-first, fast iteration |
| Components | React (islands) | Interactive elements only |
| Hosting | Vercel/Cloudflare Pages | Free, fast, global CDN |
| Search | Client-side SQLite | Offline-capable, no backend |

#### Site Structure

```
discoveries.dev/
+-- /                           # Homepage with search
+-- /skills/                    # Skill browser (paginated)
+-- /skills/[category]/         # Category pages
+-- /skills/[id]/               # Skill detail pages
+-- /compare/                   # Side-by-side comparison
+-- /profiles/[username]/       # User profiles (Phase 4)
+-- /author/                    # Author dashboard (Phase 4)
+-- /learn/                     # Learning paths (Phase 4)
+-- /api/                       # API endpoints (if needed)
```

#### Build-Time Data Pipeline

```
+============================================================================+
|                      STATIC SITE BUILD PIPELINE                             |
+============================================================================+

                    +-------------------+
                    |  Build Trigger    |
                    | (GitHub Action)   |
                    +-------------------+
                            |
                            v
                    +-------------------+
                    |  Fetch Latest     |
                    |  Skills Index     |
                    +-------------------+
                            |
                            v
                    +-------------------+
                    |  Generate Pages   |
                    | - Category pages  |
                    | - Skill details   |
                    | - Search index    |
                    +-------------------+
                            |
                            v
                    +-------------------+
                    |  Build SQLite     |
                    |  (for client)     |
                    +-------------------+
                            |
                            v
                    +-------------------+
                    |  Deploy to CDN    |
                    +-------------------+
```

#### Astro Page Structure

```typescript
// src/pages/skills/[id].astro
---
import Layout from '../../layouts/Layout.astro';
import SkillDetail from '../../components/SkillDetail.astro';
import InstallButton from '../../components/InstallButton.tsx';

export async function getStaticPaths() {
  const skills = await loadSkillsIndex();

  return skills.map(skill => ({
    params: { id: skill.id.replace(/\//g, '__') },
    props: { skill },
  }));
}

const { skill } = Astro.props;
---

<Layout title={`${skill.name} | Claude Discovery Hub`}>
  <SkillDetail skill={skill}>
    <InstallButton client:visible skillId={skill.id} />
  </SkillDetail>
</Layout>
```

### 4.2 Client-Side Search with SQLite

#### Architecture

```typescript
// Using sql.js for in-browser SQLite
import initSqlJs, { Database } from 'sql.js';

class ClientSkillSearch {
  private db: Database | null = null;

  async initialize(): Promise<void> {
    const SQL = await initSqlJs({
      locateFile: file => `/wasm/${file}`,
    });

    // Load pre-built database
    const response = await fetch('/data/skills.db');
    const buffer = await response.arrayBuffer();

    this.db = new SQL.Database(new Uint8Array(buffer));
  }

  search(query: string, options: SearchOptions = {}): SkillSummary[] {
    if (!this.db) throw new Error('Database not initialized');

    const sql = `
      SELECT
        s.id, s.name, s.description, s.trust_tier, s.final_score, s.stars
      FROM skills s
      JOIN skills_fts fts ON s.rowid = fts.rowid
      WHERE skills_fts MATCH ?
      ${options.trustTier ? 'AND s.trust_tier = ?' : ''}
      ${options.minScore ? 'AND s.final_score >= ?' : ''}
      ORDER BY rank
      LIMIT ?
      OFFSET ?
    `;

    const params = [
      query,
      ...(options.trustTier ? [options.trustTier] : []),
      ...(options.minScore ? [options.minScore] : []),
      options.limit || 20,
      options.offset || 0,
    ];

    const results = this.db.exec(sql, params);
    return this.mapResults(results);
  }
}
```

### 4.3 API for Web Frontend (Optional)

#### Edge Function API

```typescript
// For dynamic features not suitable for static generation
// Deployed as Vercel Edge Functions or Cloudflare Workers

// /api/search.ts
export const config = {
  runtime: 'edge',
};

export default async function handler(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');

  if (!query) {
    return new Response(JSON.stringify({ error: 'Query required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Use KV store or D1 database for edge
  const skills = await searchSkills(query, {
    limit: parseInt(searchParams.get('limit') || '20'),
    offset: parseInt(searchParams.get('offset') || '0'),
  });

  return new Response(JSON.stringify(skills), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 's-maxage=300', // 5 min cache
    },
  });
}
```

### 4.4 SEO Considerations

#### SEO Strategy

| Aspect | Implementation |
|--------|---------------|
| Static pages | Pre-rendered for all skill detail pages |
| Meta tags | Dynamic title, description, OG tags per skill |
| Structured data | JSON-LD for SoftwareApplication schema |
| Sitemap | Auto-generated sitemap.xml |
| Robots.txt | Allow all crawlers |
| Performance | Core Web Vitals optimized |

#### Structured Data

```typescript
// JSON-LD for skill pages
function generateSkillSchema(skill: Skill): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    'name': skill.name,
    'description': skill.description,
    'author': {
      '@type': 'Person',
      'name': skill.author,
      'url': skill.author_url,
    },
    'applicationCategory': 'DeveloperApplication',
    'operatingSystem': 'Cross-platform',
    'offers': {
      '@type': 'Offer',
      'price': '0',
      'priceCurrency': 'USD',
    },
    'aggregateRating': {
      '@type': 'AggregateRating',
      'ratingValue': skill.final_score * 5,
      'ratingCount': skill.stars,
      'bestRating': 5,
      'worstRating': 1,
    },
    'downloadUrl': skill.repo_url,
    'softwareVersion': skill.version || '1.0.0',
    'datePublished': skill.created_at,
    'dateModified': skill.updated_at,
  };
}
```

#### Meta Tag Generation

```astro
---
// src/layouts/SkillLayout.astro
const { skill } = Astro.props;
---

<head>
  <title>{skill.name} - Claude Skill | Discovery Hub</title>
  <meta name="description" content={skill.description.substring(0, 160)} />

  <!-- Open Graph -->
  <meta property="og:title" content={`${skill.name} - Claude Skill`} />
  <meta property="og:description" content={skill.description.substring(0, 160)} />
  <meta property="og:image" content={`/og/${skill.id.replace(/\//g, '__')}.png`} />
  <meta property="og:type" content="website" />

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content={`${skill.name} - Claude Skill`} />
  <meta name="twitter:description" content={skill.description.substring(0, 160)} />

  <!-- Canonical -->
  <link rel="canonical" href={`https://discoveries.dev/skills/${skill.id}`} />

  <!-- Structured Data -->
  <script type="application/ld+json" set:html={JSON.stringify(generateSkillSchema(skill))} />
</head>
```

---

## 5. Anthropic Partnership Path

### 5.1 Partnership Value Proposition

```
+==========================================================================+
|                    ANTHROPIC PARTNERSHIP PROPOSAL                         |
+==========================================================================+

VALUE FOR ANTHROPIC                      VALUE FOR DISCOVERY HUB
+------------------------------+         +------------------------------+
|                              |         |                              |
| 1. Improved skill ecosystem  |         | 1. Native skill attribution  |
|    - Quality signals         |         |    - No workaround needed    |
|    - Discovery UX            |         |                              |
|                              |         | 2. Official endorsement      |
| 2. Community engagement      |         |    - Trust signal            |
|    - Author tools            |         |    - Distribution            |
|    - User satisfaction       |         |                              |
|                              |         | 3. API access                |
| 3. Skill activation data     |         |    - Usage analytics         |
|    - Failure patterns        |         |    - Activation events       |
|    - Improvement signals     |         |                              |
|                              |         | 4. Sustainability path       |
+------------------------------+         |    - Potential integration   |
                                         +------------------------------+
```

### 5.2 Native Skill Attribution Integration Requirements

#### Proposed API Surface

```typescript
// Proposed Claude Code API for skill attribution
interface SkillAttributionAPI {
  // Events API - subscribe to skill invocations
  events: {
    // Subscribe to skill usage in current session
    onSkillInvoked(callback: (event: SkillInvocationEvent) => void): Subscription;

    // Query historical usage
    getSessionHistory(): SkillInvocationEvent[];
  };

  // Display API - control how skills are surfaced
  display: {
    // Configure attribution display
    setAttributionStyle(style: AttributionStyle): void;

    // Register custom attribution renderer
    registerRenderer(renderer: AttributionRenderer): void;
  };

  // Skill metadata API
  skills: {
    // Get currently active skills
    getActiveSkills(): SkillInfo[];

    // Get skill by ID
    getSkill(id: string): SkillInfo | null;

    // Check if skill is installed
    isInstalled(id: string): boolean;
  };
}

interface SkillInvocationEvent {
  skill_id: string;
  skill_name: string;
  timestamp: Date;
  trigger: {
    type: 'auto' | 'explicit' | 'contextual';
    context: string;
  };
  duration_ms: number;
  tokens_used: number;
}

interface AttributionStyle {
  // Where to show attribution
  position: 'inline' | 'footer' | 'sidebar' | 'none';

  // Detail level
  detail: 'minimal' | 'standard' | 'verbose';

  // Styling
  format: 'text' | 'badge' | 'icon';
}
```

#### Integration Protocol

```typescript
// Discovery Hub integration with proposed API
class AnthropicIntegration {
  private api: SkillAttributionAPI;

  async initialize(): Promise<void> {
    // Request API access
    this.api = await requestAnthropicAPI({
      scopes: ['skill:read', 'skill:events', 'skill:display'],
      purpose: 'Claude Discovery Hub - Skill attribution and analytics',
    });

    // Subscribe to skill events
    this.api.events.onSkillInvoked(this.handleSkillInvocation.bind(this));

    // Configure attribution display
    this.api.display.setAttributionStyle({
      position: 'inline',
      detail: 'standard',
      format: 'badge',
    });
  }

  private async handleSkillInvocation(event: SkillInvocationEvent): Promise<void> {
    // Track usage for analytics
    await this.analytics.track('skill_invoked', {
      skill_id: event.skill_id,
      trigger_type: event.trigger.type,
      duration_ms: event.duration_ms,
    });

    // Update local skill usage stats
    await this.updateSkillUsageStats(event.skill_id);

    // Notify user (if configured)
    if (this.config.showNotifications) {
      this.showNotification(`Skill used: ${event.skill_name}`);
    }
  }
}
```

### 5.3 Independent Fallback Path

If Anthropic partnership does not materialize, the following workarounds ensure Discovery Hub remains valuable:

#### Fallback Strategy Matrix

| Feature | Partnership Path | Independent Path | Degradation |
|---------|-----------------|------------------|-------------|
| Skill Attribution | Native API | SKILL.md injection | Less reliable |
| Usage Analytics | Events API | Heuristic detection | Estimated only |
| Activation Status | Direct query | File system scan | Delayed |
| Trust Signals | Official badges | Community ratings | Less authority |
| Distribution | Store listing | SEO + community | Slower growth |

#### Workaround Implementation

```typescript
// Independent skill attribution via SKILL.md modification
class IndependentAttribution {
  async instrumentSkill(skillPath: string): Promise<void> {
    const skillMd = await fs.readFile(path.join(skillPath, 'SKILL.md'), 'utf-8');

    // Check if already instrumented
    if (skillMd.includes('[Discovery Hub Instrumented]')) {
      return;
    }

    // Add attribution instruction to skill
    const instrumented = this.addAttributionInstruction(skillMd);

    await fs.writeFile(path.join(skillPath, 'SKILL.md'), instrumented);
  }

  private addAttributionInstruction(content: string): string {
    const attributionBlock = `
<!-- [Discovery Hub Instrumented] -->
## Attribution

When using this skill, briefly mention it in your response footer:
"[Skill: ${this.skillName} via Discovery Hub]"
`;

    return content + '\n' + attributionBlock;
  }
}

// Heuristic-based usage detection
class HeuristicUsageDetector {
  async detectSkillUsage(conversation: string[]): Promise<DetectedUsage[]> {
    const usages: DetectedUsage[] = [];
    const installedSkills = await this.getInstalledSkills();

    for (const skill of installedSkills) {
      // Pattern matching against skill triggers
      const triggers = await this.getSkillTriggers(skill);

      for (const message of conversation) {
        if (triggers.some(t => this.matchesTrigger(message, t))) {
          usages.push({
            skill_id: skill.id,
            confidence: this.calculateConfidence(message, triggers),
            detected_at: new Date(),
          });
        }
      }
    }

    return usages;
  }
}
```

### 5.4 Partnership Engagement Plan

#### Phase 0 (Weeks 1-8): Initial Outreach

| Week | Action | Owner |
|------|--------|-------|
| 1 | Identify Anthropic contacts (DevRel, Product) | Founder |
| 2 | Prepare partnership proposal deck | Product |
| 3-4 | Initial outreach via warm intros | Founder |
| 5-6 | Demo POC to Anthropic team | Engineering |
| 7-8 | Collect feedback, assess interest | Product |

#### Partnership Proposal Structure

```markdown
# Claude Discovery Hub - Anthropic Partnership Proposal

## Executive Summary
Discovery Hub improves the Claude Code skills ecosystem by solving
the discoverability problem for 50,000+ skills across fragmented sources.

## Problem We Solve
- 50% skill activation failure rate
- No unified discovery experience
- No quality signals for users
- No analytics for authors

## What We're Building
- Unified skill search across all sources
- Quality scoring with transparent methodology
- Safety scanning and trust tiers
- Activation auditor for failure diagnostics

## Partnership Request
1. Native skill attribution API (SkillAttributionAPI)
2. Skill usage events subscription
3. Official endorsement / store listing
4. Technical advisory access

## What Anthropic Gets
1. Better skill ecosystem health
2. User satisfaction improvement
3. Skill activation failure data
4. Community engagement tools

## Timeline
- POC complete: Week 8
- Phase 1 (Search): Week 12
- Phase 2 (Recommendations): Week 16
- Partnership integration: Week 20

## Team
[Team bios]

## Appendix
- Technical architecture
- Security approach
- Competitive landscape
```

---

## 6. Integration Monitoring

### 6.1 Health Monitoring Dashboard

```
+==========================================================================+
|                    INTEGRATION HEALTH DASHBOARD                           |
+==========================================================================+

+---------------------------+  +---------------------------+
|  GitHub API               |  |  SkillsMP Scraper         |
|  Status: HEALTHY          |  |  Status: HEALTHY          |
|  Rate Limit: 4,521/5,000  |  |  Last Sync: 2h ago        |
|  Last Sync: 15m ago       |  |  Skills: 24,892           |
+---------------------------+  +---------------------------+

+---------------------------+  +---------------------------+
|  claude-plugins.dev       |  |  mcp.so                   |
|  Status: DEGRADED         |  |  Status: HEALTHY          |
|  Error: Rate limited      |  |  Last Sync: 30m ago       |
|  Retry: 45m               |  |  Servers: 17,102          |
+---------------------------+  +---------------------------+

+---------------------------+  +---------------------------+
|  npm Registry             |  |  MCP Server (local)       |
|  Status: HEALTHY          |  |  Status: RUNNING          |
|  Last Sync: 3d ago        |  |  Uptime: 99.9%            |
|  Packages: 1,245          |  |  Requests: 1,234/hr       |
+---------------------------+  +---------------------------+
```

### 6.2 Alerting Rules

```typescript
interface AlertRule {
  name: string;
  condition: (metrics: Metrics) => boolean;
  severity: 'info' | 'warning' | 'critical';
  notification: 'email' | 'slack' | 'pagerduty';
}

const alertRules: AlertRule[] = [
  {
    name: 'github_rate_limit_low',
    condition: (m) => m.github_rate_limit_remaining < 500,
    severity: 'warning',
    notification: 'slack',
  },
  {
    name: 'github_rate_limit_exhausted',
    condition: (m) => m.github_rate_limit_remaining < 100,
    severity: 'critical',
    notification: 'pagerduty',
  },
  {
    name: 'scraper_failure',
    condition: (m) => m.scraper_consecutive_failures > 3,
    severity: 'warning',
    notification: 'slack',
  },
  {
    name: 'index_stale',
    condition: (m) => Date.now() - m.last_full_sync > 48 * 60 * 60 * 1000,
    severity: 'warning',
    notification: 'email',
  },
  {
    name: 'mcp_server_down',
    condition: (m) => !m.mcp_server_healthy,
    severity: 'critical',
    notification: 'pagerduty',
  },
];
```

### 6.3 Metrics Collection

```typescript
interface IntegrationMetrics {
  // GitHub
  github_rate_limit_remaining: number;
  github_rate_limit_reset: Date;
  github_last_sync: Date;
  github_sync_duration_ms: number;
  github_skills_indexed: number;

  // Scrapers
  skillsmp_last_sync: Date;
  skillsmp_skills_indexed: number;
  skillsmp_consecutive_failures: number;

  plugins_last_sync: Date;
  plugins_skills_indexed: number;
  plugins_consecutive_failures: number;

  mcpso_last_sync: Date;
  mcpso_servers_indexed: number;

  // MCP Server
  mcp_server_healthy: boolean;
  mcp_server_uptime_seconds: number;
  mcp_server_requests_per_hour: number;
  mcp_server_error_rate: number;

  // Index
  total_skills_indexed: number;
  index_size_bytes: number;
  last_full_sync: Date;
  last_incremental_sync: Date;
}
```

---

## Appendix: API Reference

### External API Summary

| API | Base URL | Auth | Rate Limit | Docs |
|-----|----------|------|------------|------|
| GitHub REST | api.github.com | PAT/App | 5K/hr | [docs](https://docs.github.com/rest) |
| GitHub GraphQL | api.github.com/graphql | PAT/App | 5K pts/hr | [docs](https://docs.github.com/graphql) |
| npm Registry | registry.npmjs.org | None | 60/min | [docs](https://github.com/npm/registry/blob/master/docs/REGISTRY-API.md) |
| SkillsMP | skillsmp.com | None | Custom | N/A |
| claude-plugins.dev | claude-plugins.dev | None | Custom | N/A |
| mcp.so | mcp.so | None | Custom | N/A |

### MCP Tools Reference

| Tool | Server | Purpose |
|------|--------|---------|
| `search` | discovery-core | Search skill index |
| `get_skill` | discovery-core | Get skill details |
| `analyze_codebase` | discovery-core | Detect tech stack |
| `recommend_skills` | discovery-core | Get recommendations |
| `install_skill` | discovery-core | Install a skill |
| `audit_activation` | discovery-core | Check activation issues |
| `check_conflicts` | discovery-core | Detect skill conflicts |
| `refresh_index` | sync | Trigger index update |
| `get_sync_status` | sync | Check sync status |
| `get_path` | learning | Get learning path |
| `next_exercise` | learning | Get next exercise |
| `submit_solution` | learning | Submit for validation |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | December 26, 2025 | Integration Architect | Initial design |

---

*Next Review: After Phase 0 gate decision (Week 8)*
