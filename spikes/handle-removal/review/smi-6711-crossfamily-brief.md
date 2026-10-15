# SMI-6711 cross-family review brief

Written 2026-09-17 by the session that ran the spike, for dispatch on or after 2026-09-19 when the
Codex usage limit lifts. It exists because the scope below depends on context that will be expensive
to reconstruct in two days and nearly impossible to reconstruct in two weeks.

**Dispatch with:** `scripts/needle/dispatch.sh --workspace <the spike worktree> --title ... --body-file <this file>`
Analysis only — omit `--expect-write`; a "no diff" outcome is expected and correct.

**Two mechanical traps, both hit for real in this work:**

- `dispatch.sh` refuses a body containing any unbroken 44-plus character run of letters, digits,
  slash, underscore or hyphen, because the bead tracker's secret scanner rejects it. Long absolute
  paths trip it. This file states directory prefixes once in prose and uses bare filenames after.
- Write no literal NUL bytes into the review or its output. Five occurrences of that class are filed
  as SMI-5539, one of them an agent that quoted a NUL verbatim into its own report and made the
  report unsearchable — `file` said `data`, and `grep` returned empty on 643 lines of markdown.

**Confirm which model answers.** Codex's default reported as `gpt-6-astra` on 2026-09-17, not
`gpt-5.6-sol`. The issue title, ADR-128 and the spike's acceptance criterion all name the latter.
Record what actually replied.

---

## Why you were asked, and what makes your answer different

Seven adversarial rounds have already run on this spike. All seven were Claude models. They were
productive — 30-plus findings, several CRITICAL, two of which would have shipped user-visible data
loss. So this is not a request for more findings of the same kind.

It is a request to break an **agreement failure**. Two are on record here:

1. A reviewer produced the claim *"the overlayfs guarded-versus-unguarded gap is 1.047 ms, 58 times
   APFS's."* The coordinating session then independently "confirmed" it by reproducing the arithmetic
   exactly. Neither asked whether the two numbers came from the same process. They came from two
   runner invocations **nine minutes forty seconds apart**. Measured within one process the gap is
   0.043 ms. About 96 percent of the published figure was between-run variance.

2. A defect sat **directly beneath a comment, written by the same author in the same commit,
   explaining why that exact defect must not exist**. A verdict function's failure clause was placed
   below a clause that pre-empted it, under the words "FAILURES BEAT THE FLOOR." Review read the
   comment and the code as agreeing. Fourteen cells shipped reporting NEVER-RAN while holding 3,076
   records of measured user-file loss.

Neither was a reasoning failure. Both were two parties sharing an assumption silently. Please read
code independently of the comments describing it, trace every cited number to whether its comparison
was controlled, and ask what a claimed verification actually covered.

---

## Part 1 — the artifacts

All paths are under the spike directory `spikes/handle-removal` unless stated.

1. `quarantine.mjs` — **production-inbound.** The owner chose quarantine-by-rename as the shipping
   mechanism on 2026-09-17, so this file is what runs against a user's skills directory.
2. `hash.mjs` and `walk.mjs`.
3. `harness/control-spec.mjs`'s verdict function and its two callers — `harness/result-schema.mjs`'s
   cell aggregator and `results/generate-summary.mjs`. This computes the verdicts the decision memo
   quotes, so a defect corrupts the evidence whether or not the code ever ships.
4. `results/decision-memo.md` as corrected. It carries strikethrough corrections. **Check whether the
   corrections are themselves correct** — a wrong retraction is worse than the claim it retracts,
   because it closes a line of inquiry that was right.
5. The four fixes made on 2026-09-17, which are the least-reviewed code in the tree:
   - the quarantine identity binding and clock gate,
   - a file-descriptor leak fix in the trash-root helper,
   - `result-shape.mjs`, a normalizer both removal paths now return through,
   - a NUL-byte fix in the tree-hash serialization, claimed to leave the digest unchanged.

## Part 2 — the decisions, which is the half that matters

For each, the question is **not** "was this defensible." It is **"what did a chain of same-family
reasoning fail to consider."**

| Decision | The question |
|---|---|
| **Ship quarantine-by-rename over the native addon** | Its load-bearing argument is *the native track cannot ship without quarantine, but quarantine can ship without the native track.* Is that true? Its four supporting measurements were re-derived independently; **the argument itself was never attacked.** Note quarantine has zero attack cells in a 606-cell corpus. |
| **Score probabilistic attacks on the landed subset, with a floor of 100** | The floor is justified by the rule of three. Is 100 right, and is the landed subset the right denominator? This rule shipped with a defect inside it. |
| **Two racer variants excluded from the probabilistic set** | They are racers by the same mechanism; the exclusion rests on calling them methodology experiments rather than attack cells. Does that distinction hold? |
| **Accept a macOS-only control for four Linux rows** | Rests on GNU rm being genuinely not vulnerable — 15 of 15 refusals. Is "no control is buildable from the platform's own rm" the same claim as "no control is buildable"? |
| **Fix the quarantine race by reusing the A1 plan's mechanism** | Reusing it avoided a second divergent design. But that mechanism was itself designed by a Claude session. Does it close the window? Is the stated residual honest? |
| **Drop Node 20 from the support matrix** | Re-scoped forward to 22, 24, 25 and 26 because every manifest already requires 22-plus. Anything downstream still assuming 20? |
| **Stop adversarial rounds on scaffolding** | Rounds were still paying out when they stopped. Was the boundary in the right place? |
| **The waiver that let seven same-family rounds gate a production UAT** | What should have been caught and was not? |

---

## What a good answer looks like

Not a list of everything. **The two or three things that would change what ships**, each with the
command that demonstrates it, the concrete failure, and the minimal fix.

If you conclude the shipping decision is wrong, say so plainly and show the work. That is a more
valuable result than confirming it, and nobody here will be embarrassed by it.

State at the top what you verified by execution and what you could not check. A gap named is correct;
a plausible story filling it is not.
