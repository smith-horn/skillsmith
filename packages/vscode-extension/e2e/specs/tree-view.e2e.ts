/**
 * Skills tree-view E2E spec (SMI-5339 Phase 2b).
 *
 * The wdio.conf.ts points `skillsmith.skillsDirectory` at the fixture tree
 * `e2e/fixtures/skills/`, so the extension's `doLoadInstalledSkills()` finds
 * `my-e2e-skill/SKILL.md` without touching `~/.claude/skills`. No MCP
 * connection or search is needed — the installed group populates from the
 * local filesystem on activation.
 *
 * This spec asserts that at least one installed-skills row whose label
 * contains `my-e2e-skill` is visible after expanding the 'Installed Skills'
 * group in the Skillsmith sidebar.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { browser, expect } from '@wdio/globals'
import { SkillsTreePage } from '../pageobjects/skills-tree.page.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_SKILL_DIR = path.resolve(here, '..', 'fixtures', 'skills', 'my-e2e-skill')

describe('Skills tree-view — installed skills from fixture dir (SMI-5339)', () => {
  before(function () {
    // governance L4 — fast fail with a clear message if the fixture is absent.
    if (!existsSync(FIXTURE_SKILL_DIR)) {
      throw new Error(
        `Fixture skill directory not found: ${FIXTURE_SKILL_DIR}\n` +
          'The tree-view spec requires e2e/fixtures/skills/my-e2e-skill/SKILL.md to exist.'
      )
    }
  })

  const page = new SkillsTreePage()

  it('installed skill row containing "my-e2e-skill" appears in the Skillsmith sidebar', async () => {
    // Allow generous time for the sidebar to open and the tree to populate on
    // activation. A cold CI runner may take several seconds for the extension
    // host to finish loading installed skills via doLoadInstalledSkills().
    let labels: string[] = []
    await browser.waitUntil(
      async () => {
        labels = await page.getInstalledSkillLabels()
        return labels.some((l) => l.includes('my-e2e-skill'))
      },
      {
        timeout: 30_000,
        interval: 1_500,
        timeoutMsg:
          `No installed-skills row containing "my-e2e-skill" appeared within 30s.\n` +
          `Last observed labels: [${labels.map((l) => `"${l}"`).join(', ')}]`,
      }
    )

    // Confirm the assertion with a synchronous expect so failures surface the
    // actual label list clearly in the test reporter.
    expect(labels.some((l) => l.includes('my-e2e-skill'))).toBe(true)
  })
})
