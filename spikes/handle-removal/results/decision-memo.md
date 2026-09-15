# SMI-6676 decision memo — checkpoint 4

Written by the Sonnet build worker per the plan's step 15 request (routed here
by the coordinating session, which still owns cross-family review and the
owner decision). Evidence lives in `results/raw/*.jsonl`, `results/SUMMARY.md`
(regenerated, not hand-typed — `node results/generate-summary.mjs`), and the
four checkpoint reports already handed back. This memo does not repeat those
numbers; it holds each plan §10 criterion against what was actually measured
and says, for each one, MET / NOT MET / NOT MEASURED.

## Recommendation

**Native, shipped as C5 with C4 as the fallback — with the child-process
probe as a requirement, not a footnote.** Every fallback trigger this spike
forced ends in a safe quarantine with one message and no crash, including
the one failure mode (a genuinely tampered macOS code signature) that
SIGKILLs the process that `require()`s it. That fact is why "native" here
specifically means "native behind a cached child-process probe" — an
in-process `require()`-then-catch is not a variant of the same
recommendation, it is a different, unsafe design this spike's own P9
measurement rules out.

This recommendation is **conditional on the gaps below being closed**,
primarily full C1 platform coverage (only 2 of 4 in-scope targets have a
built, tested binary) and the full A1–A13/N1 attack matrix against V0/V1/V2
(this spike ran the mount attacks and the two attacks the plan's own timebox
prioritized, A5/A6, against VR — not the other ten).

## §10 criterion 1 — attacks: every A1–A8, A10(a), A11, A12, A13, N1 PASS on APFS/overlayfs/tmpfs/ext4/virtiofs; A9 no timestamp reads; A7 PASS

**Partially measured, not met as stated — most attacks were never run against VR at all.**

| Attack | Against C0 | Against V0/V1/V2 |
|---|---|---|
| A1 (mount before walk) | PASS, all filesystems tested (overlayfs) | **PASS**, overlayfs, both mount kinds, N=10 |
| A2 (mount mid-walk) | PASS, overlayfs | **PASS**, overlayfs, both mount kinds, N=10 |
| A3, A4 (swap, no reuse) | PASS, overlayfs, N=30 | **NOT MEASURED** — built and run only against C0 |
| A5 (same-tick swap, mid-walk) | PASS (ported gate), 5 filesystems | **PASS**, 5 filesystems + emulated x64, full N=300 on overlayfs/APFS |
| A6/root | PASS (ported gate), 5 filesystems | **PASS**, any guard, 5 filesystems |
| A6/inner, guard=none | N/A (C0 has no guard concept) | **FAIL by design** — honest residual, every filesystem, every variant. Closed by a caller-supplied guard hash (PASS, every filesystem) |
| A7 (file substitution) | Out of scope (this is what VR-V2 is *for*) | **NOT MEASURED** |
| A8 (symlink swaps) | Not run | **NOT MEASURED** |
| A9 (clock manipulation) | Not run — superseded by the real gate work in checkpoint 2 | **NOT MEASURED**; not applicable to VR the way it is to C0 (VR has no clock gate to defeat), but "0 timestamp reads" itself was never directly instrumented and confirmed |
| A10 (pre-bind replacement) | Not run | **NOT MEASURED** |
| A11 (hard link to outside file) | Not run | **NOT MEASURED** |
| A12 (injected errno stop rule) | Not run as its own attack; the stop-rule behavior is exercised incidentally by every other attack's `entry-removed`/`identity-changed` paths, but never via a deliberately injected EBUSY/EACCES mid-walk the way A12 specifies | **NOT MEASURED** |
| A13 (concurrent racer) | Not run | **NOT MEASURED** |
| N1 (no attack, false-positive check) | PASS 300/300, every filesystem | Ad hoc only: 180/180 clean on virtiofs specifically (checkpoint 3), not recorded as a JSONL cell, not run on the other four filesystems |

**Verdict: NOT MET as written.** What was measured (A1, A2, A5, A6) is clean and consistent everywhere it ran. What wasn't (A3/A4/A7/A8/A9/A10/A11/A12/A13 against VR, and a proper multi-filesystem N1-VR) is the largest remaining gap before this criterion can honestly be called satisfied.

## §10 criterion 2 — no spurious stops: 300/300 per filesystem in N1

**NOT MET as stated — measured for C0 only.** C0's N1 is PASS 300/300 on every filesystem tested. VR's own N1-equivalent was only run as an unrecorded ad hoc check (180/180 clean on virtiofs, the one filesystem where a spurious-stop risk was actually observed for a *different* reason — see the virtiofs finding below). No formal `n1-vr.mjs` attack module exists, so this criterion has no JSONL evidence backing it for the actual native candidate.

## §10 criterion 3 — installs: clean, no-toolchain, `--ignore-scripts` load on all 4 in-scope targets; one binary loads under Node 20/22/24

**Partially met.**
- **Clean install, no toolchain (P3): MET**, but only for **2 of the 4** in-scope targets (darwin-arm64, linux-arm64). darwin-x64 and linux-x64-gnu were never built as real binaries — linux-x64 was tested only for *loading behavior* (correctly falls back, since no prebuild exists for it), which is a different claim than "a real x64 binary loads cleanly."
- **`--ignore-scripts`: NOT MEASURED directly**, though moot in the strict sense — the package has no `install`/`postinstall` script at all, so there is nothing for `--ignore-scripts` to skip. This should still be measured explicitly before the criterion is called met, since "nothing to skip" and "skip flag correctly honored" are not the same claim.
- **Node 20/22/24: NOT MEASURED.** Every test in this spike ran under whatever Node the container/host provided (22.x throughout). No cross-version load test was run against the actual shim.

## §10 criterion 4 — failure degrades: every trigger ends in C4 with one message, no crash; if P9 kills, native OK only if a cached probe costs ≤100ms

**MET, and this is the criterion checkpoint 4 measured most rigorously.** All six real triggers were forced through the *full* `removeTree()` dispatcher, not simulated:

| Trigger | How it was forced | Result |
|---|---|---|
| `SKILLSMITH_REMOVAL_NATIVE_DISABLE=1` | Real env var | Quarantined, 1 stderr line, content intact |
| Missing prebuild file | Real file deletion, both platforms | Quarantined, 1 stderr line, content intact |
| Wrong-platform binary | Real cross-platform binary swap, both directions | Quarantined, 1 stderr line, content intact |
| No matching prebuild at all | Real: linux-x64, genuinely zero prebuilds shipped for it | Quarantined, 1 stderr line, content intact |
| glibc too old | Real: `node:22-bullseye-slim` (glibc 2.31) against the real linux-arm64 binary (real floor: GLIBC_2.33, corrected from the plan's own earlier GLIBC_2.17 claim) | Quarantined, 1 stderr line, content intact |
| macOS signature tamper (SIGKILL) | Real: a byte flipped inside the loaded code segment of the real, signed darwin-arm64 binary | **Child probe SIGKILLed; the dispatcher itself never crashed**, correctly read the signal, quarantined, content intact |

The probe cost (spawn + require + self-test, child process, cached per
process) measured **~22.5ms median, 26.4ms max** across 10 runs
(checkpoint 3) — inside the plan's ≤100ms bar. **Criterion 4: MET.**

## §10 criterion 5 — size: ≤150KB/platform binary, ≤1MB total install

**Met for what was built, incomplete overall.** darwin-arm64: 53,240 bytes. linux-arm64: 71,536 bytes. Both well under 150KB. Total for 2 platforms: ~125KB, well under 1MB — **but only 2 of 4 in-scope platform binaries exist**, so the "≤1MB total" claim is not yet a claim about the real 4-platform artifact.

## §10 criterion 6 — cold start: warm require+self-test ≤10ms; first load on macOS ≤300ms once

**NOT MET as measured, needs a corrected re-measurement.** The ~22.5ms figure above is the **child-process probe's** cost (process spawn included), which is what criterion 4 is actually about. Criterion 6 asks about the **in-process** `require()` + self-test cost alone, with no spawn overhead — that was never isolated and measured separately in this spike. The "first load on macOS" figure (152–252ms) is carried over from checkpoint 0's F3 probe of a trivial hello-world addon, not re-measured against the real, larger shim.c built in checkpoint 2. Given cold-start cost plausibly scales with binary complexity, this should be re-measured against the real artifact before treating F3's number as still representative.

## §10 criterion 7 — supply chain: CI-only build with provenance describable; P-A adds 0 published packages

**NOT MEASURED — analysis only, as the plan itself scopes it (ADR-109: no real CI/publishing infrastructure is in scope for this spike).** No claim either way.

## C1 vs C2

**Not applicable — C2 (Rust/napi-rs) was never built in this spike.** Checkpoints 1–4 built and measured C1 only. Nothing here supports a C1-vs-C2 comparison; the plan's own preference for C1 (smaller, no Rust toolchain, GLIBC_2.17 floor) should be re-examined given this spike's own C1 glibc floor came in at GLIBC_2.33, not 2.17 — a materially different number from what motivated the original preference.

## C4 (quarantine) against D1 as written

**MET, and attacked directly per the coordinator's explicit ask.** Every one of D1's five named failure errnos (EXDEV, EACCES, EROFS, EBUSY, ENOSPC) was forced for real (a non-root user for EACCES specifically, since root bypasses DAC bits and would have proven nothing; real mounts for EROFS/EBUSY/EXDEV; a real 16KB tmpfs run to exhaustion for ENOSPC) and confirmed: nothing moves, nothing is deleted, the tree is exactly where it was, `quarantine-failed` is the reported reason in every case. Two real bugs were found and fixed while attacking this: an unwrapped sidecar write that let `ENOSPC` escape as an uncaught exception *after* a tree was already safely quarantined (data was never at risk, but the function crashed instead of reporting cleanly), and three of D1's own early-validation paths using invented reason codes instead of D1's literal single `quarantine-failed` string.

**Gap: the full §5.3 row set (Q1–Q10, R1–R3) was not built.** Those rows test D1 against the *A1 design's actual callers* (abort cleanup, cross-device move, `removeIfSame`, `ActivationManager.undo`, `author init` rollback) — none of that caller code exists yet; it's still design, not implementation. This spike's errno-forcing tests confirm the *mechanism* D1 specifies is sound; they do not confirm every caller integrates with it correctly, because there is no caller to test yet.

## Quarantine cost (priority 3)

Measured against this repo's own real `.claude/skills/` content (the plan's
suggested fixtures, `data/external-skills` and `packages/*/assets/skills`,
don't exist in this worktree's checkout). Median real skill: 19,713 bytes.
After 10 simulated uninstalls with no pruning: **195.8KB held**, essentially
exactly 10× the per-skill size (no deduplication, as expected — each
quarantine is an independent rename). A doctor-style recursive scan to find
all 10 costs **61 readdir/stat operations** (~6 per quarantined tree). Fixed
sidecar overhead: **333 bytes per tree**, constant regardless of tree size.

## New finding this checkpoint didn't ask for but is worth carrying: the virtiofs anomaly's actual shape

Checkpoint 3 found `identity-changed` spurious stops on virtiofs specific to
files created and re-checked in rapid succession (not general FUSE
instability — 180/180 clean on an ordinary removal). This checkpoint's
formal `n1-vr` gap (above) means that finding still isn't backed by a full
multi-filesystem, per-candidate N1 sweep — closing that gap would also
close this one.

## Day-4 stop rule

**Not triggered.** No unexplained data loss anywhere in this checkpoint.
