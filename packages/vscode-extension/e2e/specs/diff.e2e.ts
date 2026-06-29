/**
 * Diff skill (update advisor) tree-context E2E spec (SMI-5340 Wave 2).
 *
 * Drives `skillsmith.diffSkill` with a synthetic installed SkillTreeItem arg
 * that points at the `e2e/fixtures/skills/my-e2e-skill/` fixture directory
 * (which contains a real SKILL.md). The arg satisfies the
 * `preselected?.skillData?.isInstalled && preselected.skillData.path` guard in
 * diffCommandImpl so the QuickPick is skipped entirely.
 *
 * diffCommandImpl sequence:
 *   1. Reads SKILL.md from `skill.path` → `oldContent`
 *   2. Calls `client.getSkill(skill.id)` → MCP `get_skill` → `detail.content`
 *      (top-level `content` on McpGetSkillResponse — non-empty markdown)
 *   3. Calls `client.skillDiff(args)` → MCP `skill_diff`
 *   4. Opens SkillDiffPanel (title: `Updates: <skillName>`)
 *
 * Asserts:
 *   (a) `get_skill` fired for the fixture skill id.
 *   (b) `skill_diff` fired for the fixture skill id.
 *   (c) A tab whose label starts with "Updates: " appeared in the workbench
 *       (SkillDiffPanel._update sets `panel.title = \`Updates: ${this._skillName}\``).
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { browser, expect } from '@wdio/globals'
import { DiffSkillPage } from '../pageobjects/diff-skill.page.js'
import { readFakeMcpLog } from '../fixtures/fake-mcp-log.js'
import { waitForTabWithPrefix } from '../helpers/tabs.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/** The fixture skill directory — must match the dir name used as the skill id. */
const SKILL_DIR = path.resolve(here, '..', 'fixtures', 'skills', 'my-e2e-skill')
const SKILL_ID = 'my-e2e-skill'

/** Returns true once get_skill fires for our fixture skill id. */
const getSkillFired = (): boolean =>
  readFakeMcpLog().some((e) => {
    if (e['t'] !== 'tools/call' || e['name'] !== 'get_skill') return false
    const args = e['args'] as { id?: string } | undefined
    return args?.id === SKILL_ID
  })

/** Returns true once skill_diff fires for our fixture skill id. */
const skillDiffFired = (): boolean =>
  readFakeMcpLog().some((e) => {
    if (e['t'] !== 'tools/call' || e['name'] !== 'skill_diff') return false
    const args = e['args'] as { skillId?: string } | undefined
    return args?.skillId === SKILL_ID
  })

describe('Diff skill (update advisor) — tree-context flow (SMI-5340)', () => {
  const page = new DiffSkillPage()

  it('diffSkill with installed arg fires get_skill + skill_diff and opens the Updates panel', async () => {
    // Host-ready gate (SMI-5438): confirm the VS Code workbench is reachable before
    // any command dispatch or the heavy Updates-panel interaction. On a cold/slow CI
    // host the Extension Host can still be coming up when the spec starts; gating on
    // getWorkbench() (the idiom in activation.e2e.ts / mcp-failure.e2e.ts) fails fast
    // with a clear message instead of a later opaque "Remote command timeout".
    const workbench = await browser.getWorkbench()
    await browser.waitUntil(
      async () => Boolean(await workbench.getActivityBar().getViewControl('Skillsmith')),
      {
        timeout: 30_000,
        interval: 500,
        timeoutMsg: 'VS Code workbench / Skillsmith activity-bar not ready before diff interaction',
      }
    )

    // autoConnect is skipped on first activation — force an explicit connection.
    await page.forceConnect()

    // Wait for the MCP server to be ready.
    await browser.waitUntil(() => readFakeMcpLog().some((e) => e['t'] === 'start'), {
      timeout: 20_000,
      interval: 500,
      timeoutMsg: 'fake MCP server never started (no {t:"start"} marker in log)',
    })

    // Invoke diffSkill with a synthetic installed arg. The handler reads SKILL.md
    // from SKILL_DIR (the e2e fixture), then calls get_skill + skill_diff.
    await page.diffSkill({
      skillData: {
        id: SKILL_ID,
        name: SKILL_ID,
        isInstalled: true,
        path: SKILL_DIR,
      },
    })

    // Assert (a): get_skill fired with the fixture skill id.
    await browser.waitUntil(getSkillFired, {
      timeout: 20_000,
      interval: 500,
      timeoutMsg: `get_skill for "${SKILL_ID}" never reached the fake MCP server`,
    })

    // Assert (b): skill_diff fired with the fixture skill id.
    await browser.waitUntil(skillDiffFired, {
      timeout: 20_000,
      interval: 500,
      timeoutMsg: `skill_diff for "${SKILL_ID}" never reached the fake MCP server`,
    })

    // Assert (c): a tab whose label starts with "Updates: " is open.
    // The exact label is "Updates: my-e2e-skill" (SkillDiffPanel._update).
    const tabLabel = await waitForTabWithPrefix('Updates: ')
    expect(tabLabel).toContain('Updates: ')
  })
})
