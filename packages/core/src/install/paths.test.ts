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
    expect(result.find((r) => r.harness === 'antigravity')?.present).toBe(false)
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
  })

  it('grok resolves to ~/.grok/skills', () => {
    expect(CLIENT_NATIVE_PATHS.grok.endsWith('/.grok/skills')).toBe(true)
  })
})

describe('antigravity ClientId (SMI-5982 Wave 6)', () => {
  it('CLIENT_IDS includes antigravity, 9 total', () => {
    expect(CLIENT_IDS).toContain('antigravity')
    expect(CLIENT_IDS).toHaveLength(9)
  })

  it('antigravity resolves to ~/.gemini/config/skills (corrects SMI-5179 stale ~/.gemini/antigravity/skills claim)', () => {
    expect(CLIENT_NATIVE_PATHS.antigravity).toBe(join(homedir(), '.gemini', 'config', 'skills'))
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

  it('every entry but antigravity uses flat file mode; every flat entry but copilot uses the shared {name}-specialist.md pattern', () => {
    // SMI-5982 (Wave 6): antigravity is the first 'directory-package' entry —
    // see the dedicated 'antigravity directory-package entry' test below.
    for (const id of CLIENT_IDS) {
      if (id === 'antigravity') continue
      expect(COMPANION_AGENT_TARGETS[id].fileMode).toBe('flat')
      if (id === 'copilot') continue
      expect(COMPANION_AGENT_TARGETS[id].filenamePattern).toBe('{name}-specialist.md')
    }
  })

  it('copilot uses {name}.agent.md — its own independently-evidenced filename, not the shared -specialist.md suffix (PR-review finding, BLOCKING)', () => {
    // AGENT_SHIM_TARGETS.copilot (agent-harness-targets.ts) and shims.ts's
    // own doc comment both independently confirm Copilot's real
    // companion-agent format is `.agent.md` -- a plain `-specialist.md`
    // suffix risked producing a file Copilot's own surfaces never discover.
    expect(COMPANION_AGENT_TARGETS.copilot.filenamePattern).toBe('{name}.agent.md')
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

  it('antigravity directory-package entry: its own dir, directory-package mode, fixed agent.md filename (SMI-5982 Wave 6)', () => {
    // Project-scoped relative dir (Step 1 of the SMI-5982 plan: no existing
    // global-vs-project distinction anywhere in this CLI to hook into) — NOT
    // homedir()-anchored like every other client's dir.
    expect(COMPANION_AGENT_TARGETS.antigravity.dir).toBe(join('.agents', 'agents'))
    expect(COMPANION_AGENT_TARGETS.antigravity.dir).not.toBe(
      COMPANION_AGENT_TARGETS['claude-code'].dir
    )
    expect(COMPANION_AGENT_TARGETS.antigravity.fileMode).toBe('directory-package')
    // No {name} token — the skill name lives in the directory segment, not the filename.
    expect(COMPANION_AGENT_TARGETS.antigravity.filenamePattern).toBe('agent.md')
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

  it.each<ClientId>(CLIENT_IDS.filter((id) => id !== 'copilot' && id !== 'antigravity'))(
    'resolveCompanionAgentPath(%s) matches dir + <skillName>-specialist.md for every flat client but copilot',
    (client) => {
      const result = resolveCompanionAgentPath('my-skill', client)
      expect(result).toBe(join(COMPANION_AGENT_TARGETS[client].dir, 'my-skill-specialist.md'))
    }
  )

  it('resolveCompanionAgentPath(copilot) matches dir + <skillName>.agent.md', () => {
    const result = resolveCompanionAgentPath('my-skill', 'copilot')
    expect(result).toBe(join(COMPANION_AGENT_TARGETS.copilot.dir, 'my-skill.agent.md'))
  })

  it('resolveCompanionAgentPath(antigravity) matches dir/<skillName>/agent.md — directory-package mode (SMI-5982 Wave 6)', () => {
    const result = resolveCompanionAgentPath('my-skill', 'antigravity')
    expect(result).toBe(join(COMPANION_AGENT_TARGETS.antigravity.dir, 'my-skill', 'agent.md'))
    expect(result).toBe(join('.agents', 'agents', 'my-skill', 'agent.md'))
  })

  it('resolveCompanionAgentPath defaults to canonical client when omitted (regression: unchanged)', () => {
    const result = resolveCompanionAgentPath('my-skill')
    expect(result).toBe(join(COMPANION_AGENT_TARGETS['claude-code'].dir, 'my-skill-specialist.md'))
  })
})
