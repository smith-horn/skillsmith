/**
 * SMI-5390: Tests for `enumerateHarnessPresence`.
 *
 * `existsSync` is mocked via vi.mock('node:fs') so the tests never touch
 * the real filesystem. The hoisted spy is shared between the mock factory
 * and the test bodies via the vi.hoisted closure — same pattern as
 * pythonIncremental.hardening.test.ts (SMI-4315/4316).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'

// vi.hoisted runs before vi.mock factories so we can share the spy instance.
const { existsSyncSpy } = vi.hoisted(() => ({
  existsSyncSpy: vi.fn<(p: string) => boolean>(() => false),
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, existsSync: (p: string) => existsSyncSpy(p) }
})

import {
  CANONICAL_CLIENT,
  CLIENT_IDS,
  CLIENT_NATIVE_PATHS,
  COMPANION_AGENT_TARGETS,
  enumerateHarnessPresence,
  getCompanionAgentTarget,
  resolveCompanionAgentDir,
  resolveCompanionAgentPath,
  type ClientId,
} from './paths.js'

describe('enumerateHarnessPresence (SMI-5390)', () => {
  beforeEach(() => {
    existsSyncSpy.mockReset()
    existsSyncSpy.mockReturnValue(false)
  })

  it('returns one entry for every ClientId in CLIENT_IDS', () => {
    const result = enumerateHarnessPresence()
    expect(result).toHaveLength(CLIENT_IDS.length)
    const returnedHarnesses = result.map((r) => r.harness)
    expect(returnedHarnesses).toEqual(expect.arrayContaining([...CLIENT_IDS]))
  })

  it('reports present: true for harnesses whose directory exists', () => {
    // Make only claude-code and cursor appear on disk.
    existsSyncSpy.mockImplementation(
      (p) => p === CLIENT_NATIVE_PATHS['claude-code'] || p === CLIENT_NATIVE_PATHS['cursor']
    )

    const result = enumerateHarnessPresence()

    expect(result.find((r) => r.harness === 'claude-code')?.present).toBe(true)
    expect(result.find((r) => r.harness === 'cursor')?.present).toBe(true)
    expect(result.find((r) => r.harness === 'copilot')?.present).toBe(false)
    expect(result.find((r) => r.harness === 'windsurf')?.present).toBe(false)
    expect(result.find((r) => r.harness === 'agents')?.present).toBe(false)
    expect(result.find((r) => r.harness === 'opencode')?.present).toBe(false)
    expect(result.find((r) => r.harness === 'hermes')?.present).toBe(false)
    expect(result.find((r) => r.harness === 'grok')?.present).toBe(false)
  })

  it('reports all harnesses absent when existsSync returns false for every path', () => {
    existsSyncSpy.mockReturnValue(false)
    const result = enumerateHarnessPresence()
    expect(result.every((r) => r.present === false)).toBe(true)
  })

  it('reports all harnesses present when existsSync returns true for every path', () => {
    existsSyncSpy.mockReturnValue(true)
    const result = enumerateHarnessPresence()
    expect(result.every((r) => r.present === true)).toBe(true)
  })

  it('returns the canonical CLIENT_NATIVE_PATHS path for each harness', () => {
    const result = enumerateHarnessPresence()
    for (const entry of result) {
      expect(entry.path).toBe(CLIENT_NATIVE_PATHS[entry.harness])
    }
  })

  it('calls existsSync exactly once per harness', () => {
    enumerateHarnessPresence()
    expect(existsSyncSpy).toHaveBeenCalledTimes(CLIENT_IDS.length)
  })
})

describe('opencode + hermes ClientIds (SMI-5456 Wave 1 Step 5)', () => {
  it('CLIENT_IDS includes opencode and hermes', () => {
    expect(CLIENT_IDS).toContain('opencode')
    expect(CLIENT_IDS).toContain('hermes')
  })

  it('opencode resolves to ~/.config/opencode/skills', () => {
    expect(CLIENT_NATIVE_PATHS.opencode.endsWith('/.config/opencode/skills')).toBe(true)
  })

  it('hermes resolves to ~/.hermes/skills', () => {
    expect(CLIENT_NATIVE_PATHS.hermes.endsWith('/.hermes/skills')).toBe(true)
  })
})

describe('grok ClientId (SMI-5697)', () => {
  it('CLIENT_IDS includes grok', () => {
    expect(CLIENT_IDS).toContain('grok')
    expect(CLIENT_IDS).toHaveLength(8)
  })

  it('grok resolves to ~/.grok/skills', () => {
    expect(CLIENT_NATIVE_PATHS.grok.endsWith('/.grok/skills')).toBe(true)
  })
})

/**
 * SMI-5980 (Wave 3): COMPANION_AGENT_TARGETS is a regression guard by
 * design — every existing ClientId's companion-subagent output path must be
 * EXACTLY unchanged from the pre-Wave-3 hardcoded
 * `path.join(os.homedir(), '.claude', 'agents')` default, except copilot and
 * opencode, which get an independently-evidenced directory value cited from
 * AGENT_SHIM_TARGETS (agent-harness-targets.ts) for the SAME underlying
 * tool — not a new invented value.
 */
describe('COMPANION_AGENT_TARGETS (SMI-5980 Wave 3)', () => {
  it('has exactly one entry per ClientId in CLIENT_IDS', () => {
    for (const id of CLIENT_IDS) {
      expect(COMPANION_AGENT_TARGETS[id]).toBeDefined()
    }
    expect(Object.keys(COMPANION_AGENT_TARGETS)).toHaveLength(CLIENT_IDS.length)
  })

  it('every entry uses flat file mode and the shared {name}-specialist.md pattern', () => {
    for (const id of CLIENT_IDS) {
      expect(COMPANION_AGENT_TARGETS[id].fileMode).toBe('flat')
      expect(COMPANION_AGENT_TARGETS[id].filenamePattern).toBe('{name}-specialist.md')
    }
  })

  it('claude-code matches the pre-Wave-3 hardcoded default exactly', () => {
    // Pre-Wave-3: path.join(os.homedir(), '.claude', 'agents') — the exact
    // literal skill-installation.io.ts and author/utils.ts both hardcoded.
    expect(COMPANION_AGENT_TARGETS['claude-code'].dir).toBe(join(homedir(), '.claude', 'agents'))
  })

  it.each<ClientId>(['cursor', 'windsurf', 'agents', 'hermes', 'grok'])(
    '%s has no independent AGENT_SHIM_TARGETS evidence — defaults to the claude-code value',
    (client) => {
      expect(COMPANION_AGENT_TARGETS[client].dir).toBe(COMPANION_AGENT_TARGETS['claude-code'].dir)
    }
  )

  it('copilot uses its own independently-evidenced directory, not the claude-code default', () => {
    expect(COMPANION_AGENT_TARGETS.copilot.dir.endsWith('/.copilot/agents')).toBe(true)
    expect(COMPANION_AGENT_TARGETS.copilot.dir).not.toBe(COMPANION_AGENT_TARGETS['claude-code'].dir)
  })

  it('opencode uses its own independently-evidenced directory, not the claude-code default', () => {
    expect(COMPANION_AGENT_TARGETS.opencode.dir.endsWith('/.config/opencode/agents')).toBe(true)
    expect(COMPANION_AGENT_TARGETS.opencode.dir).not.toBe(
      COMPANION_AGENT_TARGETS['claude-code'].dir
    )
  })
})

describe('getCompanionAgentTarget / resolveCompanionAgentDir / resolveCompanionAgentPath (SMI-5980 Wave 3)', () => {
  it('getCompanionAgentTarget defaults to CANONICAL_CLIENT when no client is passed', () => {
    expect(getCompanionAgentTarget()).toEqual(COMPANION_AGENT_TARGETS[CANONICAL_CLIENT])
  })

  it('getCompanionAgentTarget returns the exact per-client entry', () => {
    for (const id of CLIENT_IDS) {
      expect(getCompanionAgentTarget(id)).toEqual(COMPANION_AGENT_TARGETS[id])
    }
  })

  it('resolveCompanionAgentDir defaults to the canonical (claude-code) dir', () => {
    expect(resolveCompanionAgentDir()).toBe(COMPANION_AGENT_TARGETS['claude-code'].dir)
  })

  it.each<ClientId>([...CLIENT_IDS])(
    'resolveCompanionAgentPath(%s) matches dir + <skillName>-specialist.md for every client',
    (client) => {
      const result = resolveCompanionAgentPath('my-skill', client)
      expect(result).toBe(join(COMPANION_AGENT_TARGETS[client].dir, 'my-skill-specialist.md'))
    }
  )

  it('resolveCompanionAgentPath defaults to canonical client when omitted (regression: unchanged)', () => {
    const result = resolveCompanionAgentPath('my-skill')
    expect(result).toBe(join(COMPANION_AGENT_TARGETS['claude-code'].dir, 'my-skill-specialist.md'))
  })
})
