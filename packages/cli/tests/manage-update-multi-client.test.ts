/**
 * SMI-5895 Wave 2 (Step 1) — same-name, multi-client manifest resolution
 * regression test.
 *
 * Cross-cutting Verification requirement (plan doc: "Same-name-installed-
 * under-two-clients regression scenario covered by tests in both Wave 1
 * (remove/update --client) and Wave 2 (manifest resolution)"). Wave 1's own
 * `manage-multi-client.test.ts` covers the filesystem/`--client` targeting
 * half; this file covers the Wave 2 half — that `getSkillDiff`'s NEW
 * manifest consultation (added this wave, replacing the dead
 * `resolveInstalledSkillId()`) resolves the (name, client)-keyed manifest
 * entry that actually matches the client being asked about, not whichever
 * one was written last, when two independently-sourced installs share a
 * skill name.
 *
 * Real SkillInstallationService end-to-end against a temp $HOME, mocking
 * only `fetch` (GitHub SKILL.md fetch) — same technique as Wave 1's
 * manage-multi-client.test.ts and skill-installation.service.multi-client
 * .test.ts. This is the only way to prove the manifest-consultation fix
 * behaves correctly through the CLI's own install/update actions end to
 * end, not just that a mocked SourceRecoveryService/manifest reader was
 * called with the right arguments (covered separately, with mocks, in
 * manage.update.source-recovery.test.ts).
 */
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `updateSkill()` prompts for confirmation before a real (non-dry-run)
// update — stub the interactive prompt library only; everything else in
// this file exercises the real service/manifest/filesystem stack.
vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(async () => true),
}))

const VALID_SKILL_MD = `---
name: test-repo
description: A test skill for the SMI-5895 multi-client manifest resolution test
---

# Test Skill

This is a valid skill file with enough content to pass the 100-character
minimum validation threshold that the install service checks during
installation. Nothing suspicious here, just plain instructional prose.
`

const ORIGINAL_HOME = process.env['HOME']
const ORIGINAL_USERPROFILE = process.env['USERPROFILE']
const ORIGINAL_CLIENT = process.env['SKILLSMITH_CLIENT']

let homeDir: string
let dbPath: string

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(tmpdir(), 'smi5895-manage-update-multi-'))
  process.env['HOME'] = homeDir
  process.env['USERPROFILE'] = homeDir
  delete process.env['SKILLSMITH_CLIENT']
  dbPath = path.join(homeDir, 'skills.db')

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const urlStr = typeof url === 'string' ? url : url.toString()
      if (urlStr.includes('SKILL.md')) {
        return new Response(VALID_SKILL_MD, { status: 200 })
      }
      return new Response('Not found', { status: 404 })
    })
  )

  // CLIENT_NATIVE_PATHS and DEFAULT_MANIFEST_PATH compute homedir() at
  // module import time — reset modules so each test sees its own $HOME
  // (same technique as install-multi-client.test.ts / manage-multi-client.test.ts).
  vi.resetModules()

  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (ORIGINAL_HOME === undefined) delete process.env['HOME']
  else process.env['HOME'] = ORIGINAL_HOME
  if (ORIGINAL_USERPROFILE === undefined) delete process.env['USERPROFILE']
  else process.env['USERPROFILE'] = ORIGINAL_USERPROFILE
  if (ORIGINAL_CLIENT === undefined) delete process.env['SKILLSMITH_CLIENT']
  else process.env['SKILLSMITH_CLIENT'] = ORIGINAL_CLIENT
  await rm(homeDir, { recursive: true, force: true })
})

/** Install the fixture skill from a given source URL for a given client. */
async function installForClient(sourceUrl: string, client: string): Promise<void> {
  const { installAction } = await import('../src/commands/install.js')
  await installAction(sourceUrl, {
    db: dbPath,
    client,
    quiet: true,
    json: true,
    skipOptimize: true,
  })
}

async function readManifest(): Promise<Record<string, unknown>> {
  const raw = await readFile(path.join(homeDir, '.skillsmith', 'manifest.json'), 'utf-8')
  return JSON.parse(raw) as Record<string, unknown>
}

// SMI-6004: suite-level timeout bumped 15s (default) -> 60s. Root cause is
// pure test-suite timing budget, not a bug in the code under test: this
// file exercises the REAL SkillInstallationService end-to-end (install x2 +
// update) against a temp $HOME, and under full-suite CI load with other
// packages' tests contending for CPU, that real work can still be in flight
// when the vitest default 15s test timeout fires. Vitest's timeout wrapper
// rejects the test promise but does NOT cancel the original async chain
// (confirmed against Vitest 4.1.10 runner source) -- the abandoned chain's
// manifest write then races the next test's afterEach() rm -rf of the temp
// HOME, producing `ENOENT ... rename '.../manifest.json.tmp.NNNNN'`, and the
// abandoned/poisoned install path calling process.exit(1) produces the
// third observed flake symptom ("process.exit unexpectedly called with
// '1'"). Mirrors SMI-5999's identical-class fix in
// packages/mcp-server/tests/crash-handler-integration.test.ts (same 15s ->
// 60s bump for the same suite-contention reason). Do NOT touch the shared
// vitest.config.ts default timeout -- this is scoped to just this file.
describe('SMI-5895 Wave 2: getSkillDiff manifest resolution — same skill name, two independently-sourced clients', () => {
  it("resolves the manifest id recorded for THIS client, not the other client's, when both installed the same skill name from different sources", async () => {
    // Two fully independent installs of the same skill NAME ("test-repo"),
    // each from a DIFFERENT source repo — the scenario that actually
    // exercises manifestKeyFor()'s (name, client) keying, since two installs
    // of the identical source URL would (coincidentally) resolve to the
    // same id either way.
    await installForClient('https://github.com/owner-a/test-repo', 'claude-code')
    await installForClient('https://github.com/owner-b/test-repo', 'cursor')

    const manifest = await readManifest()
    const installedSkills = manifest['installedSkills'] as Record<
      string,
      { id: string; installPath: string }
    >
    expect(installedSkills['test-repo']?.id).toBe('https://github.com/owner-a/test-repo')
    expect(installedSkills['test-repo::cursor']?.id).toBe('https://github.com/owner-b/test-repo')

    const { getSkillDiff } = await import('../src/commands/manage.js')

    const claudeDiff = await getSkillDiff('test-repo', dbPath, 'claude-code')
    expect(typeof claudeDiff).toBe('object')
    if (typeof claudeDiff === 'object') {
      expect(claudeDiff.skillId).toBe('https://github.com/owner-a/test-repo')
    }

    const cursorDiff = await getSkillDiff('test-repo', dbPath, 'cursor')
    expect(typeof cursorDiff).toBe('object')
    if (typeof cursorDiff === 'object') {
      expect(cursorDiff.skillId).toBe('https://github.com/owner-b/test-repo')
    }
  })

  it("update --client cursor force-reinstalls from the Cursor copy's own recorded source, leaving the Claude Code manifest entry's source untouched", async () => {
    await installForClient('https://github.com/owner-a/test-repo', 'claude-code')
    await installForClient('https://github.com/owner-b/test-repo', 'cursor')

    const { updateSkill } = await import('../src/commands/manage.js')

    const success = await updateSkill('test-repo', dbPath, false, 'cursor')
    expect(success).toBe(true)

    const manifest = await readManifest()
    const installedSkills = manifest['installedSkills'] as Record<
      string,
      { id: string; installPath: string }
    >
    // Cursor's copy was force-reinstalled from ITS OWN recorded source...
    expect(installedSkills['test-repo::cursor']?.id).toBe('https://github.com/owner-b/test-repo')
    // ...and the Claude Code entry was never touched by this update.
    expect(installedSkills['test-repo']?.id).toBe('https://github.com/owner-a/test-repo')
  })
}, 60_000)
