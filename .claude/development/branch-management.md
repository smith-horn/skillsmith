# Branch Management Reference

Detailed guidance referenced from `CLAUDE.md § Branch Management`. The 4-step verify protocol, sync-main one-liner, and load-bearing rules (SMI-2596 Risk-first wave ordering, SMI-2597 Wave branch stacking) remain inline in `CLAUDE.md` because they shape per-session decisions on `smi-*`/`wave-*` branches.

## Pre-Commit Auto-Restore (SMI-2747)

**If branch switched during pre-commit**, the hook auto-restores to the correct branch
and exits 1 (SMI-2747). You will see:

```text
  ✓ Restored to <branch>. Staged changes preserved.
    Re-run: git commit

  Emergency bypass: git commit --no-verify
```

Re-run `git commit` — staged changes are preserved.

## Post-Commit Fallback Recovery

**If branch switched during commit** (post-commit fallback, rare), the post-commit hook prints
recovery commands:

```bash
git checkout <expected-branch>
git cherry-pick <commit-hash>
```

## Direct-to-Main Commits (SMI-2598)

**Direct-to-main commits (SMI-2598)**: Only allowed for SQL-only fixes to migrations already deployed to staging (not production). Must run `supabase db lint` locally first and include Linear issue ref in commit message.
