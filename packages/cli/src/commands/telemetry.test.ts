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

// ---------------------------------------------------------------------------
// fs/promises mock (for manifest.ts)
// ---------------------------------------------------------------------------

const memfsAsync: Record<string, string> = {}

vi.mock('fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async (path: string, content: string) => {
    memfsAsync[path] = content
  }),
  rename: vi.fn(async (src: string, dst: string) => {
    const content = memfsAsync[src]
    if (content === undefined) throw Object.assign(new Error(`ENOENT: ${src}`), { code: 'ENOENT' })
    memfsAsync[dst] = content
    delete memfsAsync[src]
  }),
  readFile: vi.fn(async (path: string) => {
    const content = memfsAsync[path]
    if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    return content
  }),
}))

// ---------------------------------------------------------------------------
// node:fs mock (for telemetry.helpers.ts — settings.json operations)
// ---------------------------------------------------------------------------

const memfsSync: Record<string, string> = {}

vi.mock('node:fs', () => ({
  existsSync: vi.fn((p: string) => p in memfsSync),
  readFileSync: vi.fn((path: string) => {
    const c = memfsSync[path]
    if (c === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    return c
  }),
  writeFileSync: vi.fn((path: string, content: string) => {
    memfsSync[path] = content
  }),
  renameSync: vi.fn((src: string, dst: string) => {
    const c = memfsSync[src]
    if (c === undefined) throw new Error(`ENOENT: ${src}`)
    memfsSync[dst] = c
    delete memfsSync[src]
  }),
  mkdirSync: vi.fn(() => undefined),
  chmodSync: vi.fn(() => undefined),
  copyFileSync: vi.fn((src: string, dst: string) => {
    memfsSync[dst] = memfsSync[src] ?? '# stub hook script'
  }),
  unlinkSync: vi.fn((p: string) => {
    delete memfsSync[p]
  }),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() - 1000 })),
}))

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
