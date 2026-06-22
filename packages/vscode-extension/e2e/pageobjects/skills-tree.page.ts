/**
 * Page object for the Skillsmith sidebar tree view (SMI-5339 Phase 2b).
 *
 * Opens the Skillsmith activity-bar panel via wdio-vscode-service and reads
 * the labels of skills listed under the 'Installed Skills' group.
 *
 * Tree structure (SkillTreeDataProvider):
 *   Skillsmith (activity-bar view container)
 *   └─ [SideBarView]
 *      └─ ViewContent
 *         └─ ViewSection: "Installed Skills"   ← group header
 *            └─ TreeItem: "my-e2e-skill"       ← skill row
 *
 * `getVisibleItems()` on the section returns only the collapsed group headers;
 * the 'Installed Skills' section must be expanded first before child item
 * labels are accessible. (governance H6)
 */
import { browser } from '@wdio/globals'
import type { ViewSection, CustomTreeSection, TreeItem } from 'wdio-vscode-service'

/** Label set by SkillTreeDataProvider.buildInstalledGroupItem() (line 294). */
const INSTALLED_SECTION_TITLE = 'Installed Skills'

export class SkillsTreePage {
  /**
   * Opens the Skillsmith sidebar view and returns the labels of all items
   * currently visible under the 'Installed Skills' group.
   *
   * Steps:
   *  1. Open the Skillsmith activity-bar view control.
   *  2. Get the ViewContent from the returned SideBarView.
   *  3. Locate the 'Installed Skills' section.
   *  4. Expand it if collapsed.
   *  5. Call getVisibleItems() to collect the child rows.
   *  6. Map each row to its label string.
   */
  async getInstalledSkillLabels(): Promise<string[]> {
    const workbench = await browser.getWorkbench()
    const ctrl = await workbench.getActivityBar().getViewControl('Skillsmith')
    if (!ctrl) {
      throw new Error('Skillsmith activity-bar view control not found')
    }
    const view = await ctrl.openView()

    // getSections() returns one ViewSection per collapsible group header.
    const content = view.getContent()
    const sections: ViewSection[] = await content.getSections()

    // Find the 'Installed Skills' section by title.
    let installedSection: ViewSection | undefined
    for (const section of sections) {
      const title = await section.getTitle()
      if (title.includes(INSTALLED_SECTION_TITLE)) {
        installedSection = section
        break
      }
    }

    if (!installedSection) {
      // No installed section yet (e.g. tree still loading) — return empty.
      return []
    }

    // Expand the section so that child skill rows become visible.
    const alreadyExpanded = await installedSection.isExpanded()
    if (!alreadyExpanded) {
      await installedSection.expand()
    }

    // Cast to CustomTreeSection: the Skillsmith tree is an extension-contributed
    // tree view, so wdio-vscode-service wraps each section as a CustomTreeSection
    // whose getVisibleItems() returns TreeItem[] (which has getLabel()).
    // The abstract ViewSection.getVisibleItems() only guarantees ViewItem[], so
    // the cast is required to reach the typed return.
    const treeSection = installedSection as unknown as CustomTreeSection
    const items: TreeItem[] = await treeSection.getVisibleItems()

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
