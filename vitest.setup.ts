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
// an ABSOLUTE path, so all 12 vitest configs inherit it — including
// `packages/mcp-server/vitest.config.integration.ts`, which previously had no
// `setupFiles` key at all.

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
const REAL_HOME_BEFORE_SANDBOX = homedir()
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
