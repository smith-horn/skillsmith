#!/usr/bin/env node
/**
 * MCP bare-command guard (SMI-5642).
 *
 * Warns when an MCP server config uses a bare global-bin `command` (no
 * path, not npx/docker/interpreter-fronted) — the exact pattern that broke
 * the `aqe` MCP server (ENOENT) after an nvm-managed Node global-bin
 * install fell out of the active Node version.
 *
 * Scans this repo's `.mcp.json` and `~/.claude.json`'s skillsmith-project-
 * scoped `mcpServers` block only — never that file's other, unrelated
 * project entries or top-level global servers.
 *
 * @see docs/internal/implementation/mcp-bare-command-guard-hook.md
 * @see docs/internal/implementation/fix-aqe-mcp-enoent.md
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Commands that resolve on demand (npx/docker) or are the runtime/interpreter
// itself are exempt from the nvm-global-bin-isolation failure class this
// guard targets. Non-Node interpreters/launchers are exempt too — their
// resolution is NOT gated by nvm's per-Node-version global-install isolation
// (the actual mechanism that broke `aqe`), so flagging them with an
// "install under npx" remediation would be actively wrong.
const SAFE_COMMANDS = new Set([
  'npx',
  'docker',
  'node',
  'python3',
  'python',
  'uv',
  'uvx',
  'bash',
  'sh',
  'zsh',
  'ruby',
  'go',
])

// Windows absolute paths (`C:\...`) and UNC paths (`\\server\...`) contain
// no `/` but are still path-qualified.
const WINDOWS_PATH_RE = /^[A-Za-z]:[\\/]|^\\\\/

/**
 * A command is "bare" (at risk of the nvm-global-bin-isolation failure
 * class) if it's not a known-safe launcher/interpreter AND contains no
 * path separator (POSIX `/` or Windows `\`/drive-letter) — i.e. it's a
 * plain global-bin name resolved via the inherited $PATH at spawn time.
 */
export function isBareCommand(command) {
  if (typeof command !== 'string' || command.length === 0) return false
  if (SAFE_COMMANDS.has(command)) return false
  if (WINDOWS_PATH_RE.test(command)) return false
  return !command.includes('/') && !command.includes('\\')
}

export function findBareCommandServers(mcpServers, sourceLabel) {
  const findings = []
  for (const [name, entry] of Object.entries(mcpServers || {})) {
    if (!entry || entry.type === 'http' || entry.url) continue // hosted endpoint, no command
    if (isBareCommand(entry.command)) {
      findings.push({
        source: sourceLabel,
        server: name,
        command: entry.command,
        message: `uses a bare command "${entry.command}" with no path — this is resolved via the inherited $PATH at spawn time, which breaks (ENOENT) if the resolving environment ever changes (e.g. an nvm-managed Node global-bin install falling out of the active Node version, as happened with "aqe").`,
        remediation: `Use an absolute path, or if this command is provided by an npm package, wrap in npx (e.g. "npx <package-name>@<version> ..." — note the package name may differ from the bin name "${entry.command}" shown above; verify before using).`,
      })
    }
  }
  return findings
}

export function auditMcpConfigs({ repoRoot, homeDir = homedir() }) {
  const findings = []

  const mcpJsonPath = join(repoRoot, '.mcp.json')
  if (existsSync(mcpJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'))
      findings.push(...findBareCommandServers(parsed.mcpServers, '.mcp.json'))
    } catch {
      /* malformed JSON — not this guard's job to report; fail soft */
    }
  }

  const claudeJsonPath = join(homeDir, '.claude.json')
  if (existsSync(claudeJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'))
      // Deliberately silent on parse failure — unlike a naive port of
      // check-supply-chain-pins.mjs's checkMcpJson(), which includes
      // err.message in its finding. This file is known to contain
      // plaintext secrets adjacent to MCP server entries. Node's
      // JSON.parse SyntaxError messages embed a raw snippet of the
      // offending source text, so surfacing err.message here risks
      // leaking secret-adjacent content into a terminal-visible warning.
      // Do NOT "harmonize" this with checkMcpJson()'s pattern without
      // re-checking this constraint.
      if (parsed?.projects && typeof parsed.projects !== 'object') {
        console.error(
          '[mcp-command-guard] ~/.claude.json has an unexpected shape (projects is not an object) — guard may be silently blind; skipping this source.'
        )
      }
      const projectServers = parsed?.projects?.[repoRoot]?.mcpServers
      findings.push(...findBareCommandServers(projectServers, '~/.claude.json (project scope)'))
    } catch {
      /* malformed JSON or unreadable — fail soft, deliberately silent (see comment above) */
    }
  }

  return findings
}

// ---------------------------------------------------------------------------
// Per-finding debounce (SMI-5642 plan review — prevents a deliberately
// accepted bare command, e.g. `aqe`, from re-warning on every startup).
// Mirrors scripts/lib/session-start-audit-helper.ts's debounce pattern.
// ---------------------------------------------------------------------------
const DEFAULT_DEBOUNCE_HOURS = 24

function readDebounceHours() {
  const raw = process.env['SKILLSMITH_MCP_COMMAND_GUARD_DEBOUNCE_HOURS']
  if (!raw) return DEFAULT_DEBOUNCE_HOURS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DEBOUNCE_HOURS
  return parsed
}

// Keyed by content hash of source+server+command (not just server name) so
// editing a flagged entry's command re-triggers immediately even within
// the debounce window, rather than silently inheriting the old timestamp.
function findingKey(f) {
  return createHash('sha256').update(`${f.source} ${f.server} ${f.command}`).digest('hex')
}

function readState(statePath) {
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'))
  } catch {
    return {}
  }
}

function writeState(statePath, state) {
  try {
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
    const tmp = statePath + '.tmp'
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 })
    renameSync(tmp, statePath)
  } catch {
    /* best-effort — state loss just means the next run re-warns once */
  }
}

/**
 * Returns only the findings that should actually be printed this run, and
 * persists a fresh state file. A finding that's no longer present (fixed,
 * or entry removed) naturally drops out of the next state write — no
 * manual cleanup needed.
 */
export function filterDebounced(findings, statePath, hours = readDebounceHours()) {
  const state = readState(statePath)
  const now = Date.now()
  const surfaced = []
  const nextState = {}
  for (const f of findings) {
    const key = findingKey(f)
    const lastWarnedAt = state[key]
    const lastMs = lastWarnedAt ? Date.parse(lastWarnedAt) : NaN
    const debounced = Number.isFinite(lastMs) && now - lastMs < hours * 60 * 60 * 1000
    if (debounced) {
      nextState[key] = lastWarnedAt // preserve original timestamp, don't reset the clock
    } else {
      surfaced.push(f)
      nextState[key] = new Date(now).toISOString()
    }
  }
  writeState(statePath, nextState)
  return surfaced
}

// CLI entry point — only runs when invoked directly, not on import.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  try {
    const repoRoot = process.argv[2] || process.cwd()
    const findings = auditMcpConfigs({ repoRoot })
    const statePath = join(homedir(), '.skillsmith', 'mcp-command-guard-state.json')
    const surfaced = filterDebounced(findings, statePath)
    for (const f of surfaced) {
      console.error(`[mcp-command-guard] ${f.server} (${f.source}) ${f.message}`)
      console.error(`  Fix: ${f.remediation}`)
    }
  } catch {
    /* advisory only — never a nonzero exit or uncaught crash; this must never block anything */
  }
  process.exit(0)
}
