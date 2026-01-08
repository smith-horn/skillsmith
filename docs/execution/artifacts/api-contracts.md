# Skillsmith - API Contracts Reference

**Version:** 1.0
**Last Updated:** December 26, 2025
**Status:** Design Complete
**Owner:** Technical Architect

---

## Overview

This document defines API contracts for the Skillsmith, covering:

- **External API Adapters** - GitHub, SkillsMP, claude-plugins.dev, mcp.so, npm Registry
- **Internal Service Contracts** - Service layer interfaces, repository pattern, cache operations
- **Rate Limiting Patterns** - Throttling, backoff, and token rotation strategies
- **Error Response Handling** - Standardized error contracts

All contracts use TypeScript for type definitions with implementation-agnostic patterns.

---

## External API Adapters

### GitHub API Adapter

Primary source for skill repositories with the highest rate limits and most reliable data.

#### Configuration

```typescript
// ==================================================================
// GITHUB API CONFIGURATION
// ==================================================================

interface GitHubApiConfig {
  baseUrl: 'https://api.github.com';
  apiVersion: '2022-11-28';

  rateLimit: {
    requestsPerHour: 5000;           // Authenticated limit
    searchRequestsPerMinute: 30;      // Search API has stricter limits
    minRemainingBuffer: 100;          // Don't exhaust completely
  };

  authentication: {
    tokenRotation: {
      enabled: true;
      poolSize: 3;                    // Rotate between 3 tokens
      strategy: 'round-robin' | 'least-used';
    };
  };

  caching: {
    useETag: true;
    useIfModifiedSince: true;
    conditionalRequestWeight: 0;      // Conditional requests don't count against limit
  };

  retry: {
    maxAttempts: 3;
    backoffMultiplier: 2;
    initialDelayMs: 1000;
    maxDelayMs: 30000;
  };
}
```

#### Interface Contract

```typescript
// ==================================================================
// GITHUB API ADAPTER INTERFACE
// ==================================================================

interface GitHubApiAdapter {
  // Repository operations
  getRepository(owner: string, repo: string): Promise<GitHubRepoResult>;
  searchRepositories(query: string, options: GitHubSearchOptions): Promise<GitHubSearchResult>;
  getRepositoryContents(owner: string, repo: string, path: string): Promise<GitHubContentResult>;
  getReadme(owner: string, repo: string): Promise<GitHubReadmeResult>;

  // Rate limit management
  getRateLimitStatus(): Promise<RateLimitInfo>;
  waitForRateLimit(): Promise<void>;

  // Token rotation
  rotateToken(): void;
  getCurrentTokenStatus(): TokenStatus;
}

interface GitHubSearchOptions {
  perPage?: number;                   // Default: 30, Max: 100
  page?: number;
  sort?: 'stars' | 'forks' | 'help-wanted-issues' | 'updated';
  order?: 'asc' | 'desc';
  qualifiers?: {
    topic?: string[];
    language?: string;
    stars?: string;                   // e.g., '>100', '50..100'
    pushed?: string;                  // e.g., '>2024-01-01'
  };
}
```

#### Request/Response Examples

```typescript
// ==================================================================
// GITHUB API REQUEST EXAMPLES
// ==================================================================

// Repository search with conditional request
const searchRequest = {
  method: 'GET',
  url: 'https://api.github.com/search/repositories',
  headers: {
    'Authorization': 'Bearer ghp_xxxxxxxxxxxxx',
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'If-None-Match': '"abc123"',       // ETag from previous request
    'User-Agent': 'skillsmith-hub/1.0'
  },
  params: {
    q: 'topic:claude-skill language:markdown pushed:>2024-06-01',
    sort: 'updated',
    order: 'desc',
    per_page: 100,
    page: 1
  }
};

// Response types
interface GitHubRepoResult {
  success: true;
  data: {
    id: number;
    full_name: string;
    description: string | null;
    html_url: string;
    stargazers_count: number;
    forks_count: number;
    watchers_count: number;
    open_issues_count: number;
    license: { key: string; name: string } | null;
    language: string | null;
    topics: string[];
    created_at: string;
    updated_at: string;
    pushed_at: string;
    default_branch: string;
  };
  metadata: {
    etag: string;
    cached: boolean;
    rateLimitRemaining: number;
    rateLimitReset: number;
  };
}

interface GitHubSearchResult {
  success: true;
  data: {
    total_count: number;
    incomplete_results: boolean;
    items: GitHubRepoResult['data'][];
  };
  metadata: {
    etag: string;
    cached: boolean;
    rateLimitRemaining: number;
    rateLimitReset: number;
    page: number;
    hasNextPage: boolean;
  };
}
```

#### Rate Limit Handling

```typescript
// ==================================================================
// GITHUB RATE LIMIT HANDLER
// ==================================================================

interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number;                      // Unix timestamp
  used: number;
  resource: 'core' | 'search' | 'graphql';
}

interface TokenStatus {
  tokenIndex: number;
  remaining: number;
  resetAt: Date;
  isHealthy: boolean;
}

class GitHubRateLimiter {
  private tokens: TokenPool;

  // Check before making request
  async checkRateLimit(): Promise<RateLimitDecision> {
    const status = await this.getRateLimitStatus();

    if (status.remaining < this.config.minRemainingBuffer) {
      return {
        allowed: false,
        waitMs: (status.reset * 1000) - Date.now(),
        reason: 'RATE_LIMIT_EXHAUSTED'
      };
    }

    return { allowed: true };
  }

  // Token rotation strategy
  selectToken(): string {
    // Round-robin with health check
    for (let i = 0; i < this.tokens.length; i++) {
      const token = this.tokens.next();
      if (token.remaining > this.config.minRemainingBuffer) {
        return token.value;
      }
    }

    // All tokens exhausted - wait for soonest reset
    throw new RateLimitExhaustedException(this.getEarliestReset());
  }
}

// Exponential backoff for retries
function calculateBackoff(attempt: number, config: RetryConfig): number {
  const delay = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt);
  const jitter = delay * 0.1 * Math.random();
  return Math.min(delay + jitter, config.maxDelayMs);
}
```

#### ETag/Conditional Request Caching

```typescript
// ==================================================================
// GITHUB CONDITIONAL REQUEST CACHE
// ==================================================================

interface ConditionalRequestCache {
  store(key: string, etag: string, data: unknown, lastModified?: string): void;
  get(key: string): CacheEntry | null;
  buildHeaders(key: string): ConditionalHeaders;
}

interface CacheEntry {
  etag: string;
  lastModified?: string;
  data: unknown;
  cachedAt: number;
}

interface ConditionalHeaders {
  'If-None-Match'?: string;
  'If-Modified-Since'?: string;
}

// Usage pattern
async function fetchWithConditionalRequest<T>(
  url: string,
  cache: ConditionalRequestCache
): Promise<T> {
  const cacheKey = url;
  const headers = cache.buildHeaders(cacheKey);

  const response = await fetch(url, { headers });

  if (response.status === 304) {
    // Not modified - return cached data
    const cached = cache.get(cacheKey);
    return cached.data as T;
  }

  // New data - update cache
  const etag = response.headers.get('ETag');
  const lastModified = response.headers.get('Last-Modified');
  const data = await response.json();

  cache.store(cacheKey, etag, data, lastModified);
  return data as T;
}
```

---

### SkillsMP Adapter

Web scraping adapter for SkillsMP skill aggregator.

#### Configuration

```typescript
// ==================================================================
// SKILLSMP ADAPTER CONFIGURATION
// ==================================================================

interface SkillsMPConfig {
  baseUrl: 'https://skillsmp.com';

  rateLimit: {
    requestsPerMinute: 10;            // Conservative to avoid blocks
    requestsPerHour: 300;
    minDelayBetweenRequestsMs: 6000;  // 6 seconds between requests
  };

  scraping: {
    userAgent: 'skillsmith-hub/1.0 (+https://github.com/skillsmith-hub)';
    respectRobotsTxt: true;
    parseTimeout: 10000;              // 10 seconds
  };

  retry: {
    maxAttempts: 2;                   // Lower for scraping
    backoffMultiplier: 3;
    initialDelayMs: 10000;            // 10 seconds
  };
}
```

#### Interface Contract

```typescript
// ==================================================================
// SKILLSMP ADAPTER INTERFACE
// ==================================================================

interface SkillsMPAdapter {
  // Discovery operations
  getIndexPage(page: number): Promise<SkillsMPIndexResult>;
  getSkillDetail(skillPath: string): Promise<SkillsMPDetailResult>;
  getUpdatedSince(timestamp: string): Promise<SkillsMPSkill[]>;

  // Health check
  checkAvailability(): Promise<boolean>;
}

interface SkillsMPSkill {
  id: string;                         // Derived from URL path
  name: string;
  description: string;
  authorName: string;
  authorUrl?: string;
  repoUrl?: string;
  tags: string[];
  lastUpdated?: string;
  scrapedAt: string;
}

interface SkillsMPIndexResult {
  success: true;
  data: {
    skills: SkillsMPSkill[];
    currentPage: number;
    totalPages: number;
    hasNextPage: boolean;
  };
  metadata: {
    scrapedAt: string;
    parseTimeMs: number;
  };
}

interface SkillsMPDetailResult {
  success: true;
  data: SkillsMPSkill & {
    fullDescription?: string;
    readme?: string;
    installInstructions?: string;
  };
  metadata: {
    scrapedAt: string;
    parseTimeMs: number;
  };
}
```

#### HTML Parsing Patterns

```typescript
// ==================================================================
// SKILLSMP HTML PARSING PATTERNS
// ==================================================================

// Selectors for SkillsMP page structure
const SKILLSMP_SELECTORS = {
  // Index page
  skillCards: '.skill-card, [data-skill]',
  skillName: '.skill-name, h3',
  skillDescription: '.skill-description, .summary',
  skillAuthor: '.author-name, [data-author]',
  skillTags: '.skill-tags .tag, .tag-list span',
  pagination: '.pagination .page-number',

  // Detail page
  detailTitle: 'h1, .skill-title',
  detailDescription: '.description, [data-description]',
  repoLink: 'a[href*="github.com"], .repo-link',
  readmeContent: '.readme, .skill-content, article',
  lastUpdated: '.updated-at, time[datetime]',
};

// Parser implementation pattern
interface HtmlParser {
  parseIndexPage(html: string): SkillsMPIndexResult['data'];
  parseDetailPage(html: string): SkillsMPDetailResult['data'];
}

// Throttled request wrapper
class ThrottledScraper {
  private lastRequestTime = 0;
  private minDelayMs: number;

  async fetch(url: string): Promise<string> {
    const elapsed = Date.now() - this.lastRequestTime;
    if (elapsed < this.minDelayMs) {
      await sleep(this.minDelayMs - elapsed);
    }

    this.lastRequestTime = Date.now();
    const response = await fetch(url, {
      headers: {
        'User-Agent': this.config.userAgent,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });

    if (!response.ok) {
      throw new ScrapingError(response.status, url);
    }

    return response.text();
  }
}
```

---

### claude-plugins.dev Adapter

Web scraping adapter with RSS feed support.

#### Configuration

```typescript
// ==================================================================
// CLAUDE-PLUGINS.DEV ADAPTER CONFIGURATION
// ==================================================================

interface ClaudePluginsConfig {
  baseUrl: 'https://claude-plugins.dev';
  rssUrl: 'https://claude-plugins.dev/rss.xml';

  rateLimit: {
    requestsPerMinute: 10;
    requestsPerHour: 600;
    minDelayBetweenRequestsMs: 6000;
  };

  rss: {
    pollIntervalMinutes: 60;          // Check RSS hourly
    maxItemsPerFetch: 100;
  };

  scraping: {
    userAgent: 'skillsmith-hub/1.0';
    respectRobotsTxt: true;
    parseTimeout: 10000;
  };
}
```

#### Interface Contract

```typescript
// ==================================================================
// CLAUDE-PLUGINS.DEV ADAPTER INTERFACE
// ==================================================================

interface ClaudePluginsAdapter {
  // RSS feed operations
  getRssFeed(): Promise<ClaudePluginsRssResult>;
  getNewItemsSince(timestamp: string): Promise<ClaudePluginsItem[]>;

  // Web scraping operations
  scrapeIndexPage(page: number): Promise<ClaudePluginsIndexResult>;
  scrapeDetailPage(pluginPath: string): Promise<ClaudePluginsDetailResult>;

  // Sync state
  getLastScrapedAt(): Promise<string>;
}

interface ClaudePluginsItem {
  id: string;
  title: string;
  description: string;
  link: string;
  repoUrl?: string;
  author?: string;
  publishedAt: string;
  categories: string[];
}

interface ClaudePluginsRssResult {
  success: true;
  data: {
    items: ClaudePluginsItem[];
    lastBuildDate: string;
    ttl: number;                      // Time to live in minutes
  };
  metadata: {
    fetchedAt: string;
    itemCount: number;
  };
}

interface ClaudePluginsIndexResult {
  success: true;
  data: {
    plugins: ClaudePluginsItem[];
    currentPage: number;
    hasNextPage: boolean;
  };
  metadata: {
    scrapedAt: string;
    parseTimeMs: number;
  };
}

interface ClaudePluginsDetailResult {
  success: true;
  data: ClaudePluginsItem & {
    readme?: string;
    installCommand?: string;
    configuration?: string;
    screenshots?: string[];
  };
  metadata: {
    scrapedAt: string;
    parseTimeMs: number;
  };
}
```

#### RSS Feed Parsing

```typescript
// ==================================================================
// RSS FEED PARSER
// ==================================================================

interface RssFeedParser {
  parse(xml: string): RssFeed;
}

interface RssFeed {
  channel: {
    title: string;
    description: string;
    link: string;
    lastBuildDate: string;
    ttl?: number;
    items: RssItem[];
  };
}

interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: string;
  guid: string;
  categories: string[];
}

// Incremental sync using pubDate
async function syncNewItems(
  adapter: ClaudePluginsAdapter,
  lastSyncTime: string
): Promise<ClaudePluginsItem[]> {
  const feed = await adapter.getRssFeed();

  const newItems = feed.data.items.filter(item =>
    new Date(item.publishedAt) > new Date(lastSyncTime)
  );

  return newItems;
}
```

---

### mcp.so Adapter

REST API adapter for the MCP server registry.

#### Configuration

```typescript
// ==================================================================
// MCP.SO ADAPTER CONFIGURATION
// ==================================================================

interface McpSoConfig {
  baseUrl: 'https://api.mcp.so/v1';

  authentication: {
    type: 'api-key';
    headerName: 'X-API-Key';
    // API key stored securely, not in config
  };

  rateLimit: {
    requestsPerHour: 1000;
    requestsPerMinute: 60;
  };

  pagination: {
    defaultPageSize: 50;
    maxPageSize: 100;
  };

  retry: {
    maxAttempts: 3;
    backoffMultiplier: 2;
    initialDelayMs: 1000;
  };
}
```

#### Interface Contract

```typescript
// ==================================================================
// MCP.SO ADAPTER INTERFACE
// ==================================================================

interface McpSoAdapter {
  // Server listing
  listServers(options: McpSoListOptions): Promise<McpSoListResult>;
  getServer(serverId: string): Promise<McpSoServerResult>;

  // Categories
  getCategories(): Promise<McpSoCategoriesResult>;

  // Search
  searchServers(query: string, options?: McpSoSearchOptions): Promise<McpSoListResult>;
}

interface McpSoListOptions {
  page?: number;
  perPage?: number;                   // Default: 50, Max: 100
  category?: string;
  sortBy?: 'popularity' | 'recent' | 'name';
  order?: 'asc' | 'desc';
}

interface McpSoSearchOptions extends McpSoListOptions {
  fields?: ('name' | 'description' | 'author')[];
}

interface McpSoServer {
  id: string;
  name: string;
  description: string;
  shortDescription: string;
  author: {
    name: string;
    url?: string;
    verified: boolean;
  };
  repoUrl?: string;
  npmPackage?: string;
  version: string;
  category: string;
  tags: string[];
  installCount: number;
  rating: number;
  createdAt: string;
  updatedAt: string;
}

interface McpSoListResult {
  success: true;
  data: {
    servers: McpSoServer[];
    pagination: {
      page: number;
      perPage: number;
      totalItems: number;
      totalPages: number;
      hasNextPage: boolean;
      hasPrevPage: boolean;
    };
  };
  metadata: {
    requestId: string;
    responseTimeMs: number;
  };
}

interface McpSoServerResult {
  success: true;
  data: McpSoServer & {
    readme?: string;
    changelog?: string;
    configuration?: {
      schema: object;
      examples: object[];
    };
    tools: {
      name: string;
      description: string;
    }[];
  };
  metadata: {
    requestId: string;
    responseTimeMs: number;
  };
}

interface McpSoCategoriesResult {
  success: true;
  data: {
    categories: {
      id: string;
      name: string;
      description: string;
      serverCount: number;
    }[];
  };
}
```

#### Request/Response Examples

```typescript
// ==================================================================
// MCP.SO API REQUEST EXAMPLES
// ==================================================================

// List servers with pagination
const listRequest = {
  method: 'GET',
  url: 'https://api.mcp.so/v1/servers',
  headers: {
    'X-API-Key': 'mcp_xxxxxxxxxxxx',
    'Accept': 'application/json',
    'User-Agent': 'skillsmith-hub/1.0'
  },
  params: {
    page: 1,
    per_page: 50,
    category: 'development',
    sort_by: 'popularity',
    order: 'desc'
  }
};

// Pagination handling
async function* paginateServers(
  adapter: McpSoAdapter,
  options: McpSoListOptions
): AsyncGenerator<McpSoServer[]> {
  let page = options.page || 1;
  let hasMore = true;

  while (hasMore) {
    const result = await adapter.listServers({ ...options, page });
    yield result.data.servers;

    hasMore = result.data.pagination.hasNextPage;
    page++;
  }
}
```

---

### npm Registry Adapter

Package metadata and download counts from npm.

#### Configuration

```typescript
// ==================================================================
// NPM REGISTRY ADAPTER CONFIGURATION
// ==================================================================

interface NpmRegistryConfig {
  registryUrl: 'https://registry.npmjs.org';
  downloadsApiUrl: 'https://api.npmjs.org/downloads';

  rateLimit: {
    requestsPerMinute: 100;           // npm is generous
    requestsPerHour: 5000;
  };

  caching: {
    packageMetadataTtlHours: 1;
    downloadCountsTtlHours: 24;
  };
}
```

#### Interface Contract

```typescript
// ==================================================================
// NPM REGISTRY ADAPTER INTERFACE
// ==================================================================

interface NpmRegistryAdapter {
  // Package metadata
  getPackageMetadata(packageName: string): Promise<NpmPackageResult>;
  getPackageVersion(packageName: string, version: string): Promise<NpmVersionResult>;

  // Download statistics
  getDownloadCounts(packageName: string, period: 'last-day' | 'last-week' | 'last-month' | 'last-year'): Promise<NpmDownloadsResult>;
  getDownloadRange(packageName: string, startDate: string, endDate: string): Promise<NpmDownloadRangeResult>;

  // Search
  searchPackages(query: string, options?: NpmSearchOptions): Promise<NpmSearchResult>;
}

interface NpmPackageResult {
  success: true;
  data: {
    name: string;
    description: string;
    version: string;                  // Latest version
    versions: string[];               // All versions
    repository?: {
      type: string;
      url: string;
    };
    homepage?: string;
    author?: {
      name: string;
      email?: string;
    };
    maintainers: { name: string; email: string }[];
    keywords: string[];
    license: string;
    readme: string;
    time: {
      created: string;
      modified: string;
      [version: string]: string;
    };
  };
  metadata: {
    cached: boolean;
    fetchedAt: string;
  };
}

interface NpmDownloadsResult {
  success: true;
  data: {
    downloads: number;
    start: string;
    end: string;
    package: string;
  };
  metadata: {
    cached: boolean;
    fetchedAt: string;
  };
}

interface NpmSearchOptions {
  size?: number;                      // Default: 20, Max: 250
  from?: number;                      // Offset for pagination
  quality?: number;                   // Weight 0-1
  popularity?: number;                // Weight 0-1
  maintenance?: number;               // Weight 0-1
}

interface NpmSearchResult {
  success: true;
  data: {
    objects: {
      package: {
        name: string;
        version: string;
        description: string;
        keywords: string[];
        links: { npm: string; homepage?: string; repository?: string };
      };
      score: {
        final: number;
        detail: {
          quality: number;
          popularity: number;
          maintenance: number;
        };
      };
    }[];
    total: number;
    time: string;
  };
}
```

#### Request/Response Examples

```typescript
// ==================================================================
// NPM API REQUEST EXAMPLES
// ==================================================================

// Get package metadata
// GET https://registry.npmjs.org/@anthropic-ai/claude-code

// Get download counts
// GET https://api.npmjs.org/downloads/point/last-month/@anthropic-ai/claude-code

// Search packages
// GET https://registry.npmjs.org/-/v1/search?text=claude+mcp&size=20

// Response example
const downloadsResponse = {
  downloads: 15234,
  start: '2024-12-01',
  end: '2024-12-31',
  package: '@anthropic-ai/claude-code'
};
```

---

## Internal Service Contracts

### Service Layer Interfaces

Core service interfaces following dependency injection patterns.

```typescript
// ==================================================================
// SERVICE LAYER INTERFACES
// ==================================================================

// Search Service
interface SearchService {
  search(query: string, options?: SearchOptions): Promise<SearchResult>;
  getById(skillId: string): Promise<Skill | null>;
  getSuggestions(partialQuery: string): Promise<string[]>;
  getPopular(limit?: number): Promise<Skill[]>;
}

interface SearchOptions {
  filters?: {
    categories?: string[];
    technologies?: string[];
    trustTiers?: TrustTier[];
    minScore?: number;
    source?: string[];
    updatedAfter?: Date;
  };
  sort?: {
    field: 'relevance' | 'score' | 'stars' | 'updated';
    direction: 'asc' | 'desc';
  };
  pagination?: {
    limit: number;
    offset: number;
  };
}

interface SearchResult {
  skills: Skill[];
  total: number;
  hasMore: boolean;
  queryAnalysis: {
    interpretedQuery: string;
    detectedIntent: string;
    suggestedRefinements: string[];
  };
}

// Install Service
interface InstallService {
  install(skillId: string, options?: InstallOptions): Promise<InstallResult>;
  uninstall(skillId: string): Promise<UninstallResult>;
  update(skillId: string, options?: UpdateOptions): Promise<UpdateResult>;
  listInstalled(): Promise<InstalledSkill[]>;
  checkForUpdates(): Promise<UpdateAvailable[]>;
}

interface InstallOptions {
  skipConflictCheck?: boolean;
  skipSecurityScan?: boolean;
  force?: boolean;
  targetDirectory?: string;
}

interface InstallResult {
  success: boolean;
  skillId: string;
  installedPath: string;
  installMethod: 'copy' | 'symlink' | 'plugin';
  conflicts?: Conflict[];
  securityWarnings?: SecurityWarning[];
  budgetImpact?: BudgetImpact;
  activationTips: string[];
  suggestedHooks?: HookConfig;
}

// Recommendation Service
interface RecommendationService {
  recommendForCodebase(path: string, options?: RecommendOptions): Promise<RecommendationResult>;
  recommendSimilar(skillId: string, limit?: number): Promise<Skill[]>;
  getGaps(path: string): Promise<SkillGap[]>;
}

interface RecommendOptions {
  maxResults?: number;
  includeReasons?: boolean;
  excludeInstalled?: boolean;
  discoveryMode?: 'conservative' | 'exploratory';
}

interface RecommendationResult {
  recommendations: Recommendation[];
  analysisSummary: string;
  gapsIdentified: SkillGap[];
  installedCoverage: number;
}

// Audit Service
interface AuditService {
  auditActivation(skillId?: string, options?: AuditOptions): Promise<AuditResult>;
  validateFrontmatter(skillId: string): Promise<ValidationResult>;
  calculateBudget(skillIds: string[]): Promise<BudgetReport>;
  generateHooks(skillId: string): Promise<HookConfig>;
}

interface AuditOptions {
  generateHooks?: boolean;
  includeRecommendations?: boolean;
}

interface AuditResult {
  summary: AuditSummary;
  issues: AuditIssue[];
  warnings: AuditWarning[];
  recommendations: string[];
  generatedHooks?: HookConfig;
  budgetReport: BudgetReport;
}

// Sync Service
interface SyncService {
  syncAll(): Promise<SyncResult>;
  syncSource(sourceId: string): Promise<SyncResult>;
  getSyncStatus(): Promise<SyncStatus>;
  cancelSync(): Promise<void>;
  scheduleSync(cronExpression: string): void;
}

interface SyncResult {
  sourceId: string;
  syncType: 'full' | 'incremental';
  skillsProcessed: number;
  skillsAdded: number;
  skillsUpdated: number;
  skillsRemoved: number;
  skillsFailed: number;
  durationMs: number;
  errors: SyncError[];
}
```

---

### Repository Pattern

Data access layer contracts following repository pattern.

```typescript
// ==================================================================
// BASE REPOSITORY INTERFACE
// ==================================================================

interface BaseRepository<T, ID = string> {
  findById(id: ID): Promise<T | null>;
  findAll(options?: FindOptions): Promise<T[]>;
  findOne(criteria: Partial<T>): Promise<T | null>;
  count(criteria?: Partial<T>): Promise<number>;
  exists(id: ID): Promise<boolean>;

  create(entity: Omit<T, 'id'>): Promise<T>;
  update(id: ID, updates: Partial<T>): Promise<T>;
  delete(id: ID): Promise<boolean>;

  // Batch operations
  createMany(entities: Omit<T, 'id'>[]): Promise<T[]>;
  updateMany(criteria: Partial<T>, updates: Partial<T>): Promise<number>;
  deleteMany(criteria: Partial<T>): Promise<number>;
}

interface FindOptions {
  where?: Record<string, unknown>;
  orderBy?: { field: string; direction: 'asc' | 'desc' }[];
  limit?: number;
  offset?: number;
  include?: string[];                 // Relations to include
}

// ==================================================================
// SKILL REPOSITORY
// ==================================================================

interface SkillRepository extends BaseRepository<Skill> {
  // FTS search
  search(query: string, options?: FtsSearchOptions): Promise<SearchHit[]>;

  // Specialized queries
  findBySource(sourceId: string): Promise<Skill[]>;
  findByAuthor(authorId: string): Promise<Skill[]>;
  findByCategory(categoryId: string): Promise<Skill[]>;
  findByTechnology(technologyId: string): Promise<Skill[]>;
  findByTrustTier(tier: TrustTier): Promise<Skill[]>;

  // Aggregations
  getTopByStars(limit: number): Promise<Skill[]>;
  getRecentlyUpdated(limit: number, since?: Date): Promise<Skill[]>;
  getStatsBySource(): Promise<SourceStats[]>;

  // Maintenance
  markAsDeleted(skillId: string): Promise<void>;
  purgeDeleted(olderThan: Date): Promise<number>;
}

interface FtsSearchOptions {
  columns?: ('name' | 'description' | 'search_text')[];
  weights?: { name: number; description: number; search_text: number };
  limit?: number;
  offset?: number;
}

interface SearchHit {
  skill: Skill;
  score: number;
  highlights?: { field: string; snippet: string }[];
}

// ==================================================================
// CACHE REPOSITORY
// ==================================================================

interface CacheRepository {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteByPattern(pattern: string): Promise<number>;
  deleteByTags(tags: string[]): Promise<number>;

  // Bulk operations
  mget<T>(keys: string[]): Promise<(T | null)[]>;
  mset<T>(entries: { key: string; value: T; ttl?: number }[]): Promise<void>;

  // Cache stats
  getStats(): Promise<CacheStats>;
  cleanup(): Promise<number>;         // Returns deleted count
}

interface CacheStats {
  totalEntries: number;
  totalSizeBytes: number;
  hitRate: number;
  missRate: number;
  oldestEntry: Date;
  expiringWithin1Hour: number;
}

// ==================================================================
// INSTALLED SKILLS REPOSITORY
// ==================================================================

interface InstalledSkillsRepository extends BaseRepository<InstalledSkill> {
  findHealthy(): Promise<InstalledSkill[]>;
  findNeedingUpdate(): Promise<InstalledSkill[]>;
  findByInstallMethod(method: InstallMethod): Promise<InstalledSkill[]>;

  recordActivation(skillId: string): Promise<void>;
  updateHealthStatus(skillId: string, status: HealthStatus, details?: string): Promise<void>;
}
```

---

### Cache Interface

Multi-tier caching contract.

```typescript
// ==================================================================
// CACHE INTERFACE
// ==================================================================

interface CacheInterface {
  // Basic operations
  get<T>(key: string): Promise<CacheResult<T>>;
  set<T>(key: string, value: T, options?: CacheSetOptions): Promise<void>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;

  // TTL management
  getTtl(key: string): Promise<number | null>;
  setTtl(key: string, ttlSeconds: number): Promise<boolean>;
  touch(key: string): Promise<boolean>;   // Reset TTL

  // Bulk operations
  getMany<T>(keys: string[]): Promise<Map<string, CacheResult<T>>>;
  setMany<T>(entries: CacheEntry<T>[]): Promise<void>;
  deleteMany(keys: string[]): Promise<number>;

  // Pattern operations
  keys(pattern: string): Promise<string[]>;
  clear(): Promise<void>;

  // Stats and maintenance
  stats(): Promise<CacheStats>;
  prune(): Promise<number>;
}

interface CacheResult<T> {
  value: T | null;
  hit: boolean;
  stale: boolean;                     // TTL exceeded but still available
  age: number;                        // Seconds since cached
}

interface CacheSetOptions {
  ttlSeconds?: number;
  tags?: string[];
  staleWhileRevalidate?: boolean;
}

interface CacheEntry<T> {
  key: string;
  value: T;
  ttlSeconds?: number;
  tags?: string[];
}

// ==================================================================
// MULTI-TIER CACHE IMPLEMENTATION CONTRACT
// ==================================================================

interface MultiTierCache implements CacheInterface {
  private l1: MemoryCache;            // Fast, small (10MB)
  private l2: SqliteCache;            // Slower, larger (100MB)

  async get<T>(key: string): Promise<CacheResult<T>> {
    // Check L1 first
    const l1Result = await this.l1.get<T>(key);
    if (l1Result.hit && !l1Result.stale) {
      return l1Result;
    }

    // Check L2
    const l2Result = await this.l2.get<T>(key);
    if (l2Result.hit) {
      // Promote to L1
      await this.l1.set(key, l2Result.value);
      return l2Result;
    }

    return { value: null, hit: false, stale: false, age: 0 };
  }

  async set<T>(key: string, value: T, options?: CacheSetOptions): Promise<void> {
    // Write to both tiers
    await Promise.all([
      this.l1.set(key, value, { ...options, ttlSeconds: options?.ttlSeconds || 300 }),
      this.l2.set(key, value, options)
    ]);
  }
}

// Cache configuration
interface CacheConfig {
  l1: {
    maxSizeMb: 10;
    defaultTtlSeconds: 300;           // 5 minutes
    evictionPolicy: 'lru';
  };
  l2: {
    maxSizeMb: 100;
    defaultTtlSeconds: 3600;          // 1 hour
    compactionThreshold: 0.8;
  };
  invalidation: {
    onSyncComplete: ['search_results', 'skill_list'];
    onSkillInstall: ['recommendations', 'gaps'];
    onConfigChange: ['all'];
  };
}
```

---

## Rate Limiting Patterns

### Unified Rate Limiter

```typescript
// ==================================================================
// UNIFIED RATE LIMITER
// ==================================================================

interface RateLimiter {
  // Check if request is allowed
  checkLimit(key: string): Promise<RateLimitResult>;

  // Record a request
  recordRequest(key: string): Promise<void>;

  // Get current status
  getStatus(key: string): Promise<RateLimitStatus>;

  // Wait until limit resets
  waitForReset(key: string): Promise<void>;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  retryAfterMs?: number;
}

interface RateLimitStatus {
  limit: number;
  remaining: number;
  windowStart: Date;
  windowEnd: Date;
  requestsInWindow: number;
}

// Configuration per source
interface RateLimitConfig {
  github: {
    requestsPerHour: 5000;
    searchPerMinute: 30;
    burstLimit: 100;
  };
  skillsmp: {
    requestsPerMinute: 10;
    requestsPerHour: 300;
  };
  claudePlugins: {
    requestsPerMinute: 10;
    requestsPerHour: 600;
  };
  mcpSo: {
    requestsPerHour: 1000;
    requestsPerMinute: 60;
  };
  npm: {
    requestsPerMinute: 100;
    requestsPerHour: 5000;
  };
}

// Sliding window rate limiter implementation pattern
class SlidingWindowRateLimiter implements RateLimiter {
  private windows: Map<string, RequestWindow> = new Map();

  async checkLimit(key: string): Promise<RateLimitResult> {
    const config = this.getConfig(key);
    const window = this.getOrCreateWindow(key, config.windowSizeMs);

    // Remove expired requests
    window.prune();

    const remaining = config.limit - window.count;

    return {
      allowed: remaining > 0,
      remaining: Math.max(0, remaining),
      resetAt: window.endTime,
      retryAfterMs: remaining <= 0 ? window.endTime.getTime() - Date.now() : undefined
    };
  }
}
```

---

## Error Response Handling

### Standardized Error Contract

```typescript
// ==================================================================
// ERROR RESPONSE CONTRACT
// ==================================================================

interface ErrorResponse {
  success: false;
  error: {
    code: ErrorCode;
    message: string;                  // Human-readable message
    details?: Record<string, unknown>;
    recoverySuggestions?: string[];
    retryable: boolean;
    retryAfterMs?: number;
  };
  metadata?: {
    requestId?: string;
    timestamp: string;
  };
}

type ErrorCode =
  // Client errors (4xx equivalent)
  | 'INVALID_PARAMETER'
  | 'SKILL_NOT_FOUND'
  | 'AUTHOR_NOT_FOUND'
  | 'CATEGORY_NOT_FOUND'
  | 'BLOCKED_SKILL'
  | 'CONFLICT_DETECTED'
  | 'SECURITY_RISK_DETECTED'
  | 'BUDGET_EXCEEDED'
  | 'ALREADY_INSTALLED'
  | 'NOT_INSTALLED'

  // Rate limiting
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'

  // External service errors
  | 'GITHUB_API_ERROR'
  | 'EXTERNAL_SERVICE_ERROR'
  | 'SCRAPING_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT_ERROR'

  // Internal errors
  | 'DATABASE_ERROR'
  | 'CACHE_ERROR'
  | 'INTERNAL_ERROR'
  | 'SYNC_IN_PROGRESS';

// Error classification for retry logic
interface ErrorClassification {
  code: ErrorCode;
  retryable: boolean;
  maxRetries: number;
  backoffStrategy: 'none' | 'linear' | 'exponential';
  fallbackStrategy: 'cache' | 'degraded' | 'none';
}

const ERROR_CLASSIFICATIONS: Record<ErrorCode, ErrorClassification> = {
  RATE_LIMITED: {
    code: 'RATE_LIMITED',
    retryable: true,
    maxRetries: 3,
    backoffStrategy: 'exponential',
    fallbackStrategy: 'cache'
  },
  NETWORK_ERROR: {
    code: 'NETWORK_ERROR',
    retryable: true,
    maxRetries: 3,
    backoffStrategy: 'exponential',
    fallbackStrategy: 'cache'
  },
  SKILL_NOT_FOUND: {
    code: 'SKILL_NOT_FOUND',
    retryable: false,
    maxRetries: 0,
    backoffStrategy: 'none',
    fallbackStrategy: 'none'
  },
  // ... other classifications
};
```

### Error Factory

```typescript
// ==================================================================
// ERROR FACTORY
// ==================================================================

class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: Record<string, unknown>,
    public recoverySuggestions?: string[]
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toResponse(): ErrorResponse {
    const classification = ERROR_CLASSIFICATIONS[this.code];
    return {
      success: false,
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
        recoverySuggestions: this.recoverySuggestions,
        retryable: classification.retryable,
        retryAfterMs: classification.retryable ? this.calculateRetryAfter() : undefined
      },
      metadata: {
        timestamp: new Date().toISOString()
      }
    };
  }
}

// Factory functions
const Errors = {
  skillNotFound: (skillId: string) =>
    new ApiError(
      'SKILL_NOT_FOUND',
      `Skill '${skillId}' not found in the index`,
      { skillId },
      ['Check the skill ID spelling', 'Try searching for similar skills', 'Sync the index for updates']
    ),

  rateLimited: (source: string, resetAt: Date) =>
    new ApiError(
      'RATE_LIMITED',
      `Rate limit exceeded for ${source}. Resets at ${resetAt.toISOString()}`,
      { source, resetAt: resetAt.toISOString() },
      ['Wait for rate limit reset', 'Try again later', 'Use cached data if available']
    ),

  conflictDetected: (skillId: string, conflicts: Conflict[]) =>
    new ApiError(
      'CONFLICT_DETECTED',
      `Skill '${skillId}' conflicts with ${conflicts.length} installed skill(s)`,
      { skillId, conflicts },
      ['Review conflicting skills', 'Uninstall conflicting skills first', 'Use --force to override']
    ),

  securityRisk: (skillId: string, findings: SecurityFinding[]) =>
    new ApiError(
      'SECURITY_RISK_DETECTED',
      `Security issues detected in skill '${skillId}'`,
      { skillId, findings },
      ['Review security findings', 'Choose a verified alternative', 'Use --skip-security-scan to override']
    )
};
```

---

## References

- [Backend API Architecture](/docs/architecture/backend-api.md)
- [Data Schema](/docs/implementation/artifacts/data-schema.md)
- [Technical Overview](/docs/technical/overview.md)
- [MCP Servers](/docs/technical/components/mcp-servers.md)
- [Error Handling](/docs/technical/api/error-handling.md)

---

*API Contracts Version: 1.0*
*Last Updated: December 26, 2025*
*Compatibility: TypeScript 5.0+*
