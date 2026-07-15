/**
 * SMI-5554 parity guard: MCP_CLIENT_SNIPPETS in mcp-client-snippets.ts must stay
 * in sync with the canonical CLIENT_SNIPPETS matrix in @skillsmith/cli.
 *
 * Source of truth: packages/cli/src/templates/mcp-server.template.snippets.ts
 * (CLIENT_SNIPPETS + SNIPPET_DISPLAY_ORDER). The website client bundle CANNOT
 * import @skillsmith/cli at runtime (same constraint as skill-card.parity.test.ts
 * re: @skillsmith/core), so mcp-client-snippets.ts is a hand-maintained mirror,
 * and this test is the enforcement boundary.
 *
 * Unlike skill-card.parity.test.ts (which only guards a label map), this test
 * also asserts BODY content, not just id/label/configPath/format metadata —
 * the bodies are the actual copy-pasteable content that drifted last time (2 of
 * 8 canonical clients were missing entirely from both website pages, and no
 * test caught it).
 *
 * When the canonical CLI matrix changes, update MCP_CLIENT_SNIPPETS and the
 * EXPECTED constant below in lockstep.
 */

import { describe, it, expect } from 'vitest'
import { MCP_CLIENT_SNIPPETS, withApiKey } from './mcp-client-snippets'

// Hardcoded canonical contract — derived from
// packages/cli/src/templates/mcp-server.template.snippets.ts (SNIPPET_DISPLAY_ORDER).
// Do NOT derive this from MCP_CLIENT_SNIPPETS itself; that would make the test circular.
const EXPECTED: ReadonlyArray<{
  id: string
  label: string
  configPath: string
  format: 'json' | 'toml' | 'yaml'
}> = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    configPath: '~/.claude/settings.json',
    format: 'json',
  },
  { id: 'cursor', label: 'Cursor', configPath: '~/.cursor/mcp.json', format: 'json' },
  {
    id: 'copilot',
    label: 'GitHub Copilot (VS Code)',
    configPath: '.vscode/mcp.json (workspace)',
    format: 'json',
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    configPath: '~/.codeium/windsurf/mcp_config.json',
    format: 'json',
  },
  { id: 'codex', label: 'Codex CLI', configPath: '~/.codex/config.toml', format: 'toml' },
  {
    id: 'agents',
    label: 'Cross-agent (open standard)',
    configPath: '~/.agents/mcp.json',
    format: 'json',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    configPath: '~/.config/opencode/opencode.json',
    format: 'json',
  },
  {
    id: 'hermes',
    label: 'Hermes (Nous Research)',
    configPath: '~/.hermes/config.yaml',
    format: 'yaml',
  },
  {
    id: 'grok',
    label: 'Grok Build (xAI)',
    configPath: '~/.grok/config.toml',
    format: 'toml',
  },
]

describe('MCP_CLIENT_SNIPPETS — parity with CLI CLIENT_SNIPPETS (SMI-5554)', () => {
  it('has exactly the 9-entry canonical id/label/configPath/format contract, in SNIPPET_DISPLAY_ORDER', () => {
    const actual = MCP_CLIENT_SNIPPETS.map(({ id, label, configPath, format }) => ({
      id,
      label,
      configPath,
      format,
    }))
    expect(actual).toEqual(EXPECTED)
  })

  it('every body contains the expected npx launch shape for its client', () => {
    for (const snippet of MCP_CLIENT_SNIPPETS) {
      if (snippet.format === 'json') {
        const parsed = JSON.parse(snippet.body) as Record<string, unknown>
        if (snippet.id === 'opencode') {
          const mcp = parsed.mcp as Record<string, { command: unknown }>
          expect(mcp['@skillsmith/mcp-server'].command).toEqual([
            'npx',
            '-y',
            '@skillsmith/mcp-server',
          ])
        } else {
          const mcpServers = parsed.mcpServers as Record<
            string,
            { command: unknown; args: unknown }
          >
          const entry = mcpServers['@skillsmith/mcp-server']
          expect(entry.command).toBe('npx')
          expect(entry.args).toEqual(['-y', '@skillsmith/mcp-server'])
        }
      } else if (snippet.format === 'toml') {
        expect(snippet.body).toContain('command = "npx"')
        expect(snippet.body).toContain('args = ["-y", "@skillsmith/mcp-server"]')
      } else {
        // yaml (hermes)
        expect(snippet.body).toContain('command: "npx"')
        expect(snippet.body).toContain('args: ["-y", "@skillsmith/mcp-server"]')
      }
    }
  })

  it('withApiKey() injects a valid env block for every format without disturbing the launch shape', () => {
    for (const snippet of MCP_CLIENT_SNIPPETS) {
      const withKey = withApiKey(snippet.body, snippet.format, snippet.id)
      // Windsurf documents `${env:VAR}` interpolation, so its example sources
      // the key from the shell rather than inlining a literal placeholder.
      const expectedValue =
        snippet.id === 'windsurf' ? '${env:SKILLSMITH_API_KEY}' : 'sk_live_your_key_here'
      if (snippet.format === 'json') {
        const parsed = JSON.parse(withKey) as Record<string, unknown>
        if (snippet.id === 'opencode') {
          const mcp = parsed.mcp as Record<string, { environment?: Record<string, string> }>
          expect(mcp['@skillsmith/mcp-server'].environment).toEqual({
            SKILLSMITH_API_KEY: expectedValue,
          })
        } else {
          const mcpServers = parsed.mcpServers as Record<string, { env?: Record<string, string> }>
          expect(mcpServers['@skillsmith/mcp-server'].env).toEqual({
            SKILLSMITH_API_KEY: expectedValue,
          })
        }
      } else if (snippet.format === 'toml') {
        expect(withKey).toContain(`SKILLSMITH_API_KEY = "${expectedValue}"`)
      } else {
        expect(withKey).toContain(`SKILLSMITH_API_KEY: "${expectedValue}"`)
      }
    }
  })
})
