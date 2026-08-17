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
  format: 'json' | 'toml' | 'yaml'
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
    // SMI-5894 Wave 1 Step 7: SKILLSMITH_CLIENT tells the server to install
    // to ~/.cursor/skills instead of the default ~/.claude/skills — without
    // it, Cursor users silently get Claude Code's install path.
    //
    // SMI-5893 Wave 11 (GH#2368 C-01): `command` is a resolved-path
    // placeholder, not `npx` — Cursor's bundled Node cannot resolve `npx`
    // packages (a real ENOENT on a missing Resources/app/resources/lib
    // directory), confirmed by an external tester hitting this on two
    // separate live UAT passes even after `npx` carried strong caveat text.
    // A guessed default path (e.g. a Homebrew-style tab) can *also* be
    // wrong for an nvm/asdf/custom-prefix install, which fails silently
    // differently instead of predictably — so this deliberately never
    // guesses a path at all; the primary copied snippet can never be wrong,
    // only require one resolve-and-paste step. `npx` stays available as an
    // explicit, clearly-labeled fallback in `notes` below, not removed.
    body: `{
  "mcpServers": {
    "{{name}}": {
      "command": "<paste output of: which {{name}} (macOS/Linux) or where {{name}} (Windows)>",
      "env": {
        "SKILLSMITH_API_KEY": "sk_live_...",
        "SKILLSMITH_CLIENT": "cursor"
      }
    }
  }
}`,
    // Assumes the package's `bin` name matches its npm package name — true for
    // every server scaffolded by mcp-server.template.ts (PACKAGE_JSON_TEMPLATE's
    // `bin` field is literally `{{name}}`), the only production caller of this
    // matrix today. The real @skillsmith/mcp-server package is the one exception
    // (bin is the shorter `skillsmith-mcp`, not the scoped package name) — its
    // docs are hand-maintained separately (root README, packages/mcp-server/README.md,
    // website's mcp-client-snippets.ts) rather than rendered through this file.
    notes:
      "Cursor 2.4+ required, Node >=22.22 (Cursor's own bundled Node meets this). " +
      'Setup: run `npm install -g {{name}}`, then run `which {{name}}` ' +
      '(macOS/Linux) or `where {{name}}` (Windows) and paste that path into ' +
      "`command` above — Cursor's bundled Node cannot resolve packages via `npx` " +
      '(a real ENOENT on a missing Resources/app/resources/lib directory), so ' +
      'pointing directly at the installed binary is the only form confirmed to work ' +
      'inside Cursor. Prefer to try `npx` first anyway? Replace `command` with ' +
      '`"npx"` and add `"args": ["-y", "{{name}}"]` — simpler, but may hit the same ' +
      'ENOENT, plus EBADENGINE or ENOTEMPTY on repeated installs. After saving: ' +
      "enable the server in Cursor's Settings -> MCP panel and start a new chat " +
      '— a correctly-configured entry still shows disconnected until toggled on ' +
      'there — then reload the window.',
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
  // SMI-5456 Wave 1 Step 5: opencode + hermes added to ClientId (paths.ts);
  // this Record<SnippetClientId, ClientSnippet> is exhaustive over ClientId,
  // so both entries are required for the type to compile.
  opencode: {
    label: 'OpenCode',
    configPath: '~/.config/opencode/opencode.json',
    format: 'json',
    // OpenCode's own entry schema (verified opencode.ai/docs/mcp-servers/):
    // typed local|remote, `command` is an ARRAY (command + args combined),
    // env vars live under `environment` (not `env`).
    body: `{
  "mcp": {
    "{{name}}": {
      "type": "local",
      "command": ["npx", "-y", "{{name}}"],
      "enabled": true,
      "environment": {
        "SKILLSMITH_API_KEY": "sk_live_..."
      }
    }
  }
}`,
    notes:
      'OpenCode also reads .claude/skills and .agents/skills for skill discovery. Note the OpenCode-specific entry shape: command is an array and the env-var field is named environment.',
  },
  hermes: {
    label: 'Hermes (Nous Research)',
    configPath: '~/.hermes/config.yaml',
    format: 'yaml',
    body: `mcp_servers:
  {{name}}:
    command: "npx"
    args: ["-y", "{{name}}"]
    env:
      SKILLSMITH_API_KEY: "sk_live_..."`,
    notes:
      'Hermes config is YAML. Hermes has no SessionStart hook equivalent — nudge/attribution is unsupported on this harness.',
  },
  // SMI-5697: grok added to ClientId (paths.ts); this Record<SnippetClientId,
  // ClientSnippet> is exhaustive over ClientId, so this entry is required for
  // the type to compile.
  grok: {
    label: 'Grok Build (xAI)',
    configPath: '~/.grok/config.toml',
    format: 'toml',
    body: `[mcp_servers.{{name}}]
command = "npx"
args = ["-y", "{{name}}"]

[mcp_servers.{{name}}.env]
SKILLSMITH_API_KEY = "sk_live_..."`,
    notes:
      'Grok Build uses TOML under the [mcp_servers.<name>] table, mirroring the Codex CLI convention above — confirmed against docs.x.ai for the command/args shape; the env sub-table follows the same pattern as the Codex entry.',
  },
  // SMI-5982 Wave 6: antigravity added to ClientId (paths.ts); this
  // Record<SnippetClientId, ClientSnippet> is exhaustive over ClientId, so
  // this entry is required for the type to compile. Path + shape verified
  // 2026-08-11 via live web search (antigravity.google/docs/mcp, corroborated
  // by an independent third-party source): global config at
  // ~/.gemini/config/mcp_config.json, standard `mcpServers` object shape
  // (same command/args/env fields every non-Codex/non-OpenCode client uses).
  antigravity: {
    label: 'Google Antigravity',
    configPath: '~/.gemini/config/mcp_config.json',
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
      'One config file is shared across Antigravity CLI, IDE, and 2.0. A workspace-scoped alternative also exists at .agents/mcp_config.json (project root) if you prefer not to register the server globally.',
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
    // Found while touching this file for SMI-5893 Wave 11: `notes` was
    // never interpolated even though the cursor entry's notes text contains
    // literal `{{name}}` placeholders — a scaffolded server with a
    // non-Skillsmith packageName (this function's real generic use, per
    // mcp-server.template.ts:471) would show that placeholder unsubstituted
    // in its own README.
    const renderedNotes = snippet.notes?.replace(/\{\{name\}\}/g, packageName)
    const notes = renderedNotes ? `\n\n${renderedNotes}` : ''
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
  'opencode',
  'hermes',
  'grok',
  'antigravity',
])
