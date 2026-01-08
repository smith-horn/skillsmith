# ADR-0002: SQLite for Local-First Storage

**Status:** Accepted
**Date:** 2025-12-26
**Deciders:** Senior Architect, Data Architect

## Context

Claude Discovery Hub needs to store and query 50,000+ skills locally. The storage solution must:
- Work offline without network connectivity
- Support full-text search across skill metadata
- Be portable (no external database server)
- Handle incremental updates efficiently
- Fit within reasonable disk space constraints

## Decision

Use SQLite with FTS5 (Full-Text Search 5) extension as the primary local storage mechanism.

### Storage Structure

```
~/.claude-discovery/
├── index/
│   ├── skills.db         # SQLite database with FTS5
│   ├── embeddings.bin    # Vector embeddings for semantic search
│   └── cache/            # API response cache
├── config/
│   ├── settings.json     # User preferences
│   └── blocklist.json    # Blocked skills
└── docs/
    └── recommendations/  # Version-controlled suggestions
```

### SQLite Schema Highlights

- FTS5 virtual table for full-text search on name, description, README
- WAL mode for concurrent read access
- Triggers for maintaining search index

## Consequences

### Positive
- Zero-config deployment (SQLite is embedded)
- Full offline capability
- Fast full-text search (FTS5 is highly optimized)
- Single file backup/restore
- No database server to manage

### Negative
- Limited concurrent write capability
- No network-transparent access
- Size limit (~280TB theoretical, practically ~100GB)
- Complex queries may be slower than dedicated search engines

### Neutral
- Need to bundle better-sqlite3 or sql.js in npm package
- Incremental sync requires careful conflict handling
- Migrations need manual management

## Alternatives Considered

### Alternative 1: Elasticsearch
- Powerful full-text search
- Requires running separate server
- **Rejected:** Violates local-first principle, complex deployment

### Alternative 2: PostgreSQL
- Full RDBMS capabilities
- Requires running database server
- **Rejected:** Not portable, requires installation

### Alternative 3: LevelDB/RocksDB
- Embedded key-value store
- Very fast writes
- **Rejected:** No built-in full-text search, requires additional indexing

### Alternative 4: JSON Files
- Simplest possible storage
- Git-friendly diffs
- **Rejected:** Poor query performance at 50K+ records

## References

- [SQLite FTS5 Documentation](https://www.sqlite.org/fts5.html)
- [better-sqlite3 npm package](https://www.npmjs.com/package/better-sqlite3)
- [Research: 50K+ skills across platforms](../research/layers/layer-2-synthesis.md)
