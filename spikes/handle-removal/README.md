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
  `load.mjs`. Build: `cd native-c && npx --yes node-gyp@13.0.2 rebuild`
  (per-platform -- rebuild after switching between host and container, the
  build output isn't multi-platform-aware yet; that's step 9's job).
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
