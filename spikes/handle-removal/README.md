# SMI-6676 handle-relative removal spike

Prototypes and a race harness for
`docs/internal/implementation/smi-6676-handle-relative-removal-spike.md`.
Nothing here ships: see `harness/assert-unshipped.mjs` and the plan's §7.

## Layout

- `package.json`, `.gitignore` -- `"private": true`, name
  `@skillsmith-spike/handle-removal`. npm refuses to publish a private
  package, and this directory sits outside every `packages/*` workspace glob.
- `harness/`
  - `assert-unshipped.mjs` -- the no-ship guard (plan §7). Run before every
    harness invocation: `node harness/assert-unshipped.mjs`. Self-test:
    `node harness/assert-unshipped.mjs --self-test`.
  - `result-schema.mjs` -- the per-run JSONL record shape and the
    ran/passed/failed/never-ran classifier + cell aggregator (plan §9).
    Self-test: `node harness/result-schema.selftest.mjs`.
  - `fixture-root.mjs` -- throwaway fixture roots, with the refusal checks
    that keep the harness off the real `$HOME`/`.claude`/`.skillsmith`/
    `.agents`/`.cursor`. Self-test: `node harness/fixture-root.selftest.mjs`.
  - `cleanup.mjs` -- post-run mount/disk-image/Docker-volume cleanup
    assertions (plan §9's "Cleanup" bullets).
  - `attacks/` -- one module per attack (`a3.mjs`, `a4.mjs`, `a5.mjs`,
    `a6.mjs`, `n1.mjs` so far), each exporting `id`, `target` (the plan's
    §5.1 run count) and `runOnce({harnessRoot, candidate, variant})`.
  - `run-c0-control.mjs` -- runs the C0 control's A3-A6/N1 cells and prints
    `ran/passed/failed/never-ran` verdicts. `--reduced` for a fast local
    pass; omit it for the plan's full run counts.
- `c0-walk.mjs` -- C0, the control candidate ("the A1 design as of UD25"), a
  direct structural port of `reference-experiments/e53.mjs`/`e54.mjs`'s
  walk()/gate() logic. See its own top-of-file comment for what the gate
  actually is (a two-probe threshold using the filesystem's own clock, not a
  per-entry birthtime comparison and never `Date.now()`) and for the
  `gateTiming` options ('before-bind' is the plan's actual candidate,
  measured 0/300 on A5/A6; 'walk-start' reproduces the plan's own attack-
  table control, which measures *worse* than no gate at all).
- `reference-experiments/` -- the A1 design's round 9-11 experiment scripts
  (e42*, e44, e45, e47, e48, e51-e55), including e53.mjs/e54.mjs. **Use these
  directly for anything gate-shaped rather than rebuilding from prose** --
  see its own README for why.
- `hash.mjs` -- VR's guard pass: hash through held handles (§3.4, §4.1).
- `walk.mjs` -- VR (`removeVR`), the V0/V1/V2 candidate. V0/V1/V2 share one
  bind + guard-pass + post-order removal skeleton; only the removal pass's
  per-entry checks differ (none / identity / identity+content+quarantine).
- `native-c/` -- C1, the thin N-API shim (§4.1): `src/shim.c`, `binding.gyp`,
  `load.mjs` (dev loader, reads `build/`), `load-packaged.mjs` (the loader a
  real install would use, reads `prebuilds/<platform>-<arch>/shim.node` --
  see its own top comment for why this is a separate file and what it
  proves about the fallback). `prebuilds/` is gitignored (compiled
  binaries, same policy as `feasibility/`) -- regenerate per platform:
  `cd native-c && rm -rf build && npx --yes node-gyp@13.0.2 rebuild && cp
  build/Release/shim.node prebuilds/$(node -p process.platform)-$(node -p
  process.arch)/shim.node` (host), or the same rebuild inside a
  `node:22-slim` container for `linux-arm64`/`linux-x64` (`--platform
  linux/amd64` for the latter). `package.json` has `files` scoped to
  `prebuilds` + the loader only -- no source, no build script reachable
  from an install -- and deliberately no `install`/`postinstall` hook.
- `harness/attacks/` also has `a5-vr.mjs`, `a6-vr.mjs` (VR's own timing-
  equivalent attacks, since VR has no rmdir-probe to hook), `mount-
  shared.mjs` (real Linux mount/umount helpers for A1/A2, privileged-
  container only), and two more runners: `run-vr-attacks.mjs`,
  `run-mount-attacks.mjs` (Linux-only, refuses to run elsewhere).
- `results/` -- `raw/` (gitignored JSONL) plus, eventually, `SUMMARY.md`
  regenerated from it (plan §8 step 14 -- not yet built).
- `feasibility/` -- the pre-build feasibility scripts (F1-F5), already
  committed; see its own README.
- `reference-experiments/` -- the real A1-design experiment scripts
  (e42-e55, including e53/e54, the gate's actual source). Use these
  directly for anything gate-shaped; see its own README.

## C4 harness selftests

Any change to the C4 harness, its scoring (`harness/result-schema*.mjs`,
`harness/control-spec*.mjs`) or its attack modules must run all of these from
this directory (plain `node`, host or container, each exits non-zero on a
failure). Each prints a closing pass line ("all cases passed" or "ALL PASS"); a run that prints
nothing or crashes before it did not pass.

- `node harness/c4-shared.selftest.mjs` -- `runC4Candidate`, the fs interposition and trace checks
- `node harness/c4-displaced.selftest.mjs` -- `locateDisplaced` (displaced vs deleted)
- `node harness/c4-score.selftest.mjs` -- `scoreUserFiles` and the shared C4 record builders
- `node harness/c4-runner.selftest.mjs` -- the C4 runner's record assembly
- `node harness/a13-c4.selftest.mjs` -- the A13-C4 / A13-C4-OOM racer and its window split
- `node harness/result-schema.selftest.mjs` -- the legacy record schema and quarantine scan
- `node harness/result-schema.c4.selftest.mjs` -- C4 quarantine scan (`scanC4Leftovers`)
- `node harness/result-schema.c4.classify.selftest.mjs` -- C4 `classifyRecord` clauses
- `node harness/result-schema.c4.shapes.selftest.mjs` -- record-shape attacks and `makeRecord`
- `node harness/result-schema.c4.gate.selftest.mjs` -- the C4 gate, control rows, `makeRecord` snapshots, scoring reads
- `node harness/result-schema.c4.roundtrip.selftest.mjs` -- runner/summary agreement (JSON round-trip), banned keys, no coercion of lost/changed
- `node harness/cell-tally.selftest.mjs` -- the shared cell tally (vacuous-check exclusion, `cell.target`) and that `generate-summary` agrees with `aggregateCell`
- `node harness/cell-tally.a13.selftest.mjs` -- A13 completeness counted across A13-C4 and A13-C4-OOM (`cell.targetScope`), `dirs`
- `node harness/cell-tally.control.selftest.mjs` -- harness errors are never control evidence (`controlFailures`)
- `node harness/cell-tally.intent.selftest.mjs` -- a measured loss is FAILED unless a proven `pre-caller-hash` caller-intent non-landing (`callerIntentExcluded`)
- `node harness/test-verdict-rule.mjs` -- `verdictFor`, record-only cells, the tally key, and the pinned `CONTROL_SPEC`

After any of them, regenerate and diff the summary:
`node results/generate-summary.mjs`, then confirm no legacy cell moved.

## Running

Everything is plain ESM (`.mjs`), zero dependencies, Node >=20. On Linux
filesystems, run inside a throwaway container, never a repo dev container:

```bash
docker run --rm \
  -v "$(pwd)":/spike:ro \
  -v /path/to/scratch/out:/out \
  -w /spike \
  node:22-slim \
  node harness/run-c0-control.mjs --fs-label overlayfs --out /out/c0-control.jsonl
```

The fixture root itself must live inside the container's own filesystem (the
default `/work`, not a bind mount) for the run to exercise real overlayfs
semantics -- a bind-mounted scratch directory would expose the host's
filesystem instead. On macOS, omit the container: `SMI6676_HARNESS_ROOT`
defaults to a mkdtemp'd directory under `$TMPDIR`.

Always run `node harness/assert-unshipped.mjs` first.
