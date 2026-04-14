import * as vscode from 'vscode'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import crossSpawn from 'cross-spawn'
import { SkillTreeDataProvider } from '../sidebar/SkillTreeDataProvider.js'
import { track } from '../services/Telemetry.js'
import { validateSkillName } from '../utils/skillNameValidation.js'

interface WizardState {
  author: string
  name: string
  description: string
  type: 'basic' | 'intermediate' | 'advanced'
}

const SKILL_TYPES: ReadonlyArray<{ label: WizardState['type']; description: string }> = [
  { label: 'basic', description: 'Minimal skill scaffold (SKILL.md + README)' },
  { label: 'intermediate', description: 'Adds CHANGELOG and examples' },
  { label: 'advanced', description: 'Full layout with scripts/ and tests/' },
]

/**
 * Register `skillsmith.createSkill` (SMI-4196, closes GH #484).
 *
 * Multi-step QuickInput wizard that delegates scaffolding to the
 * `@skillsmith/cli`. No inline scaffolding: the CLI is the source of truth
 * for templates, and reimplementing them would drift and produce skills
 * that fail `validate`/`publish`. If the CLI is not on $PATH, surface an
 * actionable error with install command and docs link.
 *
 * Output is streamed to a dedicated OutputChannel so completion status is
 * observable (exit code captured) and success can open the new SKILL.md.
 * OutputChannel preferred over Terminal here because the `-y` non-interactive
 * path has no interactive I/O; Terminal would hide exit-status handling.
 */
export function registerCreateSkillCommand(
  context: vscode.ExtensionContext,
  treeProvider: SkillTreeDataProvider
): void {
  const output = vscode.window.createOutputChannel('Skillsmith CLI')
  context.subscriptions.push(output)

  const disposable = vscode.commands.registerCommand('skillsmith.createSkill', async () => {
    track('vscode_create_start')
    if (!(await ensureCliAvailable())) {
      track('vscode_create_failed', { reason: 'cli_missing' })
      return
    }

    const state = await runWizard()
    if (!state) {
      track('vscode_create_cancelled', { stage: 'wizard' })
      return
    }

    const targetDir = path.join(os.homedir(), '.claude', 'skills', state.name)
    if (await exists(targetDir)) {
      const overwrite = await vscode.window.showWarningMessage(
        `A skill already exists at ${targetDir}.`,
        { modal: true, detail: 'Re-running create will overwrite the existing SKILL.md.' },
        'Overwrite'
      )
      if (overwrite !== 'Overwrite') {
        track('vscode_create_cancelled', { stage: 'overwrite' })
        return
      }
    }

    const args = [
      'create',
      state.name,
      '-a',
      state.author,
      '-d',
      state.description,
      '--type',
      state.type,
      '-y',
    ]

    output.show(true)
    output.appendLine(`$ skillsmith ${args.join(' ')}`)

    const exitCode = await runCli(args, output)
    if (exitCode !== 0) {
      track('vscode_create_failed', { reason: 'cli_nonzero_exit', exit_code: exitCode })
      void vscode.window.showErrorMessage(
        `Create skill failed (exit ${exitCode}). See the "Skillsmith CLI" output channel.`
      )
      return
    }

    track('vscode_create_complete', { type: state.type })
    await treeProvider.refreshAndWait()
    const skillMd = path.join(targetDir, 'SKILL.md')
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(skillMd))
      await vscode.window.showTextDocument(doc)
    } catch {
      void vscode.window.showWarningMessage(
        `Skill "${state.name}" created, but couldn't open SKILL.md automatically. Open it from the Skills panel.`
      )
    }
    void vscode.window.showInformationMessage(`Created skill "${state.name}".`)
  })
  context.subscriptions.push(disposable)
}

async function ensureCliAvailable(): Promise<boolean> {
  const ok = await new Promise<boolean>((resolve) => {
    const child = crossSpawn('skillsmith', ['--version'], { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })
  if (ok) return true

  const INSTALL_CMD = 'npm install -g @skillsmith/cli'
  const action = await vscode.window.showErrorMessage(
    'Skillsmith CLI is not installed.',
    { modal: true, detail: `Install with:\n${INSTALL_CMD}\n\nThen retry Create Skill.` },
    'Copy install command',
    'Open docs'
  )
  if (action === 'Copy install command') {
    await vscode.env.clipboard.writeText(INSTALL_CMD)
    void vscode.window.showInformationMessage('Install command copied to clipboard.')
  } else if (action === 'Open docs') {
    await vscode.env.openExternal(vscode.Uri.parse('https://skillsmith.app/docs'))
  }
  return false
}

async function runWizard(): Promise<WizardState | undefined> {
  const author = await vscode.window.showInputBox({
    title: 'Create Skill (1/4): Author',
    prompt: 'Author GitHub username',
    placeHolder: 'e.g. your-github-handle',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Author is required'),
  })
  if (author === undefined) return undefined

  const name = await vscode.window.showInputBox({
    title: 'Create Skill (2/4): Name',
    prompt: 'Skill name — lowercase letters, digits, hyphens',
    placeHolder: 'e.g. my-new-skill',
    ignoreFocusOut: true,
    validateInput: (v) => {
      const result = validateSkillName(v)
      return result === true ? undefined : result
    },
  })
  if (name === undefined) return undefined

  const description = await vscode.window.showInputBox({
    title: 'Create Skill (3/4): Description',
    prompt: 'Short description of what the skill does',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Description is required'),
  })
  if (description === undefined) return undefined

  const pick = await vscode.window.showQuickPick(SKILL_TYPES, {
    title: 'Create Skill (4/4): Type',
    placeHolder: 'Select a skill type',
    ignoreFocusOut: true,
  })
  if (!pick) return undefined

  return {
    author: author.trim(),
    name: name.trim(),
    description: description.trim(),
    type: pick.label,
  }
}

function runCli(args: string[], output: vscode.OutputChannel): Promise<number> {
  return new Promise((resolve) => {
    const child = crossSpawn('skillsmith', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout?.on('data', (buf: Buffer) => output.append(buf.toString('utf8')))
    child.stderr?.on('data', (buf: Buffer) => output.append(buf.toString('utf8')))
    child.on('error', (err) => {
      output.appendLine(`\n[error] ${err.message}`)
      resolve(1)
    })
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
