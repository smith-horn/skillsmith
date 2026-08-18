# SMI-6015 Wave 3 production dry-run — active worktree

This worktree is in active use running `smi5879-census.ts` / `smi5879-simulate-full.ts` /
`smi5879-gate-check.ts` against production for the SMI-5879 Wave 3 readiness gate. It has no
feature commits — that's expected, this worktree only executes existing scripts, it does not
develop code.

Please do not remove this worktree while it's in use — check `smi5879_run` for an `open` row
with a recently-advancing `runner_heartbeat_at` before assuming it's abandoned. This is the third
attempt tonight; the first two were killed mid-run by worktree/container removal.

Started: 2026-08-17, this attempt.
