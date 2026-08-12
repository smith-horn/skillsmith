/**
 * SMI-5980 (Wave 3): writeInstallFiles must route the companion-subagent
 * write through COMPANION_AGENT_TARGETS (install/paths.ts) for the caller's
 * `client`, not a hardcoded `path.join(os.homedir(), '.claude', 'agents')`
 * literal.
 *
 * `homedir()` is mocked to a controlled tmp directory BEFORE `paths.ts` is
 * first imported — COMPANION_AGENT_TARGETS is a module-level constant
 * computed once at import time from `homedir()`, so every assertion below
 * compares against that SAME already-resolved map rather than a second,
 * independently-hardcoded expectation. This also keeps the test from ever
 * writing to a real developer/CI machine's actual home directory.
 *
 * Split out of skill-installation.io.test.ts to stay under the 500-line
 * CI gate (same rationale as skill-installation.io.symlink.test.ts).
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'

const { TEST_HOME, homedirMock } = vi.hoisted(() => {
  const home = '/tmp/skillsmith-wif-client-agent-path-test-' + process.pid
  return { TEST_HOME: home, homedirMock: vi.fn(() => home) }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: homedirMock }
})

import { writeInstallFiles } from '../../../src/services/skill-installation.io.js'
import { CLIENT_IDS, COMPANION_AGENT_TARGETS, type ClientId } from '../../../src/install/paths.js'

afterAll(async () => {
  await fs.rm(TEST_HOME, { recursive: true, force: true }).catch(() => {})
})

/**
 * Fresh skillsDir/installPath per test so parallel `it.each` iterations
 * (all sharing TEST_HOME) never collide with each other.
 */
async function freshInstallPath(
  label: string
): Promise<{ skillsDir: string; installPath: string }> {
  const skillsDir = path.join(TEST_HOME, 'src', label, 'skills')
  await fs.mkdir(skillsDir, { recursive: true })
  return { skillsDir, installPath: path.join(skillsDir, 'my-skill') }
}

describe('writeInstallFiles companion-subagent path per client (SMI-5980 regression)', () => {
  beforeEach(() => {
    homedirMock.mockReturnValue(TEST_HOME)
  })

  it.each<ClientId>([...CLIENT_IDS])(
    'writes the companion subagent for client=%s at exactly COMPANION_AGENT_TARGETS[client]',
    async (client) => {
      const { skillsDir, installPath } = await freshInstallPath(client)

      const result = await writeInstallFiles(
        installPath,
        skillsDir,
        'my-skill',
        '# hello',
        [],
        '---\nname: my-skill-specialist\n---\nbody',
        client
      )

      // PR-review finding fallout (SMI-5980): copilot's filenamePattern is
      // now '{name}.agent.md', not the shared '-specialist.md' suffix every
      // other client uses — derive the expected filename from the actual
      // per-client pattern instead of a universal hardcoded literal.
      const expectedFilename = COMPANION_AGENT_TARGETS[client].filenamePattern.replace(
        '{name}',
        'my-skill'
      )
      const expectedPath = path.join(COMPANION_AGENT_TARGETS[client].dir, expectedFilename)
      expect(result.subagentPath).toBe(expectedPath)
      expect(await fs.readFile(expectedPath, 'utf8')).toBe(
        '---\nname: my-skill-specialist\n---\nbody'
      )
    }
  )

  it('defaults to the canonical (claude-code) target when client is omitted (regression: unchanged)', async () => {
    const { skillsDir, installPath } = await freshInstallPath('default-client')

    const result = await writeInstallFiles(
      installPath,
      skillsDir,
      'my-skill',
      '# hello',
      [],
      'subagent body'
      // client omitted — must resolve exactly like the old hardcoded default.
    )

    const expectedPath = path.join(
      COMPANION_AGENT_TARGETS['claude-code'].dir,
      'my-skill-specialist.md'
    )
    expect(result.subagentPath).toBe(expectedPath)
    expect(await fs.readFile(expectedPath, 'utf8')).toBe('subagent body')
  })

  it('claude-code and cursor land in the SAME directory (both default, no independent evidence for cursor)', async () => {
    const claudeCode = await freshInstallPath('cc-vs-cursor-claude')
    const cursor = await freshInstallPath('cc-vs-cursor-cursor')

    const claudeResult = await writeInstallFiles(
      claudeCode.installPath,
      claudeCode.skillsDir,
      'my-skill',
      '# hello',
      [],
      'body',
      'claude-code'
    )
    const cursorResult = await writeInstallFiles(
      cursor.installPath,
      cursor.skillsDir,
      'my-skill',
      '# hello',
      [],
      'body',
      'cursor'
    )

    expect(path.dirname(cursorResult.subagentPath ?? '')).toBe(
      path.dirname(claudeResult.subagentPath ?? '')
    )
  })

  it('copilot and opencode land at their own real, literal directories (code-review finding: not just "different from claude-code")', async () => {
    const copilot = await freshInstallPath('copilot-diff')
    const opencode = await freshInstallPath('opencode-diff')

    const copilotResult = await writeInstallFiles(
      copilot.installPath,
      copilot.skillsDir,
      'my-skill',
      '# hello',
      [],
      'body',
      'copilot'
    )
    const opencodeResult = await writeInstallFiles(
      opencode.installPath,
      opencode.skillsDir,
      'my-skill',
      '# hello',
      [],
      'body',
      'opencode'
    )

    // Independently-constructed literal expected paths (via the SAME mocked
    // TEST_HOME this file's own homedir() mock uses, but NOT derived from
    // COMPANION_AGENT_TARGETS itself) — a code-review pass on an earlier
    // version of this test caught that comparing only against
    // COMPANION_AGENT_TARGETS['claude-code'].dir proves "different from
    // claude-code," not "equals the actual intended copilot/opencode value";
    // a typo in the map (e.g. singular '.copilot/agent') would have still
    // passed the old assertion.
    expect(path.dirname(copilotResult.subagentPath ?? '')).toBe(
      path.join(TEST_HOME, '.copilot', 'agents')
    )
    expect(path.dirname(opencodeResult.subagentPath ?? '')).toBe(
      path.join(TEST_HOME, '.config', 'opencode', 'agents')
    )
    // Belt-and-suspenders: still confirm both differ from claude-code's dir.
    expect(path.dirname(copilotResult.subagentPath ?? '')).not.toBe(
      COMPANION_AGENT_TARGETS['claude-code'].dir
    )
    expect(path.dirname(opencodeResult.subagentPath ?? '')).not.toBe(
      COMPANION_AGENT_TARGETS['claude-code'].dir
    )
  })

  it('does not write any companion-subagent file when subagentContent is undefined, regardless of client', async () => {
    const { skillsDir, installPath } = await freshInstallPath('no-subagent')

    const result = await writeInstallFiles(
      installPath,
      skillsDir,
      'my-skill',
      '# hello',
      [],
      undefined,
      'copilot'
    )

    expect(result.subagentPath).toBeUndefined()
  })
})
