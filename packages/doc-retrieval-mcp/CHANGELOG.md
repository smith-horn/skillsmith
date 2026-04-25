# @skillsmith/doc-retrieval-mcp

Internal MCP server (SMI-4417) wrapping `@ruvector/core` for semantic doc retrieval over the Skillsmith corpus.

## [Unreleased]

### Added
- `retrieval-log/{schema,writer}.ts` — append-only SQLite instrumentation at `~/.claude/projects/<encoded-cwd>/retrieval-logs.db` (SMI-4450 Wave 1 Step 3). Tables: `meta`, `retrieval_events`, `frontmatter_lint_events`. `$USER` ownership guard, `IS_DOCKER=true` no-op, lazy schema creation on first use.
- `FRONTMATTER_LINT_EVENTS_DDL` exported from `schema.ts` for the Step 5 runtime divergence guard.
- 5 source adapters under `src/adapters/` behind a `SourceAdapter` registry (Wave 1 Step 4):
  - `memory-topic-files` — indexes `~/.claude/projects/<cwd>/memory/*.md` user notes.
  - `script-headers` — header-comment chunks from `scripts/` and `.husky/` files.
  - `supabase-migrations` — SQL migration files (git-crypt magic-byte pre-flight skip).
  - `git-commits` — last 90 days of `main` non-merge commit subjects + bodies.
  - `github-pr-bodies` — merged PR bodies via GraphQL with cache + pagination + best-effort error surfacing.
- Existing markdown corpus extracted as `markdown-corpus.ts` default adapter.
- Virtual namespace `logicalPath` forms (`memory://`, `git://`, `github://`) for out-of-repo sources, bypassing `assertSafeIndexTarget`.
- `SearchHit.meta?: ChunkStoredMetadata` carrying `kind`, `lifetime`, `smi`, `class`, `absorbed_by`, `supersedes`, source-specific tags. Re-exported from `search.ts`.

### Dependencies
- Added `better-sqlite3@11.10.0` (writer host-side I/O; not invoked from Docker per SPARC §S4 deployment boundary).
- Added `@types/better-sqlite3@7.6.13`.
