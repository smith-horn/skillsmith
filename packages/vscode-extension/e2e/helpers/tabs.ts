/**
 * Tab-polling helpers for the SMI-5340 E2E specs.
 *
 * CompareSkillsPanel and SkillDiffPanel set dynamic titles in `_update()`:
 *   - `Compare: <name-a> vs <name-b>`   (CompareSkillsPanel.ts:151)
 *   - `Updates: <skill-name>`            (SkillDiffPanel.ts:171)
 *
 * `getWebviewByTitle` requires an EXACT title, but the fake MCP responses
 * determine the names at run-time. Polling `vscode.window.tabGroups` for
 * a prefix match is more robust and avoids the 40s openAuditPanel retry loop.
 */
import { browser } from '@wdio/globals'

/**
 * Wait until at least one open editor tab has a label that starts with
 * `prefix`, then return that label.  Polls the extension host via
 * `executeWorkbench` so it runs inside the VS Code process.
 */
export async function waitForTabWithPrefix(prefix: string, timeout = 30_000): Promise<string> {
  let found = ''
  await browser.waitUntil(
    async () => {
      const label = (await browser.executeWorkbench((vscode, p) => {
        for (const group of vscode.window.tabGroups.all) {
          for (const tab of group.tabs) {
            if (tab.label.startsWith(p)) {
              return tab.label
            }
          }
        }
        return ''
      }, prefix)) as string
      if (label) {
        found = label
        return true
      }
      return false
    },
    {
      timeout,
      interval: 500,
      timeoutMsg: `No tab with prefix "${prefix}" appeared within ${timeout}ms`,
    }
  )
  return found
}
