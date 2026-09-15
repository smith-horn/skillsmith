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
built, tested binary). The attack-matrix gap named in the checkpoint-4
version of this line is now largely closed: A3, A4, A7, A8, A9, A10, A11,
A12 and A13 have all been run against V0/V1/V2 with C0 as control, on both
APFS and overlayfs, at the plan's own run counts (see criterion 1 below) —
N1-VR (a formal, multi-filesystem false-positive sweep for the native
candidate, distinct from the attack matrix) remains open, unchanged from
checkpoint 4.

## §10 criterion 1 — attacks: every A1–A8, A10(a), A11, A12, A13, N1 PASS on APFS/overlayfs/tmpfs/ext4/virtiofs; A9 no timestamp reads; A7 PASS

**Closing pass (this checkpoint).** A3, A4, A7, A8, A9, A10, A11, A12 and A13
have now been run against C0 (control, every cell) and V0/V1/V2, on both
APFS and overlayfs, at the plan's own run counts. Predictions were written
down before any of these nine were built or run —
`results/predictions-a3-a13.md` — and are compared against the actual
result per attack below. Code: `harness/attacks/{a3,a4,a7,a8,a9,a10,a11,a12,
a13}[-vr].mjs`; runner: `harness/run-a3-a13-attacks.mjs`; raw records:
`results/raw/a3-a13-attacks-{darwin-apfs,overlayfs}.jsonl` (5,946 new
records; `results/SUMMARY.md` now covers 303 cells / 25,580 records total,
regenerated and confirmed byte-for-byte reproducible across two successive
runs). A12's own required failing control (a walk that continues past
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
for a guard hash to add here).

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
PASS 30/30. (b): C0 and V0/V1/V2 all PASS 30/30, both filesystems.

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
stays near 0; "the prediction I hold least confidently." **The most
significant divergence in this pass — V2 shows MORE raw failures than V0 on
both filesystems, the opposite of the prediction**, and understanding why
required a controlled reproduction, not just the racer's own numbers (a
first draft of the racer had NO synchronization at all and measured the
racer losing 20/20 races against a 2-file fixture — pure Node process-
startup latency, not a real test of concurrent mutation; a single
file-existence rendezvous marker fixed this before any of the numbers below
were trusted). Landed-race rates (passed+failed only; never-ran is the race
simply not landing, correctly excluded per the three-way classification):

| Candidate | APFS landed / loss rate | overlayfs landed / loss rate |
|---|---|---|
| C0 | 104 / **8.7%** | 243 / **81.5%** |
| V0 | 103 / **7.8%** | 112 / **40.2%** |
| V1 | 95 / **0%** | 88 / **30.7%** |
| V2 | 150 / **13.3%** | 134 / **19.4%** |

Two things, both confirmed by reading individual records rather than
trusting the aggregate: first, V1's 0% on APFS is the same filesystem
artifact A7 already surfaced (rare inode reuse on APFS lets V1's identity
check incidentally hold) — overlayfs shows V1's real exposure (30.7%),
consistent with A7's own finding, not a new one. Second, V2's own failures
split into two DIFFERENT, already-otherwise-explained mechanisms, neither
of which is new data destruction: (1) most APFS failures (20/20) and about
half the overlayfs ones (12/26) are `stopped/removal-failed` with
ENOTEMPTY/ENOTEMPTY-equivalent errno — reproduced under a CONTROLLED hook
(not just inferred from the racer) as a genuine, newly-found gap: when a
racing writer creates a new file inside a directory V2 has already
finished processing but not yet quarantined+rmdir'd, the quarantine RENAME
still succeeds, but the subsequent rmdir-from-quarantine fails, and V2's
own directory-removal path does not revert that rename the way its file/
symlink verify-mismatch paths do — the entry (and the racer's own new file
inside it) is left stranded inside the operation's `.skillsmith-rm-<opId>`
quarantine directory rather than restored to its original location or
destroyed. Confirmed directly: the racer's injected content was found,
intact, inside the quarantine directory, not deleted. (2) the remaining
overlayfs failures (14/26, all racer mutation 'a3') are `removed` (the
whole operation completed) and are the SAME "no earlier observation exists"
guard=none residual A3/A6/A9/A10 already document — this attack runs with
no guardHash at all (matching the plan's own "C0 without UD24" control
framing for A13), and a real race that lands before VR's guard pass has
ever looked at the entry has no earlier state to defend. **Net: V2's higher
raw A13 failure count is real, but it is not "V2 loses more data than V0" —
it is (a) a genuine, actionable gap in V2's own quarantine-revert
completeness that stops short of destroying anything, plus (b) a rate
effect of V2 doing more per-entry work (open+fstat+hash+rename+verify+
unlink vs. a single unlinkAt), which widens the SAME already-documented
guard=none window rather than opening a new one.** This is out of scope to
fix in this pass (the coordinator's ask was to run the matrix and report,
not patch candidate code), and is flagged here as a real, specific,
reproducible finding rather than smoothed over.

### Re-scored verdict

**Criterion 1: still NOT MET. The A8 control gap has been closed (F2 B
reproduced from its own script, both independently by the coordinator and
by this session), which narrows the remainder — but the pre-aged-substitute
finding under A9 sharpens, not softens, the overall picture, so this is not
simply "one item off the list."** What checkpoint 4 called the gap — nine
attacks never run against VR at all — is closed: every one of A3, A4, A7,
A8, A9, A10, A11, A12, A13 has real, controlled-fixture measurements
against C0 and V0/V1/V2, on both APFS and overlayfs, at the plan's run
counts, with guard-mode and filesystem splits kept visible wherever
collapsing them would have hidden something (A7's V1, A9's guard split and
technique split, A13's filesystem split). What remains NOT MET, honestly:

1. **A8(b) still has no natural failing control**, on either filesystem —
   checked against `check2-mac.sh`'s own case list (no "symlink replaced by
   a directory" case exists there to re-run) rather than assumed; this is a
   structural OS-level guarantee (`unlink(2)` refuses on a directory), not
   an absent fixture. A8(a)'s control is now resolved (F2 B, reproduced).
2. **A13/V2's quarantine-stranding gap is a real, newly-found defect** in
   `walk.mjs`'s `removeDirV2` — not fixed in this pass, and not previously
   known (checkpoint 2's own three-of-four-call-sites revert bug was a
   different failure mode: a verify-mismatch, not a post-rename rmdir
   failure).
3. **tmpfs, ext4, and virtiofs remain untested for this nine-attack set** —
   this pass covered exactly the two filesystems the coordinator named
   (APFS, overlayfs); the plan's criterion 1 also names tmpfs/ext4/
   virtiofs, which were covered for A1/A2/A5/A6/N1 in earlier checkpoints
   but not for A3–A13 here.
4. **N1-VR** (unchanged from checkpoint 4): still no formal, multi-
   filesystem false-positive sweep for the native candidate.
5. **New, not previously listed: C0's gate provides no protection at all
   against a pre-aged substitute** (A9's follow-up finding) — this is not a
   criterion-1 checkbox gap in the same sense as 1–4 above (the plan's own
   criterion doesn't name this specific scenario), but it directly informs
   what "A9 no timestamp reads" and the recommendation's own architectural
   claim actually rest on, and belongs in this list because it changes how
   much weight the C0 comparison can bear anywhere else in this memo. It
   does not touch VR's own criterion-1 standing (VR's behavior here is
   unchanged from, and consistent with, A6/A10's already-known guard=none
   residual) — its effect is entirely on how the C0 baseline should be
   read, including in the Recommendation section above and in any future
   C0-vs-VR comparison this spike or its successors draw.

This is a genuinely stronger evidentiary position than checkpoint 4's: the
recommendation's central architectural claim (held-fd pinning plus a
verified guard hash beats a path-based gate) now has real attack coverage
behind it across two structurally different filesystems, including two
attacks (A9, A13) that surfaced real, specific, previously-unmeasured
findings rather than confirming what was already assumed. It is not yet
"every cell passes everywhere" — items 1–4 above are the honest remainder.

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
