/**
 * @fileoverview Tests for telemetry.helpers.ts — atomic settings.json merger.
 * @module @skillsmith/cli/commands/telemetry.helpers.test
 * @see SMI-5021 Wave 3 Step 2 — plan line 717
 *
 * Covers:
 *   - addSkillHookEntries: empty settings → well-formed hooks block
 *   - addSkillHookEntries: idempotent (second add is a no-op)
 *   - addSkillHookEntries: throws on foreign Skill matcher command path
 *   - removeSkillHookEntries: removes only Skillsmith entries
 *   - removeSkillHookEntries: on empty settings → no-op
 *   - writeClaudeSettings: atomic temp-file → rename correctness
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// fs mock — intercepts node:fs (used by telemetry.helpers.ts)
// ---------------------------------------------------------------------------

const memfs: Record<string, string> = {}
let existsResult = false

vi.mock('node:fs', () => ({
  existsSync: vi.fn((_p: string) => existsResult),
  readFileSync: vi.fn((path: string) => {
    const content = memfs[path]
    if (content === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    return content
  }),
  writeFileSync: vi.fn((path: string, content: string) => {
    memfs[path] = content
  }),
  renameSync: vi.fn((src: string, dst: string) => {
    const content = memfs[src]
    if (content === undefined) throw new Error(`ENOENT: ${src}`)
    memfs[dst] = content
    delete memfs[src]
  }),
  mkdirSync: vi.fn(() => undefined),
  chmodSync: vi.fn(() => undefined),
}))

import {
  loadClaudeSettings,
  addSkillHookEntries,
  removeSkillHookEntries,
  writeClaudeSettings,
  TelemetryHookError,
  type ClaudeSettings,
} from './telemetry.helpers.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOOK_PATH = '/home/test/.skillsmith/hooks/skill-telemetry.sh'

function emptySettings(): ClaudeSettings {
  return {}
}

function settingsWithSkillsmithHooks(): ClaudeSettings {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Skill',
          hooks: [{ type: 'command', command: `${HOOK_PATH} pre` }],
        },
      ],
      PostToolUse: [
        {
          matcher: 'Skill',
          hooks: [{ type: 'command', command: `${HOOK_PATH} post` }],
        },
      ],
    },
  }
}

function settingsWithForeignSkillHook(): ClaudeSettings {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Skill',
          hooks: [{ type: 'command', command: '/other/tool/skill-hook.sh pre' }],
        },
      ],
      PostToolUse: [],
    },
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  for (const k of Object.keys(memfs)) delete memfs[k]
  existsResult = false
  vi.clearAllMocks()
})

afterEach(() => {
  for (const k of Object.keys(memfs)) delete memfs[k]
})

// ---------------------------------------------------------------------------
// loadClaudeSettings
// ---------------------------------------------------------------------------

describe('loadClaudeSettings', () => {
  it('returns empty object when file does not exist', () => {
    existsResult = false
    const result = loadClaudeSettings('user')
    expect(result).toEqual({})
  })

  it('returns parsed JSON when file exists and is valid', async () => {
    existsResult = true
    const { existsSync, readFileSync } = await import('node:fs')
    ;(existsSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(true)
    ;(readFileSync as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      JSON.stringify({ hooks: { PreToolUse: [] } })
    )
    const result = loadClaudeSettings('user')
    expect(result).toHaveProperty('hooks')
  })
})

// ---------------------------------------------------------------------------
// addSkillHookEntries
// ---------------------------------------------------------------------------

describe('addSkillHookEntries', () => {
  it('adds PreToolUse and PostToolUse Skill matchers to empty settings', () => {
    const result = addSkillHookEntries(emptySettings(), HOOK_PATH)

    expect(result.hooks?.PreToolUse).toHaveLength(1)
    expect(result.hooks?.PreToolUse?.[0]?.matcher).toBe('Skill')
    expect(result.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command).toBe(`${HOOK_PATH} pre`)

    expect(result.hooks?.PostToolUse).toHaveLength(1)
    expect(result.hooks?.PostToolUse?.[0]?.matcher).toBe('Skill')
    expect(result.hooks?.PostToolUse?.[0]?.hooks?.[0]?.command).toBe(`${HOOK_PATH} post`)
  })

  it('is idempotent — calling add twice produces only one entry per array', () => {
    const once = addSkillHookEntries(emptySettings(), HOOK_PATH)
    const twice = addSkillHookEntries(once, HOOK_PATH)

    expect(twice.hooks?.PreToolUse).toHaveLength(1)
    expect(twice.hooks?.PostToolUse).toHaveLength(1)
  })

  it('preserves existing non-Skill hook entries alongside new Skill entry', () => {
    const existing: ClaudeSettings = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre-bash' }] }],
        PostToolUse: [],
      },
    }
    const result = addSkillHookEntries(existing, HOOK_PATH)

    // Should have both Bash and Skill entries
    expect(result.hooks?.PreToolUse).toHaveLength(2)
    expect(result.hooks?.PreToolUse?.some((e) => e.matcher === 'Bash')).toBe(true)
    expect(result.hooks?.PreToolUse?.some((e) => e.matcher === 'Skill')).toBe(true)
  })

  it('throws TelemetryHookError with code hook.foreign_skill_matcher when a foreign Skill hook exists', () => {
    const settings = settingsWithForeignSkillHook()
    expect(() => addSkillHookEntries(settings, HOOK_PATH)).toThrow(TelemetryHookError)
    expect(() => addSkillHookEntries(settings, HOOK_PATH)).toThrow(
      expect.objectContaining({ code: 'hook.foreign_skill_matcher' })
    )
  })

  it('error message from foreign Skill matcher includes removal instructions', () => {
    const settings = settingsWithForeignSkillHook()
    let caught: unknown
    try {
      addSkillHookEntries(settings, HOOK_PATH)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(TelemetryHookError)
    const err = caught as TelemetryHookError
    expect(err.message).toContain('Remove it manually')
    expect(err.message).toContain('skillsmith telemetry install-hook')
  })
})

// ---------------------------------------------------------------------------
// removeSkillHookEntries
// ---------------------------------------------------------------------------

describe('removeSkillHookEntries', () => {
  it('removes Skillsmith Skill entries from both PreToolUse and PostToolUse', () => {
    const settings = settingsWithSkillsmithHooks()
    const result = removeSkillHookEntries(settings, HOOK_PATH)

    expect(result.hooks?.PreToolUse).toHaveLength(0)
    expect(result.hooks?.PostToolUse).toHaveLength(0)
  })

  it('does not touch foreign hooks when removing Skillsmith entries', () => {
    const settings: ClaudeSettings = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo bash' }] },
          { matcher: 'Skill', hooks: [{ type: 'command', command: `${HOOK_PATH} pre` }] },
        ],
        PostToolUse: [
          { matcher: 'Skill', hooks: [{ type: 'command', command: `${HOOK_PATH} post` }] },
        ],
      },
    }
    const result = removeSkillHookEntries(settings, HOOK_PATH)

    // Bash hook preserved; Skill hook removed
    expect(result.hooks?.PreToolUse).toHaveLength(1)
    expect(result.hooks?.PreToolUse?.[0]?.matcher).toBe('Bash')
    expect(result.hooks?.PostToolUse).toHaveLength(0)
  })

  it('is a no-op when settings has no hooks key', () => {
    const result = removeSkillHookEntries({}, HOOK_PATH)
    expect(result.hooks).toBeUndefined()
  })

  it('is a no-op when no Skill entries exist to remove', () => {
    const settings: ClaudeSettings = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo bash' }] }],
        PostToolUse: [],
      },
    }
    const result = removeSkillHookEntries(settings, HOOK_PATH)
    expect(result.hooks?.PreToolUse).toHaveLength(1)
    expect(result.hooks?.PostToolUse).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// writeClaudeSettings — atomic write correctness
// ---------------------------------------------------------------------------

describe('writeClaudeSettings', () => {
  it('writes the settings to a .tmp file then renames to final path', async () => {
    const { writeFileSync, renameSync } = await import('node:fs')
    const settings: ClaudeSettings = { hooks: { PreToolUse: [] } }
    writeClaudeSettings('user', settings)

    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.tmp'),
      expect.stringContaining('"PreToolUse"'),
      expect.anything()
    )
    expect(renameSync).toHaveBeenCalledWith(
      expect.stringContaining('.tmp'),
      expect.stringContaining('settings.json')
    )
  })

  it('second write fully replaces first without partial state', async () => {
    // Simulate sequential write correctness (mirrors manifest.test.ts pattern)
    const first: ClaudeSettings = { hooks: { PreToolUse: [] } }
    const second: ClaudeSettings = {
      hooks: {
        PreToolUse: [
          { matcher: 'Skill', hooks: [{ type: 'command', command: `${HOOK_PATH} pre` }] },
        ],
      },
    }

    writeClaudeSettings('user', first)
    writeClaudeSettings('user', second)

    // After both writes, memfs should contain the second write's content
    const { resolveSettingsPath } = await import('./telemetry.helpers.js')
    const finalPath = resolveSettingsPath('user')
    const raw = memfs[finalPath]
    expect(raw).toBeDefined()
    const parsed = JSON.parse(raw!) as ClaudeSettings
    expect(parsed.hooks?.PreToolUse).toHaveLength(1)
    expect(parsed.hooks?.PreToolUse?.[0]?.matcher).toBe('Skill')
  })
})
