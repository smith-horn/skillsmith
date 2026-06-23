/**
 * Create-skill happy-path E2E spec (SMI-5347).
 *
 * Exercises the create flow end-to-end: open the Create Skill wizard → fill +
 * submit → the `skillsmith` CLI scaffolds the skill → the panel disposes and
 * the SMI-5346 "Next steps" sidebar section renders with its checklist rows →
 * dismiss hides it.
 *
 * The create flow shells out to a real `skillsmith` binary (`createSkill.helpers`
 * `ensureCliAvailable`/`runCli`) and is pure-CLI — no MCP. CI provisions a
 * deterministic `skillsmith` shim (`e2e/bin/skillsmith`) on PATH for the nightly
 * `full` job; the shim writes to `~/.claude/skills/<name>` (matching the
 * extension's hardcoded `targetDirFor`, which ignores `skillsmith.skillsDirectory`).
 * The new skill therefore does NOT appear in the Installed-Skills group (which
 * scans the fixture dir) — so this spec asserts on the Next-steps group, which
 * `showNextSteps(name, targetDir)` renders independently of the skills dir.
 *
 * This spec runs in the nightly `full` tier only (it is not in the per-PR smoke
 * `--spec` list).
 */
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { browser, expect } from '@wdio/globals'
import { CreateSkillPage } from '../pageobjects/create-skill.page.js'
import { SkillsTreePage } from '../pageobjects/skills-tree.page.js'

const TEST_SKILL_NAME = 'e2e-create-skill'
const TARGET_DIR = path.join(homedir(), '.claude', 'skills', TEST_SKILL_NAME)

/** True when a `skillsmith` executable resolves on PATH and exits 0 on `--version`. */
function skillsmithOnPath(): boolean {
  try {
    execFileSync('skillsmith', ['--version'], { stdio: 'ignore', timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

describe('Create skill — happy path + Next-steps (SMI-5347)', () => {
  const createPage = new CreateSkillPage()
  const treePage = new SkillsTreePage()

  before(function () {
    // The skip-guard runs BEFORE any openCreatePanel(): if `skillsmith` is not
    // on PATH, ensureCliAvailable() shows an un-drivable {modal:true} dialog
    // (hangs the wdio bridge headless). CI puts the e2e/bin shim on PATH for the
    // `full` job; local runs without the shim skip cleanly here instead of
    // hanging.
    if (!skillsmithOnPath()) {
      this.skip()
    }
    // Remove any prior scaffold so the overwrite-confirm {modal:true} (the only
    // modal reachable in the success path) never fires for a fresh create.
    rmSync(TARGET_DIR, { recursive: true, force: true })
  })

  after(() => {
    rmSync(TARGET_DIR, { recursive: true, force: true })
  })

  it('creates a skill via the wizard and renders the Next-steps checklist', async () => {
    await createPage.openCreatePanel()
    await createPage.fillAndSubmit({
      author: 'e2e',
      name: TEST_SKILL_NAME,
      description: 'created by e2e',
      type: 'basic',
    })

    // Success-path ordering (CreateSkillPanel._handleSubmit): runCli →
    // refreshAndWait() (re-renders the tree WITHOUT the group) → dispose() →
    // showNextSteps() (re-renders WITH the group). So the group appears only
    // after the CLI round-trip; poll until both the group header and the
    // validate row are visible. The group is created Expanded, so its child rows
    // are returned by the section's flattened getVisibleItems().
    let labels: string[] = []
    await browser.waitUntil(
      async () => {
        labels = await treePage.getVisibleTreeLabels()
        return (
          labels.includes('Next steps') && labels.some((l) => l.includes('Run skillsmith validate'))
        )
      },
      {
        timeout: 30_000,
        interval: 1_500,
        timeoutMsg:
          'Next-steps group + "Run skillsmith validate" row did not appear within 30s.\n' +
          `Last observed labels: [${labels.map((l) => `"${l}"`).join(', ')}]`,
      }
    )

    expect(labels.includes('Next steps')).toBe(true)
    expect(labels.some((l) => l.includes('Run skillsmith validate'))).toBe(true)
  })

  it('dismiss hides the Next-steps section', async () => {
    await browser.executeWorkbench((vscode) =>
      vscode.commands.executeCommand('skillsmith.dismissNextSteps')
    )
    // Refresh to force a re-render; the dismissed flag (globalState) survives it.
    await browser.executeWorkbench((vscode) =>
      vscode.commands.executeCommand('skillsmith.refreshSkills')
    )

    let labels: string[] = []
    await browser.waitUntil(
      async () => {
        labels = await treePage.getVisibleTreeLabels()
        return !labels.includes('Next steps')
      },
      {
        timeout: 15_000,
        interval: 1_500,
        timeoutMsg:
          'Next-steps group still visible 15s after dismiss.\n' +
          `Last observed labels: [${labels.map((l) => `"${l}"`).join(', ')}]`,
      }
    )

    expect(labels.includes('Next steps')).toBe(false)
  })
})
