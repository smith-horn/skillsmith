/**
 * ADR-139: Global-vs-Workspace Install Scope Resolution, Keyed by (Scope, Client, Name).
 *
 * @see docs/internal/adr/139-global-vs-workspace-install-scope-resolution.md
 * @see SMI-6266, SMI-6274 (Wave 4), SMI-5894 (the (client, name) keying precedent this
 *   extends to scope), SMI-1630 (the repo-local-overrides-global promise this generalizes)
 *
 * Two scopes, both per-client:
 *   - `global`    — `CLIENT_NATIVE_PATHS[client]` (unchanged).
 *   - `workspace` — `<workspace-root>/<client's workspace segments>`, from
 *     {@link CLIENT_WORKSPACE_SEGMENTS} (a sibling table to `CLIENT_NATIVE_PATHS`
 *     in `./paths.ts`).
 *
 * {@link findWorkspaceRoot} is deliberately NOT a reuse of
 * `findMainRepoRoot()` (`packages/doc-retrieval-mcp/src/retrieval-log/project-dir.ts`).
 * That helper requires `.git` to be a real DIRECTORY, specifically so it skips
 * worktrees and returns the *main* repo root — correct for its own purpose
 * (telemetry attribution) and exactly wrong here: `.git` is a *file* in both
 * worktrees and submodules, and this repo's own default development workflow
 * is worktree-based, so requiring a directory would resolve every worktree's
 * workspace installs back to the main checkout. `findWorkspaceRoot()` tests
 * path EXISTENCE (`existsSync`), never `isDirectory()`, for `.git` — the two
 * walks are near-neighbours with deliberately OPPOSITE `.git` predicates; see
 * `findMainRepoRoot()`'s own header note pointing back here.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { loadConfig } from '../config/index.js'
import { CLIENT_NATIVE_PATHS, type ClientId } from './paths.js'

// ---------------------------------------------------------------------------
// Scope model (ADR-139 point 1)
// ---------------------------------------------------------------------------

export type InstallScope = 'global' | 'workspace'

/**
 * Workspace-relative path segments per client, sibling table to
 * `CLIENT_NATIVE_PATHS` (`./paths.ts`). `null` means the client has no
 * documented workspace convention and can only ever resolve to `global`
 * scope — adding one later is a table entry here, not a code change
 * (ADR-139 Consequences / Neutral).
 *
 * Verified 2026-08-29 against `docs/internal/research/smi-5386-opencode-antigravity-skill-dirs.md`
 * and ADR-139's own Decision §1: `antigravity` and `agents` deliberately
 * share the SAME segments (`.agents/skills`) — AntiGravity reads project
 * skills from the same open-standard cross-agent convention `agents`'
 * GLOBAL path (`~/.agents/skills`) already uses, which is exactly the
 * pathological case ADR-139 point 4's termination-before-candidacy fix
 * exists for (see `findWorkspaceRoot` below).
 */
export const CLIENT_WORKSPACE_SEGMENTS: Readonly<Record<ClientId, readonly string[] | null>> = {
  'claude-code': ['.claude', 'skills'],
  cursor: ['.cursor', 'skills'],
  copilot: null,
  windsurf: null,
  agents: ['.agents', 'skills'],
  opencode: ['.opencode', 'skills'],
  hermes: null,
  grok: null,
  antigravity: ['.agents', 'skills'],
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** An explicit `--scope`/`SKILLSMITH_SCOPE` value that isn't `global`/`workspace`. */
export class InvalidScopeValueError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidScopeValueError'
  }
}

/**
 * An explicit workspace-scope request (flag, env var, or config default)
 * that cannot be satisfied — the client has no workspace convention, or no
 * workspace root exists above `cwd`. ADR-139 point 2: this is a HARD ERROR,
 * never a silent downgrade to global.
 */
export class UnsatisfiableWorkspaceScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsatisfiableWorkspaceScopeError'
  }
}

/**
 * Parse a raw `--scope`/`SKILLSMITH_SCOPE` string. Returns `undefined` for
 * an absent/empty value (meaning "no opinion at this rank" — the caller
 * falls through to the next precedence rank), and throws for anything
 * present but not `global`/`workspace`.
 */
export function parseInstallScope(raw: string | undefined | null): InstallScope | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (raw === 'global' || raw === 'workspace') return raw
  throw new InvalidScopeValueError(`Invalid scope '${raw}'. Valid values: global | workspace.`)
}

function isInstallScope(value: unknown): value is InstallScope {
  return value === 'global' || value === 'workspace'
}

/**
 * Per-client persisted default scope from `~/.skillsmith/config.json`
 * (`defaultScope.<client>`, e.g. `defaultScope.antigravity = "workspace"`).
 * Fails soft (`undefined`) on any read/parse error — a corrupt config file
 * must never crash scope resolution, only fall through to auto-detection.
 */
export function getDefaultScopeForClient(client: ClientId): InstallScope | undefined {
  try {
    const config = loadConfig()
    const raw = config.defaultScope?.[client]
    return isInstallScope(raw) ? raw : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Ancestor-search boundary (ADR-139 points 3 + 4)
// ---------------------------------------------------------------------------

/**
 * Loop guard against symlink cycles / pathological mounts — matches the cap
 * `findMainRepoRoot()` (`project-dir.ts`) already uses, so the two walks
 * agree on their one shared parameter rather than picking independent
 * numbers. NOT a configurable max depth (ADR-139 point 4): a configurable
 * cap makes the same command behave differently on two machines and is
 * effectively undebuggable when it silently stops one level short of a
 * marker.
 */
const MAX_ANCESTOR_WALK_DEPTH = 64

export interface WorkspaceRootResult {
  /** Absolute path to the resolved workspace root. */
  root: string
  /** Which tier matched: the client's own marker directory, or a `.git` VCS boundary. */
  via: 'marker' | 'vcs'
}

export interface FindWorkspaceRootOptions {
  /**
   * Override for `os.homedir()`'s return value. Defaults to the real
   * `os.homedir()`. This is a test seam only (mirrors `agent-home-relocate.ts`'s
   * `homeDir` override precedent elsewhere in this package) — production
   * callers never pass it, and the walk otherwise ALWAYS sources home via
   * `os.homedir()`, never manual `~` expansion (ADR-139 point 4,
   * Windows-safety).
   */
  homeDirOverride?: string
}

/**
 * Resolve the nearest workspace root for `client` above (and including)
 * `cwd`, or `null` when `cwd` is outside any workspace for that client.
 *
 * Implements ADR-139 point 4's algorithm EXACTLY, including its load-bearing
 * ordering: at every directory in the walk, **termination is evaluated
 * before candidacy**. An earlier draft of ADR-139 checked candidacy first,
 * which meant a walk reaching `$HOME` would test `$HOME/<segments>` for a
 * marker BEFORE applying "stop, no match" — and for the `agents` client,
 * `$HOME/.agents/skills` IS the GLOBAL path, so that ordering collapsed
 * global and workspace scope for that client. Termination-before-candidacy
 * is the fix; do not reorder these two phases.
 *
 * `$HOME` is an EXCLUSIVE bound: the walk stops AT it without ever
 * considering it as a candidate. `.git` existence is checked via
 * `existsSync` (file OR directory) — see the module header for why this is
 * the opposite predicate from `findMainRepoRoot()`.
 */
export function findWorkspaceRoot(
  cwd: string,
  client: ClientId,
  options: FindWorkspaceRootOptions = {}
): WorkspaceRootResult | null {
  const segments = CLIENT_WORKSPACE_SEGMENTS[client]
  if (!segments) return null

  const home = options.homeDirOverride ?? homedir()
  let current = resolve(cwd)
  let vcsFallback: string | null = null

  for (let depth = 0; depth < MAX_ANCESTOR_WALK_DEPTH; depth += 1) {
    // ---- PHASE 1: TERMINATION (always first — see doc comment above) ----
    if (current === home) break

    // ---- PHASE 2: CANDIDACY (only for directories that survived phase 1) ----
    if (existsSync(join(current, ...segments))) {
      return { root: current, via: 'marker' }
    }
    if (existsSync(join(current, '.git'))) {
      vcsFallback = current
      break // the first VCS boundary also terminates the marker search
    }

    const parent = dirname(current)
    if (parent === current) break // filesystem root
    current = parent
  }

  return vcsFallback ? { root: vcsFallback, via: 'vcs' } : null
}

/** `<workspaceRoot>/.skillsmith/manifest.json` — self-scoping, self-cleaning (ADR-139 point 1). */
export function resolveWorkspaceManifestPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.skillsmith', 'manifest.json')
}

function defaultGlobalManifestPath(): string {
  return join(homedir(), '.skillsmith', 'manifest.json')
}

// ---------------------------------------------------------------------------
// Precedence resolution (ADR-139 point 2)
// ---------------------------------------------------------------------------

export interface ResolveScopeParams {
  client: ClientId
  /** Defaults to `process.cwd()`. */
  cwd?: string
  /**
   * Rank 1 — explicit `--scope` flag value, if the caller parsed one. Typed
   * `| undefined` explicitly (not just optional `?:`) so callers can pass
   * `parseInstallScope(raw)`'s own `InstallScope | undefined` return value
   * straight through under this repo's `exactOptionalPropertyTypes`.
   */
  explicitScope?: InstallScope | undefined
  /**
   * Rank 2 — raw `SKILLSMITH_SCOPE` value. Defaults to
   * `process.env.SKILLSMITH_SCOPE` when omitted (mirrors `resolveClientPath()`'s
   * own override convention in `./paths.ts`). Pass `''` explicitly to force
   * "no env value" in tests without touching real process env.
   */
  envScope?: string | undefined
  /**
   * Rank 3 — per-client persisted default. Three states, distinguished by
   * value (not by whether the key is present, since an optional TS property
   * can't tell "present as undefined" from "absent" at runtime):
   *   - omitted / `undefined` — read the real default via
   *     `getDefaultScopeForClient(client)` (`~/.skillsmith/config.json`).
   *   - `null` — explicitly "no config default configured", WITHOUT
   *     touching the real config file. The test seam for isolating ranks
   *     4-5 from a developer's real `~/.skillsmith/config.json`.
   *   - an actual `InstallScope` — used directly, also without touching disk.
   */
  configDefaultScope?: InstallScope | null
  /** Test seam — see {@link FindWorkspaceRootOptions.homeDirOverride}. */
  homeDirOverride?: string
}

export interface ResolvedSkillScope {
  scope: InstallScope
  /** Absolute path to the resolved skills directory for this scope. */
  dir: string
  /** Present only when `scope === 'workspace'`. */
  workspaceRoot?: string
  /** Present only when `scope === 'workspace'`. */
  via?: 'marker' | 'vcs'
  /**
   * `true` only when THIS call created the workspace directory — always
   * `false` for `global` and for an already-existing workspace marker.
   * Callers must print the absolute path they wrote when this is `true`
   * (ADR-139 point 5).
   */
  created: boolean
}

/**
 * Resolve the install scope for one `(client, cwd)` pair per ADR-139 point 2's
 * five-rank precedence:
 *
 *   1. Explicit `--scope` flag
 *   2. `SKILLSMITH_SCOPE` env var
 *   3. Per-client `~/.skillsmith/config.json` default
 *   4. Auto-detection of an EXISTING workspace marker (read-only, never creates)
 *   5. Global (default)
 *
 * Ranks 1-3 all represent an explicit request for a scope: requesting
 * `workspace` at any of these ranks resolves via {@link findWorkspaceRoot}
 * and, when the walk found a VCS boundary but no marker yet, CREATES the
 * marker directory (`mkdirSync(..., { recursive: true })`) — this is the
 * ONLY path that ever creates a workspace directory (ADR-139 point 5).
 * Requesting `workspace` for a client with no workspace convention, or from
 * outside any workspace entirely (no marker AND no ancestor `.git`), throws
 * {@link UnsatisfiableWorkspaceScopeError} — never a silent downgrade.
 *
 * Rank 4 (auto-detection) is deliberately narrower: it only matches an
 * EXISTING marker directory (`findWorkspaceRoot(...).via === 'marker'`) — a
 * bare VCS boundary with no marker does NOT count as an auto-detected hit,
 * and this rank never creates anything. Falling through this rank with no
 * match resolves to rank 5 (global) silently and successfully — the
 * ordinary case, not a warning-worthy one (ADR-139 point 6).
 */
export function resolveSkillScope(params: ResolveScopeParams): ResolvedSkillScope {
  const { client } = params
  const cwd = params.cwd ?? process.cwd()
  const segments = CLIENT_WORKSPACE_SEGMENTS[client]
  const findOpts: FindWorkspaceRootOptions =
    params.homeDirOverride !== undefined ? { homeDirOverride: params.homeDirOverride } : {}

  const fromFlag = params.explicitScope
  const envRaw = params.envScope !== undefined ? params.envScope : process.env['SKILLSMITH_SCOPE']
  const fromEnv = fromFlag === undefined ? parseInstallScope(envRaw) : undefined
  const fromConfig =
    fromFlag === undefined && fromEnv === undefined
      ? params.configDefaultScope === undefined
        ? getDefaultScopeForClient(client)
        : (params.configDefaultScope ?? undefined)
      : undefined

  const requested = fromFlag ?? fromEnv ?? fromConfig
  const requestSource =
    fromFlag !== undefined
      ? 'the --scope flag'
      : fromEnv !== undefined
        ? 'the SKILLSMITH_SCOPE environment variable'
        : fromConfig !== undefined
          ? `the ~/.skillsmith/config.json default for '${client}'`
          : undefined

  if (requested === 'global') {
    return { scope: 'global', dir: CLIENT_NATIVE_PATHS[client], created: false }
  }

  if (requested === 'workspace') {
    if (!segments) {
      throw new UnsatisfiableWorkspaceScopeError(
        `Workspace scope was requested (via ${requestSource}) but client '${client}' has no ` +
          `documented workspace convention — it can only be installed at global scope.`
      )
    }
    const found = findWorkspaceRoot(cwd, client, findOpts)
    if (!found) {
      throw new UnsatisfiableWorkspaceScopeError(
        `Workspace scope was requested (via ${requestSource}) but no workspace root was found ` +
          `at or above '${cwd}' — no existing ${segments.join('/')} directory and no ancestor ` +
          `.git. Run this from inside a repository, or drop --scope to install globally.`
      )
    }
    const dir = join(found.root, ...segments)
    if (found.via === 'marker') {
      return { scope: 'workspace', dir, workspaceRoot: found.root, via: 'marker', created: false }
    }
    // via === 'vcs': no marker exists on disk yet. An explicit workspace
    // request (any of ranks 1-3) is the ONLY thing permitted to create one.
    mkdirSync(dir, { recursive: true })
    return { scope: 'workspace', dir, workspaceRoot: found.root, via: 'vcs', created: true }
  }

  // Rank 4: auto-detection. Only an EXISTING marker counts — never the bare
  // VCS fallback, and this rank never creates anything.
  if (segments) {
    const found = findWorkspaceRoot(cwd, client, findOpts)
    if (found && found.via === 'marker') {
      return {
        scope: 'workspace',
        dir: join(found.root, ...segments),
        workspaceRoot: found.root,
        via: 'marker',
        created: false,
      }
    }
  }

  // Rank 5: global, silently and successfully.
  return { scope: 'global', dir: CLIENT_NATIVE_PATHS[client], created: false }
}

export interface ScopedInstallTarget extends ResolvedSkillScope {
  /**
   * The manifest to record this install in: the workspace-local
   * `<workspaceRoot>/.skillsmith/manifest.json` when `scope === 'workspace'`,
   * else the global `~/.skillsmith/manifest.json` (or `globalManifestPath`
   * when the caller passed one — CLI/MCP callers with their own resolved
   * default should pass their own constant here so it stays byte-identical
   * to `DEFAULT_MANIFEST_PATH` elsewhere, per ADR-139 point 1's requirement
   * that the global manifest and `manifestKeyFor()`'s key shape are left
   * completely untouched by this change).
   */
  manifestPath: string
}

/**
 * Convenience wrapper over {@link resolveSkillScope} that also resolves the
 * manifest path to record the install in — the one call CLI/MCP commands
 * need for `install`/`list`/`update`/`remove` (ADR-139 point 7: "One shared
 * resolver, in core, for every command").
 */
export function resolveScopedSkillsDir(
  params: ResolveScopeParams & { globalManifestPath?: string }
): ScopedInstallTarget {
  const resolved = resolveSkillScope(params)
  const manifestPath =
    resolved.scope === 'workspace' && resolved.workspaceRoot
      ? resolveWorkspaceManifestPath(resolved.workspaceRoot)
      : (params.globalManifestPath ?? defaultGlobalManifestPath())
  return { ...resolved, manifestPath }
}
