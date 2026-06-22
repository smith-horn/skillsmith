/**
 * Tree-context compare flow E2E spec (SMI-5340 Wave 2).
 *
 * Drives `skillsmith.selectForCompare` (A) → `skillsmith.compareWithSelected`
 * (B) with synthetic duck-typed SkillTreeItem args (no QuickPick interaction).
 * Asserts:
 *   (a) `skill_compare` fired with the expected {skill_a, skill_b} in the MCP
 *       call log (fake-mcp-server.mjs).
 *   (b) A tab whose label starts with "Compare: " appeared in the workbench
 *       (CompareSkillsPanel._update sets `panel.title = \`Compare: ${a} vs ${b}\``).
 *
 * compareWithSelectedImpl also calls `get_skill` to re-validate the compare
 * source; the fake server handles both `get_skill` and `skill_compare`.
 *
 * Note: the first `skillsmith.mcpReconnect` on a fresh activation may open the
 * "Reconnect / Disconnect" picker when the client is already connected; the page
 * object guard relies on the fact that first-run auto-connect is skipped and
 * the test's `forceConnect()` is the triggering call.
 */
import { browser, expect } from '@wdio/globals'
import { CompareSkillsPage } from '../pageobjects/compare-skills.page.js'
import { readFakeMcpLog } from '../fixtures/fake-mcp-log.js'
import { waitForTabWithPrefix } from '../helpers/tabs.js'

const SKILL_A_ID = 'acme/skill-alpha'
const SKILL_B_ID = 'acme/skill-beta'

/** Returns true once skill_compare fires with the expected ids. */
const compareToolFired = (): boolean =>
  readFakeMcpLog().some((e) => {
    if (e['t'] !== 'tools/call' || e['name'] !== 'skill_compare') return false
    const args = e['args'] as { skill_a?: string; skill_b?: string } | undefined
    return args?.skill_a === SKILL_A_ID && args?.skill_b === SKILL_B_ID
  })

describe('Compare skills — tree-context two-step flow (SMI-5340)', () => {
  const page = new CompareSkillsPage()

  it('selectForCompare + compareWithSelected open the Compare panel', async () => {
    // autoConnect is skipped on first activation — force an explicit connection.
    await page.forceConnect()

    // Wait for the MCP server to be ready (the start marker appears in the log
    // after the fake server truncates and writes it on spawn).
    await browser.waitUntil(() => readFakeMcpLog().some((e) => e['t'] === 'start'), {
      timeout: 20_000,
      interval: 500,
      timeoutMsg: 'fake MCP server never started (no {t:"start"} marker in log)',
    })

    // Step 1: select skill A as the compare source.
    await page.selectForCompare({ skillData: { id: SKILL_A_ID, name: 'skill-alpha' } })
    // Pause briefly so the information toast resolves before the second command.
    await browser.pause(500)

    // Step 2: compare with skill B. compareWithSelectedImpl:
    //   - reads the compare source (SKILL_A_ID)
    //   - re-validates it via skillService.getSkill() → MCP get_skill
    //   - calls client.skillCompare({skill_a, skill_b}) → MCP skill_compare
    //   - opens CompareSkillsPanel
    await page.compareWithSelected({ skillData: { id: SKILL_B_ID, name: 'skill-beta' } })

    // Assert (a): skill_compare fired with the correct ids.
    await browser.waitUntil(compareToolFired, {
      timeout: 20_000,
      interval: 500,
      timeoutMsg: `skill_compare {skill_a:"${SKILL_A_ID}", skill_b:"${SKILL_B_ID}"} never reached the fake MCP server`,
    })

    // Assert (b): a tab whose label starts with "Compare: " is open.
    // The exact label is "Compare: skill-alpha vs skill-beta" (from the fake
    // server's comparison.a.name / comparison.b.name), but we match on the
    // prefix so the assertion doesn't depend on fake-data field names.
    const tabLabel = await waitForTabWithPrefix('Compare: ')
    expect(tabLabel).toContain('Compare: ')
  })
})
