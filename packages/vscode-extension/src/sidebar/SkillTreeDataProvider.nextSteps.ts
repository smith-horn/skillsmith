/**
 * Next-steps checklist logic for SkillTreeDataProvider (SMI-5346).
 *
 * Extracted to keep SkillTreeDataProvider.ts under 500 lines.
 * The provider delegates all next-steps state and row-building here.
 */
import * as vscode from 'vscode'
import * as path from 'node:path'
import { SkillTreeItem } from './SkillTreeItem.js'
import { track } from '../services/Telemetry.js'

/** Per-create next-steps state. */
export interface NextStepsState {
  name: string
  targetDir: string
}

const DISMISSED_KEY = 'skillsmith.createChecklistDismissed'

/**
 * Manages next-steps section state and delegates from SkillTreeDataProvider.
 * The provider stores one instance and calls these methods.
 */
export class NextStepsManager {
  private state: NextStepsState | undefined = undefined

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Show the next-steps section for a newly-created skill.
   *
   * - Resets the per-create dismissed flag (so the section always appears after
   *   a fresh create, even if it was previously dismissed for an earlier create).
   * - Tracks 'vscode_create_checklist_view' EXACTLY ONCE here, synchronously,
   *   BEFORE the caller fires _onDidChangeTreeData. Never tracked in render paths.
   */
  show(name: string, targetDir: string, onChanged: () => void): void {
    void this.context.globalState.update(DISMISSED_KEY, false)
    this.state = { name, targetDir }
    track('vscode_create_checklist_view')
    onChanged()
  }

  /**
   * Dismiss the next-steps section. Persists across reloads via globalState.
   */
  dismiss(onChanged: () => void): void {
    void this.context.globalState.update(DISMISSED_KEY, true)
    this.state = undefined
    onChanged()
  }

  /**
   * Whether the section should currently be visible.
   */
  isVisible(): boolean {
    if (!this.state) {
      return false
    }
    return this.context.globalState.get<boolean>(DISMISSED_KEY) !== true
  }

  /**
   * Returns the current state (name + targetDir), or undefined if not set.
   */
  getState(): NextStepsState | undefined {
    return this.state
  }

  /**
   * Builds the 'Next steps' group header item.
   */
  buildGroupItem(): SkillTreeItem {
    return SkillTreeItem.createNextStepsGroup()
  }

  /**
   * Builds the four action rows for the 'Next steps' group.
   */
  buildRows(): SkillTreeItem[] {
    const s = this.state
    if (!s) {
      return []
    }
    const { targetDir } = s
    return [
      SkillTreeItem.createChecklistRow('Open skill folder', {
        command: 'revealFileInOS',
        title: 'Open skill folder',
        arguments: [vscode.Uri.file(targetDir)],
      }),
      SkillTreeItem.createChecklistRow('Open SKILL.md to add triggers', {
        command: 'vscode.open',
        title: 'Open SKILL.md',
        arguments: [vscode.Uri.file(path.join(targetDir, 'SKILL.md'))],
      }),
      SkillTreeItem.createChecklistRow('Run skillsmith validate', {
        command: 'skillsmith.runValidate',
        title: 'Run skillsmith validate',
      }),
      SkillTreeItem.createChecklistRow('Authoring docs', {
        command: 'vscode.open',
        title: 'Authoring docs',
        arguments: [vscode.Uri.parse('https://skillsmith.app/docs')],
      }),
    ]
  }
}
