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
 * SMI-5982 (Wave 6): antigravity's `COMPANION_AGENT_TARGETS` entry uses a
 * RELATIVE `dir` (resolved against `process.cwd()`, not `homedir()`) — its
 * own dedicated describe block below chdir's into an isolated tmp directory
 * per test (never TEST_HOME, never the real repo checkout) rather than
 * relying on the homedir() mock every other client's assertions use.
 *
 * SMI-5982 code-review fix #1 (BLOCKING, cwd-dependent resolution):
 * `writeInstallFiles()` now resolves antigravity's relative `dir` via
 * `resolveCompanionAgentPath()`'s explicit `baseDir` param (defaulting to
 * `process.cwd()` at the call site, not deferred to whatever `fs` call
 * eventually consumes the path) — so `result.subagentPath` is now an
 * ABSOLUTE path even for antigravity, not the raw relative string. The
 * `it.each` below covers both the omitted-`companionBaseDir` (falls back to
 * `process.cwd()`, which this describe block's chdir controls) and an
 * explicit `companionBaseDir` override.
 *
 * Split out of skill-installation.io.test.ts to stay under the 500-line
 * CI gate (same rationale as skill-installation.io.symlink.test.ts).
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'node:os'

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

  // SMI-5982 (Wave 6): antigravity is excluded from this generic 'flat'
  // it.each — its dir is a RELATIVE path (resolved against process.cwd(),
  // NOT the mocked homedir()), so writing it here would land outside
  // TEST_HOME, pollute the real working tree, and never get cleaned up by
  // this file's afterAll. It gets its own cwd-isolated describe block below.
  it.each<ClientId>(CLIENT_IDS.filter((id) => id !== 'antigravity'))(
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

      // Every remaining client uses 'flat' mode (copilot's own
      // '{name}.agent.md' pattern, SMI-5980 PR-review finding, included).
      const target = COMPANION_AGENT_TARGETS[client]
      const expectedPath = path.join(
        target.dir,
        target.filenamePattern.replace('{name}', 'my-skill')
      )
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

/**
 * SMI-5982 (Wave 6): antigravity's companion-agent dir is a RELATIVE path
 * (`.agents/agents`, project-scoped per the plan's Step 1 — no existing
 * global-vs-project distinction to hook into) resolved against
 * `process.cwd()`, unlike every other client's `homedir()`-anchored
 * absolute dir. This describe block is isolated from the rest of the file:
 * each test chdir's into its own fresh tmp directory (never TEST_HOME, and
 * never the real repo checkout) and restores the original cwd in
 * `afterEach` even on assertion failure, so a broken assertion can never
 * leave the whole test PROCESS's cwd corrupted for later tests/files.
 */
describe('writeInstallFiles companion-subagent path for antigravity (directory-package, SMI-5982 Wave 6)', () => {
  let originalCwd: string
  let projectDir: string

  beforeEach(async () => {
    originalCwd = process.cwd()
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skillsmith-antigravity-cwd-'))
    process.chdir(projectDir)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await fs.rm(projectDir, { recursive: true, force: true }).catch(() => {})
  })

  it('writes agent.md inside a skill-named subdirectory when companionBaseDir is passed explicitly (SMI-5982 code-review fix #1)', async () => {
    const { skillsDir, installPath } = await freshInstallPath('antigravity-write')

    const result = await writeInstallFiles(
      installPath,
      skillsDir,
      'my-skill',
      '# hello',
      [],
      '---\nname: my-skill-specialist\n---\nbody',
      'antigravity',
      // PR-review follow-up: writeInstallFiles() no longer falls back to
      // process.cwd() itself when companionBaseDir is omitted — an explicit
      // value (here, this describe block's chdir target) is required for
      // directory-package clients. See the dedicated "omitted
      // companionBaseDir" test below for the fail-closed case.
      projectDir
    )

    // SMI-5982 code-review fix #1: resolveCompanionAgentPath() resolves
    // antigravity's relative dir against the explicit baseDir BEFORE
    // returning — so subagentPath is ABSOLUTE, not the raw relative string.
    // Independently verify the REAL file via an absolute path built from the
    // known projectDir (not derived from result.subagentPath, so a bug that
    // silently mis-resolved the value would still be caught).
    const expectedRelativePath = path.join('.agents', 'agents', 'my-skill', 'agent.md')
    const expectedAbsolutePath = path.join(projectDir, expectedRelativePath)
    expect(result.subagentPath).toBe(expectedAbsolutePath)
    expect(await fs.readFile(expectedAbsolutePath, 'utf8')).toBe(
      '---\nname: my-skill-specialist\n---\nbody'
    )
    // Directory-package structure: agent.md lives INSIDE a subdirectory
    // named after the skill, not directly inside the agents dir.
    expect(path.basename(path.dirname(expectedAbsolutePath))).toBe('my-skill')
  })

  it('omitting companionBaseDir for antigravity now rejects the install instead of silently defaulting to process.cwd() (PR-review follow-up)', async () => {
    const { skillsDir, installPath } = await freshInstallPath('antigravity-omitted-basedir')

    await expect(
      writeInstallFiles(
        installPath,
        skillsDir,
        'my-skill',
        '# hello',
        [],
        '---\nname: my-skill-specialist\n---\nbody',
        'antigravity'
        // companionBaseDir omitted — must now throw (fail closed), not
        // resolve against process.cwd(). SKILL.md IS written before this
        // point (the companion-agent step runs last), but writeInstallFiles'
        // existing rollback-on-failure logic unwinds installPath entirely on
        // any thrown error — so nothing survives on disk after the throw.
      )
    ).rejects.toThrow(/directory-package mode.*explicit baseDir is required/s)

    await expect(fs.access(installPath)).rejects.toThrow()
  })

  it('writes agent.md resolved against an explicit companionBaseDir, not process.cwd() (SMI-5982 code-review fix #1)', async () => {
    // Deliberately DIFFERENT from projectDir (this block's chdir target) to
    // prove companionBaseDir — not the ambient cwd — drives resolution. This
    // is exactly the MCP-server scenario the fix targets: a long-running
    // process whose own cwd does not track the caller's real project.
    const explicitBaseDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'skillsmith-antigravity-explicit-basedir-')
    )
    try {
      const { skillsDir, installPath } = await freshInstallPath('antigravity-explicit-basedir')

      const result = await writeInstallFiles(
        installPath,
        skillsDir,
        'my-skill',
        '# hello',
        [],
        '---\nname: my-skill-specialist\n---\nbody',
        'antigravity',
        explicitBaseDir
      )

      const expectedAbsolutePath = path.join(
        explicitBaseDir,
        '.agents',
        'agents',
        'my-skill',
        'agent.md'
      )
      expect(result.subagentPath).toBe(expectedAbsolutePath)
      expect(result.subagentPath?.startsWith(projectDir)).toBe(false)
      expect(await fs.readFile(expectedAbsolutePath, 'utf8')).toBe(
        '---\nname: my-skill-specialist\n---\nbody'
      )
    } finally {
      await fs.rm(explicitBaseDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('a safeWriteFile failure on the companion-agent path does not crash, and never force-removes a non-empty per-skill directory', async () => {
    // Reachable, non-mocked failure mode for the LAST step in
    // writeInstallFiles's try block (companion-agent write): a symlink
    // already sitting at the exact target path. safeWriteFile's O_NOFOLLOW
    // open() refuses it (SymlinkError), so the rollback branch added in
    // SMI-5982 runs with subagentPath already assigned. The per-skill
    // directory is NOT empty (the symlink itself is still inside it), so
    // the rollback's rmdir() must be a safe no-op here, never a force-delete
    // — this proves the fix degrades safely rather than that it always
    // reclaims disk space (an EMPTY orphaned directory can only arise from a
    // transient I/O failure between mkdir and the write, not reproducible
    // deterministically without mocking fs internals).
    const { skillsDir, installPath } = await freshInstallPath('antigravity-symlink')

    const agentSkillDir = path.join(projectDir, '.agents', 'agents', 'my-skill')
    await fs.mkdir(agentSkillDir, { recursive: true })
    await fs.symlink('/nonexistent-target', path.join(agentSkillDir, 'agent.md'))

    await expect(
      writeInstallFiles(
        installPath,
        skillsDir,
        'my-skill',
        '# hello',
        [],
        '---\nname: my-skill-specialist\n---\nbody',
        'antigravity',
        // PR-review follow-up: explicit now that writeInstallFiles() no
        // longer defaults a missing companionBaseDir to process.cwd() —
        // required so this test still reaches the symlink failure it is
        // actually exercising, rather than the (also-now-thrown)
        // required-baseDir guard.
        projectDir
      )
    ).rejects.toThrow(/symlink/i)

    // The directory (and its symlink) must still exist — rollback did not
    // blindly force-delete non-empty content.
    const stats = await fs.lstat(agentSkillDir)
    expect(stats.isDirectory()).toBe(true)
  })

  it('rejects a path-traversal skillName ("..") for the companion-agent path and rolls back the already-written SKILL.md (SMI-5982 code-review fix #2)', async () => {
    // resolveCompanionAgentPath()'s own directory-package validation (fix #2)
    // is the last line of defense here: this test passes a malicious
    // skillName distinct from what installPath was built from, exactly the
    // "a future caller bypasses upstream sanitization" scenario the fix's
    // doc comment calls out.
    const { skillsDir, installPath } = await freshInstallPath('antigravity-traversal')

    await expect(
      writeInstallFiles(
        installPath,
        skillsDir,
        '..',
        '# hello',
        [],
        '---\nname: specialist\n---\nbody',
        'antigravity',
        // PR-review follow-up: explicit now that writeInstallFiles() no
        // longer defaults a missing companionBaseDir to process.cwd() —
        // required so this test still reaches the skillName traversal
        // guard it is actually exercising, rather than the
        // (also-now-thrown) required-baseDir guard.
        projectDir
      )
    ).rejects.toThrow(/Unsafe skill name for directory-package companion path/)

    // Rollback: the existing catch block in writeInstallFiles() already
    // covers this — SKILL.md was written before the throw (subagentPath is
    // resolved last), so it (and installPath itself) must be gone. Nothing
    // was ever created under the companion-agent dir, since the throw
    // happens BEFORE any fs.mkdir/write for that path.
    await expect(fs.access(installPath)).rejects.toThrow()
    const agentsParentDir = path.join(projectDir, '.agents')
    await expect(fs.access(agentsParentDir)).rejects.toThrow()
  })
})
