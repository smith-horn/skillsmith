/**
 * Read-only content provider backing the native "View full text diff" action
 * (SMI-5323). The structured update advisor (`SkillDiffPanel`) already holds the
 * installed SKILL.md and the registry-latest SKILL.md; this provider serves
 * those two texts to VS Code's built-in diff editor (`vscode.diff`) under the
 * `skillsmith-diff:` scheme.
 *
 * Content lives in memory only and is overwritten on each invocation (keyed by
 * URI), so the map holds at most two entries per skill the user inspects.
 *
 * @module views/skillDiffContentProvider
 */
import * as vscode from 'vscode'

export class SkillDiffContentProvider implements vscode.TextDocumentContentProvider {
  public static readonly scheme = 'skillsmith-diff'

  private readonly _contents = new Map<string, string>()

  /** VS Code calls this to populate each side of the diff editor. */
  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this._contents.get(uri.toString()) ?? ''
  }

  /**
   * Store `content` under `path` and return the `skillsmith-diff:` URI that
   * serves it. Pass a `path` ending in `.md` so the diff editor highlights the
   * content as Markdown and shows a readable tab label.
   */
  public setContent(path: string, content: string): vscode.Uri {
    const uri = vscode.Uri.parse(`${SkillDiffContentProvider.scheme}:${path}`)
    this._contents.set(uri.toString(), content)
    return uri
  }
}

/**
 * Module singleton — registered once in `extension.ts` and shared by
 * `SkillDiffPanel`, which writes content immediately before opening the diff.
 */
export const skillDiffContentProvider = new SkillDiffContentProvider()
