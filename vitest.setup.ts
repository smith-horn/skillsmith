// SMI-4244: lift the default 10-listener ceiling to absorb future modules
// that attach additional process-exit handlers (mcp-server context.ts,
// webhook endpoints). Primary fix is in client.events.ts; this is a
// defense-in-depth ceiling guard, not a root-cause fix.
process.setMaxListeners(20)

// ---------------------------------------------------------------------------
// SMI-6343 Wave 1: $HOME sandbox
// ---------------------------------------------------------------------------
//
// `packages/core/src/services/skill-installation.service.ts` resolves its
// default manifest path from `os.homedir()` at module load. Inside Docker that
// is `/root` (harmless); on a host vitest run — routine here via
// `SKILLSMITH_PRE_PUSH_HOST=1` or an ad-hoc local run — it is the developer's
// real home, so any test exercising the install path writes fixture rows into
// the real `~/.skillsmith/manifest.json`. That is exactly what happened, and
// it is why every manifest entry predating this fix is untrustworthy as
// install evidence (ADR-144 §6).
//
// Node's `os.homedir()` reads `$HOME` on POSIX and `%USERPROFILE%` on Windows,
// so redirecting both to a per-run temp directory relocates every
// homedir-derived path at once — no per-test mocking required. Setup files run
// before the test module graph is evaluated, so the override is already in
// place when module-level constants like `DEFAULT_MANIFEST_PATH` are computed.
//
// This file is loaded via `sharedTestConfig.setupFiles` (vitest.preset.ts) as
// an ABSOLUTE path, so all 13 vitest configs inherit it — including
// `packages/mcp-server/vitest.config.integration.ts`, which previously had no
// `setupFiles` key at all. (13, not 12: verified with
// `grep -rln sharedTestConfig --include='*.ts'` minus the non-config files that
// only mention it in prose. The stale 12 here was the same undercount
// vitest.preset.ts's own comment already corrected — pr-reviewer PR-12,
// SMI-6343.)

import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

// Ground truth for the runtime guard in
// `packages/core/src/services/skill-manifest.ts`. Captured BEFORE $HOME is
// rewritten — once the sandbox is installed, `os.homedir()` returns the
// sandbox and the real home is unrecoverable from inside the process. Exported
// through the environment rather than a module export because the consumer
// lives in a different package that resolves through built `dist/`, so there
// is no shared module instance to read a const from.
//
// Idempotency guard (adversarial-review finding, SMI-6343 follow-up):
// under `vitest run --no-isolate`, Vitest reuses one worker process across
// test files, so this setup file's top level runs once PER FILE in that same
// process — and by the second file, `homedir()` no longer returns the real
// home; it returns the FIRST file's sandbox (setup never restores `$HOME`,
// only removes the temp dir in `afterAll`). A bare `homedir()` capture here
// would overwrite `SKILLSMITH_TEST_REAL_HOME` with a since-deleted temp path
// on every file after the first, silently disabling `assertNotRealUserHome()`
// for the rest of the run (it would compare every real path against a
// nonexistent directory and never match). Reusing an already-captured value
// keeps the ground truth fixed to the actual real home for the whole worker
// lifetime, however many files it processes. `isolate: true` is this repo's
// default and no config overrides it, so this is currently latent — fixed
// because it costs one line and the alternative is a guard that silently
// stops working the moment someone reaches for `--no-isolate` as a speed-up.
const REAL_HOME_BEFORE_SANDBOX = process.env.SKILLSMITH_TEST_REAL_HOME ?? homedir()
process.env.SKILLSMITH_TEST_REAL_HOME = REAL_HOME_BEFORE_SANDBOX

// One sandbox per setup execution (Vitest runs setup files once per test
// file), under the OS temp dir — never under the real home, or the guard below
// would fire on the sandbox itself.
const sandboxHome = mkdtempSync(join(tmpdir(), 'skillsmith-vitest-home-'))
process.env.HOME = sandboxHome
process.env.USERPROFILE = sandboxHome

afterAll(() => {
  try {
    rmSync(sandboxHome, { recursive: true, force: true })
  } catch {
    // Best-effort teardown — a leaked temp dir is a housekeeping issue, not a
    // test failure, and throwing here would mask the real result of the suite.
  }
})
