# RuVector Dev Tooling — `skillsmith-doc-retrieval` MCP

Local, private semantic search over the Skillsmith doc corpus. Wraps
`@ruvector/core` with Skillsmith's existing `EmbeddingService` so agents can
hit 3 tools (`skill_docs_search`, `skill_docs_reindex`, `skill_docs_status`)
instead of `Read`-ing whole guides.

**Prerequisites**: Docker running (`docker compose --profile dev up -d`), `docs/internal` submodule initialized (`git submodule update --init`).

Phase 1 of [SMI-4416](https://linear.app/smith-horn-group/issue/SMI-4416) /
[SMI-4417](https://linear.app/smith-horn-group/issue/SMI-4417). See ADR-117
for the design rationale and alternatives considered.

---

## Setup (first run)

```bash
# 1. Set the encoded host project path so the memory adapter can read your
#    Claude Code auto-memory dir from inside the container (SMI-4677).
#    The one-liner is worktree-aware: encodes the MAIN repo, not the worktree.
MAIN_REPO=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
echo "SKILLSMITH_PROJECT_DIR_ENCODED=$(echo "$MAIN_REPO" | sed 's|^/|-|;s|/|-|g')" >> .env
varlock load   # validates schema; the new var is non-sensitive

# 2. Bring up the container (will now bind ~/.claude/projects/<encoded>/memory
#    into /skillsmith-memory:ro).
docker compose --profile dev up -d
docker exec skillsmith-dev-1 npm install
docker exec skillsmith-dev-1 npm run build -w packages/doc-retrieval-mcp

# 3. Verify the bind worked.
docker exec skillsmith-dev-1 printenv SKILLSMITH_MEMORY_DIR_OVERRIDE   # → /skillsmith-memory
docker exec skillsmith-dev-1 ls /skillsmith-memory/feedback_*.md | head # lists host memory files

# 4. Build the initial index (requires linux-arm64-gnu binding — must run in Docker).
git submodule update --init   # required: docs/internal must be present
docker exec skillsmith-dev-1 node /app/packages/doc-retrieval-mcp/dist/src/cli.js reindex --full
```

**SMI-4677 note**: the bind mount is in base `docker-compose.yml` (`services.dev` only — `services.test` and `services.orchestrator` deliberately omit it). Inside the container `homedir()` is `/root`, which has no `.claude/projects/` and no encoded match for the host path; `SKILLSMITH_MEMORY_DIR_OVERRIDE=/skillsmith-memory` tells the `memory-topic-files` adapter to bypass `homedir()`-based resolution and read from the bind directly. Without this, the adapter is enabled in `corpus.config.json` but produces zero `feedback_*.md` / `project_*.md` chunks — silently degrading the SMI-4451 priming + SMI-4468 per-class boost. See `feedback_ruvector_check_coverage_before_ranking.md`.

**Worktree caveat**: `SKILLSMITH_PROJECT_DIR_ENCODED` always encodes the **main repo path**, not the worktree path. Claude Code keys auto-memory by main repo; all worktrees share the same memory dir. The one-liner above uses `git rev-parse --git-common-dir` which always points at the main `.git/` regardless of which worktree it's run from.

Output lands at `.ruvector/skillsmith-docs/vectors` (single-file VectorDb),
`.ruvector/metadata.json`, and `.ruvector/.index-state.json`. All three are
git-ignored. `.git-crypt-ignore` is **not** needed — smudge/clean filters
never run on untracked files.

Restart Claude Code after the initial setup so the MCP panel discovers the `skillsmith-doc-retrieval` server. No changes to `.mcp.json` are needed — the `docker exec` entry is already in the file.

---

## Tools

| Tool | Purpose | Shape |
|------|---------|-------|
| `skill_docs_search` | Semantic doc search | `{ query, k?, min_score?, scope_globs? } → { chunks: [{ id, file_path, line_start, line_end, heading_chain, text, score }] }` |
| `skill_docs_reindex` | Rebuild / refresh | `{ mode: 'full' \| 'incremental' }` |
| `skill_docs_status` | Index health check | `{} → { chunkCount, fileCount, lastIndexedSha, lastRunAt, storagePath, corpusVersion }` |

### Score semantics

Cosine similarity, ∈ `[0, 1]`, higher is better. Default `min_score = 0.35` (matches `DEFAULT_MIN_SIMILARITY` in `config.ts`).

| Range | Meaning |
|-------|---------|
| `< 0.20` | Noise |
| `0.20–0.35` | Weak |
| `0.35–0.55` | Loose |
| `0.55–0.75` | Strong |
| `> 0.75` | Near-duplicate / exact |

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
2. `.claude/settings.json` carries a `permissions.deny` list covering 37 Ruflo
   tools with remote-persistence surfaces (AgentDB, hive-mind_memory,
   transfer_*, memory_store, etc.). This is the only Claude Code-enforced
   mechanism — `.mcp.json` `disabledTools` is silently ignored (SMI-4427).
   Authoritative list lives in
   [`docs/internal/architecture/ruflo-tool-classification.md`](../../docs/internal/architecture/ruflo-tool-classification.md)
   (SMI-4420). Re-audit when Ruflo bumps a minor version.
3. The corpus includes `docs/internal/**/*.md` (private submodule). The
   resulting `.rvf` is a searchable index of that content — treat it with
   the same confidentiality as the submodule itself.

---

## Post-commit hook

`.husky/post-commit` runs an incremental re-index in the background when:

- `$REPO_ROOT/.ruvector/skillsmith-docs/vectors` exists (first run is manual).
- `packages/doc-retrieval-mcp/dist/src/cli.js` exists (package is built).
- `CI` and `SKILLSMITH_CI` are unset.
- The `skillsmith-dev-1` Docker container is running (indexer requires the linux-arm64-gnu native binding).

The indexer uses `GIT_OPTIONAL_LOCKS=0` and passes
`--no-optional-locks` to every `git diff` invocation, avoiding the
SMI-2536 smudge-filter branch-switch hazard. Hook failure is non-fatal
and non-blocking. Sessions opened in worktrees share the same corpus — the Docker container bind-mounts the main repo at `/app` and there is no per-worktree index.

To disable the auto-reindex: `rm -rf .ruvector/skillsmith-docs/` (first-run
branch skips), or remove `packages/doc-retrieval-mcp/dist/`.

---

## Operations

### Rebuild from scratch

```bash
rm -rf .ruvector/
docker exec skillsmith-dev-1 node /app/packages/doc-retrieval-mcp/dist/src/cli.js reindex --full
```

### Verify a query end-to-end

```bash
docker exec skillsmith-dev-1 node /app/packages/doc-retrieval-mcp/dist/src/cli.js status
docker exec skillsmith-dev-1 node -e "import('/app/packages/doc-retrieval-mcp/dist/src/search.js').then(m => m.search({ query: 'git-crypt worktrees', k: 3 })).then(r => console.log(JSON.stringify(r, null, 2)))"
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

## Session Priming (SMI-4451)

A `SessionStart` hook (`scripts/session-start-priming.sh`) writes a transient priming index to `/tmp/session-priming-${SESSION_ID}.md` and pipes the same content into initial context as `additionalContext`. Fires only on `source=startup` and `smi-*`/`wave-*` branches; otherwise no-op. The transient file is mode 0600 and swept after 24h. Disable with `SKILLSMITH_DOC_RETRIEVAL_DISABLE_PRIMING=1`. The underlying retrieval index lives in `packages/doc-retrieval-mcp/`.

**Per-class rank boost (SMI-4468)**: `rerank.ts` multiplies similarity by 1.5x for `class: feedback`/`project` chunks and 0.85x for `class: wave-spec`/`plans-review` chunks before applying absorption/supersession penalties. Tunable via `SKILLSMITH_DOC_RETRIEVAL_BOOST_MEMORY` and `SKILLSMITH_DOC_RETRIEVAL_DAMPEN_PROCESS` (clamped to [0.1, 5.0]).

**Memory adapter prerequisite (SMI-4677)**: the `memory-topic-files` adapter that ingests host-scope `~/.claude/projects/<encoded>/memory/feedback_*.md` and `project_*.md` files into the index requires `SKILLSMITH_PROJECT_DIR_ENCODED` set in `.env` (validated by Varlock; see `.env.schema`). Without it, the bind in `docker-compose.yml` resolves to a non-existent host path and the adapter produces zero memory chunks — silently degrading priming + the per-class boost above. Setup one-liner in [Setup (first run)](#setup-first-run).

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Error: Native module not found for darwin-arm64` at Claude Code startup | The MCP server must run in Docker. Ensure `.mcp.json` uses `docker exec` (see Setup). Restart Claude Code after fixing. |
| MCP server fails: `No such container: skillsmith-dev-1` or `Cannot connect to the Docker daemon` | `docker compose --profile dev up -d`, then restart Claude Code. |
| `index not built` error from `skill_docs_search` | `docker exec skillsmith-dev-1 node /app/packages/doc-retrieval-mcp/dist/src/cli.js reindex --full` |
| `required submodule 'docs/internal' is not initialized` | `git submodule update --init` |
| `refusing to run in CI` | Expected — indexer never runs in CI. |
| MCP server doesn't appear in Claude Code | Restart Claude Code after editing `.mcp.json`. Run the package build first: `docker exec skillsmith-dev-1 npm run build -w packages/doc-retrieval-mcp`. |
| Stale results after many edits | `rm -rf .ruvector/ && docker exec skillsmith-dev-1 node /app/packages/doc-retrieval-mcp/dist/src/cli.js reindex --full` |

---

## Deferred

Phase 2 promotes `skill_docs_search` into `@skillsmith/mcp-server` with
an `installed`/`registry` scope split (registry side uses pgvector on
Supabase, not RuVector — Deno cannot load the native module). Phase 3
evaluates longer-context embedding models and potentially replaces the
HNSW brute-force fallback in `packages/core/src/embeddings/hnsw-store.ts`
(SMI-1519 / SMI-4419).
