/**
 * SMI-5554: Shared per-client MCP config snippet data for the website docs.
 *
 * Mirrors (does NOT import) the canonical per-client snippet matrix in
 * packages/cli/src/templates/mcp-server.template.snippets.ts — the website
 * client bundle cannot import @skillsmith/cli or @skillsmith/core at runtime
 * (same constraint documented in packages/website/src/lib/skill-card.parity.test.ts),
 * so this is a hand-maintained mirror, kept in lockstep by
 * mcp-client-snippets.parity.test.ts. When the canonical CLI matrix changes,
 * update MCP_CLIENT_SNIPPETS and that test's EXPECTED constant together.
 *
 * Consumed by:
 *   - packages/website/src/pages/docs/quickstart.astro (Step 2, Option C — uses `.body`)
 *   - packages/website/src/pages/docs/getting-started.astro (Option 3 — uses
 *     `withApiKey(snippet.body, snippet.format)`)
 *
 * Order matches SNIPPET_DISPLAY_ORDER in the CLI package's canonical file.
 *
 * @module lib/mcp-client-snippets
 */

export type McpClientId =
  | 'claude-code'
  | 'cursor'
  | 'copilot'
  | 'windsurf'
  | 'codex'
  | 'agents'
  | 'opencode'
  | 'hermes'
  | 'grok'
  | 'antigravity'

export interface McpClientSnippet {
  /** Canonical client id — matches SnippetClientId in the CLI package */
  id: McpClientId
  /** Display label for the `<summary>` header */
  label: string
  /** Path to the config file the user edits */
  configPath: string
  /** File format hint for the syntax highlighter and the withApiKey() branch */
  format: 'json' | 'toml' | 'yaml'
  /** Snippet body with NO API key — the quickstart.astro (Option C) variant */
  body: string
  /**
   * Notes shown beneath the snippet. May contain literal HTML (e.g. `<code>`)
   * — render with `set:html`, not plain `{}` interpolation, or the markup
   * gets escaped into visible text.
   */
  notes?: string
  /** True only for claude-code — renders its <details> open by default */
  openByDefault?: boolean
}

// The 5 "standard" JSON clients (claude-code, cursor, copilot, windsurf,
// agents) share an identical body: they all key on the published package
// name, not a client-specific name, so this is reused rather than
// hand-duplicated 5 times (see Review Summary #2 in the SMI-5554 plan).
const STANDARD_JSON_BODY = `{
  "mcpServers": {
    "@skillsmith/mcp-server": {
      "command": "npx",
      "args": ["-y", "@skillsmith/mcp-server"]
    }
  }
}`

// SMI-5894 Wave 1 Step 7: Cursor is the one "standard" JSON client that
// does NOT reuse STANDARD_JSON_BODY — it needs SKILLSMITH_CLIENT in its own
// env block so installs route to ~/.cursor/skills instead of the default
// ~/.claude/skills. withApiKeyJson() below special-cases this body (like
// the OpenCode branch) to merge SKILLSMITH_API_KEY into the EXISTING env
// block rather than creating a new one via the generic STANDARD_ARGS_LINE
// path, which assumes no env block is present yet.
const CURSOR_JSON_BODY = `{
  "mcpServers": {
    "@skillsmith/mcp-server": {
      "command": "npx",
      "args": ["-y", "@skillsmith/mcp-server"],
      "env": {
        "SKILLSMITH_CLIENT": "cursor"
      }
    }
  }
}`

/** Per-client snippet matrix, in SNIPPET_DISPLAY_ORDER. */
export const MCP_CLIENT_SNIPPETS: ReadonlyArray<McpClientSnippet> = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    configPath: '~/.claude/settings.json',
    format: 'json',
    body: STANDARD_JSON_BODY,
    openByDefault: true,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    configPath: '~/.cursor/mcp.json',
    format: 'json',
    body: CURSOR_JSON_BODY,
    notes:
      'Cursor 2.4+ required. Reload the window after saving. <code>SKILLSMITH_CLIENT</code> routes installs to <code>~/.cursor/skills</code> instead of the default <code>~/.claude/skills</code>. Recommended: <code>npm install -g @skillsmith/mcp-server</code> first, then point <code>command</code> at the installed <code>skillsmith-mcp</code> binary (run <code>which skillsmith-mcp</code> to get the exact path — it is platform/npm-prefix specific, e.g. <code>/opt/homebrew/bin/skillsmith-mcp</code> on macOS/Homebrew; Linux and Windows paths differ). The <code>npx</code> form above still works as a fallback, but re-resolves the package on every launch and may hit <code>EBADENGINE</code> (Cursor bundles its own Node, sometimes older than the <code>&gt;=22.22</code> this package requires) or <code>ENOTEMPTY</code> on repeated installs.',
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot (VS Code)',
    configPath: '.vscode/mcp.json (workspace)',
    format: 'json',
    body: STANDARD_JSON_BODY,
    notes:
      'VS Code 1.108+ required. Workspace-scoped (commit to repo if team-shared, or use user settings.json instead).',
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    configPath: '~/.codeium/windsurf/mcp_config.json',
    format: 'json',
    body: STANDARD_JSON_BODY,
    notes: 'Supports <code>${env:VAR}</code> interpolation for secrets in this config.',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    configPath: '~/.codex/config.toml',
    format: 'toml',
    body: `[mcp_servers.@skillsmith/mcp-server]
command = "npx"
args = ["-y", "@skillsmith/mcp-server"]`,
    notes:
      'Codex reads <code>~/.agents/skills</code>. When installing via Skillsmith CLI, pass <code>--client agents</code>.',
  },
  {
    id: 'agents',
    label: 'Cross-agent (open standard)',
    configPath: '~/.agents/mcp.json',
    format: 'json',
    body: STANDARD_JSON_BODY,
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    configPath: '~/.config/opencode/opencode.json',
    format: 'json',
    // OpenCode's entry schema differs from the other 5 JSON clients:
    // `command` is an array and the env-var field is named `environment`,
    // not `env` (verified opencode.ai/docs/mcp-servers/).
    body: `{
  "mcp": {
    "@skillsmith/mcp-server": {
      "type": "local",
      "command": ["npx", "-y", "@skillsmith/mcp-server"],
      "enabled": true
    }
  }
}`,
    notes:
      'OpenCode also reads <code>.claude/skills</code> and <code>.agents/skills</code> for skill discovery. Note the OpenCode-specific entry shape: <code>command</code> is an array and the env-var field is named <code>environment</code>, not <code>env</code>.',
  },
  {
    id: 'hermes',
    label: 'Hermes (Nous Research)',
    configPath: '~/.hermes/config.yaml',
    format: 'yaml',
    body: `mcp_servers:
  @skillsmith/mcp-server:
    command: "npx"
    args: ["-y", "@skillsmith/mcp-server"]`,
    notes:
      'Hermes config is YAML. Hermes has no <code>SessionStart</code> hook equivalent — nudge/attribution is unsupported on this harness.',
  },
  {
    id: 'grok',
    label: 'Grok Build (xAI)',
    configPath: '~/.grok/config.toml',
    format: 'toml',
    body: `[mcp_servers.@skillsmith/mcp-server]
command = "npx"
args = ["-y", "@skillsmith/mcp-server"]`,
    notes:
      'Grok Build uses TOML under a <code>[mcp_servers.NAME]</code> table, the same convention as Codex CLI above.',
  },
  {
    id: 'antigravity',
    label: 'Google Antigravity',
    configPath: '~/.gemini/config/mcp_config.json',
    format: 'json',
    body: STANDARD_JSON_BODY,
    notes:
      'One config file is shared across the Antigravity CLI, IDE, and 2.0. A workspace-scoped alternative also exists at <code>.agents/mcp_config.json</code> (project root) if you prefer not to register the server globally.',
  },
]

const STANDARD_ARGS_LINE = /(\n {6}"args": \[[^\n]*\])\n( {4}\}\n)/
const OPENCODE_ENABLED_LINE = /(\n {6}"enabled": true)\n( {4}\}\n)/
// SMI-5894 Wave 1 Step 7: cursor's body already has an "env" block
// (SKILLSMITH_CLIENT) before withApiKey() runs — matches the
// "SKILLSMITH_CLIENT" line so SKILLSMITH_API_KEY is merged INTO that block
// instead of STANDARD_ARGS_LINE trying (and failing) to insert a second one.
const CURSOR_ENV_LINE = /(\n {8}"SKILLSMITH_CLIENT": "cursor")\n( {6}\}\n)/

function withApiKeyJson(body: string, id?: McpClientId): string {
  // OpenCode's shape is keyed differently (`mcp` + `environment`, not
  // `mcpServers` + `env`) — special-cased here rather than folded into the
  // standard branch below, so the 5 standard JSON clients stay simple.
  if (body.includes('"mcp": {')) {
    return body.replace(
      OPENCODE_ENABLED_LINE,
      '$1,\n      "environment": {\n        "SKILLSMITH_API_KEY": "sk_live_your_key_here"\n      }\n$2'
    )
  }
  // Cursor already has an "env" block (SKILLSMITH_CLIENT) — merge the API
  // key into it rather than inserting a second "env" block via the generic
  // STANDARD_ARGS_LINE branch below, which assumes none exists yet.
  if (id === 'cursor') {
    return body.replace(
      CURSOR_ENV_LINE,
      '$1,\n        "SKILLSMITH_API_KEY": "sk_live_your_key_here"\n$2'
    )
  }
  // Windsurf documents `${env:VAR}` interpolation, so its example shows the
  // key sourced from the shell instead of inlined as a literal placeholder
  // (see the `notes` field on the windsurf entry above).
  const value = id === 'windsurf' ? '${env:SKILLSMITH_API_KEY}' : 'sk_live_your_key_here'
  return body.replace(
    STANDARD_ARGS_LINE,
    `$1,\n      "env": {\n        "SKILLSMITH_API_KEY": "${value}"\n      }\n$2`
  )
}

function withApiKeyToml(body: string): string {
  const match = body.match(/^\[mcp_servers\.(.+)\]/)
  const table = match ? match[1] : '@skillsmith/mcp-server'
  return `${body}\n\n[mcp_servers.${table}.env]\nSKILLSMITH_API_KEY = "sk_live_your_key_here"`
}

function withApiKeyYaml(body: string): string {
  return `${body}\n    env:\n      SKILLSMITH_API_KEY: "sk_live_your_key_here"`
}

/**
 * Derives the API-key variant of a snippet body from its no-API-key `body`,
 * instead of hand-authoring a second template string per client. Used by
 * getting-started.astro; quickstart.astro renders `.body` as-is.
 *
 * `id` is optional but should be passed whenever available — it's only used
 * to special-case Windsurf's `${env:VAR}` interpolation example.
 */
export function withApiKey(
  body: string,
  format: 'json' | 'toml' | 'yaml',
  id?: McpClientId
): string {
  if (format === 'toml') return withApiKeyToml(body)
  if (format === 'yaml') return withApiKeyYaml(body)
  return withApiKeyJson(body, id)
}
