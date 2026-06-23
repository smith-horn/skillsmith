/**
 * Page object for the Create Skill webview wizard (SMI-5347 / SMI-5313).
 *
 * Encapsulates opening the wizard, entering its webview iframe, filling the
 * four-field form, submitting, and returning the wdio context to the top frame.
 *
 * The success path (`CreateSkillPanel._handleSubmit`) runs the `skillsmith`
 * CLI, then `dispose()`s the panel (tearing down the iframe) and finally calls
 * `treeProvider.showNextSteps(name, targetDir)`. Because the panel auto-disposes,
 * we exit the iframe via `browser.switchToFrame(null)` (reset to the top-level
 * browsing context) rather than `webview.close()`, which would operate on the
 * now-detached iframe.
 */
import { browser, $ } from '@wdio/globals'
import { type WebView } from 'wdio-vscode-service'

/** Panel title set by CreateSkillPanel (`createWebviewPanel(..., 'Create Skill', ...)`). */
const PANEL_TITLE = 'Create Skill'

export interface CreateFormInput {
  author: string
  name: string
  description: string
  type: 'basic' | 'intermediate' | 'advanced'
}

export class CreateSkillPage {
  /**
   * Open the Create Skill wizard and switch the wdio context INTO its webview
   * iframe. Retries the command until the panel appears; re-invoking
   * `skillsmith.createSkill` while the panel is already open just reveals it
   * (no second CLI check — CreateSkillPanel singleton), so the retry is safe.
   */
  async openCreatePanel(): Promise<void> {
    const workbench = await browser.getWorkbench()
    const webview = (await browser.waitUntil(
      async () => {
        await browser.executeWorkbench((vscode) =>
          vscode.commands.executeCommand('skillsmith.createSkill')
        )
        try {
          return await workbench.getWebviewByTitle(PANEL_TITLE)
        } catch {
          return false
        }
      },
      {
        timeout: 40_000,
        interval: 3_000,
        timeoutMsg: `create panel "${PANEL_TITLE}" did not open`,
      }
    )) as WebView
    await webview.open()
  }

  /**
   * Inside the iframe: fill the four fields, submit, then reset to the top
   * frame. Must be called after `openCreatePanel()` (which leaves the wdio
   * context inside the iframe). The name is a valid kebab-case slug, so host-side
   * validation passes and no `submitError` is posted.
   */
  async fillAndSubmit(fields: CreateFormInput): Promise<void> {
    await (await $('#author')).setValue(fields.author)
    await (await $('#name')).setValue(fields.name)
    await (await $('#description')).setValue(fields.description)
    await (await $(`input[name="type"][value="${fields.type}"]`)).click()

    const submit = await $('#createBtn')
    await submit.waitForClickable({ timeout: 15_000 })
    await submit.click()

    // The success path disposes the panel (iframe detaches) before the next
    // assertion reads the tree, so reset to the top-level browsing context.
    // switchToFrame(null) is safe whether or not the iframe still exists.
    await browser.switchToFrame(null)
  }
}
