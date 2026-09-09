# data/wordlists/

Inputs to `scripts/gen-weak-password-lexicon.mjs`, which emits the
`COMMON_WEAK_PASSWORDS` lexicon used by the `sensitive_path` MF-4b veto
(SMI-6441). Never published — see `data/` package-`files`-field verification
in the plan doc, Wave 1 Step 1.4.

## Files

| File | What it is | Editable? |
|---|---|---|
| `seclists-xato-top-10000.txt` | Vendored, unmodified bytes of SecLists' `xato-net-10-million-passwords-10000.txt` at a pinned commit | **No** — upstream bytes, verified by SHA-256 before every generation run |
| `LICENSE-SecLists` | SecLists' MIT license text, carried alongside the vendored snapshot per MIT's notice-must-travel-with-the-copy requirement | **No** — upstream bytes |
| `SOURCES.json` | Provenance record (`file`, `upstream`, `path`, `commit`, `sha256`, `license`, `retrieved`) for every vendored file above | Only when re-pinning to a new upstream commit |
| `doc-vocab-keeplist.txt` | Hand-curated documentation-vocabulary subtraction list | **Yes** — see below |

## `doc-vocab-keeplist.txt` is the sole guard against a documentation false positive

This is the single most important file in this directory. The generator
subtracts every token in it from the filtered SecLists list before emitting
`COMMON_WEAK_PASSWORDS`. Two failure directions, both silent if this file
drifts:

- A careless **addition** silently **weakens detection** (removes a real
  common password from the veto set).
- A careless **omission** silently **creates a false positive** (an ordinary
  documentation word like `access`, `master`, or `rotation` gets vetoed to
  HIGH severity — reopening the exact FP class SMI-5207 closed).

A second, separate mechanism — the generator's `PROSE_STOPWORDS`
disjointness gate — is **not interchangeable** with this keeplist: it is a
hard-fail invariant check (the build stops and names the colliding token),
not a silent subtraction. See the file's own header and the plan doc's
§ item 2 for the distinction.

## Regenerating

```bash
npm run lexicon:weak-passwords          # --write
npm run lexicon:weak-passwords:check    # --check, exit 1 on drift
```

**Any edit to `doc-vocab-keeplist.txt` or a re-pin of the vendored snapshot
requires re-running Wave 2's fixture matrix** before it is safe to commit —
these files are inputs to generated source shipped into three scanner
substrates, one of them production Deno edge code.

## Only the first 5,000 ranks of the vendored snapshot are used (M-2a)

`seclists-xato-top-10000.txt` is 10,000 lines, but the generator only feeds
its first `SOURCE_RANK_LIMIT = 5000` lines into the lexicon
(`lines.slice(0, SOURCE_RANK_LIMIT)`, applied **before** any shape
filtering) — a reader who assumes all 10,000 lines are in use will
mis-predict what the MF-4b veto fires on. The file is frequency-rank-ordered
(most common password first), so the cut keeps the most-common half and
drops the least-common half; it is not an arbitrary sample, and the true
FN-coverage cost is documented in the plan doc's "Sizing the corpus"
section. **Raising `SOURCE_RANK_LIMIT` is a gated change**, not a config
tweak — it requires re-running the sizing table (both the `[2000,6000]`
count gate and the `<=480`-line gate), the Wave 2 fixture matrix, and the
Wave 2 Step 4 full-population counterfactual replay.

## Pointers

- Full design: [`docs/internal/implementation/smi-6441-weak-password-veto.md`](../../docs/internal/implementation/smi-6441-weak-password-veto.md)
- [`docs/internal/adr/149-generated-scanner-data-veto-severity-model.md`](../../docs/internal/adr/149-generated-scanner-data-veto-severity-model.md)
- Generated output: `packages/core/src/security/scanner/SecurityScanner.weak-passwords.ts`,
  `scripts/indexer/_shared/security-scanner-edge.weak-passwords.ts`,
  `supabase/functions/_shared/security-scanner-edge.weak-passwords.ts`
