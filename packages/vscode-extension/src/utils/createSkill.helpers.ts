/**
 * Shared helpers for the Create Skill flow (SMI-5313 / GH #1454).
 *
 * Extracted from createSkillCommand.ts so both the command (createSkillCommand.ts)
 * and the webview panel (views/CreateSkillPanel.ts) can use them. Lives in utils/
 * — NOT commands/ — so the import graph stays acyclic: commands → views → utils,
 * commands → utils, views → utils (utils imports nothing from views/commands).
 *
 * The CLI is the source of truth for templates; this module never scaffolds inline.
 */
import * as vscode from 'vscode'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import crossSpawn from 'cross-spawn'

/** The four fields the Create Skill form collects. */
export interface CreateFormFields {
  author: string
  name: string
  description: string
  type: 'basic' | 'intermediate' | 'advanced'
}

/** Absolute path where `skillsmith create <name>` writes the skill. */
export function targetDirFor(name: string): string {
  return path.join(os.homedir(), '.claude', 'skills', name)
}

/** Build the exact `skillsmith create …` CLI args (non-interactive). */
export function buildCreateArgs(fields: CreateFormFields): string[] {
  return [
    'create',
    fields.name,
    '-a',
    fields.author,
    '-d',
    fields.description,
    '--type',
    fields.type,
    '-y',
  ]
}

/**
 * Verify the `skillsmith` CLI is on $PATH (`skillsmith --version` exits 0).
 * On miss, surface an actionable modal (copy install cmd / open docs) and return false.
 */
export async function ensureCliAvailable(): Promise<boolean> {
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

/**
 * Spawn `skillsmith <args>` (array args — no shell, injection-safe). Streams
 * stdout/stderr to the OutputChannel and, when provided, to `onChunk` (e.g. the
 * webview log). Resolves the exit code (1 on spawn error).
 */
export function runCli(
  args: string[],
  output: vscode.OutputChannel,
  onChunk?: (chunk: string) => void
): Promise<number> {
  return new Promise((resolve) => {
    const child = crossSpawn('skillsmith', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const emit = (buf: Buffer): void => {
      const text = buf.toString('utf8')
      output.append(text)
      onChunk?.(text)
    }
    child.stdout?.on('data', emit)
    child.stderr?.on('data', emit)
    child.on('error', (err) => {
      const msg = `\n[error] ${err.message}`
      output.appendLine(msg)
      onChunk?.(msg)
      resolve(1)
    })
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

/** True if the path exists. */
export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * Run `skillsmith validate` against the current skill (SMI-5346).
 *
 * Injection-safe: args are passed as an array to cross-spawn, never via shell.
 * The command is intended to be registered as 'skillsmith.runValidate' and
 * wrapped with withTelemetry by the queen (extension.ts).
 *
 * Races a 30-second timeout that kills the child and writes a timeout line to
 * the output channel. On exit-0 writes a success line; on non-zero writes a
 * failure line + hint.
 */
export async function runValidate(output: vscode.OutputChannel): Promise<void> {
  output.show(true)
  output.appendLine('Running skillsmith validate…')

  const TIMEOUT_MS = 30_000

  await new Promise<void>((resolve) => {
    const child = crossSpawn('skillsmith', ['validate'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const timer = setTimeout(() => {
      child.kill()
      output.appendLine('[error] skillsmith validate timed out after 30 s.')
      resolve()
    }, TIMEOUT_MS)

    const emit = (buf: Buffer): void => {
      output.append(buf.toString('utf8'))
    }
    child.stdout?.on('data', emit)
    child.stderr?.on('data', emit)

    child.on('error', (err) => {
      clearTimeout(timer)
      output.appendLine(`[error] ${err.message}`)
      resolve()
    })

    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        output.appendLine('skillsmith validate completed successfully.')
      } else {
        output.appendLine(
          `skillsmith validate exited with code ${String(code)}. Check the output above for details.`
        )
      }
      resolve()
    })
  })
}
