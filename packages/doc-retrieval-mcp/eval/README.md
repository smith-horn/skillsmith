# Retrieval Eval Harness (SMI-4702)

## Purpose

Falsifiable retrieval evaluation for the `doc-retrieval-mcp` ranking pipeline.

Every ranking constant in `rerank.ts` (`DEFAULT_BOOST_MEMORY`, `DEFAULT_DAMPEN_PROCESS`, etc.) was hand-tuned against a narrow 6-pair retro-reversal regression test. That gate caught the 2026-04-25 ship-gate halt but is coarse by design: pass/fail only, one query class, zero precision on ranking position or broader categories. A future PR bumping boost from 1.5 → 1.7 could ship green while degrading top-5 recall by 15% on implementation-lookup queries — a silent regression.

This harness replaces that folklore with a falsifiable benchmark:

- **55-entry gold set** across 6 query categories and 3 difficulty levels
- **Recall@5, Recall@10, MRR, nDCG@10** metrics computed per-run
- **Ablation sweeps** over boost, dampen, floor, and BM25 dimensions
- **CI gate** (Layer A structural + Layer B baseline drift — see [implementation plan](../../../docs/internal/implementation/smi-4702-retrieval-eval-harness.md))
- **Baseline promotion**: `baseline.json` tracks `prior` and `current` recall@5 values; a PR that regresses >5% fails CI

---

## Quick Start

**Unit mode** (CI-safe, no live index, structural validation only):

```bash
npm run eval:retrieval --workspace=packages/doc-retrieval-mcp
```

**Real mode** (requires live RuVector index and SMI-4677 bind-mount wiring):

```bash
RETRIEVAL_EVAL_REAL=1 docker exec skillsmith-dev-1 npm run eval:retrieval --workspace=packages/doc-retrieval-mcp
```

**Ablation sweep** (sweeps one dimension, holds others at production defaults):

```bash
npm run eval:retrieval --workspace=packages/doc-retrieval-mcp -- --ablate boost
npm run eval:retrieval --workspace=packages/doc-retrieval-mcp -- --ablate boost --json
npm run eval:retrieval --workspace=packages/doc-retrieval-mcp -- --ablate dampen
npm run eval:retrieval --workspace=packages/doc-retrieval-mcp -- --ablate floor
npm run eval:retrieval --workspace=packages/doc-retrieval-mcp -- --ablate bm25
```

Additional flags:

- `--json` — machine-readable JSON output (signed `deltaRecallAt5` as number, no `(↓)` annotations)
- `--category <cat>` — filter gold set to one category
- `--difficulty` — include per-difficulty breakdown in markdown output

---

## Adding Gold-Set Entries

Edit `eval/gold-set.json` (JSON array). Each entry must satisfy all four labeling guidelines:

1. **Independently verifiable**: a reviewer who has never seen the gold set must be able to confirm the `expectedChunks` are correct by reading the referenced file directly. Do not rely on familiarity or context.
2. **Specific chunks**: `expectedChunks` should identify the most specific file(s) expected — not every file that mentions the topic. If three files discuss migrations but one is authoritative, list only that one.
3. **Prefer filename substring match**: use `matchType: "substring"` on the filename itself (not the full path) to tolerate worktree/prefix variation. Example: `"feedback_audit_logs_no_user_id_column.md"` instead of a full absolute path.
4. **Calibrate difficulty honestly**:
   - **easy** — clear vocabulary match between query and file; little competition from other files
   - **medium** — 4-15 chunks, moderate competition from topic-adjacent docs
   - **hard** — expected file is short (1-3 chunks) and competes with longer topic-adjacent docs; the query vocabulary overlaps with many other documents

### Worked Example: Easy

```json
{
  "id": "q056",
  "category": "implementation-lookup",
  "query": "docker compose dev up command",
  "expectedChunks": [
    { "filePath": "CLAUDE.md", "matchType": "substring" }
  ],
  "rationale": "CLAUDE.md Docker-First section contains the exact phrase 'docker compose --profile dev up -d' as a highlighted command. The vocabulary is distinctive enough that no other file in the corpus is a credible competitor.",
  "difficulty": "easy"
}
```

**Why easy**: the query phrase `docker compose dev up` appears verbatim in CLAUDE.md's Docker-First section. The section heading itself (`## Docker-First Development`) and the command block make this a strong vocabulary match with minimal competition.

### Worked Example: Hard

```json
{
  "id": "q057",
  "category": "implementation-lookup",
  "query": "build worker eval harness produces gold set fifty entries",
  "expectedChunks": [
    { "filePath": "smi-4702-retrieval-eval-harness.md", "matchType": "substring" }
  ],
  "rationale": "The plan doc for SMI-4702 is the authoritative source for the harness design and the 55-entry gold set. However, it competes with multiple other implementation docs that also mention 'harness', 'gold set', and 'eval' in varying contexts. The expected file is long, but the competing docs have overlapping vocabulary.",
  "difficulty": "hard"
}
```

**Why hard**: the query terms `eval harness`, `gold set`, and the numeric anchor `fifty entries` appear in the plan doc, but the same cluster of words (`harness`, `gold set`, `eval`) appears in related implementation docs (SMI-4467, SMI-4468, SMI-4469 tuning records) and other benchmark discussions. The plan doc must surface above those competitors. A retrieval system that ranks by topic frequency rather than document-level specificity will fail this query.

---

## Categories

| Category | Count | Coverage |
|---|---|---|
| memory-recall | 14 | User feedback files, project memory bullets |
| implementation-lookup | 12 | Specific plan docs, ADRs, implementation specs |
| retro-lookup | 10 | Retrospective files by symptom or date |
| script-header | 8 | Shell scripts by function description |
| adr-lookup | 6 | Architecture decision records by decision topic |
| skill-discovery | 5 | Skill SKILL.md files by capability description |
| **Total** | **55** | |

---

## Baseline Lifecycle

`eval/baseline.json` is the machine-readable source of truth for regression gating. SMI-4764 added pre-push, cron, and CI automation around it; the manual "first developer to merge a ranking PR must populate" step is gone.

1. **Initial state** (shipped with Worker 3): `prior: null`, `current: null` — no real-mode run yet. The CI regression gate skips when `prior === null`.
2. **First real-mode run**: `RETRIEVAL_EVAL_REAL=1 npm run eval:retrieval` sets `current` from the run. `prior` remains `null`. The eval-runner appends a SHA-256 signature of the new `baseline.json` to `eval/.signatures.log` (FIFO 15-line cap).
3. **Subsequent real-mode runs**: eval-runner promotes `current → prior` and sets the new value as `current`. SMI-4764 Wave 1 added per-category metrics (`byCategory.recallAt5` + `byCategory.recallAt5Prior`); the hybrid drift gate uses per-category `max(5% rel, N-hit floor)` thresholds plus a 10% global tripwire.
4. **Pre-push enforcement** (SMI-4764 Wave 0, `.husky/pre-push` Phase 6 → `scripts/eval-baseline-validator.mjs`): if the push touches a ranking file (`rerank.ts`, `search.ts`, `corpus.config.json`, anything under `eval/`), the validator looks up the local `baseline.json` SHA-256 in `.signatures.log`. Hash absent in **canonical mode** (`SKILLSMITH_EVAL_CANONICAL=true`) → push **rejected** with copy-pasteable repro. Hash absent in **advisory mode** (default) → warning printed, push proceeds. Hash present → silent pass.
5. **Weekly cron** (SMI-4764 Wave 2, canonical-dev only): `scripts/eval-baseline-cron.sh` fires Sunday 03:00 local on the canonical dev's machine. If the run produces a drifted `baseline.json`, an auto-PR opens with the `eval-baseline-cron` label. A heartbeat is always written to `.cron-heartbeat`; `audit:standards` check 44 warns if it's >14 days old (replacement-protocol prompt — see `.claude/development/eval-cron-setup.md`).
6. **CI gate** (Retrieval Eval Gate in `.github/workflows/ci.yml`): on every PR that touches a ranking file, runs `check-baseline-drift.ts` against the hybrid threshold, posts a sticky comment with overall + per-category recall@5 deltas, and emits an advisory annotation (audit:standards check 45) if the new `baseline.json` SHA-256 has no matching signature in `.signatures.log`.

`eval/baseline.md` is the human-readable companion — prose only, not parsed by CI.

---

## Schema Stability Note

The `gold-set.json` schema is locked. **SMI-4706** (modern embedding bench) and **SMI-4709** (drift audit) both depend on this schema. Do not add, rename, or remove fields without coordinating with those issues first.

Current locked fields: `id`, `category`, `query`, `expectedChunks` (array of `{filePath, matchType}`), `rationale`, `difficulty`.
