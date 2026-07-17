# Baseline -- Retrieval Eval (SMI-4702)

This file is generated deterministically from `baseline.json` by `updateBaseline()`
(eval/eval-runner-baseline.ts) on each `RETRIEVAL_EVAL_REAL=1` run. Do not hand-edit --
edits are silently overwritten on the next real-mode run. The machine-readable source
of truth is `baseline.json`.

## Current Baseline

Generated: 2026-06-24

Corpus: 1995 files, 37829 chunks

Knobs: boost=1.5, dampen=0.85, floor=0.35, BM25=off

| Metric     | Value  | Prior  |
|------------|--------|--------|
| recall@5   | 0.6364 | 0.4364 |
| recall@10  | 0.7273 | -- |
| MRR        | 0.4566 | -- |
| nDCG@10    | 0.5219 | -- |

### By Category

| Category | Count | Recall@5 | Recall@5 Prior |
|----------|-------|----------|-----------------|
| adr-lookup | 6 | 0.8333 | 0.6667 |
| implementation-lookup | 12 | 0.5833 | 0.2500 |
| memory-recall | 14 | 0.9286 | 0.2857 |
| retro-lookup | 10 | 0.4000 | 0.5000 |
| script-header | 8 | 0.5000 | 0.6250 |
| skill-discovery | 5 | 0.4000 | 0.6000 |

## How This Is Updated

`updateBaseline()` writes `baseline.json`, then regenerates this file from it, after each
`RETRIEVAL_EVAL_REAL=1` run. Each write is individually atomic (temp-file-then-rename); the
two writes are not a single transaction, but a failure on either one throws and fails the run
loudly rather than silently leaving this file stale. There is no separate manual step -- hand
edits to this file are silently overwritten on the next run.

To run: `npm run eval:retrieval` (mock mode, CI structural validation)

To run with real index: `RETRIEVAL_EVAL_REAL=1 npm run eval:retrieval`

To run ablations: `npm run eval:retrieval -- --ablate boost`

See `eval/README.md` for labeling guidelines and the full workflow.
