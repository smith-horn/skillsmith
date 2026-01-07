# @skillsmith/core

Core library for Skillsmith - provides database operations, search services, caching, security, and analytics for Claude Code skill discovery.

## Installation

```bash
npm install @skillsmith/core
```

## Quick Start

```typescript
import {
  openDatabase,
  SkillRepository,
  SearchService,
  TieredCache,
} from '@skillsmith/core'

// Open database
const db = openDatabase('~/.skillsmith/skills.db')

// Create repository and search service
const skillRepo = new SkillRepository(db)
const cache = new TieredCache()
const searchService = new SearchService(skillRepo, cache)

// Search for skills
const results = await searchService.search({
  query: 'testing',
  limit: 10,
})
```

## Features

### Database Operations

SQLite-based storage with migrations and type-safe queries.

```typescript
import { openDatabase, createDatabase, runMigrations } from '@skillsmith/core'

const db = openDatabase('./skills.db')
await runMigrations(db)
```

### Repositories

- **SkillRepository** - CRUD operations for skills
- **CacheRepository** - Persistent cache storage
- **IndexerRepository** - Batch indexing operations

```typescript
import { SkillRepository } from '@skillsmith/core'

const repo = new SkillRepository(db)
const skill = await repo.findById('author/skill-name')
const skills = await repo.search({ query: 'testing', limit: 10 })
```

### Search Services

Hybrid search combining full-text and semantic search.

```typescript
import { HybridSearch, SearchService } from '@skillsmith/core'

const search = new HybridSearch(db)
const results = await search.search({
  query: 'git commit helper',
  filters: { trustTier: 'verified' },
})
```

### Caching

Multi-tier caching with L1 (memory) and L2 (SQLite) layers.

```typescript
import { TieredCache, L1Cache, L2Cache } from '@skillsmith/core'

const cache = new TieredCache({
  l1: new L1Cache({ maxSize: 1000, ttlMs: 60000 }),
  l2: new L2Cache(db),
})

await cache.set('key', { data: 'value' })
const cached = await cache.get('key')
```

### Security

Rate limiting, path validation, security scanning, and audit logging.

```typescript
import {
  RateLimiter,
  SecurityScanner,
  AuditLogger,
  validateDbPath,
} from '@skillsmith/core'

// Rate limiting
const limiter = new RateLimiter({ maxRequests: 100, windowMs: 60000 })
const allowed = await limiter.checkLimit('user-123')

// Path validation (prevent traversal attacks)
const result = validateDbPath('/path/to/db.sqlite')
if (!result.valid) throw new Error(result.error)

// Security scanning
const scanner = new SecurityScanner()
const report = await scanner.scan(skillContent)

// Audit logging
const logger = new AuditLogger(db)
await logger.log({
  eventType: 'skill.install',
  actor: { type: 'user', id: 'user-123' },
  resource: { type: 'skill', id: 'author/skill' },
})
```

### Indexing

Index skills from GitHub repositories.

```typescript
import { GitHubIndexer, SkillParser } from '@skillsmith/core'

const indexer = new GitHubIndexer({
  token: process.env.GITHUB_TOKEN,
})

const result = await indexer.indexRepository('owner/repo')
```

### Quality Scoring

Score skills based on documentation, security, and community signals.

```typescript
import { QualityScorer, quickScore } from '@skillsmith/core'

const scorer = new QualityScorer()
const score = await scorer.score(skill)
// { overall: 85, breakdown: { documentation: 90, security: 80, ... } }

// Quick scoring without full analysis
const quick = quickScore(skillMetadata)
```

### Analytics

Track skill usage and generate insights.

```typescript
import { UsageTracker, UsageAnalyticsService } from '@skillsmith/core'

const tracker = new UsageTracker(db)
await tracker.trackUsage({
  skillId: 'author/skill',
  eventType: 'install',
})

const analytics = new UsageAnalyticsService(db)
const summary = await analytics.getSummary({ days: 30 })
```

### Telemetry

OpenTelemetry-based tracing and metrics.

```typescript
import {
  initializeTelemetry,
  getTracer,
  getMetrics,
  traced,
} from '@skillsmith/core'

await initializeTelemetry({ serviceName: 'skillsmith' })

// Manual tracing
const tracer = getTracer()
const span = tracer.startSpan('operation')
// ... do work
span.end()

// Decorator-based tracing
class MyService {
  @traced('search')
  async search(query: string) {
    // automatically traced
  }
}
```

## Exports

The package provides multiple entry points:

```typescript
// Main exports
import { SkillRepository, SearchService } from '@skillsmith/core'

// Error handling
import { SkillsmithError, ValidationError } from '@skillsmith/core/errors'

// Embeddings (lazy-loaded to avoid startup overhead)
import { EmbeddingService } from '@skillsmith/core/embeddings'
```

## Requirements

- Node.js >= 22.0.0
- SQLite (via better-sqlite3)

## License

Apache-2.0

## Links

- [GitHub](https://github.com/smith-horn-group/skillsmith)
- [Issues](https://github.com/smith-horn-group/skillsmith/issues)
