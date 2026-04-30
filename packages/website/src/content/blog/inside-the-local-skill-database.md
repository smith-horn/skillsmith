---
title: "Inside the Local Skill Database: How Skillsmith Searches Without Sending Your Queries to a Server"
description: "A tour of Skillsmith's embedded SQLite cache, the FTS5 search path, opt-in semantic search, and the differential sync algorithm — what's stored, what isn't, and why."
author: "Skillsmith Team"
date: 2026-04-30
updated: 2026-04-30
category: "Engineering"
tags: ["sqlite", "fts5", "embeddings", "onnx", "search", "architecture"]
ogImage: "https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200,h_630,c_fill/blog/inside-the-local-skill-database/local-db-hero"
---

<!-- IMAGE_PROMPT id="local-db-hero" purpose="hero, ogImage": "Stylized illustration of a SQLite cylinder feeding three surfaces — a chat bubble for MCP, a terminal for CLI, a code editor for VS Code — converging into a single Skillsmith logo. Brand-coral and white accents on a near-black background, flat geometric illustration, 1200x630." -->

![Inside the Local Skill Database](https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200/blog/inside-the-local-skill-database/local-db-hero)

## TL;DR

When you run a Skillsmith search through the MCP server, the CLI, or the VS Code extension, the query never leaves your machine. Skillsmith caches the registry locally in a single SQLite database at `~/.skillsmith/skills.db`. By default, search runs against an FTS5 full-text index over that cache. There is no vector virtual table in the default schema — semantic search is opt-in (`SKILLSMITH_USE_HNSW=true`) and uses an in-memory vector index over local ONNX embeddings. `skillsmith sync` keeps the cache fresh by pulling only the rows that changed since the last sync. This post walks through what's stored, what isn't, and why we made each choice.

Jump to: [Where the DB lives](#where-the-db-lives) · [Schema tour](#schema-tour) · [FTS5 default](#fts5-the-default-search-path) · [Semantic search](#semantic-search-opt-in-with-a-footnote) · [`sync`](#sync-the-diff-algorithm) · [`import`](#import-the-other-direction) · [Tradeoffs](#tradeoffs)

## Two posts, two halves

This post is the **client-side** companion to ["From GitHub to Search Results: How Skillsmith Indexes and Curates Skills"](/blog/how-skillsmith-indexes-skills), which covers the **server side** — how we discover skills on GitHub, validate them, run security scans, score them, and ship them to the registry. If you want to know how a skill *gets into* the registry, read that one. If you want to know what happens *after* the registry hands a skill back to your machine — what's cached, how search works, what `sync` actually does — keep reading here. Both posts are useful in isolation; together they cover end-to-end discovery.

## Where the DB lives

Skillsmith installs a single SQLite database at `~/.skillsmith/skills.db`. The path is overridable via the `SKILLSMITH_DB_PATH` environment variable, which is mostly useful in CI or for keeping per-project caches.

The database is shared across all three Skillsmith surfaces:

- The **MCP server** (`@skillsmith/mcp-server`) opens it on startup so tools like `search`, `get_skill`, `install_skill`, and `skill_recommend` can return results without an API round-trip.
- The **CLI** (`skillsmith` or `sklx`) reads and writes the same file — the path constant lives in `packages/cli/src/config.ts:14` and the MCP equivalent is in `packages/mcp-server/src/context.helpers.ts:46`.
- The **VS Code extension** uses it transitively: it spawns the MCP server in the background and routes everything through that subprocess, so its sidebar and quick-pick share state with whatever the CLI last synced.

The file is created on first run by `createDatabaseAsync()` → `initializeSchema()` (`packages/core/src/db/schema.ts:54`). After that, you can poke at it directly with `sqlite3 ~/.skillsmith/skills.db` and write your own queries — it's just SQLite.

## Schema tour

<!-- IMAGE_PROMPT id="schema-overview" purpose="schema diagram": "Entity-relationship style diagram showing the main tables: skills (center), skills_fts (FTS5 mirror linked by content rowid), sources, categories, skill_categories (join), cache, audit_logs, sync_config, sync_history, skill_versions. Brand-coral accents on a near-black background, flat illustration style, 1200x800." -->

![Schema overview](https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200/blog/inside-the-local-skill-database/schema-overview)

The schema is currently at version 13 and lives in two places. The initial tables are declared in `packages/core/src/db/schema-sql.ts`:

- `skills` — one row per skill (`id`, `name`, `description`, `author`, `repo_url`, `quality_score`, `trust_tier`, `tags`, `risk_score`, `security_scanned_at`, `content_hash`, timestamps).
- `skills_fts` — an FTS5 virtual table that mirrors `name`, `description`, `tags`, and `author` for full-text search. Triggers keep it in sync with `skills` on insert/update/delete.
- `sources`, `categories`, `skill_categories` — registry source provenance and taxonomy.
- `cache` — small key-value cache for things like rate-limit windows and last-fetched timestamps.
- `audit_logs` — local audit trail for installs, removes, and config changes.

Add-on tables come from migrations:

- `sync_config` and `sync_history` ship in `v3-sync-tables.ts` — they record the last sync timestamp and a row per sync run with status, started/finished times, and counts.
- `skill_versions` ships in `v5-skill-versions.ts` — one row per `(skill_id, version_hash)` so we can cheaply detect "this skill changed" on subsequent syncs.

Notably absent: there is no `vec_*` or `vss_*` virtual table in the default schema. We don't ship `sqlite-vec` or `sqlite-vss`. Vector search, when it's enabled, lives outside SQL — more on that below.

## FTS5 — the default search path

When you search Skillsmith, the default path runs in three steps: tokenize your query, hand it to the FTS5 virtual table, and join the BM25-ranked rowids back to `skills` for the full row. That's it. No HTTP, no embedding model, no graph traversal — just SQLite's built-in full-text engine.

<!-- IMAGE_PROMPT id="fts5-vs-hnsw" purpose="search path comparison": "Side-by-side flow diagram. Left rail: query → FTS5 BM25 ranking → ranked skills rows (annotated 'default'). Right rail: query → ONNX embedding → in-memory vector index (annotated 'HNSW when available, brute-force fallback') → cosine ranking → ranked skills rows (annotated 'opt-in'). Brand-coral accents on near-black background, flat illustration style, 1200x800." -->

![FTS5 vs HNSW](https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200/blog/inside-the-local-skill-database/fts5-vs-hnsw)

The FTS5 ranking weights `name` and `tags` higher than `description` and `author`, so an exact match on a skill's name floats to the top even when the description is sprawling. BM25 handles term frequency and inverse document frequency, so common words like "skill" or "test" don't dominate the ranking just because they appear everywhere. For most queries — name lookups, tag filters, "find anything mentioning playwright" — this is the right tool.

A nice side effect of doing search locally: it's basically free latency-wise. Typical FTS5 query times against the full registry cache are sub-millisecond, which means the whole search-to-render cycle in your editor or chat is dominated by network calls *you didn't make* (because you're hitting your own disk).

There's a small footnote: native `better-sqlite3` is the default driver, but if its prebuilt binary fails to load (Node ABI mismatch after a Node upgrade is the usual cause), Skillsmith automatically falls back to a WASM SQLite build via `fts5-sql-bundle`. The user-visible behavior is identical; the only difference is a small startup cost the first time the WASM module loads. The fallback policy is documented in [ADR-009](https://github.com/smith-horn/skillsmith/blob/main/docs/internal/adr/009-embedding-service-fallback.md).

## Semantic search — opt-in, with a footnote

FTS5 is great for keyword queries. It's not great when you ask "I want a skill that helps me write tests for React components" and the best match is named `vitest-component-harness` with no exact-keyword overlap. For that, you want semantic search.

Skillsmith ships semantic search as **opt-in** behind `SKILLSMITH_USE_HNSW=true`. When enabled:

- Skills are embedded with `Xenova/all-MiniLM-L6-v2` via ONNX Runtime — a small (q8-quantized, ~25 MB on disk) sentence-transformer that produces 384-dim vectors. The model runs locally on CPU; no API call.
- For testing or development, you can swap the real model for a deterministic mock via `SKILLSMITH_USE_MOCK_EMBEDDINGS=true`. The mock is sub-millisecond and produces stable vectors — useful for test fixtures.
- Embeddings are cached in a `skill_embeddings` BLOB column inside SQLite, so we don't re-embed the entire registry on every cold start.
- Search itself happens in process: queries are embedded the same way, then compared against cached vectors with cosine similarity. SQLite is not the query target — it's just a durable cache for the blobs.

Now the honest footnote. The vector index implementation is currently in a brute-force fallback path. The file header at `packages/core/src/embeddings/hnsw-store.ts:5` states:

```text
SMI-1519: HNSW Embedding Store
High-performance vector storage using HNSW index for fast ANN search.
Uses brute-force search (V3 VectorDB unavailable after claude-flow rename).
```

Translation: the HNSW graph is wired and will re-engage when the upstream V3 VectorDB module is restored, but as of writing, when you flip the opt-in flag you get an in-process linear scan over cached vectors rather than an HNSW-accelerated approximate nearest-neighbor search. For the size of registry most users carry (thousands, not millions of skills), this is still fine — the user-visible difference is "search takes a few hundred ms on a cold cache" instead of "search takes a few tens of ms." We chose to ship the contract ("in-memory vector index") rather than block on the fastest possible implementation, and we'd rather tell you about the fallback than have you discover it from a benchmark.

## `sync` — the diff algorithm

<!-- IMAGE_PROMPT id="sync-sequence" purpose="sync flow": "Sequence diagram with three swim lanes — Registry API, SyncEngine, SQLite. Show: (1) fetch by broad query, (2) dedup across queries, (3) filter by lastSyncAt, (4) per-row content_hash compare, (5) upsert changed rows, (6) write sync_history row. Number the steps 1-6. Brand-coral accents on near-black background, flat illustration style, 1200x900." -->

![Sync diff algorithm](https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200/blog/inside-the-local-skill-database/sync-sequence)

`skillsmith sync` populates and refreshes the local cache. The implementation is in `packages/core/src/sync/SyncEngine.ts` (lines 122–360) and runs as a differential pull by default — full refresh is available via `--force`.

The shape of an incremental run:

1. **Fetch from the registry API.** The registry imposes a 2-character minimum on search queries, so SyncEngine fans out across a small set of broad queries (`git`, `code`, `dev`, `test`, `npm`, `api`, `cli`, `doc`) to cover the namespace (lines 176–224). This is a workaround, not a load-bearing design choice — it keeps the API simple at the cost of a few duplicate hits we have to dedupe.
2. **Deduplicate by skill id.** Multiple broad queries return overlapping results; we collapse to a unique set before continuing (lines 193–199).
3. **Filter to changed rows.** When `lastSyncAt` is set (i.e. not the first run and not `--force`), we keep only skills whose registry-side `updated_at` is strictly newer than our last sync (lines 238–245). On a registry with thousands of skills and dozens of changes per day, this turns a multi-thousand-row sync into a few-dozen-row sync.
4. **Compare and upsert.** For each candidate, we compare the registry's `content_hash` against the local row. If they differ, we upsert into `skills` and append the new version to `skill_versions` (lines 376–423). Identical hashes are no-ops.
5. **Persist sync state.** We update `sync_config.lastSyncAt` and append a row to `sync_history` with start/finish timestamps and counts (lines 293–311). If you're debugging a flaky sync, `sync_history` is the first place to look.

A few things `sync` does *not* do, by design:

- **It does not recompute embeddings.** Embeddings are populated lazily when semantic search is enabled — keeping them out of the sync path means the default `sync` is fast and doesn't pin you to the model download.
- **It does not delete locally installed skills.** `~/.claude/skills/` is your file system, not ours. `sync` only mutates the registry cache.
- **It does not re-run security scans.** Those are server-side artifacts; we cache the result.

Typical incremental run is on the order of tens of seconds, dominated by registry API latency rather than local CPU.

## `import` — the other direction

`sync` flows registry → cache. `import` flows the other way: it walks `~/.claude/skills/` (or any directory you point it at), parses each `SKILL.md`, and writes the result into the same `skills` table. The implementation lives in `packages/cli/src/import.ts`.

This matters for two cases. First, hand-installed skills — skills you copied into `~/.claude/skills/` from a teammate's repo or your own scratch — show up in search after `import` even if they were never published to the registry. Second, locally authored skills under active development; `import` lets you `search` for your own work-in-progress alongside everything else.

`import` writes to the same table `sync` does, so a subsequent `sync --force` will overwrite locally imported rows if the registry has a same-id record. This is intentional; the registry is the source of truth for published skills.

## Tradeoffs

Local-first costs disk and adds a sync step. We think the tradeoff is worth it, but it's worth being explicit:

**Wins.** Search latency is local-disk speed, not network speed — sub-millisecond FTS5, sub-second semantic when opted in. Your queries do not leave your machine, which matters for proprietary projects, privacy-sensitive workflows, and anyone running on a network where you'd rather not log "what skills were they searching for?" to someone else's analytics. You burn fewer API quota credits because every search hits the cache instead of the registry. And when the registry is down or your network is flaky, search still works — the cache doesn't care.

**Costs.** The cache takes disk — typically tens of MB of metadata for the full registry; add ~25 MB if you opt into semantic search and download the ONNX model. Data is stale until the next `sync`; if a skill was updated this morning and you haven't synced since yesterday, you'll see yesterday's metadata. The default sync cadence is up to you (we don't auto-sync on every command), so long-running stale caches are possible. Native modules (`better-sqlite3`, `onnxruntime-node`) ship as prebuilt binaries for common platforms; when those binaries fail to load — usually after a major Node upgrade — the WASM fallbacks kick in automatically, but you may see a one-time slowdown the first time WASM compiles.

We've found these tradeoffs to be the right ones for a developer-tool registry where most queries repeat, the data shape is small, and privacy of "what are you about to install?" is a real consideration.

## What's next

If you want to know how the registry got those rows in the first place, read the companion post: ["From GitHub to Search Results: How Skillsmith Indexes and Curates Skills"](/blog/how-skillsmith-indexes-skills). If you're trying to decide whether to use the MCP server, the CLI, or the VS Code extension, the comparison page at [`/product`](/product) walks through which surface fits which workflow. And if you have a question that didn't get answered here, [the docs FAQ](/docs/faq#technical) is the next stop.
