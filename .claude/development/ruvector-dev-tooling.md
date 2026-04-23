# RuVector Dev Tooling — `skillsmith-doc-retrieval` MCP

> ⚠️ **Runtime status: BLOCKED on [SMI-4426](https://linear.app/smith-horn-group/issue/SMI-4426)**
>
> Wave 2 Step 1 ([PR #722](https://github.com/smith-horn/skillsmith/pull/722))
> ships this package as a **scaffold**. Unit tests cover chunker, metadata
> store, and config guards (19/19 green), but the `@ruvector/core@0.1.30`
> integration surface has **not** been runtime-validated. `skill_docs_search`
> and `skill_docs_reindex` will throw a clear SMI-4426 error at invocation
> rather than NPE. `skill_docs_status` works (metadata-only). The rest of
> this guide documents the *intended* end-state — treat it as a spec until
> SMI-4426 lands.
>
> See SMI-4426 for the API mismatch findings (`VectorDb` vs `VectorDB`,
> `withDimensions(n)` factory, opaque persistence, distance-like scores,
> platform native bindings).

Local, private semantic search over the Skillsmith doc corpus. Wraps
`@ruvector/core` with Skillsmith's existing `EmbeddingService` so agents can
hit 3 tools (`skill_docs_search`, `skill_docs_reindex`, `skill_docs_status`)
instead of `Read`-ing whole guides.

Phase 1 of [SMI-4416](https://linear.app/smith-horn-group/issue/SMI-4416) /
[SMI-4417](https://linear.app/smith-horn-group/issue/SMI-4417). See ADR-117
for the design rationale and alternatives considered.

---

## Setup (first run)

```bash
docker compose --profile dev up -d
docker exec skillsmith-dev-1 npm install
docker exec skillsmith-dev-1 npm run build -w packages/doc-retrieval-mcp

# Build the initial .rvf — runs on host because we do not index CI artifacts
git submodule update --init   # required: docs/internal must be present
node packages/doc-retrieval-mcp/dist/src/cli.js reindex --full
```

Output lands at `.ruvector/skillsmith-docs.rvf` +
`.ruvector/metadata.json` + `.ruvector/.index-state.json`. All three are
git-ignored. `.git-crypt-ignore` is **not** needed — smudge/clean filters
never run on untracked files.

Restart Claude Code so it picks up the new `.mcp.json` entry.

---

## Tools

| Tool | Purpose | Shape |
|------|---------|-------|
| `skill_docs_search` | Semantic doc search | `{ query, k?, min_score?, scope_globs? } → { chunks: [{ id, file_path, line_start, line_end, heading_chain, text, score }] }` |
| `skill_docs_reindex` | Rebuild / refresh | `{ mode: 'full' \| 'incremental' }` |
| `skill_docs_status` | Index health check | `{} → { chunkCount, fileCount, lastIndexedSha, lastRunAt, rvfPath, corpusVersion }` |

### Score semantics

Cosine similarity, ∈ `[0, 1]`, higher is better. Default `min_score = 0.30`.

| Range | Meaning |
|-------|---------|
| `< 0.25` | Noise |
| `0.25–0.40` | Weakly related |
| `0.40–0.60` | Loosely relevant |
| `0.60–0.80` | Strongly relevant |
| `> 0.80` | Near-duplicate / exact |

---

## Corpus

Defined in
[`packages/doc-retrieval-mcp/src/corpus.config.json`](../../packages/doc-retrieval-mcp/src/corpus.config.json):
`CLAUDE.md`, `CONTRIBUTING.md`, `README.md`, `.claude/development/**`,
`.claude/skills/**/SKILL.md`, `.claude/templates/**`, `docs/internal/**`,
`packages/*/README.md`. The indexer refuses to start if the
`docs/internal/` submodule is uninitialized — it would silently omit
private content otherwise.

## Chunk sizing — design note

`all-MiniLM-L6-v2` has a **256-token hard cap** and `EmbeddingService.embed`
further truncates input to 1000 chars (~250 tokens). Chunks target
240 tokens (≈960 chars), overlap 48 tokens. The original plan targeted
500-token chunks, which was infeasible with this model — the second half
of every chunk would have been ignored by the encoder. Phase 3
([SMI-4419](https://linear.app/smith-horn-group/issue/SMI-4419)) revisits
this if we adopt a longer-context model.

---

## Privacy boundary

1. `.ruvector/` is **git-ignored** and **CI-refused**. The indexer exits
   non-zero if `CI=true` or `SKILLSMITH_CI=true`. It also refuses to write
   outside `$REPO_ROOT/.ruvector/`.
2. `.claude/settings.json` `permissions.deny` lists 37 Ruflo tools with
   remote-persistence surfaces (AgentDB, hive-mind_memory, transfer_*,
   memory_store, etc.). Authoritative list lives in
   [`docs/internal/architecture/ruflo-tool-classification.md`](../../docs/internal/architecture/ruflo-tool-classification.md)
   (SMI-4420). SMI-4417 initially shipped this block in `.mcp.json` under a
   `disabledTools` key — that field is not part of the `.mcp.json` schema and
   is silently ignored; SMI-4427 moved it to the correct enforcement point.
   Re-audit when Ruflo bumps a minor version.
3. The corpus includes `docs/internal/**/*.md` (private submodule). The
   resulting `.rvf` is a searchable index of that content — treat it with
   the same confidentiality as the submodule itself.

---

## Post-commit hook

`.husky/post-commit` runs an incremental re-index in the background when:

- `$REPO_ROOT/.ruvector/skillsmith-docs.rvf` exists (first run is manual).
- `packages/doc-retrieval-mcp/dist/src/cli.js` exists (package is built).
- `CI` and `SKILLSMITH_CI` are unset.

The indexer uses `GIT_OPTIONAL_LOCKS=0` and passes
`--no-optional-locks` to every `git diff` invocation, avoiding the
SMI-2536 smudge-filter branch-switch hazard. Hook failure is non-fatal
and non-blocking.

To disable the auto-reindex: delete the `.rvf` (first-run branch skips),
or unset the cli by removing `packages/doc-retrieval-mcp/dist/`.

---

## Operations

### Rebuild from scratch

```bash
rm -rf .ruvector/
node packages/doc-retrieval-mcp/dist/src/cli.js reindex --full
```

### Verify a query end-to-end

```bash
node packages/doc-retrieval-mcp/dist/src/cli.js status
node -e "import('./packages/doc-retrieval-mcp/dist/src/search.js').then(m => m.search({ query: 'git-crypt worktrees', k: 3 })).then(r => console.log(JSON.stringify(r, null, 2)))"
```

### Token-delta measurement (Wave 2 Step 6 gate)

```bash
node scripts/token-delta-harness.mjs run --mode baseline
node scripts/token-delta-harness.mjs run --mode measured
node scripts/token-delta-harness.mjs compare
```

Pass = ≥40% median input-token reduction across the three tasks in
[`scripts/ruvector-harness-tasks.json`](../../scripts/ruvector-harness-tasks.json).
Fail = Phase 2 abandoned, retro filed.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `index not built` error from `skill_docs_search` | `node packages/doc-retrieval-mcp/dist/src/cli.js reindex --full` |
| `required submodule 'docs/internal' is not initialized` | `git submodule update --init` |
| `refusing to run in CI` | Expected — indexer never runs in CI. |
| MCP server doesn't appear in Claude Code | Restart Claude Code after editing `.mcp.json`. Run the package build first: `docker exec skillsmith-dev-1 npm run build -w packages/doc-retrieval-mcp`. |
| Stale results after many edits | `rm -rf .ruvector && node packages/doc-retrieval-mcp/dist/src/cli.js reindex --full` |

---

## Deferred

Phase 2 promotes `skill_docs_search` into `@skillsmith/mcp-server` with
an `installed`/`registry` scope split (registry side uses pgvector on
Supabase, not RuVector — Deno cannot load the native module). Phase 3
evaluates longer-context embedding models and potentially replaces the
HNSW brute-force fallback in `packages/core/src/embeddings/hnsw-store.ts`
(SMI-1519 / SMI-4419).
