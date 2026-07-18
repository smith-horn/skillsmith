# Baseline -- Retrieval Eval (SMI-4702)

This file is generated deterministically from `baseline.json` by `updateBaseline()`
(eval/eval-runner-baseline.ts) on each `RETRIEVAL_EVAL_REAL=1` run. Do not hand-edit --
edits are silently overwritten on the next real-mode run. The machine-readable source
of truth is `baseline.json`.

## Current Baseline

Generated: 2026-07-18

Corpus: 2426 files, 46749 chunks

Knobs: boost=1.5, dampen=0.85, floor=0.35, BM25=off

| Metric     | Value  | Prior  |
|------------|--------|--------|
| recall@5   | 0.6545 | 0.6364 |
| recall@10  | 0.7455 | -- |
| MRR        | 0.4616 | -- |
| nDCG@10    | 0.5298 | -- |

### By Category

| Category | Count | Recall@5 | Recall@5 Prior |
|----------|-------|----------|-----------------|
| adr-lookup | 6 | 0.8333 | 0.8333 |
| implementation-lookup | 12 | 0.5833 | 0.5833 |
| memory-recall | 14 | 0.9286 | 0.9286 |
| retro-lookup | 10 | 0.4000 | 0.4000 |
| script-header | 8 | 0.6250 | 0.5000 |
| skill-discovery | 5 | 0.4000 | 0.4000 |

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
