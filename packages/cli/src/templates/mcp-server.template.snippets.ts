/**
 * SMI-4580: Per-client MCP config snippets.
 *
 * Single source of truth for the install-time configuration block each
 * agent expects. Same source feeds:
 *   - the scaffolded mcp-server README (via mcp-server.template.ts)
 *   - the website docs (`getting-started.astro`, `quickstart.astro`)
 *   - the root README + packages/mcp-server/README.md
 *
 * Four of five clients accept the same `mcpServers` JSON shape.
 * Codex needs TOML (separate `[mcp_servers.<name>]` table).
 *
 * @module @skillsmith/cli/templates/mcp-server.template.snippets
 */

import type { ClientId } from '@skillsmith/core/install'

export type SnippetClientId = ClientId | 'codex'

export interface ClientSnippet {
  /** Display label for the per-client tab/section header */
  label: string
  /** Path to the config file the user edits */
  configPath: string
  /** File format hint for the syntax highlighter */
  format: 'json' | 'toml'
  /** Snippet body — interpolated with `{{name}}` for the package name */
  body: string
  /** Notes shown beneath the snippet */
  notes?: string
}

/**
 * Per-client snippet matrix. `name` placeholder is interpolated when the
 * snippet is rendered; pass `'@skillsmith/mcp-server'` for the published
 * package, or any other server name when scaffolding via the template.
 */
export const CLIENT_SNIPPETS: Record<SnippetClientId, ClientSnippet> = {
  'claude-code': {
    label: 'Claude Code',
    configPath: '~/.claude/settings.json',
    format: 'json',
    body: `{
  "mcpServers": {
    "{{name}}": {
      "command": "npx",
      "args": ["-y", "{{name}}"],
      "env": {
        "SKILLSMITH_API_KEY": "sk_live_..."
      }
    }
  }
}`,
    notes: 'Restart Claude Code after editing settings.json.',
  },
  cursor: {
    label: 'Cursor',
    configPath: '~/.cursor/mcp.json',
    format: 'json',
    body: `{
  "mcpServers": {
    "{{name}}": {
      "command": "npx",
      "args": ["-y", "{{name}}"],
      "env": {
        "SKILLSMITH_API_KEY": "sk_live_..."
      }
    }
  }
}`,
    notes: 'Cursor 2.4+ required. Reload the window after saving.',
  },
  copilot: {
    label: 'GitHub Copilot (VS Code)',
    configPath: '.vscode/mcp.json (workspace)',
    format: 'json',
    body: `{
  "mcpServers": {
    "{{name}}": {
      "command": "npx",
      "args": ["-y", "{{name}}"],
      "env": {
        "SKILLSMITH_API_KEY": "sk_live_..."
      }
    }
  }
}`,
    notes:
      'VS Code 1.108+ required. Workspace-scoped config (commit to repo if team-shared, or use user settings.json instead).',
  },
  windsurf: {
    label: 'Windsurf',
    configPath: '~/.codeium/windsurf/mcp_config.json',
    format: 'json',
    body: `{
  "mcpServers": {
    "{{name}}": {
      "command": "npx",
      "args": ["-y", "{{name}}"],
      "env": {
        "SKILLSMITH_API_KEY": "\${env:SKILLSMITH_API_KEY}"
      }
    }
  }
}`,
    notes:
      'Supports `${env:VAR}` interpolation; export SKILLSMITH_API_KEY in your shell instead of inlining the secret.',
  },
  agents: {
    label: 'Cross-agent (open standard)',
    configPath: '~/.agents/mcp.json',
    format: 'json',
    body: `{
  "mcpServers": {
    "{{name}}": {
      "command": "npx",
      "args": ["-y", "{{name}}"],
      "env": {
        "SKILLSMITH_API_KEY": "sk_live_..."
      }
    }
  }
}`,
    notes:
      'Read by any agent honouring the cross-agent skill convention. Codex CLI users prefer the Codex-native TOML snippet below.',
  },
  codex: {
    label: 'Codex CLI',
    configPath: '~/.codex/config.toml',
    format: 'toml',
    body: `[mcp_servers.{{name}}]
command = "npx"
args = ["-y", "{{name}}"]

[mcp_servers.{{name}}.env]
SKILLSMITH_API_KEY = "sk_live_..."`,
    notes:
      'Codex uses TOML, not JSON. Skill discovery still reads ~/.agents/skills (set --client agents when installing via Skillsmith CLI).',
  },
}

/**
 * Render a single client snippet with the package name interpolated.
 */
export function renderSnippet(client: SnippetClientId, packageName: string): string {
  const snippet = CLIENT_SNIPPETS[client]
  return snippet.body.replace(/\{\{name\}\}/g, packageName)
}

/**
 * Render every snippet as a markdown section sequence — labelled with
 * `<details>` + `<summary>` so the docs surface stays compact when no
 * dedicated tabs component is available. Used by both the website
 * markdown surfaces and the scaffolded mcp-server README.
 */
export function renderAllSnippetsAsMarkdown(packageName: string): string {
  const sections = (Object.keys(CLIENT_SNIPPETS) as SnippetClientId[]).map((id) => {
    const snippet = CLIENT_SNIPPETS[id]
    const body = renderSnippet(id, packageName)
    const notes = snippet.notes ? `\n\n${snippet.notes}` : ''
    return [
      `<details>`,
      `<summary><strong>${snippet.label}</strong> — \`${snippet.configPath}\`</summary>`,
      ``,
      `\`\`\`${snippet.format}`,
      body,
      `\`\`\`${notes}`,
      ``,
      `</details>`,
    ].join('\n')
  })
  return sections.join('\n\n')
}

/**
 * Snippet IDs in display order. Use when a docs surface needs to
 * render snippets without a `<details>` accordion (e.g. printable PDF).
 */
export const SNIPPET_DISPLAY_ORDER: ReadonlyArray<SnippetClientId> = Object.freeze([
  'claude-code',
  'cursor',
  'copilot',
  'windsurf',
  'codex',
  'agents',
])
