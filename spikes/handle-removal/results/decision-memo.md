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
probe AND a caller-supplied guard hash both as requirements, not
footnotes.** The probe requirement is unchanged from checkpoint 4: every
fallback trigger this spike forced ends in a safe quarantine with one
message and no crash, including the one failure mode (a genuinely tampered
macOS code signature) that SIGKILLs the process that `require()`s it, and
an in-process `require()`-then-catch remains a different, unsafe design
this spike's own P9 measurement rules out. The guard-hash requirement is
new this pass, and without it the recommendation below is not honestly
stated.

**The mechanism the fallback was expected to lean on does not work, and
this pass measured why.** C0's UD25 gate compares a directory's real
birthtime against a threshold established from two filesystem probes taken
*after* `removeC0()` is called (`c0-walk.mjs`'s `establishThreshold()`,
quoted in full under criterion 1/A9 below). Anything that already existed
before that moment — a substitute created seconds, minutes, or days
earlier, with no forgery of any field — passes the check by construction.
This is not a race: there is no window to miss, because the threshold is
set after the attacker's substitute already exists. Measured directly
(`harness/measure-preaged-gate-defeat.mjs`, both APFS and overlayfs, five
age gaps from 0ms to 2000ms, independently reproduced by the coordinator):
C0 is defeated in every cell, including the 0ms gap.

**What works in its place, measured on the same cells**: a caller-supplied
`guardHash` — a content hash of the tree computed before the operation,
compared against a fresh hash taken at removal time — passes every one of
those same cells, on every candidate (V0, V1, V2), at every age gap,
because it never reads a clock or any other timestamp field at all
(`wrapStatAtFieldLog` confirms zero timestamp-shaped keys ever appear in
what the native shim returns). This property is **not native-specific**:
nothing about comparing two content hashes depends on held file
descriptors, `openat`, or any syscall this spike's C1 shim provides — a
pure-JS candidate could implement the identical check. The pre-aged
finding does not favor native over a JS design or the reverse; it favors
verifying a caller-supplied hash over not verifying one, which is
orthogonal to the native-vs-JS question this memo otherwise argues.

**What this does to the recommendation's shape.** Checked directly against
this spike's own code, not assumed: `walk.mjs`'s `removeVR()` already wires
`guardHash` in and enforces it correctly (`if (guardHash !== undefined &&
guardHash !== treeHash) { ...return { status: 'kept' } }`) — but it is an
*optional* parameter (`const { ..., guardHash, ... } = options`), so a
caller that omits it gets the same unguarded exposure as C0. More
consequentially, `quarantine.mjs`'s `quarantineTree()` — **the fallback
path C4 actually runs, precisely when native is unavailable** — accepts a
`treeHash` option and only ever writes it into the sidecar as inert
metadata (`treeHash: options.treeHash ?? null`); it is never computed
fresh and compared against anything before `fs.renameSync()` moves the
tree. As built today, **the fallback path has no guard-hash enforcement at
all** — it is at least as exposed to a pre-aged substitute as C0's gate,
with not even a threshold check standing in the way. This is a specific,
already-checked-against-the-code gap, not a general worry: `quarantineTree`
needs the same verify-before-act step `removeVR` already has, and does not
have it yet.

**So: C4-as-fallback stands, but not as currently built, and not
optionally.** The evidence supports making a verified guard hash mandatory
at both of the places this spike's own code shows it currently is not
mandatory: (1) every call site that invokes `removeTree()` must compute and
pass `guardHash`, the same discipline already established for the
child-process probe; and (2) `quarantineTree()` itself needs a
verify-before-rename step equivalent to `removeVR`'s, since today it has
none, and the fallback is exactly the path that runs when the system is
already in a degraded state. Native remains the recommendation for the
reasons checkpoint 4 already established (P9's SIGKILL handling chief among
them) — this finding does not change which primitive to ship. It changes
what "shipping it safely" requires or, said the other way, **without a
mandatory, code-enforced guard hash on both paths, this recommendation
inherits a gap identical in kind to the one the gate-based design already
had**, just relocated from "the JS walk's own gate" to "whichever code path
the caller forgot to pass a hash into."

This recommendation is **conditional on the gaps below being closed**,
primarily full C1 platform coverage (only 2 of 4 in-scope targets have a
built, tested binary) and the guard-hash enforcement gap in
`quarantineTree()` named above. The attack-matrix gap named in the
checkpoint-4 version of this line is now largely closed: A3, A4, A7, A8,
A9, A10, A11, A12 and A13 have all been run against V0/V1/V2 with C0 as
control, on both APFS and overlayfs, at the plan's own run counts (see
criterion 1 below) — N1-VR (a formal, multi-filesystem false-positive
sweep for the native candidate, distinct from the attack matrix) remains
open, unchanged from checkpoint 4.

## §10 criterion 1 — attacks: every A1–A8, A10(a), A11, A12, A13, N1 PASS on APFS/overlayfs/tmpfs/ext4/virtiofs; A9 no timestamp reads; A7 PASS

**Closing pass (this checkpoint), updated to its final state across all
five filesystems.** A3, A4, A7, A8, A9, A10, A11, A12 and A13 have now been
run against C0 (control, every cell) and V0/V1/V2, on APFS, overlayfs,
tmpfs, ext4, and virtiofs, at the plan's own run counts. Predictions were
written down before any of these nine were built or run —
`results/predictions-a3-a13.md` — and are compared against the actual
result per attack below. Code: `harness/attacks/{a3,a4,a7,a8,a9,a10,a11,a12,
a13}[-vr].mjs`; runner: `harness/run-a3-a13-attacks.mjs`; raw records:
`results/raw/a3-a13-attacks-{darwin-apfs,overlayfs,tmpfsroot,ext4vol,
virtiofsroot}.jsonl` — **5 files, 15,010 records total, counted directly
(`cat results/raw/a3-a13-attacks-*.jsonl | wc -l` = 15010, matching the sum
of each file's own `wc -l`)**: 3,170 on APFS, 2,960 each on the four Linux
filesystems. The 210-record APFS excess is fully explained, not a
discrepancy: A9 runs two techniques on macOS (`stub` and the real
`apfs-setfile` syscall, macOS-only, gated `process.platform !== 'darwin'`)
but only `stub` on Linux — confirmed by a direct per-attack breakdown of
each file, which is otherwise cell-for-cell identical across all five
filesystems (A9-C0: 60 on APFS vs. 30 on each Linux fs; A9-VR: 360 vs. 180;
every other attack identical: A3=240, A4=120, A7=480, A8=240, A10-C0=60,
A10-VR=270, A11=40, A12=100, A13=1200, on all five). `results/SUMMARY.md`
covers all raw data across every attack module in this spike (N1-VR
included): **549 cells / 43,460 records, confirmed two independent ways —
the generator's own reported total, and a direct `cat results/raw/*.jsonl |
wc -l` over all 23 raw files, which returns the identical 43460** — and
regenerated byte-for-byte reproducible across two successive runs. A12's
own required failing control (a walk that continues past
errors, `removeContinuingPastErrors`) was built fresh and run alongside it
— **and separately corroborated against the already-cited F1 script**
(`feasibility/c3/check1-trace.sh`, real `strace` on real GNU `rm`), rerun
this pass (`docker run --rm --privileged ... bash check1-trace.sh`) and
confirmed to show the identical property on the real system tool:
`unlinkat(4, "m", AT_REMOVEDIR) = -1 EBUSY` immediately followed by
`unlinkat(4, "a.txt", 0) = 0` — GNU `rm` hits the error and keeps going
rather than stopping, matching the plan's own F1 citation and this pass's
own `removeContinuingPastErrors` control on the same property.

**Methodology rule, restated after it mattered twice this pass**: a cited
control that already exists as a script gets re-run from that script; a
re-implementation is a new experiment and is reported as one, never
presented with the evidentiary weight of the original until it has been
shown to reproduce it. A8's control (below) was where this rule was missed
and then corrected; F1 above and F2 B below are both re-runs of their own
scripts, not rebuilds.

**Second methodology rule, from the same pass, caught before it propagated
rather than after**: when a fix changes what a cell measures, the stale
records are replaced at the source (the raw JSONL), never merged alongside
the new ones under the same cell label — a regenerated summary cannot tell
two generations of the same cell apart, so a merge produces a number that
is wrong in a way nothing downstream can detect. The A13/V2 quarantine-
revert fix below is the case that surfaced this: re-running A13 after the
fix and appending the new records to the existing raw file would have
silently averaged 300 pre-fix runs against 300 post-fix runs under one
`darwin-apfs` label (`ran=600` where the correct figure was 300) —
`results/SUMMARY.md` would have regenerated cleanly and reported a blended
number with no indication anything was wrong. Caught by inspecting the
regenerated table's own `ran` column before trusting it, fixed by removing
the stale pre-fix A13 records from the raw file and writing the post-fix
ones in their place, confirmed via a byte-for-byte-reproducible
regeneration afterward.

**A methodology bug was caught and fixed before any of these numbers were
trusted, not after**: an early version of the runner looped the C0-only A9
and A10 modules across all four candidate labels (V0/V1/V2 labels were
silently rerunning C0's own algorithm under the wrong name), and separately
looped A10's VR-only module under a spurious 'C0' label (silently running
`removeVR` with no variant, defaulting to V2, mislabeled as C0). Both were
found by inspecting the printed verdicts before writing anything down, fixed
in `run-a3-a13-attacks.mjs` (`candidateKeys` now restricts each block to the
candidates its own module actually supports), and the full matrix was rerun
from a clean, fresh `results/raw/*.jsonl` file — the numbers below are from
that corrected run, not the first one.

### A3 — directory renamed aside and replaced, timed after root's own listing

**Predicted:** guard=none fails (no earlier observation exists yet, same
shape as A6/inner); guard=hash passes. **Matched exactly**, both
filesystems: C0 PASS 30/30 (C0 has no guard concept, so its 'none'/
'guardHash' labels are the same measurement run twice); V0/V1/V2 FAIL 30/30
under guard=none, PASS 30/30 under guard=hash.

### A4 — same swap, timed after the target's own fd is already held

**Predicted:** passes cleanly, guard irrelevant, "fd already pinned before
the swap." **Matched on the pass/fail line, but the mechanism is more
specific than predicted** — checked directly via each record's own
`outcome.reason`, not assumed: C0 stops `identity-unverifiable` (its real
UD25 gate, established before the swap, correctly rejects the genuinely
fresh replacement's birthtime); V0 stops `removal-failed` (an *accidental*
protection — `unlinkAt`'s plain unlink refuses on the still-non-empty
replacement directory, not a designed check); V1/V2 stop `identity-changed`
(the *designed* protection). All four PASS 30/30, both filesystems, no
guard split (the fd is pinned regardless of guard mode, so there is nothing
for a guard hash to add here). **Caveat, added when A9's pre-aged-substitute
finding surfaced the same claim elsewhere in this memo**: C0's gate
"correctly rejects" the replacement here only because A4's swap is
genuinely FRESH — created same-tick, after the threshold. A9 measures the
same gate against a substitute that existed before the call instead, and
it does not reject that one at all. This line describes A4's own result
accurately; it is not evidence the gate is reliable in general.

### A7 — file/symlink substitution, 'between' (post-guard) and 'before-unlink' (last-moment)

**Predicted:** V0 fails (no content check); V1 fails when reuse is achieved
(dev,ino match, content doesn't); V2 passes via content re-hash, "the
attack specifically designed to separate V1 from V2." **Partially matched —
the divergence is the most informative result in this pass.** All four
sub-cells (file/symlink × between/before-unlink) on both filesystems:

| Sub-case | C0 | V0 | V1 (APFS) | V1 (overlayfs) | V2 |
|---|---|---|---|---|---|
| between/file | FAIL | FAIL | **PASS** | **FAIL** | PASS |
| between/symlink | FAIL | FAIL | **PASS** | **FAIL** | PASS |
| before-unlink/file | FAIL | FAIL | FAIL | FAIL | PASS |
| before-unlink/symlink | FAIL | FAIL | FAIL | FAIL | PASS |

Required failing control (V0, per the plan's own row): fails in every cell,
confirming the fixture bites. V2 passes every cell on both filesystems,
confirming the predicted V1/V2 separation — but V1's own result is
**filesystem-dependent, not fixed**: V1's 'between' PASS on APFS is a
same-tick-swap-rarely-reuses-inodes-on-APFS artifact (already established in
checkpoint 2 for A5/A6), not a real protection — overlayfs, where inode
reuse is common, shows V1 failing 'between' too. Collapsing across
filesystems would have reported V1 as safe against 'between'; it is not.
V1's 'before-unlink' failure is a *separate*, filesystem-independent gap:
`removeLeafV1`'s identity check and its actual unlink are two syscalls, not
one — a substitution landing in that specific gap defeats V1 regardless of
inode reuse, confirmed identically on both filesystems. Prediction
correction: V1 is not "safe unless inode reuse happens" — it has a real,
always-exploitable TOCTOU window between its own check and its own act,
independent of the reuse question entirely.

### A8 — symlink swaps: (a) dir replaced by a symlink to an outside dir, (b) symlink replaced by a dir with user files

**Predicted:** (a) passes for all of C0/V0/V1/V2 (structural O_NOFOLLOW, not
an identity-check property); (b) passes for V1/V2 (type/identity mismatch),
V0's outcome flagged as "the one prediction I'm not confident calling."
**Matched for (a). For (b), the actual result is stronger than predicted —
even V0 passes**, but not by a check: `unlink(2)` itself refuses when the
name currently resolves to a directory, and VR's removal pass (all three
variants, including V0) dispatches strictly off the TYPE recorded during
the guard pass, never re-deriving it from a fresh stat — so V0 is protected
here by two stacked facts neither of which is "V0 checks anything," not by
luck. Confirmed directly (`outcome.reason`, not inferred): all four
candidates on both filesystems PASS 30/30 for both sub-cases.

**Required failing control — F2 B, reproduced from its own script.** The
plan names a real, already-cited control: "macOS `/bin/rm -r` (F2 B: 3/3
deleted)", from `feasibility/c3/check2-mac.sh`. An earlier draft of this
memo reported three re-implemented attempts that failed to reproduce it and
called the discrepancy unresolved — that was wrong, and it was wrong
against the re-implementation, not against F2. Re-running the ORIGINAL
script unmodified (`bash feasibility/c3/check2-mac.sh`, defaults `REPS=3
NBIG=60000`, this same host, macOS 26.5.2, `/bin/rm` `file_cmds-479`, uid
501) reproduces it cleanly:

```
$ bash feasibility/c3/check2-mac.sh
B-symlink-swapped-before-descent rep=1 entriesInWalkedDirAtSwap=53134 rc=1 outside=DELETED ...
B-symlink-swapped-before-descent rep=2 entriesInWalkedDirAtSwap=53719 rc=1 outside=DELETED ...
B-symlink-swapped-before-descent rep=3 entriesInWalkedDirAtSwap=53512 rc=1 outside=DELETED ...
```

**3/3 deleted, matching F2 B exactly.** (The coordinator independently ran
the identical script on the identical host and got the same result —
`entriesInWalkedDirAtSwap` 53630/53175/54059, also 3/3 — this run is a
second, independent confirmation, not the only one.) Two more cells from
the same script reproduce alongside it: `A-dir-swapped-before-descent`
gives `replacement=DAMAGED` 3/3, `D-mount-before-descent` gives
`mountedFile=DELETED` 3/3.

**Why the three re-implemented attempts missed it, diagnosed from the
numbers, not guessed:** the original swaps at a fixed `sleep 0.4` while
`rm` is roughly 53,000 entries into a 60,000-entry sibling directory that
the script's own `pick_names()` has confirmed sorts first in readdir
order — a specific, narrow mid-traversal window. The re-implementations
used a 30,000-entry tree (half the window) and their own timing schemes
rather than the original's, and none of them printed anything equivalent
to `entriesInWalkedDirAtSwap` — the instrument that proves the swap
actually landed mid-traversal. Without it, there was no way to tell
whether those three runs ever reached the state the attack needs, only
that they didn't produce a deletion. **The general rule this confirms a
second time this session (the first was the e53/e54 provenance correction
in checkpoint 1): when a cited control already exists as a script, run
that script before writing anything re-implemented — a re-implementation
that fails is evidence about the re-implementation until it has first been
shown to reproduce the original.**

For subcase (b), no natural failing control exists on either
filesystem, and this is checked, not assumed: `check2-mac.sh`'s own `swap_run`
has exactly three swap `kind`s (`dir`, `symlink`, `mount`) and none is
"symlink replaced by a directory" — the inverse of F2 B's own case (b), so
there is no cited script covering it to re-run. Real `rm` would hit the
identical `unlink(2)`-refuses-on-a-directory guarantee VR's own candidates
do, a structural OS-level fact rather than an absent fixture. **Net: A8(a)
now has a real, reproduced failing control (F2 B); A8(b) genuinely has
none, on either filesystem, and that absence is itself checked rather than
inferred.**

### A9 — clock attacks on C0's own UD25 gate, and the pre-aged-substitute question it raised

**Predicted:** VR passes trivially, C0 "record" (no committed outcome), "the
attack I most expect to just confirm a structural property." **Matched for
VR's structural immunity; C0's result is a genuinely more serious finding
than the neutral prediction anticipated — and a follow-up question the
coordinator raised against the first draft of this section turned out to
be the single most consequential result in this whole pass.** First draft
of this attack swapped a FILE and measured 100% loss regardless of any
forgery — that proved nothing about the gate (C0's threshold check only
ever fires for directories; files never reach it, the same gap A7 already
established) and was rebuilt to swap the DIRECTORY itself, matching A5/A6's
own technique, the only shape that actually reaches the gate.

**The gate's own code, quoted exactly (`c0-walk.mjs`), because the answer to
every question below depends on precisely what it compares:**

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

The threshold is anchored to **when `removeC0()` is called**, established
from the filesystem's own clock via two real probes taken at that moment.
Any directory whose real, unforged `birthtimeNs` predates that moment
passes trivially — the gate cannot distinguish "created a long time ago"
from "created one nanosecond before this specific call happened to run."
That is the structural fact the four questions below, and the finding after
them, all follow from.

**1. Which technique actually ran on each filesystem, checked directly
against the raw records, not assumed:**

| Technique | Mechanism | Capability it assumes | Ran on |
|---|---|---|---|
| (a) `stub` | `fs.lstatSync` monkeypatch reporting a forged `birthtimeNs` | **In-process code execution** — inside the same process as the walker. At that point the attacker could call `fs.rmSync` directly; this proves the gate reads a forgeable field, not that an external attacker can forge it | APFS **and** overlayfs |
| (b) `apfs-setfile` | Real `SetFile -d` call (confirmed to wrap `setattrlist(ATTR_CMN_CRTIME)`) | **Unprivileged local process** with write access to the target path (uid 501, no root) — a real external capability | **APFS only** — gated by `process.platform !== 'darwin'` in both the runner and the attack module itself |

The memo's earlier line — "defeated 30/30 by BOTH forgery techniques, both
filesystems" — **was overstated for Linux and is corrected here**: overlayfs
only ever ran technique (a). Linux has no equivalent to `SetFile`/
`setattrlist(ATTR_CMN_CRTIME)` (`utimensat` doesn't touch birthtime; `statx`
`STATX_BTIME` is filesystem-recorded, read-only from userspace on ext4/
overlayfs), so (b) was never attempted there and the gap is real, not an
oversight — there is no known unprivileged Linux syscall to forge btime.

**2. Does a pre-aged substitute — no forgery, no in-process execution,
nothing but real elapsed time — defeat the gate? Yes, unconditionally, and
this needed no timing precision at all.** Built fresh for this question (no
existing script covers it — checked `reference-experiments/` and
`feasibility/`, including `e45-birthtime.mjs`, which measures inode-reuse
birthtime collision, a different property; found nothing) as
`harness/measure-preaged-gate-defeat.mjs`, re-runnable directly (`node
harness/measure-preaged-gate-defeat.mjs [--fs-label <name>]`): create a
substitute directory under an aside name with different content, wait a
REAL elapsed gap (no timer trickery — an actual process sleep), rename it
over the real target (`rename(2)` confirmed, per run, to preserve the
source's own `birthtimeNs` unchanged — `renamePreservedBirthtime: true` in
every one of the 70 runs below), then call `removeC0`/`removeVR` with no
hooks at all — the fixture is already in its final, attacked shape before
the walker is even invoked. N=1 per cell, not N=30 like the plan's main
matrix — this is a confirmation of a deterministic mechanism (the gate's
own threshold code has no randomness in it), not a probabilistic sample, so
a single clean run per cell is what the mechanism itself calls for; the
script is checked into the tree and re-runnable to add more if that's not
convincing on its own.

| Age gap | Capability required | C0 | VR guard=none | VR guard=hash |
|---|---|---|---|---|
| 0ms (renamed in immediately) | Unprivileged local process, write access to a scratch path | **DEFEATED**, both filesystems | FAILS (known residual) | PASSES |
| 10ms | same | **DEFEATED**, both filesystems | FAILS | PASSES |
| 500ms | same | **DEFEATED**, both filesystems | FAILS | PASSES |
| 1000ms | same | **DEFEATED**, both filesystems | FAILS | PASSES |
| 2000ms | same | **DEFEATED**, both filesystems | FAILS | PASSES |

All 10 C0 cells (5 age gaps × 2 filesystems, from the checked-in script's
final clean run on each): `{"status":"removed"}`, replacement content lost,
every single time, **including the 0ms gap** — the threshold-establishment
probes themselves take real time after the call starts, so anything that
existed even microseconds earlier already qualifies as "old enough." This
is not a race:
there is no window to miss. **A first draft of this table was wrong and
caught before being written down**: it computed the VR guard hash from the
tree *after* the substitute was already swapped in, which trivially
"matches" the attacker's own content and produces a meaningless PASS for
every `guardHash` cell — fixed to capture the hash from the ORIGINAL,
pre-attack tree (what a real caller with a guard would have had), rerun,
and the corrected numbers are the ones in the table.

**3. The gate's threshold, restated plainly**: relative to the call, not
to process start and not to a fixed window (see the quoted code above).

**4. Capability assumed by each A9-family result, one line each:**
- Same-tick race (A5/A6/A10(a), for comparison): unprivileged local
  process, precise timing (must land inside a narrow race window).
- (a) in-process stub: in-process code execution — close to worthless as
  proof against an external attacker, since that attacker could bypass the
  walker entirely; useful only as an API-level fact ("the gate reads a
  forgeable field").
- (b) `SetFile`/`setattrlist`: unprivileged local process, real capability,
  macOS-only, no timing precision needed beyond "before the walk runs."
- **Pre-aged substitute: unprivileged local process, real capability, no
  forgery, no timing precision, no race window, both filesystems — the
  weakest capability assumption of every attack in this pass, and the one
  the recommendation most needs to reckon with.**

**Net for A9:** VR's structural immunity is confirmed at every capability
level tested (`wrapStatAtFieldLog` shows `timeFieldRead: false` in every
VR run, all techniques, both filesystems) and is unaffected by any of this.
C0's gate, however, is not merely "defeatable under a strong attacker
model" — it provides **no protection at all** against the single easiest
thing an attacker (or a completely mundane non-adversarial race — a
leftover directory from a previous, unrelated operation, still sitting
there when a later removal runs) could do: have something already exist
under the target's name before the removal call starts. That is a more
severe and more realistic finding than either forgery technique, and it
did not require defeating anything about the gate's design cleverly — it
is what the gate's own call-time anchor already implies.

### A10 — whole tree replaced before the caller's own bind

**Predicted:** (a) redundant with A6/root's own finding, one hook point
earlier; (b) passes trivially via `unlink(2)`'s property. **Matched
exactly, both filesystems.** (a): C0 PASS 30/30 (the real, un-forged gate
correctly catches a genuinely-fresh replacement here, unlike A9's forged
case); VR guard=none FAIL 30/30 (same residual as A6/root/none), guard=hash
PASS 30/30. (b): C0 and V0/V1/V2 all PASS 30/30, both filesystems. **Same
caveat as A4**: A10(a)'s own swap technique (same-tick delete+recreate) is
still a genuinely fresh replacement, timed after the threshold — the
scenario the gate was built for and correctly rejects. It is not the
scenario A9's pre-aged-substitute finding tests (a substitute that existed
before the call), which this same real, un-forged gate does not reject at
all. A10's own PASS here says nothing about that case.

### A11 — hard link to an outside file, property check, no attack

**Predicted:** passes trivially, all variants. **Matched exactly.** C0 and
V0/V1/V2 PASS 10/10, both filesystems — no control needed, per the plan's
own "none (property check)" row.

### A12 — injected EBUSY (inner rmdir) / EACCES (unlink)

**Predicted:** passes for all variants, doesn't differentiate V0/V1/V2, the
shared removal-walk skeleton's own stop-rule. **Matched exactly**, with one
labeling nuance found by checking `outcome.reason` directly: V2's injection
landed on `renameAtNoReplace` (its quarantine step) rather than `unlinkAt`
(V0/V1's direct call), so V2 reports `entry-substituted` where V0/V1 report
`removal-failed` for the conceptually same injected error — both are
correctly "stopped", nothing removed after, matching the actual pass
criterion. All candidates PASS 10/10, both sub-cases, both filesystems.
Required failing control (`removeContinuingPastErrors`, built for this
attack, not cited): FAILS 10/10 as designed — it removes the sibling that
sorts after the injection point, proving the fixture bites when stop-
discipline is absent.

### A13 — real concurrent racer (300 walks, a genuinely separate OS process racing each one)

**Predicted:** V0/V1 show losses from A7-shaped substitution racing; V2
stays near 0. **The first pass through this attack measured V2 showing
MORE raw failures than V0/V1 on both filesystems — the opposite of the
prediction. That result did not survive a fix to the bug that caused it,
and the corrected numbers below match the original prediction.**

**The bug, and the fix.** `removeDirV2`'s quarantine step renamed a
directory into `Q`, verified its identity, then called `unlinkAt(Q, rnd,
true)` (rmdir) — but if that rmdir failed (e.g. a racing writer adds a new
file inside the directory after it's been fully processed but before its
own rmdir runs, giving a real `ENOTEMPTY`), nothing reverted the rename.
The entry — and the racer's own content inside it — was left correctly
un-destroyed but permanently stranded under a random name in the
operation's own quarantine directory, never restored to where a caller or
a doctor-style scan would look for it. Fixed by consolidating all four
`quarantineEntry` call sites (file, symlink, dir, top-of-tree) into one
`quarantineAndRemove(D, name, isDir, verifyFn)` (`walk.mjs`) that reverts
the rename on ANY failure past the initial rename — a verify mismatch (the
existing behavior) or the final unlink/rmdir failing (the new behavior).
Verified against the SAME controlled reproduction that found the bug
(inject a new file into a directory right before its own quarantine step):
pre-fix, the directory ended up stranded at `Q/<rnd>/racer-injected.txt`;
post-fix, `target still at original path: true`, `injected file at
original path: true`, quarantine dir empty. Re-ran the existing
`result-schema.selftest.mjs` and A7-VR's own already-established pass/fail
shape (unaffected) to confirm the refactor changed nothing else.

**A13 re-run after the fix, both filesystems now.** Landed-race rates
(passed+failed only; never-ran is the race simply not landing, correctly
excluded per the three-way classification):

| Candidate | APFS pre-fix | APFS post-fix | overlayfs pre-fix | overlayfs post-fix |
|---|---|---|---|---|
| C0 | 104 / 8.7% | 114 / **14.0%** (fresh sample; same mechanism, real run-to-run variance) | 243 / 81.5% | 242 / **85.1%** (same) |
| V0 | 103 / 7.8% | 116 / **7.8%** | 112 / 40.2% | 89 / **43.8%** (same) |
| V1 | 95 / 0% | 114 / **0%** | 88 / 30.7% | 103 / **36.9%** (same) |
| V2 | 150 / **13.3%** | 115 / **0%** | 134 / **19.4%** | 127 / **17.3%** |

**Provenance of every number in this table, re-checked against source, not
narrative.** The post-fix columns are re-derived directly this pass from
the current `results/raw/a3-a13-attacks-{darwin-apfs,overlayfs}.jsonl`
(filtering `cell.attack==='A13'`, `applied = extra.racerApplied != null`,
`lost = userFiles.lost > 0`) and match the table exactly: APFS
114/116/114/115 applied with 16/9/0/0 lost; overlayfs 242/89/103/127
applied with 206/39/38/22 lost. The pre-fix columns are **not**
re-derivable from the current raw JSONL — by the second methodology rule
above, those records were deliberately replaced at the source, not kept
alongside the post-fix ones. What still exists is the exploratory run's own
captured stdout, three APFS attempts and one overlayfs attempt, timestamped
13:48-13:57 the same day, before the fix: the cited APFS figures (104/8.7%,
103/7.8%, 95/0%, 150/13.3%) match the **third** of three APFS attempts
exactly; the first two attempts show the same qualitative shape with real
race-timing variance (attempt 1: C0 108 applied/8.3% lost; attempt 2: C0
110/12.7%) — V2 shows nonzero loss in all three attempts (20, 22, 30 lost)
against V1's zero in all three, so the pre-fix finding itself does not
depend on which of the three exploratory runs is cited. The overlayfs
pre-fix figures match the one captured overlayfs attempt exactly with no
alternate runs to compare against.

**Overlayfs V2 does not drop to 0% the way APFS's did, and that is
explained, not left as a residual worry.** Every one of the 22 remaining
overlayfs V2 failures (checked directly against `outcome.status`, not
inferred) is `removed` with `racer=a3` — zero are `stopped/removal-failed`
(the ENOTEMPTY-stranding signature the fix targets), confirming the fix
eliminated that mechanism completely, on overlayfs as on every other
filesystem. What remains is the SAME already-documented "no earlier
observation exists" guard=none residual A3/A6/A9/A10 already carry (A13
runs with no guardHash, matching the plan's own "C0 without UD24" control
for this row) — real, on overlayfs specifically, because overlayfs's more
frequent inode reuse (established back in checkpoint 2 for A5/A6) gives the
racer more chances to land before the guard pass has looked at the entry
at all. Not a new mechanism; the existing one showing up at its expected,
filesystem-dependent rate.

**The pre-fix 13.3% measured a broken prototype and should not be cited as
a property of V2's design — it was reported upward as one, and that was
wrong.** The pre-fix figure is kept in the table above rather than quietly
replaced, on purpose: a corrected number with its predecessor still visible
is more trustworthy than a clean one that appears to have come from
nowhere, and a later reader re-deriving "why does this table have two
columns" should land on "the fix changed the measurement," not have to
guess. Post-fix, V2 matches V1 exactly (0% loss, both now protected against everything this
attack's racer throws at them on APFS), confirming the original prediction
("V2 stays near 0") rather than the pre-fix anomaly. V1's own 0% here is
still the same filesystem artifact A7 already surfaced (rare inode reuse on
APFS lets V1's identity check incidentally hold, not a designed content
check) — that part of the finding is unchanged and is expected to look
different on overlayfs once that re-run happens, the same way A7's did.

### Re-scored verdict

**Criterion 1: MET for the five filesystems this pass actually reached
(APFS, overlayfs, tmpfs, ext4, virtiofs), with exactly one honest, named
exception (A8(b)'s absent control) that is structural and does not close.**
Every one of A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, N1 now
has real, controlled-fixture measurements against C0 and V0/V1/V2, at the
plan's own run counts, on all five filesystems the plan's own criterion 1
names (A1/A2/A5/A6/N1 from earlier checkpoints on all five; A3/A4/A7-A13
this pass, also now on all five), with guard-mode and filesystem splits
kept visible wherever collapsing them would have hidden something (A7's
V1, A9's guard and technique split, A13's filesystem split, A3/A7's V1
inode-reuse artifact). What this pass closed, in order:

1. **The V2 quarantine-revert defect is fixed, verified, and confirmed to
   hold on every filesystem, not just the one that first showed it.**
   `quarantineAndRemove()` now reverts the rename on any post-verify
   failure. Re-ran A13 for V2 on all five filesystems: **zero
   `stopped/removal-failed` (ENOTEMPTY-stranding) records anywhere** —
   confirmed directly against each filesystem's own raw records, not
   assumed from one. Remaining V2 losses on overlayfs, tmpfs, ext4 and
   virtiofs are all `removed` status, all attributable to the
   already-documented guard=none residual (A3/A6/A9/A10) rather than any
   new mechanism.
2. **A8(b) still has no natural failing control**, on any filesystem —
   checked against `check2-mac.sh`'s own case list (no "symlink replaced by
   a directory" case exists there to re-run) rather than assumed; this is a
   structural OS-level guarantee (`unlink(2)` refuses on a directory), not
   an absent fixture, and it is the one item in this whole re-score that
   does not close. A8(a)'s own control is resolved (F2 B, reproduced).
3. **tmpfs, ext4, and virtiofs are now covered for the full nine-attack
   set**, via the same throwaway `docker run --rm` pattern proven on
   overlayfs — tmpfs via `--privileged` + `mount -t tmpfs`, ext4 via a
   Docker named volume (confirmed `ext2/ext3` via `stat -f -c %T`),
   virtiofs via a host bind-mount into the container (confirmed `fuseblk`,
   the same proxy mechanism checkpoint 3 established). tmpfs and ext4
   reproduce the exact same pass/fail shape as APFS/overlayfs, cell for
   cell (guard splits, V1's inode-reuse-dependent A7 result, A12's stop
   rule, everything). **Virtiofs is the one filesystem whose numbers look
   different, and it is explained rather than left as an open question**:
   see the dedicated note below.
4. **N1-VR is closed on all five filesystems.** `harness/attacks/n1-vr.mjs`
   + `harness/run-n1-vr.mjs`, PASS 300/300 on every one of 30 cells (5
   filesystems × 6 cells: V0/V1/V2 × guard none/guardHash) — 0 spurious
   stops anywhere, including virtiofs, where checkpoint 3's own
   `identity-changed`-on-rapid-recheck anomaly might have been expected to
   surface here first; it did not (N1-VR builds a tree and removes it
   immediately, without the rapid create-then-recheck pattern that anomaly
   needs, so this is consistent with, not a contradiction of, checkpoint
   3's own narrower characterization of it).
5. **C0's gate providing no protection against a pre-aged substitute**
   (A9's follow-up finding, carried from the prior pass) still stands
   exactly as before — it does not touch VR's own criterion-1 standing,
   and its effect is on how the C0 baseline is read in the Recommendation
   section above, not on this criterion's own score.

**Virtiofs's A13 numbers, explained rather than reported as a bare
divergence.** Every other filesystem shows a meaningful "never-ran" share
(the racer not landing in time) — virtiofs shows **zero** never-ran across
all 1,200 A13 runs: the racer landed on literally every single attempt.
This is not a new spurious-stop mechanism (checked: every failing record's
`outcome.status` is `removed`, none is `stopped`, so the earlier N1-style
`identity-changed` anomaly is not what's happening here) — it is virtiofs
being measurably slower than every other filesystem tested (FUSE overhead
is well-documented as the mechanism), which removes the timing race
entirely: a walk that takes long enough gives a 0-2ms racer effectively
unlimited opportunity to land, turning "probabilistic race" into "near-
certain collision." This amplifies the SAME two already-documented
mechanisms (the guard=none residual, and V1's A7-established TOCTOU gap)
rather than introducing a new one — confirmed by checking that A7's own
CONTROLLED test on the identical virtiofs run still shows V2 fully
protected (30/30 in both subcases), which the racer-driven A13 numbers
would contradict if this were a new V2-specific gap rather than a timing
effect. **Not separately re-proven with a dedicated controlled test** (that
would need instrumenting exactly when a landed mutation occurred relative
to the guard pass, which this pass did not build) — stated as the
best-supported explanation from the evidence gathered, not as something
independently confirmed beyond that.

**Day-4 stop rule check, explicit since virtiofs's numbers could be
misread as exactly that:** not triggered. Every loss on virtiofs is
explained by a real, external, already-understood cause (racer timing
advantage from FUSE slowness, landing on top of two already-documented
mechanisms) — nothing here is unexplained native data loss.

This is a genuinely stronger evidentiary position than checkpoint 4's, and
than the prior draft of this section: the recommendation's central
architectural claim (held-fd pinning plus a verified guard hash beats a
path-based gate) now has real attack coverage across all five filesystems
the plan names, a real implementation defect found, fixed, and confirmed
fixed on every one of them rather than merely reported, and the one
remaining open item (A8(b)'s control) is a structural fact about
`unlink(2)`, not an unresolved measurement.

## §10 criterion 2 — no spurious stops: 300/300 per filesystem in N1

**MET, closed this pass.** C0's N1 is PASS 300/300 on every filesystem tested. VR's own N1-equivalent, previously only an unrecorded ad hoc check, now has a real, recorded, formal module (`harness/attacks/n1-vr.mjs` + `harness/run-n1-vr.mjs`) with JSONL evidence: **PASS 300/300 on all 30 cells** — 5 filesystems (APFS, overlayfs, tmpfs, ext4, virtiofs) × 6 cells (V0/V1/V2 × guard none/guardHash) — 0 spurious stops anywhere, including virtiofs, the one filesystem where a spurious-stop risk was previously observed only informally. This closes the gap the prior draft of this section left open: the formal multi-filesystem sweep now exists and backs the native candidate directly, not just C0.

**Re-checked against the pre-aged-substitute finding (A9): the score survives, and the reason is that N1 and A9 are the same mechanism seen from opposite sides, not in tension.** N1's fixture is ordinary, legitimate content that already exists by the time the walk starts — exactly the shape the gate's call-time threshold is *designed* to let through without incident. A9's finding is that a pre-aged *attacker* substitute passes the identical check for the identical reason. The gate being permissive toward anything that predates the call is what makes N1 pass 300/300 for C0, and it is also why A9 succeeds — one finding explains the other; neither undermines it. This applies identically to N1-VR's own now-closed result: VR's guard=none cells pass N1 for the same reason C0 does (nothing to flag in a clean tree), and VR's guard=guardHash cells pass it too, confirming the hash never spuriously mismatches legitimate, unmodified content.

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

**Re-checked against the pre-aged-substitute finding: the score survives,
because criterion 4 and the finding measure different properties of the
same fallback.** Criterion 4 asks whether a broken native load degrades
safely — no crash, one message, content not destroyed — and all six
triggers forced through the real `removeTree()` dispatcher confirmed
exactly that; none of the six triggers (env-disable, missing prebuild,
wrong-platform binary, no matching prebuild, glibc floor, signature
tamper) involves C0's gate, a timestamp, or anything the pre-aged finding
touches. What the pre-aged finding adds is a **separate, real gap in the
same fallback**, found while re-checking the code for the Recommendation
above: `quarantineTree()` (what `quarantineFallback()` actually calls)
accepts a `treeHash` option and only ever stores it as inert sidecar
metadata — it is never computed fresh and compared before the rename, so
the fallback has no guard-hash enforcement at all today. That is real and
is carried in the Recommendation section's own conditions, not folded into
this score: criterion 4's own wording is about crash-safety and message
behavior, which this gap does not change — the fallback still degrades
without crashing, it just degrades to an unverified quarantine rather than
a verified one, which is a claim criterion 4 never made in the first
place.

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

**Update, later pass: the `n1-vr` gap this section forward-referenced is now closed, and the closure confirms the original characterization rather than changing it.** Checkpoint 3 found `identity-changed` spurious stops on virtiofs specific to files created and re-checked in rapid succession (not general FUSE instability — 180/180 clean on an ordinary removal). The formal `n1-vr.mjs` module (criterion 1/2 above) now gives this a real multi-filesystem, per-candidate N1 sweep: **300/300 PASS on virtiofs across all six cells, 0 spurious stops** — N1-VR builds a tree and removes it immediately, without checkpoint 3's rapid create-then-recheck pattern, so a clean result here is consistent with, not a contradiction of, checkpoint 3's own narrower characterization. Separately, this later pass's A13 racer sweep found a *different* virtiofs effect worth distinguishing from this one by name: a 100% racer-landing rate (vs. partial landing on every other filesystem), explained by virtiofs's own FUSE-induced slowness amplifying the already-known guard=none residual, not a recurrence of `identity-changed` (zero such records in the new data) and not a new mechanism — see criterion 1's re-scored verdict above for the full measurement.

## Day-4 stop rule

**Not triggered.** No unexplained data loss anywhere in this checkpoint.
