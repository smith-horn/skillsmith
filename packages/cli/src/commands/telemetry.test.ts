/**
 * @fileoverview Tests for `skillsmith telemetry` subcommands.
 * @module @skillsmith/cli/commands/telemetry.test
 * @see SMI-5021 Wave 3 Step 2 — plan lines 700, 703, 706
 *
 * Covers:
 *   enable: fresh manifest → generates id, sets enabled=true; idempotent on re-run
 *   disable: enabled manifest → sets enabled=false; anonymousId preserved
 *   status: prints expected shape (ID tail only); detects + triggers rotation when backdated >365d
 *   reset-id: rotates unconditionally; new id distinct; previous id populated
 *   install-hook (mocked): adds PreToolUse+PostToolUse; idempotent; throws on foreign Skill matcher
 *   uninstall-hook: removes only Skillsmith entries; preserves foreign hooks
 *   install-hook --scope project: writes to ./.claude/settings.json
 *
 * Privacy invariant: idTail() — last 8 chars only, never full id.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { homedir } from 'node:os'
import { assertInside } from '../utils/sandbox-path.js'

// ---------------------------------------------------------------------------
// fs/promises mock (for manifest.ts)
// ---------------------------------------------------------------------------

const memfsAsync: Record<string, string> = {}

// SMI-6343 follow-up: manifest.ts now imports assertNotRealUserHome from
// @skillsmith/core, which transitively imports `constants` from fs/promises
// (packages/core/src/utils/safe-fs.ts, module-level O_NOFOLLOW lookup). A
// full-replacement mock factory must re-export it via importOriginal, or
// that transitive import throws "No constants export is defined" at
// collection time — not just at the call sites this file actually exercises.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    // SMI-6358: REAL mkdir, not a no-op. The manifest lock creates
    // `<MANIFEST_PATH>.lock.<id>.tmp` beside the manifest, so
    // `~/.skillsmith/` has to exist on disk even though the manifest's own
    // contents stay in `memfsAsync`. A no-op here left the lock opening a
    // temp file in a directory nothing had created — ENOENT, all 19 tests.
    // Safe: vitest.setup.ts sandboxes $HOME per test file.
    mkdir: vi.fn(async (p: string, opts?: unknown) => actual.mkdir(p, opts as never)),
    writeFile: vi.fn(async (path: string, content: string) => {
      memfsAsync[path] = content
    }),
    rename: vi.fn(async (src: string, dst: string) => {
      const content = memfsAsync[src]
      if (content === undefined)
        throw Object.assign(new Error(`ENOENT: ${src}`), { code: 'ENOENT' })
      memfsAsync[dst] = content
      delete memfsAsync[src]
    }),
    readFile: vi.fn(async (path: string) => {
      const content = memfsAsync[path]
      if (content === undefined)
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return content
    }),
  }
})

// ---------------------------------------------------------------------------
// node:fs mock (for telemetry.helpers.ts — settings.json operations)
// ---------------------------------------------------------------------------

const memfsSync: Record<string, string> = {}

// SMI-6358: telemetry's writes now route through `updateManifestEntry()`,
// which takes @skillsmith/core's manifest lock. That lock's claim path
// (`owned-lock.claim.ts`) calls openSync/linkSync/fstatSync/readSync/
// closeSync — none of which a full-replacement factory supplies, so
// collection threw `No "openSync" export is defined on the "node:fs" mock`
// and took all 19 tests in this file with it. Same defect the `fs/promises`
// mock above already carries a comment about, one mock down.
//
// Partial-mock via importOriginal so those six fall through to real fs, and
// additionally delegate `writeFileSync`/`unlinkSync` for paths this file does
// NOT fake — those two the lock genuinely uses, and intercepting them left it
// writing its claim into memory while `openSync` had created a real file, then
// failing to remove it (a stale lock on the second call).
//
// Deliberately NOT path-scoped: existsSync, readFileSync, mkdirSync,
// copyFileSync, readdirSync, statSync. The lock touches none of those, and
// `copyFileSync` in particular must stay fully faked — it copies the hook
// TEMPLATE from a path that does not exist in the container, so delegating it
// to real fs breaks the install-hook tests.
//
// `chmodSync` is the exception, and is deliberately left fully faked even
// though the lock DOES call it: `owned-lock.claim.ts`'s `writeTempClaimExclusive`
// runs `chmodSync(tmp, 0o600)` on every acquisition, to re-assert the mode
// under a permissive umask. No-opping it is safe because `openSync(…, 'wx',
// 0o600)` already caps the temp file's mode and nothing writes it afterwards,
// so the chmod is belt-and-braces rather than load-bearing — and core's own
// `owned-lock.test.ts` exercises it against real fs. If it ever becomes
// load-bearing, this mock would hide the failure; path-scope it then.
//
// `includes`, not `endsWith`: telemetry.helpers.ts writes settings atomically
// via `settings.json.<id>.tmp` + rename, and a predicate anchored on the
// suffix missed that temp file — it fell through to real fs and threw ENOENT
// because nothing had created `.claude/`. A check narrower than the thing it
// models is how that happens.
//
// The `includes` arm is wider than any path in play today (measured: no
// manifest or lock path contains the substring). The shape it would catch
// wrongly is a lock whose TARGET is a settings.json — that fails
// asymmetrically and silently, because `openSync`/`linkSync` would create the
// real lock file while the faked `unlinkSync` never removes it, leaving a
// permanent stale lock. Stating the constraint so it stays deliberate.
//
// Each half of this predicate was mutated separately (SMI-6497's rule). Only
// `includes('settings.json')` is pinned: dropping it turns 4 tests red.
// Dropping `p in memfsSync` leaves all 19 GREEN — no memfs-backed path that
// lacks the `settings.json` substring reaches any of the three functions that
// consult this predicate (the hook script arrives via the fully-faked
// `copyFileSync`, and `uninstall-hook` only edits settings entries, it never
// unlinks the script). It is kept as insurance, not because a test holds it:
// "I have faked this path's content, so keep faking it" stays the right rule
// if a future writer does route one of those paths through writeFileSync.
// A third clause, `p.startsWith('/stub/')`, was REMOVED as genuinely dead —
// its one path is seeded into memfsSync, so the first clause always caught it
// and it could never be the deciding arm.
//
// Real-fs writes here are safe: vitest.setup.ts redirects $HOME to a
// per-test-file sandbox before this module graph is evaluated, the same
// guarantee manifest-lock.test.ts relies on.
const isFakedSyncPath = (p: unknown): boolean =>
  typeof p === 'string' && (p in memfsSync || p.includes('settings.json'))

// Real-fs pass-throughs must stay inside the test sandbox.
//
// `resolveSettingsPath('project')` resolves to `<cwd>/.claude/settings.json` —
// the REAL, TRACKED repo file. vitest.setup.ts redirects $HOME to a sandbox
// but not cwd, so the only thing keeping this file out of the repo's own
// config is `isFakedSyncPath` returning true for it. That predicate has been
// wrong once already, and when it is wrong the write escapes silently:
// `.gitignore` matches `*.tmp`, so `git status --untracked-files=all` shows
// nothing.
//
// The check lives in `../utils/sandbox-path.js` rather than inline here, so
// its own behaviour is pinned by tests. It answers a question about ONE path
// and enforces nothing on its own: only the three delegating branches below
// consult it. `openSync`, `linkSync`, async `mkdir` and an fd-based
// `writeFileSync` reach real fs without passing through it — their paths are
// HOME-derived today, which is a property of those callers, not a guarantee
// this file makes.

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: vi.fn((p: string) => p in memfsSync),
    readFileSync: vi.fn((path: string) => {
      const c = memfsSync[path]
      if (c === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      return c
    }),
    writeFileSync: vi.fn((path: string, content: string, ...rest: unknown[]) => {
      if (!isFakedSyncPath(path)) {
        // `path` is a number (an fd) on the lock's own claim write — that is a
        // correct real-fs fallthrough, and has no path to guard.
        if (typeof path === 'string') assertInside(path, homedir(), 'writeFileSync')
        return (actual.writeFileSync as (...a: unknown[]) => unknown)(path, content, ...rest)
      }
      memfsSync[path] = content
      return undefined
    }),
    // Path-scoped for the same reason as writeFileSync/unlinkSync: an atomic
    // write is a writeFileSync+renameSync PAIR, and scoping only the first
    // half splits the pair across two backing stores. `atomicWriteFile`
    // (config-atomic-write.ts) writes `<dir>/.<hex>.tmp` — no `settings.json`
    // substring — so the temp file lands on real disk while a fully-faked
    // renameSync looks for it in memfs and throws ENOENT naming a file that
    // demonstrably exists, leaking the temp. It is reachable from this
    // module graph (the @skillsmith/core barrel → device-identity.ts), and is
    // un-called today only because these tests exercise the unwrapped run*
    // helpers rather than the withTelemetry-wrapped exports.
    renameSync: vi.fn((src: string, dst: string) => {
      if (!isFakedSyncPath(src)) {
        assertInside(src, homedir(), 'renameSync')
        assertInside(dst, homedir(), 'renameSync')
        return actual.renameSync(src, dst)
      }
      const c = memfsSync[src]
      if (c === undefined) throw new Error(`ENOENT: ${src}`)
      memfsSync[dst] = c
      delete memfsSync[src]
      return undefined
    }),
    mkdirSync: vi.fn(() => undefined),
    chmodSync: vi.fn(() => undefined),
    copyFileSync: vi.fn((src: string, dst: string) => {
      memfsSync[dst] = memfsSync[src] ?? '# stub hook script'
    }),
    unlinkSync: vi.fn((p: string) => {
      if (!isFakedSyncPath(p)) {
        assertInside(p, homedir(), 'unlinkSync')
        return actual.unlinkSync(p)
      }
      delete memfsSync[p]
      return undefined
    }),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ mtimeMs: Date.now() - 1000 })),
  }
})

// ---------------------------------------------------------------------------
// Import after mocks are registered
// ---------------------------------------------------------------------------

import {
  runEnable,
  runDisable,
  runStatus,
  runResetId,
  runInstallHook,
  runUninstallHook,
  idTail,
} from './telemetry.js'
import {
  loadManifest,
  saveManifest,
  generateAnonymousId,
  type TelemetryManifest,
} from '../utils/manifest.js'
import { resolveSettingsPath } from './telemetry.helpers.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString()
}

async function seedManifest(telemetry: TelemetryManifest): Promise<void> {
  await saveManifest({ version: '1.0.0', installedSkills: {}, telemetry })
}

function captureConsole() {
  const lines: string[] = []
  const origLog = console.log
  const origWarn = console.warn
  const origError = console.error
  vi.spyOn(console, 'log').mockImplementation((...args) => lines.push(args.join(' ')))
  vi.spyOn(console, 'warn').mockImplementation((...args) => lines.push(args.join(' ')))
  vi.spyOn(console, 'error').mockImplementation((...args) => lines.push(args.join(' ')))
  return {
    lines,
    restore() {
      console.log = origLog
      console.warn = origWarn
      console.error = origError
    },
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  for (const k of Object.keys(memfsAsync)) delete memfsAsync[k]
  for (const k of Object.keys(memfsSync)) delete memfsSync[k]
  vi.clearAllMocks()
})

afterEach(() => {
  for (const k of Object.keys(memfsAsync)) delete memfsAsync[k]
  for (const k of Object.keys(memfsSync)) delete memfsSync[k]
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// enable
// ---------------------------------------------------------------------------

describe('telemetry enable', () => {
  it('generates an anonymousId and sets enabled=true on fresh manifest', async () => {
    await runEnable()

    const m = await loadManifest()
    expect(m.telemetry?.enabled).toBe(true)
    expect(m.telemetry?.anonymousId).toMatch(/^[0-9a-f]{64}$/)
    expect(m.telemetry?.anonymousIdCreatedAt).toBeDefined()
    expect(m.telemetry?.scope).toBe('personal')
  })

  it('is idempotent — second enable does not change the anonymousId', async () => {
    await runEnable()
    const firstId = (await loadManifest()).telemetry?.anonymousId

    await runEnable()
    const secondId = (await loadManifest()).telemetry?.anonymousId

    expect(firstId).toBe(secondId)
  })

  it('does not overwrite an existing anonymousId when re-enabling after disable', async () => {
    const existingId = generateAnonymousId()
    await seedManifest({ enabled: false, anonymousId: existingId })

    await runEnable()
    const m = await loadManifest()
    expect(m.telemetry?.anonymousId).toBe(existingId)
    expect(m.telemetry?.enabled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// disable
// ---------------------------------------------------------------------------

describe('telemetry disable', () => {
  it('sets enabled=false while preserving the anonymousId', async () => {
    const id = generateAnonymousId()
    await seedManifest({ enabled: true, anonymousId: id })

    await runDisable()

    const m = await loadManifest()
    expect(m.telemetry?.enabled).toBe(false)
    // anonymousId must be preserved for re-enable continuity (plan line 719)
    expect(m.telemetry?.anonymousId).toBe(id)
  })

  it('is a no-op when already disabled', async () => {
    await seedManifest({ enabled: false })
    const cap = captureConsole()
    try {
      await runDisable()
    } finally {
      cap.restore()
    }
    expect(cap.lines.some((l) => l.includes('already disabled'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe('telemetry status', () => {
  it('prints anonymousId-tail (last 8 chars) but not the full id', async () => {
    const id = generateAnonymousId()
    await seedManifest({
      enabled: true,
      anonymousId: id,
      anonymousIdCreatedAt: new Date().toISOString(),
      scope: 'personal',
    })

    const cap = captureConsole()
    try {
      await runStatus()
    } finally {
      cap.restore()
    }

    const output = cap.lines.join('\n')
    // Privacy: tail only
    expect(output).toContain(`...${id.slice(-8)}`)
    // Privacy: full id must not appear
    expect(output).not.toContain(id)
  })

  it('triggers rotation and reports "rotation triggered" when anonymousIdCreatedAt > 365d ago', async () => {
    const oldId = generateAnonymousId()
    await seedManifest({
      enabled: true,
      anonymousId: oldId,
      anonymousIdCreatedAt: daysAgo(400),
    })

    const cap = captureConsole()
    try {
      await runStatus()
    } finally {
      cap.restore()
    }

    const output = cap.lines.join('\n')
    expect(output.toLowerCase()).toContain('rotation triggered')

    // The manifest should now have a new id
    const m = await loadManifest()
    expect(m.telemetry?.anonymousId).not.toBe(oldId)
    expect(m.telemetry?.previousAnonymousId).toBe(oldId)
  })

  it('shows enabled=no when telemetry is disabled', async () => {
    await seedManifest({ enabled: false })

    const cap = captureConsole()
    try {
      await runStatus()
    } finally {
      cap.restore()
    }

    const output = cap.lines.join('\n')
    expect(output).toContain('no')
    expect(output.toLowerCase()).toContain('enabled')
  })
})

// ---------------------------------------------------------------------------
// reset-id
// ---------------------------------------------------------------------------

describe('telemetry reset-id', () => {
  it('rotates unconditionally even when id is young (< 365d)', async () => {
    const currentId = generateAnonymousId()
    await seedManifest({
      enabled: true,
      anonymousId: currentId,
      anonymousIdCreatedAt: new Date().toISOString(), // brand new
    })

    await runResetId()

    const m = await loadManifest()
    expect(m.telemetry?.anonymousId).toBeDefined()
    expect(m.telemetry?.anonymousId).not.toBe(currentId)
  })

  it('populates previousAnonymousId with the old id', async () => {
    const currentId = generateAnonymousId()
    await seedManifest({
      enabled: true,
      anonymousId: currentId,
      anonymousIdCreatedAt: new Date().toISOString(),
    })

    await runResetId()

    const m = await loadManifest()
    expect(m.telemetry?.previousAnonymousId).toBe(currentId)
  })

  it('new id is distinct from current and previous', async () => {
    const currentId = generateAnonymousId()
    const previousId = generateAnonymousId()
    await seedManifest({
      enabled: true,
      anonymousId: currentId,
      previousAnonymousId: previousId,
      anonymousIdCreatedAt: new Date().toISOString(),
    })

    await runResetId()

    const m = await loadManifest()
    const newId = m.telemetry?.anonymousId
    expect(newId).toBeDefined()
    expect(newId).not.toBe(currentId)
    expect(newId).not.toBe(previousId)
  })

  it('prints new ID tail (not full id) to stdout', async () => {
    const currentId = generateAnonymousId()
    await seedManifest({
      enabled: true,
      anonymousId: currentId,
      anonymousIdCreatedAt: new Date().toISOString(),
    })

    const cap = captureConsole()
    try {
      await runResetId()
    } finally {
      cap.restore()
    }

    const m = await loadManifest()
    const newId = m.telemetry?.anonymousId
    if (!newId) throw new Error('telemetry.anonymousId missing after runResetId')
    const output = cap.lines.join('\n')

    // Tail visible
    expect(output).toContain(`...${newId.slice(-8)}`)
    // Full new id NOT in output
    expect(output).not.toContain(newId)
  })
})

// Shared constant — used by both install-hook and uninstall-hook describe blocks.
const HOOK_PATH_TEST = `${process.env['HOME'] ?? '/tmp'}/.skillsmith/hooks/skill-telemetry.sh`

// ---------------------------------------------------------------------------
// install-hook
// ---------------------------------------------------------------------------

describe('telemetry install-hook', () => {
  it('adds PreToolUse and PostToolUse Skill entries to empty settings.json', async () => {
    // Seed template in memfsSync so copyFileSync does not throw
    memfsSync['/stub/templates/skill-telemetry.sh'] = '#!/bin/sh\n'

    // Mock existsSync to return true for template path
    const { existsSync } = await import('node:fs')
    ;(existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (String(p).includes('skill-telemetry.sh') && !String(p).includes('.skillsmith/hooks'))
        return true
      return p in memfsSync
    })

    await runInstallHook({ scope: 'user' })

    const settingsPath = resolveSettingsPath('user')
    const raw = memfsSync[settingsPath]
    expect(raw).toBeDefined()
    const parsed = JSON.parse(raw!) as { hooks: { PreToolUse: unknown[]; PostToolUse: unknown[] } }
    expect(parsed.hooks.PreToolUse).toHaveLength(1)
    expect(parsed.hooks.PostToolUse).toHaveLength(1)
  })

  it('is idempotent — installing twice does not add duplicate entries', async () => {
    const { existsSync } = await import('node:fs')
    ;(existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (String(p).includes('skill-telemetry.sh') && !String(p).includes('.skillsmith/hooks'))
        return true
      return p in memfsSync
    })

    await runInstallHook({ scope: 'user' })
    await runInstallHook({ scope: 'user' })

    const settingsPath = resolveSettingsPath('user')
    const parsed = JSON.parse(memfsSync[settingsPath]!) as {
      hooks: { PreToolUse: unknown[] }
    }
    expect(parsed.hooks.PreToolUse).toHaveLength(1)
  })

  it('uses ./.claude/settings.json when scope is project', async () => {
    const { existsSync } = await import('node:fs')
    ;(existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (String(p).includes('skill-telemetry.sh') && !String(p).includes('.skillsmith/hooks'))
        return true
      return p in memfsSync
    })

    await runInstallHook({ scope: 'project' })

    const projectPath = resolveSettingsPath('project')
    expect(memfsSync[projectPath]).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// uninstall-hook
// ---------------------------------------------------------------------------

describe('telemetry uninstall-hook', () => {
  it('removes only Skillsmith entries; does not touch foreign hooks', async () => {
    // Seed settings with a Bash hook + Skillsmith Skill hook
    const settingsPath = resolveSettingsPath('user')
    memfsSync[settingsPath] = JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo bash' }] },
          { matcher: 'Skill', hooks: [{ type: 'command', command: `${HOOK_PATH_TEST} pre` }] },
        ],
        PostToolUse: [
          { matcher: 'Skill', hooks: [{ type: 'command', command: `${HOOK_PATH_TEST} post` }] },
        ],
      },
    })

    await runUninstallHook({ scope: 'user' })

    const raw = memfsSync[settingsPath]
    expect(raw).toBeDefined()
    const parsed = JSON.parse(raw!) as {
      hooks: { PreToolUse: Array<{ matcher: string }>; PostToolUse: Array<{ matcher: string }> }
    }
    // Bash hook preserved
    expect(parsed.hooks.PreToolUse.some((e) => e.matcher === 'Bash')).toBe(true)
    // Skill hook removed
    expect(parsed.hooks.PreToolUse.some((e) => e.matcher === 'Skill')).toBe(false)
    expect(parsed.hooks.PostToolUse.some((e) => e.matcher === 'Skill')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// idTail — privacy invariant unit test
// ---------------------------------------------------------------------------

describe('idTail privacy invariant', () => {
  it('returns only the last 8 characters of the id', () => {
    const id = 'a'.repeat(56) + 'b'.repeat(8)
    expect(idTail(id)).toBe('...bbbbbbbb')
    expect(idTail(id)).not.toContain('a'.repeat(56))
  })

  it('returns (none) when id is undefined', () => {
    expect(idTail(undefined)).toBe('(none)')
  })

  it('never leaks the full SHA-256 hex (64 chars) in the returned string', () => {
    const id = generateAnonymousId()
    const tail = idTail(id)
    expect(tail.length).toBeLessThan(20) // "..." + 8 chars = 11 chars max
    expect(tail).not.toBe(id)
  })
})
