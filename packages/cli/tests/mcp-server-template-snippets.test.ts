/**
 * SMI-5893 Wave 11 (GH#2368 C-01): tests for the canonical per-client MCP
 * config snippet matrix. Previously had zero test coverage — added while
 * touching this file to fix Cursor's `npx` reliability problem.
 */
import { describe, it, expect } from 'vitest'
import {
  CLIENT_SNIPPETS,
  renderSnippet,
  renderAllSnippetsAsMarkdown,
  SNIPPET_DISPLAY_ORDER,
} from '../src/templates/mcp-server.template.snippets.js'

describe('mcp-server.template.snippets', () => {
  describe('cursor entry (SMI-5893 Wave 11, GH#2368 C-01)', () => {
    // Uses a plain scaffold-shaped name, not '@skillsmith/mcp-server' — this
    // matrix's only production caller is mcp-server.template.ts's scaffold
    // path (data.name), where `bin` always equals the package name by the
    // scaffold's own PACKAGE_JSON_TEMPLATE convention. The real Skillsmith
    // package's binary name (`skillsmith-mcp`) differs from its scoped
    // package name and is handled by hand-maintained docs instead (see the
    // comment on CLIENT_SNIPPETS.cursor in the source file).
    it('command is a resolved-path placeholder, not npx', () => {
      const rendered = renderSnippet('cursor', 'my-custom-server')
      const parsed = JSON.parse(rendered) as {
        mcpServers: Record<string, { command: unknown; args?: unknown }>
      }
      const entry = parsed.mcpServers['my-custom-server']!
      expect(entry.command).not.toBe('npx')
      // Unmistakably a placeholder — not a real, plausible-looking path
      // someone could paste without noticing it's fake.
      expect(entry.command).toContain('which my-custom-server')
      expect(entry.command).toContain('where my-custom-server')
      expect(entry.args).toBeUndefined()
    })

    it('SKILLSMITH_CLIENT env var is still present', () => {
      const rendered = renderSnippet('cursor', 'my-custom-server')
      const parsed = JSON.parse(rendered) as {
        mcpServers: Record<string, { env?: Record<string, string> }>
      }
      // This matrix's cursor body carries a hardcoded API-key placeholder
      // alongside SKILLSMITH_CLIENT (unlike the website mirror, which
      // derives the API-key variant separately via withApiKey()) — assert
      // the key is present, not exact env-block equality.
      const entry = parsed.mcpServers['my-custom-server']!
      expect(entry.env?.['SKILLSMITH_CLIENT']).toBe('cursor')
    })

    it('notes document npx as an explicit, working fallback', () => {
      const notes = CLIENT_SNIPPETS.cursor.notes ?? ''
      expect(notes).toContain('npx')
      expect(notes).toContain('"args": ["-y", "{{name}}"]')
    })

    it('notes document the Settings -> MCP enable step (GH#2368 C-21)', () => {
      const notes = CLIENT_SNIPPETS.cursor.notes ?? ''
      expect(notes.toLowerCase()).toContain('settings')
      expect(notes.toLowerCase()).toContain('mcp')
      expect(notes.toLowerCase()).toContain('disconnected')
    })

    it('notes explain WHY (the real ENOENT), not just what to do', () => {
      const notes = CLIENT_SNIPPETS.cursor.notes ?? ''
      expect(notes).toContain('ENOENT')
    })
  })

  describe('every other client (regression guard: still uses npx)', () => {
    const nonCursorIds = SNIPPET_DISPLAY_ORDER.filter((id) => id !== 'cursor')

    it.each(nonCursorIds)('%s body still launches via npx', (id) => {
      const rendered = renderSnippet(id, '@skillsmith/mcp-server')
      expect(rendered).toContain('npx')
    })
  })

  describe('renderAllSnippetsAsMarkdown — {{name}} interpolation (found while touching this file)', () => {
    it('interpolates {{name}} in body for every client', () => {
      const markdown = renderAllSnippetsAsMarkdown('my-custom-server')
      expect(markdown).not.toContain('{{name}}')
    })

    it('interpolates {{name}} in notes too — regression guard for the fix', () => {
      // Before this fix, notes were inserted raw (no .replace()), so any
      // notes text containing a literal {{name}} placeholder (cursor's did)
      // would leak into a scaffolded server's own generated README.
      const markdown = renderAllSnippetsAsMarkdown('my-custom-server')
      expect(markdown).toContain('npm install -g my-custom-server')
      expect(markdown).not.toContain('npm install -g {{name}}')
    })

    it('renders the real Skillsmith package name correctly (the common call site)', () => {
      const markdown = renderAllSnippetsAsMarkdown('@skillsmith/mcp-server')
      expect(markdown).toContain('npm install -g @skillsmith/mcp-server')
      expect(markdown).not.toContain('{{name}}')
    })
  })
})
