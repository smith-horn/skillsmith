#!/usr/bin/env node
/**
 * MCP command guard (SMI-5642 bare-command check; SMI-6229 plugin-config
 * scan + hosted-scope check).
 *
 * Two checks:
 *
 * 1. `findBareCommandServers` — warns when an MCP server config uses a bare
 *    global-bin `command` (no path, not npx/docker/interpreter-fronted) —
 *    the exact pattern that broke the `aqe` MCP server (ENOENT) after an
 *    nvm-managed Node global-bin install fell out of the active Node
 *    version.
 * 2. `findHostedScopeViolations` — warns on any hosted (`url`-based) MCP
 *    server matching a HOSTED_SCOPE_RULES host (currently `mcp.supabase.com`)
 *    that is not disabled for this project. SMI-6308 CORRECTION: a
 *    `features=docs` URL was previously treated as compliant on its own —
 *    a live security investigation proved that's false: the `features=`
 *    parameter never narrows the connector's actual OAuth grant, which is
 *    always the full, organization-wide Management API regardless of that
 *    parameter's value. The only state that removes the risk is having no
 *    live connection at all, so this check now exempts an entry only when
 *    its server name appears in this project's `disabledMcpServers` list
 *    (`~/.claude.json`, set via Claude Code's own `/mcp` panel) — every
 *    other matching hosted entry flags, regardless of `features=`.
 *
 * Scans three sources: this repo's `.mcp.json`; `~/.claude.json`'s
 * skillsmith-project-scoped `mcpServers` block (never that file's other,
 * unrelated project entries or top-level global servers); and every ENABLED
 * Claude Code plugin's pinned-cache `.mcp.json`
 * (./mcp-command-guard.plugin-scan.mjs) — the only place a plugin-registered
 * hosted server like `mcp.supabase.com` actually appears on disk.
 *
 * SECURITY-RELEVANT DUPLICATION (ADR-137): the plugin-discovery logic in
 * ./mcp-command-guard.plugin-scan.mjs (`readEnabledPluginIds`) is a native
 * `.mjs` reimplementation of
 * packages/mcp-server/src/utils/local-inventory.helpers.ts's function of the
 * same name (SMI-6228 Wave 1), not a shared import — this file runs on a
 * `SessionStart` hook path where `packages/mcp-server/dist` may not exist.
 * A silent divergence between the two implementations is a security gap,
 * not a cosmetic inconsistency: it would mean this guard scans a different
 * plugin set than `skill_inventory_audit` does, going blind to exactly the
 * class of hosted, write-capable MCP server this scan exists to catch.
 * Enforced by @see packages/mcp-server/tests/unit/plugin-scan-parity.test.ts.
 *
 * @see docs/internal/implementation/mcp-bare-command-guard-hook.md
 * @see docs/internal/implementation/fix-aqe-mcp-enoent.md
 * @see docs/internal/implementation/mcp-guard-plugin-config-scan.md
 * @see docs/internal/adr/136-cross-runtime-duplication-of-security-logic.md
 * @see docs/internal/implementation/smi-6308-supabase-mcp-oauth-scope-guard.md
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { scanPluginMcpServers } from './mcp-command-guard.plugin-scan.mjs'

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

// Host-keyed hosted-MCP-server scope rules (SMI-6229). Structured as a table
// so a second host is a data addition, not a code fork — the rule shape
// (`features` must equal exactly the allowed set) is Supabase-specific
// semantics no other vendor shares; see change 2's "Scope decision" in
// docs/internal/implementation/mcp-guard-plugin-config-scan.md.
const HOSTED_SCOPE_RULES = {
  'mcp.supabase.com': {
    param: 'features',
    allowed: new Set(['docs']),
    why: 'omitting `features` enables all groups except Storage — including Database (execute_sql / apply_migration)',
  },
}

/**
 * Evaluate hosted (`url`-based) MCP server entries against
 * HOSTED_SCOPE_RULES. Complementary to findBareCommandServers, not an
 * extension of it: a stdio entry is never evaluated here (ownership
 * boundary — findBareCommandServers owns anything without a string `url`),
 * and a hosted entry is never evaluated by findBareCommandServers.
 *
 * SMI-6308 CORRECTION: a `features=docs` URL is NO LONGER treated as
 * compliant on its own. A live security investigation
 * (docs/internal/implementation/smi-6308-supabase-mcp-oauth-scope-guard.md)
 * proved the `features=` URL parameter never narrows this connector's
 * actual OAuth grant — `mcp.supabase.com`'s own
 * `.well-known/oauth-protected-resource` metadata returns the SAME fixed,
 * 13-scope, organization-wide Management-API scope set regardless of the
 * query string, and Supabase has confirmed (supabase/mcp#239) that
 * feature-based scope narrowing is unimplemented upstream. `features=` only
 * filters which TOOLS the connector exposes post-authorization — it does
 * nothing to the OAuth token itself, which can always reach the full
 * Management API (including `secrets:read`, which can retrieve a project's
 * durable `service_role` key). `read_only=true` is likewise NOT accepted as
 * satisfying this rule, for the same underlying reason: it is a server-side
 * tool-filtering parameter, not something that narrows the OAuth grant.
 *
 * The only state that actually removes this risk is having no live
 * connection at all — checked FIRST, below, via `disabledServerNames`
 * (a project's `disabledMcpServers` list in `~/.claude.json`, populated by
 * Claude Code's own `/mcp` panel). Every other hosted entry matching
 * HOSTED_SCOPE_RULES now flags, regardless of its `features=` value.
 *
 * @param disabledServerNames - Set of disabled-server identifiers for this
 *   project (see readDisabledMcpServerNames). Defaults to an empty Set so
 *   existing direct callers/tests that don't pass one behave exactly as
 *   before (nothing is exempted).
 * @param pluginId - present only when `mcpServers` came from a plugin's
 *   pinned-cache config (the `<pluginName>@<marketplace>` shape
 *   scanPluginMcpServers returns). Needed because a plugin-sourced server's
 *   entry in `disabledMcpServers` is NOT keyed by that shape — it's keyed by
 *   `plugin:<pluginName>:<serverName>` (confirmed live against this repo's
 *   own `~/.claude.json`), so the lookup key differs by source.
 */
export function findHostedScopeViolations(
  mcpServers,
  sourceLabel,
  disabledServerNames = new Set(),
  pluginId
) {
  const findings = []
  for (const [name, entry] of Object.entries(mcpServers || {})) {
    if (!entry || typeof entry.url !== 'string') continue // stdio entry — findBareCommandServers owns it

    // SMI-6308: a server this project has disabled (Claude Code's own /mcp
    // panel, persisted to ~/.claude.json's disabledMcpServers) has no live
    // connection — Claude Code refuses to start it — so it carries no OAuth
    // risk regardless of what scope its URL claims. Skip it entirely, before
    // ever parsing the URL.
    const disabledKey = pluginId ? `plugin:${pluginId.split('@')[0]}:${name}` : name
    if (disabledServerNames.has(disabledKey)) continue

    let url
    try {
      url = new URL(entry.url)
    } catch {
      continue // unparseable URL — fail soft, silent
    }

    // Cross-provider review finding (GPT-5.6-Sol, Medium): `URL.hostname`
    // already lowercases and strips the port, but preserves a DNS
    // root-notation trailing dot (`mcp.supabase.com.` resolves identically
    // to `mcp.supabase.com`). Without stripping it, that trivially-valid
    // variant would miss the HOSTED_SCOPE_RULES lookup entirely and bypass
    // this check completely, silently — confirmed live:
    // `new URL('https://mcp.supabase.com./mcp').hostname === 'mcp.supabase.com.'`.
    const hostname = url.hostname.replace(/\.$/, '')
    const rule = HOSTED_SCOPE_RULES[hostname]
    if (!rule) continue

    // getAll, not get: a repeated `?features=` param must not be half-read.
    const raw = url.searchParams.getAll(rule.param).join(',')
    const groups = new Set(
      raw
        .split(',')
        .map((g) => g.trim().toLowerCase())
        .filter((g) => g.length > 0)
    )

    // SMI-6308: no "compliant scope" branch anymore — every entry that
    // reaches this point (not disabled, hostname matches a rule) flags,
    // whether unscoped or scoped to any value including "docs".
    findings.push({
      check: 'hosted-scope',
      source: sourceLabel,
      server: name,
      url: entry.url,
      // Message-copy fix (plan-review Medium #8, still true post-SMI-6308):
      // the scoped branch does NOT reuse rule.why's omission-framed
      // sentence — that sentence ("omitting `features` enables...") would
      // be self-contradictory here, since the user demonstrably did supply
      // `features`. The two branches read differently on purpose.
      message:
        groups.size === 0
          ? `is a hosted ${hostname} MCP server with no "${rule.param}" scoping — ${rule.why}.`
          : `is a hosted ${hostname} MCP server scoped to "${[...groups].sort().join(',')}" — but the "${rule.param}" parameter does not narrow this connector's OAuth grant (${hostname}'s own OAuth metadata returns the same full, organization-wide Management-API scope set no matter what "${rule.param}" is set to), so even a "${[...rule.allowed].join(',')}"-only value still carries full read/write access to write-capable tool groups such as Database (execute_sql / apply_migration).`,
      remediation: `The OAuth grant behind ${hostname} is broad (full Management API read/write, organization-wide, no project_ref scoping) no matter what "${rule.param}=" value the URL carries — Supabase has no supported way to narrow it via that parameter (see supabase/mcp#239 and ${hostname}'s own .well-known/oauth-protected-resource metadata). The only mitigation that actually removes this risk is disabling this connector entirely via Claude Code's /mcp panel, which adds it to this project's "disabledMcpServers" list in ~/.claude.json (SMI-6308) — once disabled it has no live connection and this check exempts it.`,
    })
  }
  return findings
}

/**
 * Read this project's `disabledMcpServers` list from `~/.claude.json`
 * (SMI-6308). A server Claude Code has disabled for this project has no
 * live MCP connection — Claude Code itself refuses to start it — so it
 * carries no OAuth risk no matter what scope its URL claims;
 * findHostedScopeViolations uses this to skip such entries entirely rather
 * than flag them.
 *
 * Fail-soft on every edge case, mirroring auditMcpConfigs' own
 * ~/.claude.json handling immediately below it: a missing file, an
 * unreadable file, malformed JSON, `projects` not being an object, no entry
 * for this repoRoot, or a missing/non-array `disabledMcpServers` key all
 * resolve to an empty Set — never a thrown error. Deliberately no
 * `console.error` here even for a malformed `projects` shape: the
 * ~/.claude.json (project scope) block in auditMcpConfigs already emits
 * that warning once for the same root cause — a second warning here would
 * be a duplicate, not new information. Also deliberately silent on a
 * JSON.parse failure for the same reason as auditMcpConfigs' own parse
 * catch blocks: this file is known to contain plaintext secrets adjacent to
 * MCP server entries, and Node's SyntaxError messages embed a raw snippet
 * of the offending source.
 */
function readDisabledMcpServerNames({ repoRoot, homeDir }) {
  const claudeJsonPath = join(homeDir, '.claude.json')
  if (!existsSync(claudeJsonPath)) return new Set()

  try {
    const parsed = JSON.parse(readFileSync(claudeJsonPath, 'utf-8'))
    if (!parsed?.projects || typeof parsed.projects !== 'object') return new Set()
    const disabled = parsed.projects[repoRoot]?.disabledMcpServers
    if (!Array.isArray(disabled)) return new Set()
    return new Set(disabled.filter((s) => typeof s === 'string'))
  } catch {
    return new Set()
  }
}

export function auditMcpConfigs({ repoRoot, homeDir = homedir() }) {
  const findings = []

  // SMI-6308: resolve this project's disabledMcpServers list up front — a
  // server disabled via Claude Code's own /mcp panel has no live connection
  // regardless of which of the three sources below registers it, so every
  // findHostedScopeViolations call below needs this set before it evaluates
  // any hosted-URL entry. Reads ~/.claude.json a second time (independent
  // of the project-scope block below) — deliberately: it keeps this read
  // and its fail-soft behavior self-contained and independently testable,
  // and this is a small local file read on an advisory, non-hot-path guard.
  const disabledServerNames = readDisabledMcpServerNames({ repoRoot, homeDir })

  const mcpJsonPath = join(repoRoot, '.mcp.json')
  if (existsSync(mcpJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'))
      findings.push(...findBareCommandServers(parsed.mcpServers, '.mcp.json'))
      findings.push(
        ...findHostedScopeViolations(parsed.mcpServers, '.mcp.json', disabledServerNames)
      )
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
      findings.push(
        ...findHostedScopeViolations(
          projectServers,
          '~/.claude.json (project scope)',
          disabledServerNames
        )
      )
    } catch {
      /* malformed JSON or unreadable — fail soft, deliberately silent (see comment above) */
    }
  }

  // Source 3 (SMI-6229): every ENABLED Claude Code plugin's pinned-cache
  // .mcp.json. Only findHostedScopeViolations runs against this source,
  // deliberately — findBareCommandServers against plugin-sourced configs
  // would be a literal no-op today (every real plugin .mcp.json on this
  // machine declares `type: 'http'` entries with no `command` at all) while
  // shipping remediation text ("use an absolute path, or wrap in npx") that
  // is wrong for a vendor-owned config the user cannot edit.
  try {
    for (const { pluginId, mcpServers } of scanPluginMcpServers({ homeDir })) {
      findings.push(
        ...findHostedScopeViolations(
          mcpServers,
          `plugin:${pluginId}`,
          disabledServerNames,
          pluginId
        )
      )
    }
  } catch {
    /* never let the new source suppress the two pre-existing ones */
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

// Keyed by content hash of source+server+discriminant (not just server
// name) so editing a flagged entry's command/url re-triggers immediately
// even within the debounce window, rather than silently inheriting the old
// timestamp.
function findingKey(f) {
  // Discriminant is the field that actually changes when the flagged config
  // changes: `command` for bare-command findings, `url` for hosted-scope
  // ones. The template is UNCHANGED for command findings, so existing
  // entries in ~/.skillsmith/mcp-command-guard-state.json keep matching —
  // no one-time re-warn on upgrade for a deliberately accepted finding
  // (e.g. `aqe`).
  //
  // FORWARD-COMPAT WARNING (plan-review Medium #7): this only distinguishes
  // today's two finding shapes. A future third check whose findings carry
  // neither `command` nor `url` would silently fall through to `undefined`,
  // recreating the exact SMI-4861-class debounce-key collision this change
  // exists to fix. Any new check MUST extend this discriminant explicitly.
  const discriminant = typeof f.command === 'string' ? f.command : f.url
  if (discriminant === undefined) {
    // Defensive: a finding with neither field is a bug in whatever check
    // produced it, not a normal fail-soft case — surface it rather than
    // silently corrupt the debounce key.
    console.error(
      `[mcp-command-guard] internal: finding for ${f.server} (${f.source}) has no command or url — debounce key may collide`
    )
  }
  return createHash('sha256').update(`${f.source} ${f.server} ${discriminant}`).digest('hex')
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
