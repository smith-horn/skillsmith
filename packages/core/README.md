# @skillsmith/core

Core library for Skillsmith - provides database operations, search services, caching, security, analytics, and **multi-language codebase analysis** for Claude Code skill discovery.

**v2.0.0** introduces multi-language support for analyzing TypeScript, JavaScript, Python, Go, Rust, and Java codebases.

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

## Live API

As of v0.2.0, Skillsmith uses a live API at `api.skillsmith.app` to serve skills.

### Configuration

```bash
# Use default API (recommended)
# No configuration needed

# Custom API URL
export SKILLSMITH_API_URL=https://your-api.example.com

# Offline mode (use local database)
export SKILLSMITH_OFFLINE_MODE=true
```

### Telemetry

Skillsmith collects anonymous usage data to improve the product.
To opt out:

```bash
export SKILLSMITH_TELEMETRY=false
```

See [PRIVACY.md](./PRIVACY.md) for details on what data is collected.

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

### Multi-Language Codebase Analysis (v2.0.0)

Analyze codebases in TypeScript, JavaScript, Python, Go, Rust, and Java.

```typescript
import { CodebaseAnalyzer } from '@skillsmith/core'

const analyzer = new CodebaseAnalyzer()
const context = await analyzer.analyze('/path/to/project')

// Languages detected
console.log(context.metadata.languages)
// ['typescript', 'python', 'go']

// Files by language
console.log(context.stats.filesByLanguage)
// { typescript: 45, python: 23, go: 12 }

// Detected frameworks across all languages
console.log(context.frameworks)
// [{ name: 'React', confidence: 0.95 }, { name: 'Django', confidence: 0.9 }]

analyzer.dispose()
```

#### Language Router

Route files to appropriate language adapters:

```typescript
import {
  LanguageRouter,
  TypeScriptAdapter,
  PythonAdapter,
  GoAdapter,
  RustAdapter,
  JavaAdapter,
} from '@skillsmith/core'

const router = new LanguageRouter()
router.registerAdapter(new TypeScriptAdapter())
router.registerAdapter(new PythonAdapter())
router.registerAdapter(new GoAdapter())
router.registerAdapter(new RustAdapter())
router.registerAdapter(new JavaAdapter())

// Check if file is supported
router.canHandle('main.py') // true
router.getLanguage('main.go') // 'go'

// Parse a file
const result = router.parseFile(content, 'main.py')
console.log(result.imports, result.exports, result.functions)

router.dispose()
```

#### Parse Caching

Cache parse results for improved performance:

```typescript
import { ParseCache } from '@skillsmith/core'

const cache = new ParseCache({ maxMemoryMB: 100 })

// Check cache before parsing
const cached = cache.get('src/main.ts', content)
if (cached) {
  return cached
}

// Parse and cache
const result = adapter.parseFile(content, 'src/main.ts')
cache.set('src/main.ts', content, result)

// View cache statistics
console.log(cache.getStats())
// { size: 1048576, entries: 50, maxSize: 104857600, hitRate: 0.85 }
```

#### Incremental Parsing

Efficiently parse changes:

```typescript
import { IncrementalParser, TypeScriptAdapter } from '@skillsmith/core'

const parser = new IncrementalParser({ maxTrees: 50 })
const adapter = new TypeScriptAdapter()

// First parse (full)
const result1 = parser.parse('src/main.ts', content1, adapter)
console.log(result1.wasIncremental) // false

// Second parse with small change (incremental, <100ms)
const result2 = parser.parse('src/main.ts', content2, adapter)
console.log(result2.wasIncremental) // true

parser.dispose()
```

#### Parallel Parsing

Parse large codebases in parallel:

```typescript
import { ParserWorkerPool } from '@skillsmith/core'

const pool = new ParserWorkerPool({ poolSize: 4 })

const tasks = files.map(f => ({
  filePath: f.path,
  content: f.content,
  language: 'typescript'
}))

const results = await pool.parseFiles(tasks)
console.log(`Parsed ${results.length} files`)

pool.dispose()
```

#### Dependency Parsers

Parse language-specific dependency files:

```typescript
import {
  parseGoMod,
  parseCargoToml,
  parsePomXml,
  parseBuildGradle,
} from '@skillsmith/core'

// Go dependencies
const goMod = parseGoMod(goModContent)
console.log(goMod.module)  // "github.com/user/project"
console.log(goMod.require) // [{ path: "...", version: "..." }]

// Rust dependencies
const cargo = parseCargoToml(cargoTomlContent)
// [{ name: "serde", version: "1.0", isDev: false }]

// Java Maven dependencies
const maven = parsePomXml(pomXmlContent)
// [{ name: "org.springframework:spring-core", version: "5.3.0", isDev: false }]

// Java Gradle dependencies
const gradle = parseBuildGradle(buildGradleContent)
// [{ name: "org.springframework:spring-core", version: "5.3.0", isDev: false }]
```

#### Supported Languages & Frameworks

| Language | Extensions | Frameworks Detected |
|----------|------------|---------------------|
| TypeScript/JS | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` | React, Vue, Angular, Next.js, Express, Nest.js, Jest, Vitest |
| Python | `.py`, `.pyi`, `.pyw` | Django, FastAPI, Flask, pytest, pandas, numpy |
| Go | `.go` | Gin, Echo, Fiber, GORM, Cobra, gRPC, testify |
| Rust | `.rs` | Actix, Rocket, Axum, Tokio, Serde, Diesel, SQLx |
| Java | `.java` | Spring Boot, Quarkus, Micronaut, JUnit, Hibernate, Lombok |

#### Performance

| Metric | Target |
|--------|--------|
| 10k file analysis | <5 seconds |
| Incremental parse | <100ms |
| Cache hit rate | >80% |
| Memory efficiency | LRU eviction |

## Exports

The package provides multiple entry points:

```typescript
// Main exports
import { SkillRepository, SearchService } from '@skillsmith/core'

// Error handling
import { SkillsmithError, ValidationError } from '@skillsmith/core/errors'

// Embeddings (lazy-loaded to avoid startup overhead)
import { EmbeddingService } from '@skillsmith/core/embeddings'

// Analysis module (v2.0.0)
import {
  CodebaseAnalyzer,
  LanguageRouter,
  ParseCache,
  TreeCache,
  IncrementalParser,
  ParserWorkerPool,
  MemoryMonitor,
  // Adapters
  TypeScriptAdapter,
  PythonAdapter,
  GoAdapter,
  RustAdapter,
  JavaAdapter,
  // Dependency parsers
  parseGoMod,
  parseCargoToml,
  parsePomXml,
  parseBuildGradle,
  // Types
  type SupportedLanguage,
  type ParseResult,
  type ImportInfo,
  type ExportInfo,
  type FunctionInfo,
  type CodebaseContext,
} from '@skillsmith/core'
```

## Requirements

- Node.js >= 22.0.0
- SQLite (via better-sqlite3)

## License

Apache-2.0

## Links

- [GitHub](https://github.com/smith-horn-group/skillsmith)
- [Issues](https://github.com/smith-horn-group/skillsmith/issues)
