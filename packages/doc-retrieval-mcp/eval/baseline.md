# Baseline -- Retrieval Eval (SMI-4702)

This file is auto-regenerated alongside `baseline.json` on each `RETRIEVAL_EVAL_REAL=1` run.
It is prose-only; the machine-readable source of truth is `baseline.json`.

## Current Baseline

Generated: 2026-05-05 (initial null state -- no real-mode run yet)

Corpus: 0 files, 0 chunks

Knobs: boost=1.5, dampen=0.85, floor=0.35, BM25=off

| Metric     | Value | Prior |
|------------|-------|-------|
| recall@5   | --    | --    |
| recall@10  | --    | --    |
| MRR        | --    | --    |
| nDCG@10    | --    | --    |

All values are `--` because no real-mode eval run has been executed yet.
The first developer to merge a ranking-code PR must populate this baseline by running:

```
RETRIEVAL_EVAL_REAL=1 npm run eval:retrieval --workspace=packages/doc-retrieval-mcp
```

After that run, `baseline.json` will contain real metric values and this file will be updated.

## How This Is Updated

The eval runner (`eval/eval-runner.ts`) writes `baseline.json` after each `RETRIEVAL_EVAL_REAL=1` run.
The `baseline.md` companion should be regenerated at the same time by the developer who ran the eval.

To run: `npm run eval:retrieval` (mock mode, CI structural validation)

To run with real index: `RETRIEVAL_EVAL_REAL=1 npm run eval:retrieval`

To run ablations: `npm run eval:retrieval -- --ablate boost`

See `eval/README.md` for labeling guidelines and the full workflow.
