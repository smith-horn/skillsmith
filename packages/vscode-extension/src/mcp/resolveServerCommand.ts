/**
 * Self-healing resolution of the MCP server spawn command (SMI-5398).
 *
 * The MCP spawn historically passed a bare `npx` with no env and no PATH
 * resolution, so a GUI-launched VS Code (which lacks the login-shell PATH) hit
 * `spawn npx ENOENT`. This resolver augments the env (nodePath.ts), resolves the
 * configured command to an absolute path, and — when it cannot — computes a
 * self-heal suggestion the failure UX can offer to write to settings.
 */
import * as os from 'node:os'
import * as path from 'node:path'
import { accessSync, constants, realpathSync } from 'node:fs'
import { buildAugmentedEnv, whichOnPath } from '../utils/nodePath.js'
import { validateSpawnArgs } from '../utils/security.js'
import { logMcp } from './mcpLog.js'

/** A settings write the failure UX can apply to recover from an unresolved command. */
export interface SelfHealSuggestion {
  serverCommand: string
  serverArgs: string[]
  label: string
}

/** Outcome of resolving the configured MCP server command against the augmented PATH. */
export type ResolvedServerCommand =
  | {
      kind: 'absolute'
      command: string
      args: string[]
      env: NodeJS.ProcessEnv
      source: 'configured-absolute'
      pathDirsAdded: string[]
    }
  | {
      kind: 'resolved'
      command: string
      args: string[]
      env: NodeJS.ProcessEnv
      source: string
      pathDirsAdded: string[]
    }
  | {
      kind: 'unresolved'
      command: string
      args: string[]
      searchedDirs: string[]
      selfHeal?: SelfHealSuggestion | undefined
    }

/**
 * Thrown by the spawn path when the configured command cannot be resolved on the
 * augmented PATH. Carries the self-heal suggestion (if any) for the failure UX.
 */
export class ServerCommandUnresolvedError extends Error {
  readonly selfHeal: SelfHealSuggestion | undefined

  constructor(command: string, selfHeal: SelfHealSuggestion | undefined) {
    super(`Could not resolve MCP server command "${command}" on PATH.`)
    this.name = 'ServerCommandUnresolvedError'
    this.selfHeal = selfHeal
  }
}

/** Dirs present on the augmented PATH that were not on the inherited process.env.PATH. */
function computeAddedDirs(augmentedPath: string): string[] {
  const original = new Set((process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean))
  return augmentedPath.split(path.delimiter).filter((dir) => dir && !original.has(dir))
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the configured MCP server command:
 *   1. Augment the env (login-shell + node-manager PATH).
 *   2. An absolute, executable command passes through unprobed (env still attached).
 *   3. Otherwise `which`-resolve it on the augmented PATH.
 *   4. Otherwise return `unresolved` with a self-heal suggestion.
 */
export async function resolveServerCommand(
  command: string,
  args: string[]
): Promise<ResolvedServerCommand> {
  const env = await buildAugmentedEnv()
  const augmentedPath = env['PATH'] ?? ''
  const pathDirsAdded = computeAddedDirs(augmentedPath)

  // Back-compat fast path: an already-pinned absolute, executable command needs
  // no probe — but still attach `env` so an absolute `npx`'s shebang resolves.
  if (path.isAbsolute(command) && isExecutable(command)) {
    logMcp(`resolved configured-absolute command: ${command}`)
    return { kind: 'absolute', command, args, env, source: 'configured-absolute', pathDirsAdded }
  }

  const hit = whichOnPath(command, augmentedPath)
  if (hit) {
    logMcp(`resolved "${command}" -> ${hit}`)
    return { kind: 'resolved', command: hit, args, env, source: path.dirname(hit), pathDirsAdded }
  }

  const searchedDirs = augmentedPath.split(path.delimiter).filter(Boolean)
  const selfHeal = computeSelfHeal(augmentedPath)
  logMcp(
    `unresolved "${command}" (searched ${String(searchedDirs.length)} dirs); ` +
      `self-heal: ${selfHeal ? selfHeal.label : 'none'}`
  )
  return { kind: 'unresolved', command, args, searchedDirs, selfHeal }
}

/**
 * Compute a self-heal suggestion when the configured command is unresolved but a
 * real toolchain is discoverable on the augmented PATH. Preferred form pins a
 * stable node + the resolved global mcp-server entry; fallback pins npx. Both
 * forms must pass validateSpawnArgs or the suggestion is suppressed.
 */
function computeSelfHeal(augmentedPath: string): SelfHealSuggestion | undefined {
  const nodeHit = whichOnPath('node', augmentedPath)
  const mcpBinHit = whichOnPath('skillsmith-mcp', augmentedPath)

  // Preferred: stable node + realpath'd global mcp-server entry (dist/src/index.js).
  if (nodeHit && mcpBinHit) {
    let entry: string
    try {
      entry = realpathSync(mcpBinHit)
    } catch {
      entry = mcpBinHit
    }
    const preferred: SelfHealSuggestion = {
      serverCommand: stableNodePath(nodeHit),
      serverArgs: [entry],
      label: 'Use detected Node',
    }
    if (isSafeSuggestion(preferred)) return preferred
  }

  // Fallback: absolute npx (works because resolveServerCommand injects the
  // augmented env, so npx's `#!/usr/bin/env node` shebang resolves).
  const npxHit = whichOnPath('npx', augmentedPath)
  if (npxHit) {
    const fallback: SelfHealSuggestion = {
      serverCommand: npxHit,
      serverArgs: ['@skillsmith/mcp-server'],
      label: 'Use detected npx',
    }
    if (isSafeSuggestion(fallback)) return fallback
  }

  return undefined
}

/**
 * Stable-node rule (F3): `whichOnPath('node', …)` can return a version-pinned
 * path that breaks on the next node upgrade. Prefer a version-manager-stable
 * form when one exists; only fall back to the versioned realpath as a last
 * resort (and log why so the OutputChannel records the choice).
 */
function stableNodePath(nodeHit: string): string {
  const home = os.homedir()

  // nvm has NO stable node shim (unlike asdf/volta/mise): ~/.nvm/alias/default is
  // a version *file*, not a symlink, so no fixed path tracks the user's default.
  // nvm hits therefore fall through to the versioned realpath below; if the user
  // later upgrades node that path 404s and the self-heal re-offers automatically
  // (resolveServerCommand returns `unresolved` again). (SMI-5398 governance F-1.)

  // asdf — the shim is already version-agnostic; write as-is (no realpath).
  if (nodeHit === path.join(home, '.asdf', 'shims', 'node')) return nodeHit

  // 3. mise — same as asdf.
  if (nodeHit === path.join(home, '.local', 'share', 'mise', 'shims', 'node')) return nodeHit

  // 4. volta — ~/.volta/bin/node is a stable shim; write as-is.
  if (nodeHit === path.join(home, '.volta', 'bin', 'node')) return nodeHit

  // 5. Last resort — the versioned realpath. Warn that it may go stale.
  let resolved: string
  try {
    resolved = realpathSync(nodeHit)
  } catch {
    resolved = nodeHit
  }
  logMcp(`self-heal pinned a versioned node path (${resolved}); it may go stale on a node upgrade`)
  return resolved
}

/** Gate self-heal values through the spawn-arg allowlist before they are offered. */
function isSafeSuggestion(s: SelfHealSuggestion): boolean {
  try {
    validateSpawnArgs(s.serverCommand, s.serverArgs)
    return true
  } catch {
    logMcp(`self-heal suppressed: "${s.serverCommand}" failed the spawn-arg safety gate`)
    return false
  }
}
