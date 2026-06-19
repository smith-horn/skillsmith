/**
 * Action-block builder for SkillDetailPanel (#1437 / SMI-5308).
 *
 * Extracted from skill-panel-html.ts so that module stays under the 500-line
 * gate. Renders the sticky-header CTA cluster: Install (available) vs
 * Uninstall + Open Folder + Open SKILL.md (installed). Every button carries an
 * explicit `aria-label` (H7) because the header-first DOM order places actions
 * ahead of the body content.
 */
import { escapeHtml } from '../utils/security.js'
import type { SkillActionContext } from './skill-panel-types.js'

/**
 * Build the header action buttons for the detail panel.
 *
 * @param ctx - Installed-state context resolved at load time
 * @param safeRepository - An already-`escapeHtml`'d repository URL, or `''`
 * @returns The buttons HTML fragment
 */
export function getActionBlock(ctx: SkillActionContext, safeRepository: string): string {
  // Defense-in-depth: ctx carries no raw user strings into the markup today, but
  // re-escape the repository URL so this builder stays safe if callers change.
  const repoUrl = escapeHtml(safeRepository)
  const repoButton = safeRepository
    ? `<button class="btn-secondary" id="repoBtn" data-url="${repoUrl}" aria-label="View the source repository">View Repository</button>`
    : ''

  if (!ctx.installed) {
    return `<div class="actions">
        <button class="btn-primary" id="installBtn" aria-label="Install this skill">Install Skill</button>
        ${repoButton}
    </div>`
  }

  const openSkillFileButton = ctx.hasSkillMd
    ? `<button class="btn-secondary" id="openSkillFileBtn" aria-label="Open SKILL.md">Open SKILL.md</button>`
    : ''

  return `<div class="actions">
        <button class="btn-destructive" id="uninstallBtn" aria-label="Uninstall this skill">Uninstall</button>
        <button class="btn-secondary" id="openFolderBtn" aria-label="Open the skill folder">Open Folder</button>
        ${openSkillFileButton}
        ${repoButton}
    </div>`
}
