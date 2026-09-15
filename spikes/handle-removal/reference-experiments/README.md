# Reference experiments (A1 design rounds 9-11)

The experiment scripts behind the measurements in the SMI-6528 A1 plan and
ADR-155, and behind this spike's attack table. Copied from the session
scratchpad so they outlive it.

**Use these directly. Do not rebuild a mechanism from the plan's prose** —
a reconstruction measures a different thing, and the plan's numbers won't
reproduce against it.

| Script | What it measures |
|---|---|
| `e42*.mjs` | Mount inside a removed tree; the rmdir-first walk |
| `e44.mjs` | Directory swapped after the rmdir probe (identity checks) |
| `e45-birthtime.mjs` | Birthtime granularity and inode reuse (superseded by e47) |
| `e47.mjs` | Birthtime granularity, immediate delete-recreate pairs |
| `e48.mjs`, `e51.mjs`, `e52.mjs`, `e53.mjs` | Gate variants A, B, C and a probe-1 threshold |
| `e54.mjs` | Where the gate runs relative to the caller's bind |
| `e55.mjs` | File and symlink substitution |

`e53-reverify-overlayfs.out` is a re-run on 2026-09-15 confirming gate C:
`none` emptied 93/300, `C` emptied 0/300, on overlay in `node:22-slim`.
The A1 plan records 224/300 for `none` from an earlier run; both are far
above zero, and the rate varies run to run. The `C` result is the one the
design depends on.

Most scripts take `<base-dir> [trials]` and refuse a base outside a scratch
path. Run them in a throwaway container:

    docker run --rm -v <this dir>:/exp:ro node:22-slim \
      sh -c 'mkdir -p /work && node /exp/e53.mjs /work/e53 300'
