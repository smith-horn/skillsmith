# SMI-6676 feasibility scripts

The scripts that produced the measurements in
`docs/internal/implementation/smi-6676-handle-relative-removal-spike.md`,
copied from the session scratchpad so they outlive it.

- `c1/` — N-API toolchain probes, a mount probe, a hello-world addon
- `c2/` — Rust and napi-rs toolchain probes, plus notes on cap-std's own removal
- `c3/` — what system `rm -r` does: strace on Linux, Apple source, swap tests
- `c4/` — quarantine

Build outputs, `node_modules`, Cargo `target/`, compiled binaries and vendored
crate tarballs were stripped before committing. Re-fetch the crates and rebuild
as the plan's step 0 describes. Logs stay in the session scratchpad; the plan
carries the numbers.

Nothing here ships. No `packages/*` file may import from `spikes/`.
