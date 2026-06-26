/**
 * Shared node/command/PATH resolution for spawning child processes from the
 * VS Code extension host (SMI-5398).
 *
 * VS Code's GUI process (Dock / desktop launcher / shortcut) does NOT inherit
 * the user's login-shell PATH, so node version managers that inject themselves
 * via shell init scripts (.zshrc, .bash_profile) are absent. Every spawn site
 * in the extension must therefore augment PATH before invoking `node`/`npx`/CLI.
 *
 * Generalized from createSkill.helpers.ts: the CLI path already solved the
 * GUI-PATH problem with a static node-manager dir list + a Windows PowerShell
 * probe. This module adds (a) a unix login-shell PATH probe (the static list
 * misses custom prefixes) and (b) a `which`-style lookup that yields an absolute
 * command for diagnostics and the MCP self-heal write.
 *
 * Pure node built-ins only — no `vscode` import — so it is unit-testable without
 * the VS Code test host.
 */
import * as os from 'node:os'
import * as path from 'node:path'
import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import crossSpawn from 'cross-spawn'

/**
 * Resolve the active nvm node version's bin dir by reading the default alias
 * file (`~/.nvm/alias/default`). Returns undefined if nvm is absent or the
 * alias is a symbolic ref like `lts/iron` rather than a concrete version.
 */
export function resolveNvmBin(home: string): string | undefined {
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
 * Static list of node version-manager bin dirs the GUI-launched VS Code process
 * would otherwise miss. Moved verbatim from createSkill.helpers.ts's buildCliEnv
 * (the canonical list — do not invent new entries here).
 */
function nodeManagerDirs(home: string): string[] {
  const nvmBin = resolveNvmBin(home)
  return [
    // fnm — stable alias symlink managed by `fnm default` (Linux default data dir)
    path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    // fnm — macOS default data dir (~/Library/Application Support/fnm)
    path.join(home, 'Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin'),
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
}

/**
 * Single-flight cache for the Windows PATH resolved via PowerShell. Stores the
 * in-flight Promise (not just the value) so concurrent callers spawn PowerShell
 * at most once (P-5). Reset between test runs via `vi.resetModules()`.
 */
let windowsPathPromise: Promise<string> | undefined

/**
 * Spawn `powershell -NoProfile -Command "$env:PATH"` to capture the full
 * Windows PATH (which includes registry-level entries from version managers
 * like Volta, pnpm, and Scoop that VS Code inherits at launch).
 *
 * Falls back to `process.env.PATH` on spawn error or 3 s timeout. Single-flight
 * cached for the VS Code session.
 */
export function resolveWindowsPath(): Promise<string> {
  if (windowsPathPromise !== undefined) return windowsPathPromise
  windowsPathPromise = probeWindowsPath()
  return windowsPathPromise
}

function probeWindowsPath(): Promise<string> {
  const fallback = (): string => process.env['PATH'] ?? ''
  return new Promise<string>((resolve) => {
    const timer = setTimeout(() => {
      // Kill the orphaned PowerShell child so a slow/hung cold-start does not
      // linger past the timeout (mirrors runValidate's timeout handling).
      child.kill()
      resolve(fallback())
    }, 3000)
    const child = crossSpawn('powershell', ['-NoProfile', '-Command', '$env:PATH'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let output = ''
    child.stdout?.on('data', (buf: Buffer) => {
      output += buf.toString('utf8')
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(fallback())
    })
    child.on('exit', () => {
      clearTimeout(timer)
      resolve(output.trim() || fallback())
    })
  })
}

/**
 * Single-flight cache for the unix login-shell PATH. Stores the in-flight
 * Promise so concurrent callers spawn the shell at most once (P-5). Reset
 * between test runs via `vi.resetModules()`.
 */
let loginShellPathPromise: Promise<string> | undefined

/**
 * Spawn the user's login shell once to capture its PATH — the static dir list
 * misses custom prefixes the user added in their shell init. Unix only.
 *
 * Security: `$SHELL` is the EXECUTABLE (never interpolated into a shell string);
 * the command is a fixed literal `printf "%s" "$PATH"` with no user data, run
 * with `stdin` ignored. A 2.5 s timeout `child.kill()`s a hung interactive
 * shell; on error/timeout it resolves to '' (fail-soft — the static
 * node-manager list still applies). Never runs on win32.
 */
export function resolveLoginShellPath(): Promise<string> {
  if (loginShellPathPromise !== undefined) return loginShellPathPromise
  loginShellPathPromise = probeLoginShellPath()
  return loginShellPathPromise
}

function probeLoginShellPath(): Promise<string> {
  if (process.platform === 'win32') return Promise.resolve('')

  return new Promise<string>((resolve) => {
    const shell = process.env['SHELL'] || '/bin/zsh'
    const timer = setTimeout(() => {
      child.kill()
      resolve('')
    }, 2500)
    const child = crossSpawn(shell, ['-lic', 'printf "%s" "$PATH"'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: process.env,
    })
    let output = ''
    child.stdout?.on('data', (buf: Buffer) => {
      output += buf.toString('utf8')
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve('')
    })
    child.on('exit', () => {
      clearTimeout(timer)
      resolve(output.trim())
    })
  })
}

/** Join unique, non-empty segments in first-occurrence order. */
function dedupePath(segments: string[]): string {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const seg of segments) {
    if (seg && !seen.has(seg)) {
      seen.add(seg)
      ordered.push(seg)
    }
  }
  return ordered.join(path.delimiter)
}

/**
 * Build a PATH string augmented with the user's real toolchain dirs.
 *
 * Windows: the PowerShell probe (registry-level PATH already includes Volta,
 * pnpm, Scoop, etc.).
 *
 * Unix: deterministic precedence — login-shell PATH (highest; reflects the
 * user's actual toolchain selection) → existing node-manager dirs → the
 * inherited `process.env.PATH` (lowest). De-duplicated, first occurrence wins.
 */
export async function buildAugmentedPath(): Promise<string> {
  if (process.platform === 'win32') {
    return resolveWindowsPath()
  }

  const home = os.homedir()
  const loginPath = await resolveLoginShellPath()
  const segments: string[] = []
  if (loginPath) segments.push(...loginPath.split(path.delimiter))
  segments.push(...nodeManagerDirs(home).filter((dir) => existsSync(dir)))
  segments.push(...(process.env['PATH'] ?? '').split(path.delimiter))

  return dedupePath(segments)
}

/** `{ ...process.env, PATH: <augmented> }` for spawning node/npx/CLI. */
export async function buildAugmentedEnv(): Promise<NodeJS.ProcessEnv> {
  return { ...process.env, PATH: await buildAugmentedPath() }
}

/**
 * `which`-style lookup: return the first absolute path to `command` found on
 * `pathString` that is executable (X_OK), or undefined. On win32 also tries the
 * `.cmd` / `.exe` suffixes.
 */
export function whichOnPath(command: string, pathString: string): string | undefined {
  const dirs = pathString.split(path.delimiter).filter(Boolean)
  const names =
    process.platform === 'win32' ? [command, `${command}.cmd`, `${command}.exe`] : [command]
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // not here / not executable — keep looking
      }
    }
  }
  return undefined
}
