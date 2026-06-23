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
import { readFileSync } from 'node:fs'
import crossSpawn from 'cross-spawn'

// ---------------------------------------------------------------------------
// CLI resolution
// ---------------------------------------------------------------------------

/**
 * Return the CLI executable to spawn — either the user-configured absolute
 * path (`skillsmith.cliPath`) or the bare `'skillsmith'` command (resolved
 * via the augmented PATH from `buildCliEnv`).
 */
export function resolveCliCommand(): string {
  const configured = vscode.workspace.getConfiguration('skillsmith').get<string>('cliPath', '')
  return configured.trim() || 'skillsmith'
}

/**
 * Resolve the active nvm node version's bin dir by reading the default alias
 * file (`~/.nvm/alias/default`). Returns undefined if nvm is absent or the
 * alias is a symbolic ref like `lts/iron` rather than a concrete version.
 */
function resolveNvmBin(home: string): string | undefined {
  try {
    const raw = readFileSync(path.join(home, '.nvm', 'alias', 'default'), 'utf8').trim()
    // Only handle concrete version strings ("20", "20.19.1", "v20.19.1").
    // Symbolic refs like "lts/iron" or "lts/*" are not resolvable here.
    if (!/^v?\d/.test(raw)) return undefined
    const version = raw.startsWith('v') ? raw : `v${raw}`
    return path.join(home, '.nvm', 'versions', 'node', version, 'bin')
  } catch {
    return undefined
  }
}

/**
 * Session-scoped cache for the Windows PATH resolved via PowerShell.
 * Reset between test runs via `vi.resetModules()`.
 */
let windowsPathCache: string | undefined

/**
 * Spawn `powershell -NoProfile -Command "$env:PATH"` to capture the full
 * Windows PATH (which includes registry-level entries from version managers
 * like Volta, pnpm, and Scoop that VS Code inherits at launch).
 *
 * Falls back to `process.env.PATH` on spawn error or 3 s timeout.
 * Result is cached for the VS Code session.
 */
export async function resolveWindowsPath(): Promise<string> {
  if (windowsPathCache !== undefined) return windowsPathCache

  const resolved = await new Promise<string | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 3000)
    const child = crossSpawn('powershell', ['-NoProfile', '-Command', '$env:PATH'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let output = ''
    child.stdout?.on('data', (buf: Buffer) => {
      output += buf.toString('utf8')
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(undefined)
    })
    child.on('exit', () => {
      clearTimeout(timer)
      resolve(output.trim() || undefined)
    })
  })

  windowsPathCache = resolved ?? process.env['PATH'] ?? ''
  return windowsPathCache
}

/**
 * Build a PATH-augmented environment for spawning the Skillsmith CLI.
 *
 * VS Code's GUI process does not inherit the user's login-shell PATH, so node
 * version managers that inject themselves via shell init scripts are absent.
 *
 * macOS / Linux — static list of stable bin dirs for every major version
 * manager, plus a synchronous nvm alias-file read for the active version.
 *
 * Windows — PowerShell resolves the full registry-level PATH (which already
 * includes Volta, pnpm, Scoop, etc.) and caches it for the session.
 */
export async function buildCliEnv(): Promise<NodeJS.ProcessEnv> {
  if (process.platform === 'win32') {
    return { ...process.env, PATH: await resolveWindowsPath() }
  }

  const home = os.homedir()
  const nvmBin = resolveNvmBin(home)

  const extras = [
    // fnm — stable alias symlink managed by `fnm default`
    path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    // volta
    path.join(home, '.volta', 'bin'),
    // nvm — resolved from ~/.nvm/alias/default
    ...(nvmBin !== undefined ? [nvmBin] : []),
    // asdf — shim directory (version-agnostic)
    path.join(home, '.asdf', 'shims'),
    // mise / rtx — shim directory
    path.join(home, '.local', 'share', 'mise', 'shims'),
    // pnpm global (macOS)
    path.join(home, 'Library', 'pnpm'),
    // pnpm global (Linux)
    path.join(home, '.local', 'share', 'pnpm'),
    // npm custom global prefix (common override)
    path.join(home, '.npm-global', 'bin'),
    // yarn global
    path.join(home, '.yarn', 'bin'),
    // user-local bin (Linux / some macOS setups)
    path.join(home, '.local', 'bin'),
    // snap packages (Linux)
    '/snap/bin',
    // Homebrew on Apple-Silicon Macs
    '/opt/homebrew/bin',
    // Homebrew on Intel Macs / traditional npm global
    '/usr/local/bin',
  ]

  return {
    ...process.env,
    PATH: [...extras, process.env['PATH'] ?? ''].join(path.delimiter),
  }
}

// ---------------------------------------------------------------------------
// Form types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// CLI invocation
// ---------------------------------------------------------------------------

/**
 * Verify the Skillsmith CLI is available (`skillsmith --version` exits 0).
 * On miss, surface an actionable modal (copy install cmd / open docs) and
 * return false. Respects `skillsmith.cliPath` when set.
 */
export async function ensureCliAvailable(): Promise<boolean> {
  const cmd = resolveCliCommand()
  const env = await buildCliEnv()

  const ok = await new Promise<boolean>((resolve) => {
    const child = crossSpawn(cmd, ['--version'], { stdio: 'ignore', env })
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
 * stdout/stderr to the OutputChannel and, when provided, to `onChunk` (e.g.
 * the webview log). Resolves the exit code (1 on spawn error). Respects
 * `skillsmith.cliPath` when set.
 */
export async function runCli(
  args: string[],
  output: vscode.OutputChannel,
  onChunk?: (chunk: string) => void
): Promise<number> {
  const cmd = resolveCliCommand()
  const env = await buildCliEnv()

  return new Promise((resolve) => {
    const child = crossSpawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
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
 * Respects `skillsmith.cliPath` when set.
 * Races a 30-second timeout that kills the child and writes a timeout line.
 */
export async function runValidate(output: vscode.OutputChannel): Promise<void> {
  const cmd = resolveCliCommand()
  const env = await buildCliEnv()

  output.show(true)
  output.appendLine('Running skillsmith validate…')

  const TIMEOUT_MS = 30_000

  await new Promise<void>((resolve) => {
    // Exactly one terminal path (timeout / error / exit) may report + resolve.
    // `kill()` on timeout still fires `exit`, so without this guard the channel
    // would get a spurious "exited with code null" line after the timeout
    // message (governance follow-up).
    let settled = false
    const settle = (): boolean => {
      if (settled) return false
      settled = true
      return true
    }

    const child = crossSpawn(cmd, ['validate'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    })

    const timer = setTimeout(() => {
      if (!settle()) return
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
      if (!settle()) return
      output.appendLine(`[error] ${err.message}`)
      resolve()
    })

    child.on('exit', (code) => {
      clearTimeout(timer)
      if (!settle()) return
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
