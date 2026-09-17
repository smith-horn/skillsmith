# SMI-6676 decision memo — checkpoint 7

Written by the Sonnet build worker per the plan's step 15 request (routed here
by the coordinating session, which still owns cross-family review and the
owner decision). Evidence lives in `results/raw/*.jsonl`, `results/SUMMARY.md`
(regenerated, not hand-typed — `node results/generate-summary.mjs`), and the
earlier checkpoint reports already handed back. This memo does not repeat those
numbers; it holds each plan §10 criterion against what was actually measured
and says, for each one, MET / NOT MET / NOT MEASURED.

**Where the raw evidence lives, stated plainly because it changes what an owner
can re-derive.** `spikes/handle-removal/.gitignore` lists both `results/raw/` and
`prebuilds/` (unanchored, so it also catches `native-c/prebuilds/`; confirm with
`git check-ignore -v <path>`). The 46,760 records and both compiled binaries are
therefore **machine-local — they are not on the branch**, and an owner reading
this from `main` cannot re-derive a single number in it from the raw data. What
IS on the branch and tracked: every harness and attack script, this memo, and
`results/SUMMARY.md` — which is regenerated from the raw data and carries the
per-cell ran/passed/failed/never-ran counts and the control status.

> **CORRECTION 2026-09-17 — this memo's own reproducibility instruction was
> broken, and it is the most consequential error found in it.** The sentence
> here used to say `SUMMARY.md` carries those counts "for all 560 cells, so the
> cell-level claims here ARE checkable from the branch." **Follow that today and
> the numbers contradict this memo with nothing explaining why.** `SUMMARY.md`
> now reads **606 cells / 136,240 records / 60 raw files**; every figure in this
> memo was computed against **560 cells / 46,760 records / 34 raw files**.
>
> The corpus is not corrupt and the memo is not stale in its conclusions — the
> corpus GREW. The `A13-WARMARM` arms alone added 86,400 records, and the scored
> `guardHash` cell, the `A13-VALIDATE` runs and the Linux filesystem passes
> added the rest. Nothing was removed.
>
> **So read this memo's tables as a point-in-time snapshot of the 560-cell
> corpus, not as a live query against `SUMMARY.md`.** Where the two disagree on a
> total, `SUMMARY.md` is current and this memo describes an earlier state.
> Where they disagree on a *verdict*, see the plan's R6 section: `verdictFor`'s
> clause order was corrected on 2026-09-17 and 14 cells legitimately changed
> verdict.
>
> This is the same defect class this memo exists to document, turned on the memo
> itself: a confident, checkable-looking instruction that nobody executed. Digests of the two binaries, so a later build can
be compared against what was measured:

| Artifact | Bytes | sha256 |
|---|---|---|
| `native-c/prebuilds/darwin-arm64/shim.node` | 53,240 | `bb5e950da25c37850358576c9251b6b39044a4eadd2f9eada262a86e64da64f4` |
| `native-c/prebuilds/linux-arm64/shim.node` | 71,488 | `415010c974e92f3c886af0d8f664ea3cabf34fcbdd2bb0c93850e909435bbc7d` |

A further consequence, named rather than left to be discovered: the "pre-fix
A13" stdout this memo's A13 provenance paragraph leans on exists in **no file
at all** — it was terminal output from an exploratory run, and it is gone. Those
four pre-fix numbers are the one class of figure in this memo that cannot be
checked by anyone, including its author.

---

## Read this first

**This memo is checkpoint 7 and has since been partly superseded. Five
adversarial rounds ran against it and the code on 2026-09-16; four of its claims
are corrected inline below and marked SUPERSEDED / CLOSED / DONE / ATTEMPTED.
The corrections are written at the point of the original claim rather than
collected here, because a correction filed elsewhere leaves two surfaces
disagreeing and the wrong one is read first. Where this memo and the plan's
"Spike results" section disagree, THE PLAN IS NEWER. In particular: its "all but
7" residual figure is wrong by roughly 5x, its `quarantineLeft` gap is closed,
and the 1.047 ms overlayfs timing gap cited for Linux was an artifact of
comparing two runs made nine minutes apart -- measured within one process it is
0.043 ms.**

This memo now gates a customer-facing UAT, so the headline goes first and
unhedged:

1. **Plan §10 criterion 1 is NOT MET.** Not "MET with one exception" — NOT MET,
   on every filesystem. An earlier draft of this memo said MET; that was
   contradicted by its own `results/SUMMARY.md`, and the re-score is below.
2. **The reason is not that the native candidate lost data in the configuration
   this memo recommends.** It is that (a) A13, the concurrent-racer row,
   produces losses in the *unguarded* configuration and has no PASS cell on any
   filesystem, and (b) several attacks' required controls never ran, so their
   clean results prove nothing under the plan's own verdict rule.
3. **The configuration the recommendation actually mandates — V2 plus a
   caller-supplied guard hash — was never run against A13 until this pass. It
   now has been: 1,500 runs, five filesystems, 807 of them with the racer
   confirmed to have landed while the walk was running. Zero user-file losses.**
4. **A real, exploitable defect was found in the fallback path and fixed this
   pass**: `removeTree(target, { guardHash })` was silently unguarded on the
   quarantine path. See "The guard-hash condition was tickable with the exposure
   intact" below.
5. **Two criteria that gate the recommendation are still not met on their own
   terms**: criterion 3 (only 2 of 4 platform binaries exist) and criterion 6
   (cold start never isolated). Criterion 7 was never measured, by plan scope.

What that adds up to: the architectural claim is in better shape than the
criterion score, but the criterion score is what the plan says to decide on, and
it says the spike is not finished. The specific, bounded work that would finish
it is listed under "What would close criterion 1" below.

---

## Recommendation

**Native, shipped as C5 with C4 as the fallback — with the child-process probe
AND a caller-supplied guard hash both as requirements, not footnotes.** The
probe requirement is unchanged from checkpoint 4: every fallback trigger this
spike forced ends in a safe quarantine with one message and no crash, including
the one failure mode (a genuinely tampered macOS code signature) that SIGKILLs
the process that `require()`s it, and an in-process `require()`-then-catch
remains a different, unsafe design this spike's own P9 measurement rules out.

**This recommendation is conditional on all of the following. It is not a
summary of the criteria below — it is narrower than they are, and where they
disagree the criteria win.**

| # | Condition | Status now |
|---|---|---|
| 1 | A wrong `guardHash` passed to `removeTree()` leaves the tree in place, on the native path AND the fallback path, and the sidecar records the hash that was actually verified | **MET this pass** — `harness/test-guard-hash-parity.mjs`, 6 tree shapes + 4 behavioural cases, all pass; confirmed to FAIL against the unfixed code |
| 2 | All four in-scope platform binaries built and load-tested (§10 criterion 3) | **NOT met** — 2 of 4 (darwin-arm64, linux-arm64) |
| 3 | One binary loads under Node 20, 22 and 24 (§10 criterion 3) | **NOT MEASURED** — everything ran on 22.x |
| 4 | `--ignore-scripts` install measured, not argued moot (§10 criterion 3) | **NOT MEASURED** |
| 5 | Warm in-process `require` + self-test ≤ 10 ms, and first macOS load ≤ 300 ms, measured against the REAL shim (§10 criterion 6) | **NOT MET** — never isolated from the child-probe cost; the 300 ms figure is a hello-world addon's |
| 6 | §10 criterion 1 PASS on every named cell | **NOT MET** — see the re-score below |
| 7 | Supply chain describable (§10 criterion 7) | **NOT MEASURED** — out of plan scope (ADR-109) |

Condition 1 used to read "every call site that invokes `removeTree()` must
compute and pass `guardHash`". That is a promise about call sites, not a
property of the system, and it was unfalsifiable from outside the code — which
mattered, because it was **tickable with the exposure fully intact**. It is now
a behavioural acceptance test, which is a thing an owner can run.

### The guard-hash condition was tickable with the exposure intact

`removeVR` read `options.guardHash`. `quarantineTree` read `options.treeHash`.
`removeTree` forwards its options verbatim to both. So a caller doing exactly
what condition (1) demanded — passing a guard hash to `removeTree()` — got no
guard at all whenever the fallback ran, and the hash was silently dropped into
the sidecar as `null`. Reproduced before the fix:

```
$ SKILLSMITH_REMOVAL_NATIVE_DISABLE=1 node -e "... removeTree(target, { guardHash: 'DELIBERATELY-WRONG-HASH' })"
[skillsmith] native tree removal unavailable (env-disable); quarantining instead. ...
result           = {"status":"quarantined", ...}
original exists  = false
sidecar.treeHash = null
```

This was the more dangerous half of the gap the checkpoint-6 draft already
described in prose ("`quarantineTree()` needs the same verify-before-act step
`removeVR` already has"): prose cannot be run, and the parameter-name mismatch
meant the gap was invisible to a caller who believed they had done everything
asked of them.

**Fixed this pass, in `quarantine.mjs`:**

- `quarantineTree` now reads `options.guardHash` (the same name `removeVR`
  uses), keeping `options.treeHash` only as a deprecated alias so an older
  caller is not silently ignored.
- It recomputes the tree's own hash **before** `rename(2)` — the destructive
  step — and returns `{status:'kept', reason:'identity-changed'}` without moving
  anything on a mismatch.
- The sidecar records the hash that was actually verified; `null` now means
  "no guard hash was supplied", which is a different and honest claim from the
  old `null`, which meant "a hash may have been supplied under a name nothing
  read".
- The path-based hash is built with the **same** `computeTreeHash` from
  `hash.mjs` that the handle-based guard pass uses, imported rather than
  reimplemented, so one `guardHash` value satisfies both paths.

**The acceptance test, and its own red test.** `harness/test-guard-hash-parity.mjs`:

| Case | What it pins |
|---|---|
| T0, both paths | The path under test was **actually exercised** — the native arm really ran native, the fallback arm really fell back |
| T1, both paths | A WRONG `guardHash` leaves the tree and its content in place |
| T2, both paths | A CORRECT `guardHash` still acts — without this, T1 passes trivially for an implementation that never removes anything |
| T3, 6 tree shapes | The two paths agree on the hash of the same tree (flat files, nested, empty dir, symlink, empty file, exec-mode file) |
| T4 / T4b | The sidecar records the verified hash, and records `null` only when no hash was supplied |

T0 earned itself on its first Linux run: without it, a container whose packaged
prebuild was missing ran the **fallback for both arms** and printed a clean
sheet, reporting the native cases as passing when the native path had never been
exercised. The results above are with T0 green on both macOS (APFS host) and
Linux (container, real `linux-arm64` prebuild loaded).

All cases pass on both platforms. **They were then run against the unfixed code**
(the verify
removed, the option name un-unified, per the SMI-6598 rule that a regression
test you have not watched fail is unverified): `T1/fallback` and `T4/fallback`
FAIL, with exactly the observed defect —
`status=quarantined treeExists=false contentExists=false` and
`sidecar.treeHash=null`. The native-path cases pass either way, correctly: the
defect was never on that path.

**What this fix does NOT do**, stated because the fallback's limits are the
thing a UAT will lean on: the fallback's hash comes from a **path walk**, because
C4 runs precisely when no native shim is available to hold handles. It closes
the pre-aged-substitute class (something already sitting under the target's name
before the call). It does **not** close the concurrent-race class the way VR's
held-fd guard pass does, and must not be described as if it did.

### The C0 gate the fallback was expected to lean on does not work

C0's UD25 gate compares a directory's real birthtime against a threshold
established from two filesystem probes taken *after* `removeC0()` is called
(`c0-walk.mjs`'s `establishThreshold()`, quoted in full under criterion 1/A9
below). Anything that already existed before that moment — a substitute created
seconds, minutes, or days earlier, with no forgery of any field — passes the
check by construction. This is not a race: there is no window to miss, because
the threshold is set after the attacker's substitute already exists. Measured
directly (`harness/measure-preaged-gate-defeat.mjs`, on APFS and overlayfs —
those two only, and the table below says so per row — five age gaps from 0 ms to
2000 ms, independently reproduced by the coordinator): C0 is defeated in every
cell, including the 0 ms gap.

**What works in its place, measured on the same cells**: a caller-supplied
`guardHash` — a content hash of the tree computed before the operation, compared
against a fresh hash taken at removal time — passes every one of those same
cells, on every candidate (V0, V1, V2), at every age gap, because it never reads
a clock or any other timestamp field at all (`wrapStatAtFieldLog` confirms zero
timestamp-shaped keys ever appear in what the native shim returns). This property
is **not native-specific**: nothing about comparing two content hashes depends on
held file descriptors, `openat`, or any syscall this spike's C1 shim provides — a
pure-JS candidate could implement the identical check, and as of this pass the
pure-JS fallback does. The pre-aged finding does not favor native over a JS
design or the reverse; it favors verifying a caller-supplied hash over not
verifying one, which is orthogonal to the native-vs-JS question this memo
otherwise argues.

---

## §10 criterion 1 — attacks: every A1–A8, A10(a), A11, A12, A13, N1 PASS on APFS/overlayfs/tmpfs/ext4/virtiofs; A9 no timestamp reads; A7 PASS

### Verdict: NOT MET, on all five filesystems

A prior draft of this section scored it "**MET** for the five filesystems this
pass actually reached, with exactly one honest, named exception (A8(b)'s absent
control)". That was wrong, and it was contradicted by this spike's own
`results/SUMMARY.md` at the time it was written. Restated against the data:

| Claim in the prior draft | What the data says |
|---|---|
| Every named cell PASSes on five filesystems | A13 has **no PASS cell on any filesystem** — every A13 cell is FAIL or NEVER-RAN |
| Exactly one un-controlled cell (A8(b)) | The harness could not have found a second one; wired up, it finds **93** |
| Verdict MET | 151 cells FAIL, 51 NEVER-RAN, 93 NEVER-RAN (control) |

All 20 A13 cells, from `results/SUMMARY.md` — 2 FAIL, 18 NEVER-RAN, 0 PASS:

```
A13/V1/virtiofsroot                300 runs  163 passed  137 failed   0 never-ran   FAIL
A13/V2/virtiofsroot                300 runs  174 passed  126 failed   0 never-ran   FAIL
A13/{C0,V0}/virtiofsroot                                                             NEVER-RAN
A13/{C0,V0,V1,V2}/{apfs,overlayfs,ext4,tmpfs}                                        NEVER-RAN
```

The 18 NEVER-RAN cells are never-ran because the racer did not land on every
run — which is the correct classification (a race that did not happen is not a
pass), not a defect. It does mean A13 cannot reach PASS as currently built at
all, on any filesystem, independently of whether V2 loses anything.

### Which reading of the plan's escape clause was applied, and why

The plan's criterion 1 ends: "A V2 loss that can't be **explained and fixed**
with one more review round within the timebox fails this."

That is a conjunction. The A13 V2 losses are now **explained** — measured, in
fact, not merely explained, see the racer-timing instrument below — but they are
**not fixed**: V2 under `guard=none` still loses user bytes on four of five
filesystems, and no code change in this pass removes that.

**The conjunctive (literal) reading is the one applied here.** Three reasons:

1. It is the plain text. "Explained and fixed" is not "explained or fixed", and
   a memo that reads a conjunction as a disjunction to reach a favourable score
   is doing the thing this whole spike exists to prevent.
2. The permissive reading makes the clause unfalsifiable. Any loss can be
   explained; only some can be fixed. A criterion that a sufficiently good
   narrative always satisfies is not a criterion.
3. This memo now gates a customer-facing UAT. Under that bar, the stricter
   reading is the correct default even where the text were ambiguous, and here
   it is not ambiguous.

**What the permissive reading would have bought, so the owner can see the size
of the disagreement**: even scoring the A13 V2 losses as "explained, therefore
acceptable", criterion 1 would still be NOT MET. 150 cells have a control that
is `absent` or `did-not-fail`; 93 of those are otherwise clean and therefore
score `NEVER-RAN (control)` instead of PASS, and the rest fail on their own
merits — as do the A3/`none`, A6-VR/`inner/none`, A9-VR/`*/none` and
A10-VR/`a/none` cells. The reading changes the argument, not the verdict.

### A13 runs UNGUARDED — the configuration the recommendation forbids

`harness/attacks/a13-vr.mjs` calls `removeVR(treeRoot, { ...candidate, hooks })`
with **no `guardHash`**, and the main runner never supplies one. That is
defensible on its own terms — the plan's own control for the A13 row is "C0
without UD24", i.e. the unguarded configuration — but it has a consequence the
prior draft left for a reader to discover: **A13 measures a configuration this
memo's own recommendation forbids.**

So an A13 loss under `guard=none` is not evidence about the recommended
configuration. It is evidence about a configuration no caller is supposed to
use. Both halves of that sentence matter, and the prior draft stated neither.

**So this pass ran the missing arm.** A13's racer, unchanged, against V2 **with**
a caller-supplied guard hash computed from the pristine tree before the racer is
spawned (`harness/measure-a13-race-timing.mjs --guard guardHash`), 300 runs per
filesystem, all five:

| Filesystem | Runs | Racer landed | Landed *while the walk was running* | User files lost |
|---|---|---|---|---|
| APFS | 300 | 170 | 123 | **0** |
| overlayfs | 300 | 156 | 129 | **0** |
| ext4 | 300 | 145 | 127 | **0** |
| tmpfs | 300 | 145 | 137 | **0** |
| virtiofs | 300 | 300 | 291 | **0** |
| **total** | **1,500** | **916** | **807** | **0** |

Against the same racer with `guard=none`, V2, same instrument, same session:
1,500 runs, 1,036 landed, 811 raced the walk, **244 lost**.

This is the single most decision-relevant number in the re-score, and it points
the opposite way from the criterion verdict: the attack that has no PASS cell
anywhere passes cleanly, on every filesystem, in the configuration the
recommendation actually mandates. It does not rescue criterion 1 — the plan
names A13 and A13 is not PASS — but an owner should not read "criterion 1 NOT
MET" as "native loses data under concurrency when configured as recommended".
It has not, in 1,500 runs.

Under the plan's own verdict rule this arm is still `NEVER-RAN (control)` on
four of five filesystems, because A13's named control (C0 without UD24) was
never run outside overlayfs. That is the same gap as everywhere else in this
section, not a special pleading about this result.

### The racer-timing instrument, and what it replaces

The checkpoint-6 draft said the remaining V2 losses were "all attributable to
the already-documented guard=none residual (A3/A6/A9/A10)", corroborated by A7's
controlled test showing V2 protected 30/30. **Both halves were wrong as stated.**

**The corroboration could not discriminate.** `a7-vr.mjs` hooks *post-guard* by
construction; A13's racer fires at a random 0–2 ms offset from walk start,
predominantly *pre*-guard. A7's clean result therefore says nothing about
whether A13's losses are in the window V2 closes — it was answering a different
question. It is dropped, not rewritten.

**The measured distribution is not what the draft said.** Per racer kind, from
the raw records (`extra.racerApplied`, V2, `guard=none`):

| Filesystem | V2 losses | By racer kind (lost / landed) |
|---|---|---|
| APFS | 0 | — |
| overlayfs | 22 | a3 22/33 |
| ext4 | 30 | a3 30/41 |
| tmpfs | 73 | a3 21/30, a5 14/44, **a7 23/40**, **a8 15/33** |
| virtiofs | 126 | a3 50/72, **a7 76/83** |

On virtiofs, 76 of 126 losses are `a7` — the file-substitution shape V2 exists to
close. On tmpfs, `a5` and `a8` appear too. "The A3/A6/A9/A10 residual" named a
set of attack IDs that does not match what was measured.

**The instrument the review asked for, built this pass.** The checkpoint-6 draft
said the virtiofs explanation was "not separately re-proven with a dedicated
controlled test (that would need instrumenting exactly when a landed mutation
occurred relative to the guard pass, which this pass did not build)". It is
cheap, because `a13-vr.mjs` already controlled the racer's delay: the racer child
now reports the absolute instant its mutation landed, and two `removeVR` hooks
(`afterBind`, `betweenGuardAndRemoval`) report when the guard pass started and
ended, on the **system monotonic clock** (`process.hrtime.bigint()`), which is
shared across processes on one host.

That turns the attribution from a story into a phase:

- **pre-guard / during-guard / straddles-guard-start** — the guard pass hashed
  the attacker's own content. Only a caller-supplied `guardHash` could have
  caught it. This is the real residual.
- **post-guard** — landed inside the window V2's per-entry re-verification
  exists to close. **A loss here would be a genuine V2 gap.**
- **straddles-guard-end** — the mutation began before the guard pass ended and
  completed after. Ambiguous by construction; reported as its own bucket rather
  than forced onto one side.
- **post-call** — landed after `removeVR()` returned. Raced nothing.

Results, V2, `guard=none`, 300 runs per filesystem:

| Filesystem | Landed | Raced the walk | Lost | post-guard landings | **post-guard losses** |
|---|---|---|---|---|---|
| APFS | 135 | 110 | 1 | 0 | **0** |
| overlayfs | 226 | 141 | 41 | 2 | **0** |
| ext4 | 203 | 128 | 30 | 4 | **0** |
| tmpfs | 172 | 146 | 64 | 1 | **0** |
| virtiofs | 300 | 286 | 108 | 2 | **0** |
| virtiofs, V1 | 297 | 285 | 127 | 1 | **0** |

**SUPERSEDED 2026-09-16 -- the sentence below was produced by a defective
classifier and its "all but 7" is wrong by roughly 5x.** `classifyPhase`'s
`straddles-guard-start` branch tested `mutationStartedAt` alone and never looked
at where `landedAt` fell, so it swallowed during-guard, post-guard and post-call
landings alike. Re-measured with the corrected classifier: **115 landings fell
after the guard pass ended and before the call returned, and 34 of them were
losses** -- 32 carrying `straddles-guard-start` purely by branch order. The
per-entry instrument built to resolve those 34 could not: the racer's mutation
runs 10-37x longer than the window it is compared against. See the plan's
"Adversarial review" and "Fourth round" sections. The original sentence, kept so
the correction has a subject:
~~Across 10 unambiguous post-guard landings, zero losses. All but 7 of the
remaining losses landed pre-guard, during-guard, or straddling the guard pass's
start; the other 7 straddled its end and are reported as ambiguous immediately
below rather than claimed for either side.~~ The virtiofs `a7` losses are
`a7`-*shaped mutations* that landed
before or during the guard pass, not in the post-guard window A7's controlled
test probes — which is why A7's clean result and A13's losses were never in
tension, and why the old sentence attributing them to a list of attack IDs was
the wrong shape of claim.

**Named, not smoothed:** 235 landings across the `guard=none` rows fell in
`straddles-guard-end`, of which 7 lost. Those 7 are genuinely ambiguous — the
instrument cannot say whether the substituted content was visible to the guard
pass for that entry — and they are the one bucket where a post-guard V2 gap
could still be hiding. Narrowing them needs per-entry guard timing, not
per-pass, which this instrument does not do.

**The instrument is its own control on whether it perturbed the race.** The
overlayfs V2 landed-race loss rate measured 18.1% under the instrumented runner
against 17.3% in the pre-existing A13 cell, and virtiofs 36.0% against 42.0% —
same shape, ordinary run-to-run variance, no sign that two hook calls changed
the outcome. The new runs were written to their **own** cell label
(`A13-TIMING`) and their own raw files, never appended to the existing A13 cells,
per this memo's own rule about never merging two generations of one cell.

**An instrument defect the timing data exposed, which affects every A13 number
in this memo.** The "landed-race" denominator used throughout is
`extra.racerApplied != null`, which counts runs where the racer's mutation
*succeeded* — including runs where it landed **after `removeVR()` returned**, and
therefore raced nothing. Those can only ever score as passes, so they deflate
every rate. Measured **within the `A13-TIMING` runs**, where both denominators
are available for the same 300 runs (so this is a correction, not a comparison
across two runs):

| Filesystem (V2, guard=none) | Landed | Lost | Rate on "landed" | Raced the walk | Rate on "raced" |
|---|---|---|---|---|---|
| APFS | 135 | 1 | 0.7% | 110 | 0.9% |
| overlayfs | 226 | 41 | 18.1% | 141 | **29.1%** |
| ext4 | 203 | 30 | 14.8% | 128 | **23.4%** |
| tmpfs | 172 | 64 | 37.2% | 146 | **43.8%** |
| virtiofs | 300 | 108 | 36.0% | 286 | 37.8% |

On overlayfs 81 of 226 "landed" runs (36%) raced nothing at all; on virtiofs, 0
did, which is why its rate barely moves. The five-column A13 table below reports
the **original** denominator, because that is what the pre-existing A13 cells
were scored with and no phase data exists for them; treat those figures as lower
bounds on the true raced-loss rate for every filesystem except virtiofs.

### A13 — real concurrent racer, all five filesystems

The prior draft's table had two columns (APFS and overlayfs), so a reader took
away "worst V2 loss is 17.3%". The three filesystems it omitted are the three
worst. All five, post-fix, `guard=none`, landed-race rates (landed / % of those
that lost user bytes):

| Candidate | APFS | overlayfs | ext4 | tmpfs | virtiofs |
|---|---|---|---|---|---|
| C0 | 114 / 14.0% | 242 / 85.1% | 230 / 74.8% | 222 / 80.2% | 270 / 39.3% |
| V0 | 116 / 7.8% | 89 / 43.8% | 87 / 43.7% | 79 / 69.6% | 297 / 37.7% |
| V1 | 114 / **0.0%** | 103 / 36.9% | 90 / 41.1% | 119 / 57.1% | 300 / 45.7% |
| V2 | 115 / **0.0%** | 127 / **17.3%** | 143 / **21.0%** | 147 / **49.7%** | 300 / **42.0%** |

V2 is the best candidate on every filesystem, and on four of five it still loses
user bytes when run unguarded. The same cells with a guard hash: 0 losses
everywhere (table above).

**The V2 quarantine-revert defect, and what "zero stranding" actually means.**
`removeDirV2`'s quarantine step renamed a directory into `Q`, verified its
identity, then called `unlinkAt(Q, rnd, true)` (rmdir) — but if that rmdir failed
(e.g. a racing writer adds a new file inside the directory after it has been
fully processed but before its own rmdir runs, giving a real `ENOTEMPTY`),
nothing reverted the rename. The entry — and the racer's own content inside it —
was left correctly un-destroyed but permanently stranded under a random name in
the operation's own quarantine directory. Fixed by consolidating all four
`quarantineEntry` call sites into one `quarantineAndRemove(D, name, isDir,
verifyFn)` (`walk.mjs`) that reverts the rename on ANY failure past the initial
rename.

A prior draft claimed the fix was confirmed by "**zero `stopped/removal-failed`
(ENOTEMPTY-stranding) records anywhere**". That is false as a count, and it
named the wrong signature:

- There are **60** `stopped/removal-failed` records in the A13/V2 cells — APFS
  18, ext4 16, overlayfs 14, tmpfs 12, virtiofs 0.
- **None of the 60 coincides with a user-file loss** (`userFiles.lost + changed`
  is 0 in all 60), which is the property that was actually meant.
- The stranding signature the fix targets is not `removal-failed` at all — it is
  `removal-failed-left-in-quarantine` / `entry-substituted-left-in-quarantine`,
  the reasons `quarantineAndRemove` returns when the *revert itself* fails.
  There are **zero** of those anywhere in the corpus (all 46,760 records). A
  plain `removal-failed` post-fix means the rename WAS reverted — the fix
  working, not the bug.

Restated: *zero stranding records anywhere in the corpus; 60 reverted
removal-failures across four filesystems, none of them losing a user file.*

**A13 has no stranding instrument of its own, and that is a gap, not a result.**
The plan's §9 record shape includes `quarantineLeft`. `a13-vr.mjs` never sets
it — and neither does anything else: `quarantineLeft` is `null` in **all 46,760
records in the corpus**, not just A13's 1,500. **CLOSED 2026-09-16:** all twelve
VR attack modules now populate it, red-tested for discrimination (a clean
removal reports 0; a stopped one reports the leftover directory), and the
scanner is pinned by 27 selftest assertions covering five directions. The gap
that remains is narrower and is stated in the plan: `entries > 0` has still
never fired in a real run, so the instrument is proven on constructed fixtures
rather than in situ. So the "zero stranding" claim
above rests entirely on `outcome.reason`, which is a reasonable proxy and is not
the same thing as looking in the quarantine directory afterwards. A13 cannot
observe stranding directly. Populating `quarantineLeft` would close that.

**Provenance of the pre-fix figures.** The post-fix numbers above are re-derived
directly from the current `results/raw/a3-a13-attacks-*.jsonl`. The pre-fix
figures cited in earlier drafts (APFS C0 104/8.7%, V0 103/7.8%, V1 95/0%, V2
150/13.3%) are **not re-derivable from any file** — those records were
deliberately replaced at the source per the no-merging rule, and the exploratory
run's stdout was terminal output that no longer exists. They are retained in the
narrative only because a corrected number with its predecessor visible is more
trustworthy than one that appears from nowhere; they should not be cited as
evidence, and the pre-fix 13.3% in particular measured a broken prototype.

### The control instrument, and the 93 cells it found

The plan's §9 verdict rule has two halves: a cell is PASS only when
`ran == target`, `never-ran == 0`, `failed == 0`, **and** the attack's control
cell on the same filesystem recorded `failed >= 1`. "If the control didn't fail,
the fixture is invalid: the cell is NEVER-RAN (control)."

`aggregateCell()` in `harness/result-schema.mjs` implements the second half — it
takes a `controlFailed` option. **Nothing supplied it.** `run-a3-a13-attacks.mjs`
and `run-n1-vr.mjs` omitted the option entirely, so `options.controlFailed` was
`undefined`, which is not `=== false`, so the `NEVER-RAN (control)` branch was
unreachable from either runner. `run-vr-attacks.mjs` hardcoded
`controlFailed: true` — an assertion about a cell that process never observed.
`results/generate-summary.mjs` had its own local `verdict()` that ignored control
altogether.

So the prior draft's "exactly one honest, named exception (A8(b))" rested on an
instrument that **could not have found a second one**. That is the same
invisible-success class this spike's own three-way classification exists to
prevent, reproduced one level up.

**Wired up this pass.** `harness/control-spec.mjs` holds one machine-readable
row per attack, transcribed from the plan's §5.1 "Control expected to fail"
column, and resolves it against the cells actually present. It distinguishes:
`satisfied` (the named control failed ≥ 1 on this filesystem), `did-not-fail`,
`absent` (no such cell on this filesystem), `external` (the plan's control is a
script or a cited earlier experiment, not a cell — reported as unverifiable here
rather than counted as satisfied), `none` (the plan says none is required), and
`is-control`. All three runners (`run-a3-a13-attacks.mjs`, `run-n1-vr.mjs`,
`run-vr-attacks.mjs` — the last of which had the hardcoded `true`) and the
summary generator now consume it.

**Red-tested, not assumed.** Running `node harness/run-a3-a13-attacks.mjs --only
a4` — A4's control (`baseline`, the plan's "C0 without UD24") is not run by that
runner — now prints:

```
NEVER-RAN (control)  A4/default/V2  ran=30 passed=30 failed=0 never-ran=0  control=ABSENT
4 cell(s) are NOT PASS because their control never bit:
  A4/default/C0: plan §5.1 A4: 'C0 without UD24' -- no A4/baseline cell exists on smoke-apfs
  ...
```

**Re-scored corpus** (560 cells / 46,760 records / 34 raw files — the original
549 cells plus 11 new `A13-TIMING` cells). **These are the numbers as of this
memo's writing, not a live `SUMMARY.md` query**: that file now reads 606 cells /
136,240 records / 60 raw files because the corpus grew afterwards. See the
correction near the top:

| Verdict | Cells | Was, control-blind |
|---|---|---|
| PASS | 175 | 357 |
| PASS (control unverified) | 90 | — |
| FAIL | 151 | 150 |
| NEVER-RAN | 51 | 42 |
| NEVER-RAN (control) | **93** | **0 — unreachable** |

**The named cells, corrected against the review that found them.** The review
that prompted this pass named A4 and A8(a)-on-Linux. Both are real; one of its
supporting statements is not, and a wrong disproof is worse than the claim it
retracts, so it is corrected here rather than repeated:

- **A4** — the review said "no such candidate label exists in the data". It
  does: `A4/baseline/overlayfs` FAILs 30/30. But it exists on **overlayfs only**.
  On APFS, tmpfs, ext4 and virtiofs, A4's required control never ran, so all 16
  A4 cells there are NEVER-RAN (control), not PASS. The review's conclusion holds;
  its reason was one filesystem too broad.
- **A8(a)** — its only cited control is F2 B (`feasibility/c3/check2-mac.sh`),
  which is macOS-only. On the four Linux filesystems it has no control at all.
  All 40 A8 cells resolve to `external-unverified`.
- **A8(b)** — no control exists on any filesystem, checked against
  `check2-mac.sh`'s own case list (its `swap_run` has exactly three swap kinds —
  `dir`, `symlink`, `mount` — and none is "symlink replaced by a directory").
  This one is structural: real `rm` would hit the identical
  `unlink(2)`-refuses-on-a-directory guarantee, so there is no fixture to build.
- **A2** — not previously named anywhere. Its plan-named control is C0, and
  `A2/c0/overlayfs` recorded **0** failures. All 8 A2 cells are NEVER-RAN
  (control).
- **A3, A13** — same shape as A4: the `baseline` control exists on overlayfs
  only.
- **A5/A6 on APFS, tmpfs and virtiofs** — the `ud24Only` control cells exist but
  are entirely NEVER-RAN (inode reuse was never observed), so they recorded 0
  failures. That is the plan working as designed ("must be ≥1 on overlayfs or
  the cell is never-ran"), surfaced rather than hidden.
- **A10** — the plan's control is C3, which was never built. All 40 A10 cells
  are `external-unverified`.

`results/SUMMARY.md` now carries a per-cell Control column and a dedicated
"Cells whose control did not bite" table, so this is re-derivable without
reading this memo.

### What would close criterion 1

Bounded, and in rough order of value per hour:

1. **Run the `baseline` (C0 without UD24) control on APFS, tmpfs, ext4 and
   virtiofs.** `run-c0-control.mjs` already implements it; it has only ever been
   run on overlayfs. This alone converts 52 cells (A3, A4, A13) from NEVER-RAN
   (control) to a real verdict.
2. **Run A13 as a scored cell with `guardHash`**, not only as the `A13-TIMING`
   side measurement, so the recommended configuration appears in the criterion-1
   matrix rather than beside it.
3. ~~**Populate `quarantineLeft`**~~ **DONE 2026-09-16** in all twelve VR
   modules, so stranding is observed rather than inferred from
   `outcome.reason`.
4. **Decide, at owner level, whether A8's macOS-only control is acceptable for
   the Linux rows**, or whether a Linux failing control must be built. This is a
   scope question, not a measurement.
5. ~~**Narrow the 7 `straddles-guard-end` losses**~~ **ATTEMPTED AND DID NOT
   SUCCEED, 2026-09-16.** The count was never 7 -- it is 34 (see the correction
   above) -- and per-entry guard timing was built and cannot resolve them: the
   racer's mutation runs 1.771 ms (APFS) / 2.834 ms (Linux) against an entry
   observation window of 0.048 ms, so it engulfs the window. Closing them needs
   the racer's decisive step to become a single `renameat`, not a better
   classifier.
6. **Resolve a contradiction in the plan itself, which no amount of measuring
   will fix.** Criterion 1 requires every A13 cell to be `PASS`; §9 makes `PASS`
   require `never-ran == 0`; and A13 is specified as a *probabilistic* racer,
   so on any filesystem where the racer sometimes fails to land, `never-ran > 0`
   by construction. **A13 as written cannot reach PASS even against a perfect
   candidate** — 18 of its 20 cells are NEVER-RAN for exactly this reason, and
   virtiofs only escapes it by being slow enough that the racer lands 300/300.
   Either A13 needs a rendezvous that guarantees the race lands (making
   `never-ran` meaningful again), or criterion 1 needs to score A13 on its
   landed subset. That is an owner/plan decision, not a spike result, and it
   should be taken before anyone reads "A13 NEVER-RAN" as a verdict on the
   candidate.

---

### Per-attack detail

Predictions were written down before any of the nine attacks in this pass were
built or run — `results/predictions-a3-a13.md` — and are compared against the
actual result per attack below. Code: `harness/attacks/{a3,a4,a7,a8,a9,a10,a11,
a12,a13}[-vr].mjs`; runner: `harness/run-a3-a13-attacks.mjs`; raw records:
`results/raw/a3-a13-attacks-{darwin-apfs,overlayfs,tmpfsroot,ext4vol,
virtiofsroot}.jsonl` — 5 files, 15,010 records total, counted directly: 3,170 on
APFS, 2,960 each on the four Linux filesystems. The 210-record APFS excess is
fully explained: A9 runs two techniques on macOS (`stub` and the real
`apfs-setfile` syscall, macOS-only, gated `process.platform !== 'darwin'`) but
only `stub` on Linux (A9-C0: 60 on APFS vs. 30 on each Linux fs; A9-VR: 360 vs.
180; every other attack identical: A3=240, A4=120, A7=480, A8=240, A10-C0=60,
A10-VR=270, A11=40, A12=100, A13=1200, on all five).

**The 549-cell (now 560-cell) tally is a sum over a polysemous predicate, and
that is worth knowing before anyone cites it as one number.** `userFiles.lost`
does not mean the same thing in every module:

- In most attacks it means what it says: content that should have survived was
  destroyed.
- In A13, a `racerApplied === 'a8'` run scores the **attacker's own symlink** (a
  link to `/tmp`, created by the racer when it replaced the target directory) as
  a lost "user file" if the walk removes it. Removing it is arguably correct
  behaviour, counted as a loss.
- In `n1-vr.mjs` the polarity is **inverted**: `lost = removedCleanly ? 0 : 1`,
  so a "loss" there means the tree was NOT removed — a spurious stop, the
  opposite failure mode. All 1,500 N1-VR records use this polarity.

The per-cell verdicts are sound, because each cell's records share one
predicate. Summing across cells is not, and no claim in this memo should rest on
the aggregate tally alone.

**Methodology rule, restated after it mattered twice**: a cited control that
already exists as a script gets re-run from that script; a re-implementation is a
new experiment and is reported as one, never presented with the evidentiary
weight of the original until it has been shown to reproduce it. A8's control
(below) was where this rule was missed and then corrected; F1 and F2 B below are
both re-runs of their own scripts, not rebuilds.

**Second methodology rule, from the same pass**: when a fix changes what a cell
measures, the stale records are replaced at the source (the raw JSONL), never
merged alongside the new ones under the same cell label — a regenerated summary
cannot tell two generations of the same cell apart, so a merge produces a number
that is wrong in a way nothing downstream can detect. The A13 quarantine-revert
fix is the case that surfaced this. The cost of following it is visible above:
the pre-fix figures are now unverifiable by anyone.

**A methodology bug was caught and fixed before any of these numbers were
trusted**: an early version of the runner looped the C0-only A9 and A10 modules
across all four candidate labels, and separately looped A10's VR-only module
under a spurious 'C0' label. Both were found by inspecting the printed verdicts
before writing anything down, fixed in `run-a3-a13-attacks.mjs`
(`candidateKeys` now restricts each block to the candidates its own module
actually supports), and the full matrix was rerun from a clean raw file.

#### A3 — directory renamed aside and replaced, timed after root's own listing

**Predicted:** guard=none fails (no earlier observation exists yet, same shape as
A6/inner); guard=hash passes. **Matched exactly, on all five filesystems**: C0
PASS 30/30 (C0 has no guard concept, so its 'none'/'guardHash' labels are the
same measurement run twice); V0/V1/V2 FAIL 30/30 under guard=none on APFS,
overlayfs, ext4 and tmpfs, and on virtiofs FAIL 30/30 (V0), 28/30 (V1), 19/30
(V2); PASS 30/30 under guard=hash everywhere.

**Control**: `baseline` (C0 without UD24) exists on **overlayfs only**. The 32 A3
cells on the other four filesystems have no control — 20 of them (the clean
guard=hash and C0 cells) are therefore NEVER-RAN (control) rather than PASS, and
the other 12 FAIL on their own merits regardless.

#### A4 — same swap, timed after the target's own fd is already held

**Predicted:** passes cleanly, guard irrelevant, "fd already pinned before the
swap." **Matched on the pass/fail line, but the mechanism is more specific than
predicted** — checked directly via each record's own `outcome.reason`: C0 stops
`identity-unverifiable` (its real UD25 gate, established before the swap,
correctly rejects the genuinely fresh replacement's birthtime); V0 stops
`removal-failed` (an *accidental* protection — `unlinkAt`'s plain unlink refuses
on the still-non-empty replacement directory, not a designed check); V1/V2 stop
`identity-changed` (the *designed* protection). All four PASS 30/30 on all five
filesystems, no guard split.

**Caveat**: C0's gate "correctly rejects" the replacement here only because A4's
swap is genuinely FRESH — created same-tick, after the threshold. A9 measures the
same gate against a substitute that existed before the call instead, and it does
not reject that one at all. This line describes A4's own result accurately; it is
not evidence the gate is reliable in general.

**Control**: `baseline` (C0 without UD24) ran on **overlayfs only**. A4's 16
cells on APFS, tmpfs, ext4 and virtiofs are NEVER-RAN (control) — clean, but
proving nothing.

#### A7 — file/symlink substitution, 'between' (post-guard) and 'before-unlink' (last-moment)

**Predicted:** V0 fails (no content check); V1 fails when reuse is achieved
(dev,ino match, content doesn't); V2 passes via content re-hash, "the attack
specifically designed to separate V1 from V2." **Partially matched — the
divergence is the most informative result in this pass.** All four sub-cells
(file/symlink × between/before-unlink), all five filesystems:

| Sub-case | C0 | V0 | V1 (APFS) | V1 (tmpfs) | V1 (overlayfs) | V1 (ext4) | V1 (virtiofs) | V2 |
|---|---|---|---|---|---|---|---|---|
| between/file | FAIL | FAIL | **PASS** | **PASS** | **FAIL** | **FAIL** | **PASS** | PASS |
| between/symlink | FAIL | FAIL | **PASS** | **PASS** | **FAIL** | **FAIL** | **PASS** | PASS |
| before-unlink/file | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | PASS |
| before-unlink/symlink | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | FAIL | PASS |

Required failing control (V0, per the plan's own row): fails in every cell,
confirming the fixture bites — A7 is one of the few attacks whose control is
both in-data and genuinely satisfied on all five filesystems.

V2 passes every cell on every filesystem, confirming the predicted V1/V2
separation — but V1's own result is **filesystem-dependent, not fixed**: V1's
'between' PASS on APFS, tmpfs and virtiofs is a
same-tick-swap-rarely-reuses-inodes artifact (established in checkpoint 2 for
A5/A6), not a real protection — on overlayfs and ext4, where inode reuse is
common, V1 fails 'between' too. Collapsing across filesystems would have reported
V1 as safe against 'between'; it is not. V1's 'before-unlink' failure is a
*separate*, filesystem-independent gap: `removeLeafV1`'s identity check and its
actual unlink are two syscalls, not one. Prediction correction: V1 is not "safe
unless inode reuse happens" — it has a real, always-exploitable TOCTOU window
between its own check and its own act, independent of the reuse question.

#### A8 — symlink swaps: (a) dir replaced by a symlink to an outside dir, (b) symlink replaced by a dir with user files

**Predicted:** (a) passes for all of C0/V0/V1/V2 (structural O_NOFOLLOW, not an
identity-check property); (b) passes for V1/V2 (type/identity mismatch), V0's
outcome flagged as "the one prediction I'm not confident calling." **Matched for
(a). For (b), the actual result is stronger than predicted — even V0 passes**,
but not by a check: `unlink(2)` itself refuses when the name currently resolves
to a directory, and VR's removal pass (all three variants, including V0)
dispatches strictly off the TYPE recorded during the guard pass, never
re-deriving it from a fresh stat. Confirmed directly via `outcome.reason`: all
four candidates on all five filesystems PASS 30/30 for both sub-cases.

**Required failing control — F2 B, reproduced from its own script, and
macOS-only.** The plan names a real, already-cited control: "macOS `/bin/rm -r`
(F2 B: 3/3 deleted)", from `feasibility/c3/check2-mac.sh`. An earlier draft of
this memo reported three re-implemented attempts that failed to reproduce it and
called the discrepancy unresolved — that was wrong, and it was wrong against the
re-implementation, not against F2. Re-running the ORIGINAL script unmodified
(`bash feasibility/c3/check2-mac.sh`, defaults `REPS=3 NBIG=60000`, this same
host, macOS 26.5.2, `/bin/rm` `file_cmds-479`, uid 501) reproduces it cleanly:

```
$ bash feasibility/c3/check2-mac.sh
B-symlink-swapped-before-descent rep=1 entriesInWalkedDirAtSwap=53134 rc=1 outside=DELETED ...
B-symlink-swapped-before-descent rep=2 entriesInWalkedDirAtSwap=53719 rc=1 outside=DELETED ...
B-symlink-swapped-before-descent rep=3 entriesInWalkedDirAtSwap=53512 rc=1 outside=DELETED ...
```

**3/3 deleted, matching F2 B exactly.** (The coordinator independently ran the
identical script on the identical host and got the same result —
`entriesInWalkedDirAtSwap` 53630/53175/54059, also 3/3.) Two more cells from the
same script reproduce alongside it: `A-dir-swapped-before-descent` gives
`replacement=DAMAGED` 3/3, `D-mount-before-descent` gives `mountedFile=DELETED`
3/3.

**But it is a macOS script.** It covers A8(a) on APFS and nothing else. On
overlayfs, tmpfs, ext4 and virtiofs, A8(a)'s control did not run, and the cells
there are clean-but-uncontrolled.

**Why the three re-implemented attempts missed it, diagnosed from the numbers:**
the original swaps at a fixed `sleep 0.4` while `rm` is roughly 53,000 entries
into a 60,000-entry sibling directory that the script's own `pick_names()` has
confirmed sorts first in readdir order — a specific, narrow mid-traversal window.
The re-implementations used a 30,000-entry tree (half the window) and their own
timing schemes, and none of them printed anything equivalent to
`entriesInWalkedDirAtSwap` — the instrument that proves the swap actually landed
mid-traversal. **The general rule this confirms a second time this session: when
a cited control already exists as a script, run that script before writing
anything re-implemented — a re-implementation that fails is evidence about the
re-implementation until it has first been shown to reproduce the original.**

For subcase (b), no natural failing control exists on any filesystem, and this
is checked, not assumed: `check2-mac.sh`'s own `swap_run` has exactly three swap
`kind`s (`dir`, `symlink`, `mount`) and none is "symlink replaced by a
directory". Real `rm` would hit the identical `unlink(2)`-refuses-on-a-directory
guarantee VR's own candidates do, a structural OS-level fact rather than an
absent fixture.

#### A9 — clock attacks on C0's own UD25 gate, and the pre-aged-substitute question it raised

**Predicted:** VR passes trivially, C0 "record" (no committed outcome).
**Matched for VR's structural immunity; C0's result is more serious than the
neutral prediction anticipated.** A first draft of this attack swapped a FILE and
measured 100% loss regardless of any forgery — that proved nothing about the gate
(C0's threshold check only ever fires for directories) and was rebuilt to swap
the DIRECTORY itself.

**The gate's own code, quoted exactly (`c0-walk.mjs`):**

```js
// establishThreshold(), called once, inside removeC0(), for
// gateTiming: 'before-bind' -- i.e. at the moment the removal call itself
// runs, not at process start and not against any fixed window:
const p1 = mk(1)                // real mkdir+rmdir probe #1, parent of targetRoot
let p2 = mk(2)                  // probe #2
const deadline = Date.now() + 100
while (p2 <= p1 && Date.now() < deadline) { sleep(1); p2 = mk(2) }
return { threshold: p2, ... }   // threshold = probe 2's REAL birthtimeNs

// walkDir(), the per-directory check, evaluated once per directory visited:
if (threshold !== null && !(st.birthtimeNs < threshold)) {
  stopped = { reason: 'identity-unverifiable', path: relPath, errno: null }
  return
}
```

The threshold is anchored to **when `removeC0()` is called**. Any directory whose
real, unforged `birthtimeNs` predates that moment passes trivially — the gate
cannot distinguish "created a long time ago" from "created one nanosecond before
this specific call happened to run."

**1. Which technique actually ran on each filesystem, checked against the raw
records:**

| Technique | Mechanism | Capability it assumes | Ran on |
|---|---|---|---|
| (a) `stub` | `fs.lstatSync` monkeypatch reporting a forged `birthtimeNs` | **In-process code execution**. At that point the attacker could call `fs.rmSync` directly; this proves the gate reads a forgeable field, not that an external attacker can forge it | All five filesystems |
| (b) `apfs-setfile` | Real `SetFile -d` call (confirmed to wrap `setattrlist(ATTR_CMN_CRTIME)`) | **Unprivileged local process** with write access to the target path (uid 501, no root) — a real external capability | **APFS only** — gated by `process.platform !== 'darwin'` in both the runner and the attack module |

An earlier line — "defeated 30/30 by BOTH forgery techniques, both filesystems"
— was overstated for Linux and is corrected: the Linux filesystems only ever ran
technique (a). Linux has no equivalent to `SetFile`/`setattrlist(ATTR_CMN_CRTIME)`
(`utimensat` doesn't touch birthtime; `statx` `STATX_BTIME` is
filesystem-recorded, read-only from userspace on ext4/overlayfs), so (b) was
never attempted there and the gap is real, not an oversight.

**2. Does a pre-aged substitute — no forgery, no in-process execution, nothing
but real elapsed time — defeat the gate? Yes, unconditionally.** Built fresh for
this question (no existing script covers it — checked `reference-experiments/`
and `feasibility/`, including `e45-birthtime.mjs`, which measures inode-reuse
birthtime collision, a different property) as
`harness/measure-preaged-gate-defeat.mjs`: create a substitute directory under an
aside name with different content, wait a REAL elapsed gap, rename it over the
real target (`rename(2)` confirmed, per run, to preserve the source's own
`birthtimeNs` unchanged — `renamePreservedBirthtime: true` in every one of the 70
runs), then call `removeC0`/`removeVR` with no hooks at all — the fixture is
already in its final, attacked shape before the walker is even invoked. N=1 per
cell, not N=30 like the plan's main matrix — this is a confirmation of a
deterministic mechanism (the gate's threshold code has no randomness in it), not
a probabilistic sample.

**This table covers APFS and overlayfs only. It was never run on tmpfs, ext4 or
virtiofs.**

| Age gap | Capability required | C0 (APFS, overlayfs) | VR guard=none | VR guard=hash |
|---|---|---|---|---|
| 0ms (renamed in immediately) | Unprivileged local process, write access to a scratch path | **DEFEATED** on both | FAILS (known residual) | PASSES |
| 10ms | same | **DEFEATED** on both | FAILS | PASSES |
| 500ms | same | **DEFEATED** on both | FAILS | PASSES |
| 1000ms | same | **DEFEATED** on both | FAILS | PASSES |
| 2000ms | same | **DEFEATED** on both | FAILS | PASSES |

All 10 C0 cells (5 age gaps × 2 filesystems): `{"status":"removed"}`,
replacement content lost, every single time, **including the 0ms gap** — the
threshold-establishment probes themselves take real time after the call starts,
so anything that existed even microseconds earlier already qualifies as "old
enough." **A first draft of this table was wrong and caught before being written
down**: it computed the VR guard hash from the tree *after* the substitute was
already swapped in, which trivially "matches" the attacker's own content and
produces a meaningless PASS for every `guardHash` cell — fixed to capture the
hash from the ORIGINAL, pre-attack tree, rerun, and the corrected numbers are the
ones above.

**3. Capability assumed by each A9-family result:**
- Same-tick race (A5/A6/A10(a)): unprivileged local process, precise timing.
- (a) in-process stub: in-process code execution — close to worthless as proof
  against an external attacker; useful only as an API-level fact ("the gate reads
  a forgeable field").
- (b) `SetFile`/`setattrlist`: unprivileged local process, real capability,
  macOS-only, no timing precision needed beyond "before the walk runs."
- **Pre-aged substitute: unprivileged local process, real capability, no forgery,
  no timing precision, no race window — the weakest capability assumption of
  every attack in this pass, and the one the recommendation most needs to reckon
  with. Measured on two filesystems, not five.**

**Net for A9:** VR's structural immunity is confirmed at every capability level
tested — `wrapStatAtFieldLog` shows `timeFieldRead: false` in **1,080 of 1,080**
A9-VR records, across all five filesystems and both techniques, with zero
records missing the field (re-derived from the raw JSONL this pass, not carried
forward from a prior draft). C0's gate provides **no protection at all** against
the single easiest thing an attacker — or a completely mundane non-adversarial
race, a leftover directory from a previous unrelated operation — could do: have
something already exist under the target's name before the removal call starts.

#### A10 — whole tree replaced before the caller's own bind

**Predicted:** (a) redundant with A6/root's own finding, one hook point earlier;
(b) passes trivially via `unlink(2)`'s property. **Matched exactly, on all five
filesystems.** (a): C0 PASS 30/30; VR guard=none FAIL 30/30 on APFS, overlayfs,
ext4 and tmpfs and FAIL 20/30 (V1) and 24/30 (V2) on virtiofs; guard=hash PASS
30/30 everywhere. (b): C0 and V0/V1/V2 all PASS 30/30 everywhere.

**Same caveat as A4**: A10(a)'s own swap technique (same-tick delete+recreate) is
a genuinely fresh replacement, timed after the threshold — the scenario the gate
was built for and correctly rejects. It is not the scenario A9's
pre-aged-substitute finding tests. A10's own PASS says nothing about that case.

**Control**: the plan names C3 (no guard), which was never built in this spike.
All 55 A10 cells (10 A10-C0 + 45 A10-VR) are `external-unverified`: the 30 clean
A10-VR cells score PASS (control unverified), and the 15 `a/none` cells FAIL on
their own merits.

#### A11 — hard link to an outside file, property check, no attack

**Predicted:** passes trivially, all variants. **Matched exactly.** C0 and
V0/V1/V2 PASS 10/10 on all five filesystems — no control needed, per the plan's
own "none (property check)" row, and that is the one attack where "no control" is
a designed property rather than a gap.

#### A12 — injected EBUSY (inner rmdir) / EACCES (unlink)

**Predicted:** passes for all variants, doesn't differentiate V0/V1/V2.
**Matched exactly, on all five filesystems**, with one labeling nuance found by
checking `outcome.reason` directly: V2's injection landed on `renameAtNoReplace`
(its quarantine step) rather than `unlinkAt` (V0/V1's direct call), so V2 reports
`entry-substituted` where V0/V1 report `removal-failed` for the conceptually same
injected error — both are correctly "stopped", nothing removed after. All
candidates PASS 10/10, both sub-cases, all five filesystems. Required failing
control (`removeContinuingPastErrors`, built for this attack, not cited): FAILS
10/10 as designed on every filesystem — A7, A9-VR and A12 are the only three
attacks whose in-data control is satisfied on every cell (60, 36 and 40 cells
respectively, all `ok`).

A12's control was **separately corroborated against the already-cited F1 script**
(`feasibility/c3/check1-trace.sh`, real `strace` on real GNU `rm`), rerun this
pass (`docker run --rm --privileged ... bash check1-trace.sh`) and confirmed to
show the identical property on the real system tool:
`unlinkat(4, "m", AT_REMOVEDIR) = -1 EBUSY` immediately followed by
`unlinkat(4, "a.txt", 0) = 0` — GNU `rm` hits the error and keeps going.

---

## §10 criterion 2 — no spurious stops: 300/300 per filesystem in N1

**MET for the candidate; C0's own N1 covers 2 of 5 filesystems.** C0's N1
(`N1/ud25`) exists only on APFS and overlayfs — PASS 300/300 on both, and it was
never run on tmpfs, ext4 or virtiofs. The criterion is about the candidate under
evaluation, and there VR's own N1-equivalent, previously only an unrecorded ad
hoc check, now has a real,
recorded, formal module (`harness/attacks/n1-vr.mjs` + `harness/run-n1-vr.mjs`)
with JSONL evidence: **PASS 300/300 on all 30 cells** — 5 filesystems (APFS,
overlayfs, tmpfs, ext4, virtiofs) × 6 cells (V0/V1/V2 × guard none/guardHash) —
0 spurious stops anywhere, including virtiofs, the one filesystem where a
spurious-stop risk was previously observed only informally.

Two caveats that do not change the score:

- N1-VR's `userFiles.lost` has **inverted polarity** relative to every other
  module (see the polysemous-predicate note above). Within N1-VR's own cells it
  is consistent and the verdicts are sound; it just must not be summed with the
  rest.
- The plan names a control for N1 "for C0 only" (gate B, E48), so N1-VR's 30
  cells resolve to `none-by-design` rather than to a satisfied control. That is
  the plan's own scoping, not a gap discovered here.

**Re-checked against the pre-aged-substitute finding (A9): the score survives,
and the reason is that N1 and A9 are the same mechanism seen from opposite sides,
not in tension.** N1's fixture is ordinary, legitimate content that already
exists by the time the walk starts — exactly the shape the gate's call-time
threshold is *designed* to let through. A9's finding is that a pre-aged
*attacker* substitute passes the identical check for the identical reason. One
finding explains the other. This applies identically to N1-VR: VR's guard=none
cells pass for the same reason C0 does, and the guardHash cells pass too,
confirming the hash never spuriously mismatches legitimate, unmodified content.

## §10 criterion 3 — installs: clean, no-toolchain, `--ignore-scripts` load on all 4 in-scope targets; one binary loads under Node 20/22/24

**Partially met.**

- **Clean install, no toolchain (P3): MET**, but only for **2 of the 4** in-scope
  targets (darwin-arm64, linux-arm64). darwin-x64 and linux-x64-gnu were never
  built as real binaries — linux-x64 was tested only for *loading behavior*
  (correctly falls back, since no prebuild exists for it), which is a different
  claim than "a real x64 binary loads cleanly."
- **`--ignore-scripts`: NOT MEASURED directly**, though moot in the strict sense
  — the package has no `install`/`postinstall` script at all, so there is nothing
  for `--ignore-scripts` to skip. This should still be measured explicitly before
  the criterion is called met, since "nothing to skip" and "skip flag correctly
  honored" are not the same claim.
- **Node 20/22/24: NOT MEASURED.** Every test in this spike ran under whatever
  Node the container/host provided (22.x throughout). No cross-version load test
  was run against the actual shim.

## §10 criterion 4 — failure degrades: every trigger ends in C4 with one message, no crash; if P9 kills, native OK only if a cached probe costs ≤100ms

**MET on its own terms, with one gap in the caching clause.** All six real
triggers were forced through the *full* `removeTree()` dispatcher, not simulated:

| Trigger | How it was forced | Result |
|---|---|---|
| `SKILLSMITH_REMOVAL_NATIVE_DISABLE=1` | Real env var | Quarantined, 1 stderr line, content intact |
| Missing prebuild file | Real file deletion, both platforms | Quarantined, 1 stderr line, content intact |
| Wrong-platform binary | Real cross-platform binary swap, both directions | Quarantined, 1 stderr line, content intact |
| No matching prebuild at all | Real: linux-x64, genuinely zero prebuilds shipped for it | Quarantined, 1 stderr line, content intact |
| glibc too old | Real: `node:22-bullseye-slim` (glibc 2.31) against the real linux-arm64 binary (real floor: GLIBC_2.33, corrected from the plan's own earlier GLIBC_2.17 claim) | Quarantined, 1 stderr line, content intact |
| macOS signature tamper (SIGKILL) | Real: a byte flipped inside the loaded code segment of the real, signed darwin-arm64 binary | **Child probe SIGKILLed; the dispatcher itself never crashed**, correctly read the signal, quarantined, content intact |

The probe cost (spawn + require + self-test, child process, cached per process)
measured **~22.5ms median, 26.4ms max** across 10 runs (checkpoint 3) — inside
the plan's ≤100ms bar.

**Gap in the caching clause, found this pass.** The criterion's wording is "a
cached child probe costs ≤ 100 ms **once per binary version**". `hybrid.mjs`'s
cache is `let cachedProbe = null`, keyed on **nothing at all** — not the binary's
path, mtime, size or digest. It is a per-process memo. In this spike that is
harmless, because nothing replaces a prebuild mid-process. In a long-lived
process that survives a package update it would reuse a probe result for a binary
that is no longer on disk — the invisible-success shape this spike keeps finding.
Not a measurement failure; a design note the criterion's own wording already
asks for and the code does not satisfy.

**Re-checked against the guard-hash finding: the score survives, because
criterion 4 and that finding measure different properties of the same fallback.**
Criterion 4 asks whether a broken native load degrades safely — no crash, one
message, content not destroyed — and all six triggers confirmed exactly that;
none of them involves C0's gate, a timestamp, or a guard hash. What the guard-hash
finding added was a **separate, real gap in the same fallback**, now fixed: the
fallback still degrades without crashing, and as of this pass it degrades to a
*verified* quarantine rather than an unverified one.

## §10 criterion 5 — size: ≤150KB/platform binary, ≤1MB total install

**Met for what was built, incomplete overall.** darwin-arm64: **53,240 bytes**.
linux-arm64: **71,488 bytes** (an earlier draft said 71,536; the file on disk is
71,488 — `stat -f %z`, sha256 in the table at the top of this memo). Both well
under 150KB. Total for 2 platforms: ~122KB, well under 1MB — **but only 2 of 4
in-scope platform binaries exist**, so the "≤1MB total" claim is not yet a claim
about the real 4-platform artifact.

## §10 criterion 6 — cold start: warm require+self-test ≤10ms; first load on macOS ≤300ms once

**NOT MET as measured, needs a corrected re-measurement.** The ~22.5ms figure
above is the **child-process probe's** cost (process spawn included), which is
what criterion 4 is about. Criterion 6 asks about the **in-process** `require()`
+ self-test cost alone, with no spawn overhead — that was never isolated and
measured separately in this spike. The "first load on macOS" figure (152–252ms)
is carried over from checkpoint 0's F3 probe of a trivial hello-world addon, not
re-measured against the real, larger shim.c built in checkpoint 2. Given
cold-start cost plausibly scales with binary complexity, this should be
re-measured against the real artifact before treating F3's number as
representative.

## §10 criterion 7 — supply chain: CI-only build with provenance describable; P-A adds 0 published packages

**NOT MEASURED — analysis only, as the plan itself scopes it (ADR-109: no real
CI/publishing infrastructure is in scope for this spike).** No claim either way.

## C1 vs C2

**Not applicable — C2 (Rust/napi-rs) was never built in this spike.** Checkpoints
1–7 built and measured C1 only. Nothing here supports a C1-vs-C2 comparison; the
plan's own preference for C1 (smaller, no Rust toolchain, GLIBC_2.17 floor)
should be re-examined given this spike's own C1 glibc floor came in at
GLIBC_2.33, not 2.17 — a materially different number from what motivated the
original preference.

## C4 (quarantine) against D1 as written

**MET, and attacked directly.** Every one of D1's five named failure errnos
(EXDEV, EACCES, EROFS, EBUSY, ENOSPC) was forced for real (a non-root user for
EACCES specifically, since root bypasses DAC bits; real mounts for
EROFS/EBUSY/EXDEV; a real 16KB tmpfs run to exhaustion for ENOSPC) and confirmed:
nothing moves, nothing is deleted, the tree is exactly where it was,
`quarantine-failed` is the reported reason in every case. Three real bugs were
found and fixed while attacking this: an unwrapped sidecar write that let
`ENOSPC` escape as an uncaught exception *after* a tree was already safely
quarantined; three of D1's own early-validation paths using invented reason codes
instead of D1's literal single `quarantine-failed` string; and — this pass — the
silently-dropped guard hash described at the top of this memo.

**Gap: the full §5.3 row set (Q1–Q10, R1–R3) was not built.** Those rows test D1
against the *A1 design's actual callers* (abort cleanup, cross-device move,
`removeIfSame`, `ActivationManager.undo`, `author init` rollback) — none of that
caller code exists yet; it's still design, not implementation. This spike's
errno-forcing tests confirm the *mechanism* D1 specifies is sound; they do not
confirm every caller integrates with it correctly, because there is no caller to
test yet.

## Quarantine cost (priority 3)

Measured against this repo's own real `.claude/skills/` content (the plan's
suggested fixtures, `data/external-skills` and `packages/*/assets/skills`, don't
exist in this worktree's checkout). Median real skill: 19,713 bytes. After 10
simulated uninstalls with no pruning: **195.8KB held**, essentially exactly 10×
the per-skill size (no deduplication, as expected — each quarantine is an
independent rename). A doctor-style recursive scan to find all 10 costs **61
readdir/stat operations** (~6 per quarantined tree). Fixed sidecar overhead: **333
bytes per tree**, constant regardless of tree size.

Note: the guard-hash verify added to `quarantineTree` this pass adds a full
content read of the tree on any guarded call. That cost was **not** measured and
is not included in the figures above.

## The virtiofs anomaly's actual shape

Checkpoint 3 found `identity-changed` spurious stops on virtiofs specific to
files created and re-checked in rapid succession (not general FUSE instability —
180/180 clean on an ordinary removal). The formal `n1-vr.mjs` module now gives
this a real multi-filesystem, per-candidate N1 sweep: **300/300 PASS on virtiofs
across all six cells, 0 spurious stops** — N1-VR builds a tree and removes it
immediately, without checkpoint 3's rapid create-then-recheck pattern, so a clean
result here is consistent with, not a contradiction of, checkpoint 3's own
narrower characterization.

Separately, this pass's A13 racer sweep found a *different* virtiofs effect worth
distinguishing by name: a 100% racer-landing rate (vs. partial landing on every
other filesystem), explained by virtiofs's own FUSE-induced slowness — a walk
that takes long enough gives a 0–2 ms racer effectively unlimited opportunity to
land. **This is no longer just the best-supported explanation; the timing
instrument measures it**: on virtiofs, 241 of 300 landings fell in the
`straddles-guard-start` or `during-guard` phases, versus 118 of 226 on overlayfs
where a third of landings arrived after the call had already returned. Zero of
the virtiofs losses were post-guard.

**Day-4 stop rule check, explicit since virtiofs's numbers could be misread as
exactly that:** not triggered. Every loss on virtiofs is explained by a real,
external, now-measured cause (racer timing advantage from FUSE slowness, landing
before or during the guard pass) — nothing here is unexplained native data loss.

## Filesystem-shape comparison, corrected

A prior draft said "tmpfs and ext4 reproduce the exact same pass/fail shape as
APFS/overlayfs, cell for cell (guard splits, V1's inode-reuse-dependent A7
result, A12's stop rule, everything)". That is false, and the cells it is false
about are the ones the sentence names as examples. Measured, comparing verdicts
cell-by-cell over the attacks run on all five filesystems:

| Pair | Differing cells (of those present on both) |
|---|---|
| APFS vs **tmpfs** | **0** |
| overlayfs vs **ext4** | **0** |
| APFS vs overlayfs | 2 — `A7/between/file/V1`, `A7/between/symlink/V1` |
| APFS vs ext4 | 2 — the same two |
| tmpfs vs ext4 | 2 — the same two |
| tmpfs vs overlayfs | 2 — the same two |
| virtiofs vs APFS | 2 — `A13/V1`, `A13/V2` |
| virtiofs vs tmpfs | 2 — the same two |
| virtiofs vs overlayfs | 4 — the two A13 cells **plus** the two A7/V1 cells |
| virtiofs vs ext4 | 4 — the same four |

So there are two families, not one: **tmpfs and virtiofs behave like APFS** (rare
inode reuse, so V1's 'between' check incidentally holds) and **ext4 behaves like
overlayfs** (common inode reuse, so it does not). The divergent cells are exactly
the A7/V1 ones the original sentence cited as evidence they all matched.
Virtiofs's only additional divergence is its two A13 cells, and that is the
timing effect above.

## Day-4 stop rule

**Not triggered.** No unexplained data loss anywhere in this checkpoint.
