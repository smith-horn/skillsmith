# Baseline -- Retrieval Eval (SMI-4702)

This file is regenerated alongside `baseline.json` on each `RETRIEVAL_EVAL_REAL=1` run.
It is prose-only; the machine-readable source of truth is `baseline.json`.

## Current Baseline

Generated: 2026-05-06 (first real-mode run -- SMI-4762 bootstrap)

Corpus: 1325 files, 28432 chunks

Knobs: boost=1.5, dampen=0.85, floor=0.35, BM25=off

| Metric     | Value  | Prior |
|------------|--------|-------|
| recall@5   | 0.4182 | --    |
| recall@10  | 0.4909 | --    |
| MRR        | 0.2824 | --    |
| nDCG@10    | 0.3327 | --    |

`prior` is `--` because this is the first real-mode run. Subsequent runs will promote
`current → prior` and the drift check will gate >5% recall@5 regression.

### By Category

| Category               | Count | Recall@5 | Recall@10 | MRR    | nDCG@10 |
|------------------------|-------|----------|-----------|--------|---------|
| adr-lookup             | 6     | 0.5000   | 0.8333    | 0.2946 | 0.4236  |
| implementation-lookup  | 12    | 0.2500   | 0.2500    | 0.2083 | 0.2192  |
| memory-recall          | 14    | 0.2857   | 0.2857    | 0.2286 | 0.2419  |
| retro-lookup           | 10    | 0.5000   | 0.7000    | 0.3283 | 0.4161  |
| script-header          | 8     | 0.6250   | 0.6250    | 0.3854 | 0.4452  |
| skill-discovery        | 5     | 0.6000   | 0.6000    | 0.3400 | 0.4036  |

## How This Is Updated

The eval runner (`eval/eval-runner.ts`) writes `baseline.json` after each `RETRIEVAL_EVAL_REAL=1` run.
The `baseline.md` companion should be regenerated at the same time by the developer who ran the eval.

To run: `npm run eval:retrieval` (mock mode, CI structural validation)

To run with real index: `RETRIEVAL_EVAL_REAL=1 npm run eval:retrieval`

To run ablations: `npm run eval:retrieval -- --ablate boost`

See `eval/README.md` for labeling guidelines and the full workflow.

### Notes from the bootstrap run (2026-05-06)

- The eval-runner currently does NOT recompute `corpus.filesScanned` / `corpus.chunksUpserted` on each run --
  these were filled in manually from `.ruvector/.index-state.json`. Tracked as a follow-up.
- The eval-runner's GAP 1 startup check at `eval-runner.ts:90` resolves the index path relative to
  `eval/..` rather than `repoRoot()`, so it silently skips when the index is at the repo root.
  The actual `search()` call works because it uses `resolveRepoPath()` from `config.ts`.
  Tracked as a follow-up.
