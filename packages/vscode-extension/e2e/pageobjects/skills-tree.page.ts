/**
 * Page object for the Skillsmith sidebar tree view (SMI-5339 Phase 2b).
 *
 * Opens the Skillsmith activity-bar panel via wdio-vscode-service and reads the
 * labels of the rows currently visible in the tree.
 *
 * Tree structure (SkillTreeDataProvider): `skillsmith.skillsView` is a SINGLE
 * VS Code view (one `ViewSection`). The "Installed Skills (N)" and "Available
 * Skills" GROUPS are root TREE ITEMS *inside* that one section — they are NOT
 * separate `ViewSection`s. The Installed group is created Expanded
 * (`createGroup(..., expanded=true)`), so its child skill rows (label =
 * `skill.name`, e.g. `my-e2e-skill`) are rendered and therefore returned by the
 * section's flattened `getVisibleItems()`. So we read the single section's
 * visible items directly rather than looking for a section titled
 * "Installed Skills" (which does not exist — the earlier mistake).
 */
import { browser } from '@wdio/globals'
import type { CustomTreeSection, TreeItem } from 'wdio-vscode-service'

export class SkillsTreePage {
  /**
   * Opens the Skillsmith sidebar view and returns the labels of every tree row
   * currently visible (group headers + their expanded children). The caller
   * asserts on the presence of a specific installed-skill label.
   */
  async getVisibleTreeLabels(): Promise<string[]> {
    const workbench = await browser.getWorkbench()
    const ctrl = await workbench.getActivityBar().getViewControl('Skillsmith')
    if (!ctrl) {
      throw new Error('Skillsmith activity-bar view control not found')
    }
    const view = await ctrl.openView()

    const content = view.getContent()
    const sections = await content.getSections()
    if (sections.length === 0) {
      return []
    }

    // `skillsmith.skillsView` is a single tree section. Cast to CustomTreeSection
    // (the concrete extension-tree wrapper) whose getVisibleItems() returns
    // TreeItem[] (with getLabel()); the abstract ViewSection only guarantees
    // ViewItem[] (no getLabel()).
    const section = sections[0] as unknown as CustomTreeSection
    const items: TreeItem[] = await section.getVisibleItems()

    const labels: string[] = []
    for (const item of items) {
      const label = await item.getLabel()
      if (label) {
        labels.push(label)
      }
    }
    return labels
  }
}
