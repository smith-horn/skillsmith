/**
 * @fileoverview Tests for the SMI-5676 extraction-hardening additions to
 *   McpReferenceExtractor.ts (frontmatter parsing, mcpServers JSON-block
 *   detection, .mcp.json cross-check tagging). Split from
 *   McpReferenceExtractor.test.ts to stay under the 500-line file gate.
 * @module @skillsmith/core/analysis/McpReferenceExtractor.hardening.test
 * @see SMI-5676: Wave 1 Step 3b — harden extractMcpReferences
 */
import { describe, it, expect } from 'vitest'

import { extractMcpReferences } from './McpReferenceExtractor.js'

describe('McpReferenceExtractor — SMI-5676 hardening', () => {
  describe('extractMcpReferences', () => {
    describe('frontmatter allowed-tools/tools parsing (SMI-5676)', () => {
      it('should detect the bare-server form in a YAML block list (real ~/.claude/skills/linear/SKILL.md shape)', () => {
        const content = [
          '---',
          'name: Linear',
          'description: Managing Linear issues, projects, and teams.',
          'version: 3.2.0',
          'author: Ryan Smith <ryan@smithhorn.ca>',
          'tags:',
          '  - linear',
          '  - issue-tracking',
          '  - mcp',
          'allowed-tools:',
          '  - mcp__linear',
          '  - WebFetch(domain:linear.app)',
          '  - Bash',
          '---',
          '',
          '# Linear',
          '',
          'Tools and workflows for managing issues, projects, and teams in Linear.',
        ].join('\n')

        const result = extractMcpReferences(content)

        expect(result.servers).toContain('linear')
        expect(result.highConfidenceServers).toContain('linear')

        const frontmatterRef = result.references.find(
          (r) => r.server === 'linear' && r.tool === '*'
        )
        expect(frontmatterRef).toBeDefined()
        expect(frontmatterRef?.inCodeBlock).toBe(false)
        expect(frontmatterRef?.line).toBe(11) // the "- mcp__linear" line
      })

      it('should detect the wildcard form (mcp__server__*) and only from the allowed-tools/tools fields', () => {
        const content = [
          '---',
          'name: SPARC',
          'tools_required:', // wrong field name (real sparc-methodology.md shape) — must NOT be picked up
          '  - mcp__wrongfield__*',
          'tools:',
          '  - mcp__claude-flow__*',
          '  - Bash',
          '---',
          '',
          '# SPARC',
        ].join('\n')

        const result = extractMcpReferences(content)

        expect(result.servers).toContain('claude-flow')
        expect(result.servers).not.toContain('wrongfield')

        const ref = result.references.find((r) => r.server === 'claude-flow')
        expect(ref?.tool).toBe('*')
      })

      it('should detect the full mcp__server__tool form inside a frontmatter list exactly once (not double-counted by the base inline scan)', () => {
        const content = [
          '---',
          'name: X',
          'allowed-tools:',
          '  - mcp__linear__save_issue',
          '---',
        ].join('\n')

        const result = extractMcpReferences(content)
        // Regression guard (SMI-5676 review finding): the full mcp__server__tool
        // form matches the base inline MCP_PATTERN regex too, so without
        // excluding the frontmatter block from that base scan this entry was
        // counted twice — once by the base scan, once by the frontmatter
        // parser. Use .filter() + toHaveLength, not .find(), so a duplicate
        // can't hide behind "first match wins".
        const linearRefs = result.references.filter((r) => r.server === 'linear')
        expect(linearRefs).toHaveLength(1)
        expect(linearRefs[0].tool).toBe('save_issue')
        expect(linearRefs[0].inCodeBlock).toBe(false)
      })

      it('should support the YAML flow-list form (allowed-tools: [mcp__linear, Bash])', () => {
        const content = ['---', 'name: X', 'allowed-tools: [mcp__linear, Bash]', '---'].join('\n')

        const result = extractMcpReferences(content)
        expect(result.servers).toContain('linear')
      })

      it('should support quoted flow-list entries', () => {
        const content = [
          '---',
          'name: X',
          'tools: ["mcp__stripe__create_customer", "Bash"]',
          '---',
        ].join('\n')

        const result = extractMcpReferences(content)
        const ref = result.references.find((r) => r.server === 'stripe')
        expect(ref?.tool).toBe('create_customer')
      })

      it('should support a single bare scalar value (no brackets, no dash)', () => {
        const content = ['---', 'name: X', 'allowed-tools: mcp__linear', '---'].join('\n')

        const result = extractMcpReferences(content)
        expect(result.servers).toContain('linear')
      })

      it('should ignore non-mcp__ tool names in the list', () => {
        const content = [
          '---',
          'allowed-tools:',
          '  - Bash',
          '  - WebFetch(domain:example.com)',
          '---',
        ].join('\n')

        const result = extractMcpReferences(content)
        expect(result.servers).toEqual([])
      })

      it('should fail open (skip frontmatter refs, keep scanning body) on malformed YAML frontmatter', () => {
        const content = [
          '---',
          'allowed-tools: [unterminated',
          '  bash: {',
          '---',
          'mcp__linear__save_issue in body still works',
        ].join('\n')

        const result = extractMcpReferences(content)
        // Frontmatter YAML fails to parse, but the base body regex scan is
        // entirely independent and still finds the prose reference.
        expect(result.servers).toContain('linear')
      })

      it('should return no frontmatter refs when there is no frontmatter block', () => {
        const content = '# No frontmatter\n\nJust prose.'
        const result = extractMcpReferences(content)
        expect(result.references).toEqual([])
      })
    })

    describe('mcpServers JSON registration block detection (SMI-5676)', () => {
      it('should detect a server name from an mcpServers JSON block (real ~/.claude/skills/stripe-mcp/SKILL.md Option 1 shape)', () => {
        const content = [
          '### Option 1: Remote HTTP (Recommended)',
          '',
          'Add to `~/.claude/settings.json`:',
          '',
          '```json',
          '{',
          '  "mcpServers": {',
          '    "stripe": {',
          '      "type": "http",',
          '      "url": "https://mcp.stripe.com/v1/sse"',
          '    }',
          '  }',
          '}',
          '```',
        ].join('\n')

        const result = extractMcpReferences(content)

        expect(result.servers).toContain('stripe')
        const ref = result.references.find((r) => r.server === 'stripe')
        expect(ref?.tool).toBe('*')
        expect(ref?.inCodeBlock).toBe(true) // it's inside a fenced ```json block
      })

      it('should detect a server name from the Option 3 project .mcp.json shape (nested env object)', () => {
        const content = [
          '### Option 3: Project .mcp.json',
          '',
          'Create `.mcp.json` in your project root:',
          '',
          '```json',
          '{',
          '  "mcpServers": {',
          '    "stripe": {',
          '      "command": "npx",',
          '      "args": ["-y", "@stripe/mcp"],',
          '      "env": {',
          '        "STRIPE_SECRET_KEY": "${STRIPE_SECRET_KEY}"',
          '      }',
          '    }',
          '  }',
          '}',
          '```',
        ].join('\n')

        const result = extractMcpReferences(content)

        expect(result.servers).toEqual(['stripe'])
        // Nested keys inside the server's config object must NOT be picked
        // up as server names.
        expect(result.servers).not.toContain('env')
        expect(result.servers).not.toContain('STRIPE_SECRET_KEY')
      })

      it('should detect multiple servers registered in one mcpServers block', () => {
        const content = [
          '```json',
          '{ "mcpServers": { "stripe": { "url": "x" }, "linear": { "url": "y" } } }',
          '```',
        ].join('\n')

        const result = extractMcpReferences(content)
        expect(result.servers).toEqual(['linear', 'stripe'])
      })

      it('should not throw and should skip invalid JSON after an mcpServers marker', () => {
        const content = '"mcpServers": { not valid json here'
        const result = extractMcpReferences(content)
        expect(result.references).toEqual([])
      })

      it('should not hang on adversarial input with many unclosed mcpServers markers (SMI-5676 review finding, DoS guard)', () => {
        // Each occurrence is unclosed (no matching "}" anywhere in the
        // document), so without a cap on markers processed, every one of
        // 1000+ occurrences would trigger its own O(remaining-document-length)
        // brace scan — O(n^2) worst case. Stays under the 100KB input cap so
        // this exercises the NEW marker-count cap, not input truncation.
        const content = '"mcpServers": { '.repeat(3000) // ~51KB, well under 100KB
        expect(content.length).toBeLessThan(100 * 1024)

        const start = Date.now()
        const result = extractMcpReferences(content)
        const elapsedMs = Date.now() - start

        expect(result.references).toBeDefined()
        expect(elapsedMs).toBeLessThan(2000)
      })
    })

    describe('.mcp.json cross-check tagging (SMI-5676) — keep-and-tag, never exclude', () => {
      it('should tag every server "unknown" when registeredServers is not passed', () => {
        const content = 'Use mcp__linear__save_issue and mcp__claude-flow__agent_spawn.'
        const result = extractMcpReferences(content)

        expect(result.servers).toEqual(['claude-flow', 'linear'])
        expect(result.serverResolutions).toEqual({
          'claude-flow': 'unknown',
          linear: 'unknown',
        })
      })

      it('should tag registered vs unregistered without excluding either from servers/references', () => {
        const content = 'Use mcp__linear__save_issue and mcp__claude-flow__agent_spawn.'
        const result = extractMcpReferences(content, ['linear', 'ruflo', 'skillsmith'])

        // Neither candidate is dropped — both remain in servers/references.
        expect(result.servers).toEqual(['claude-flow', 'linear'])
        expect(result.references).toHaveLength(2)

        expect(result.serverResolutions?.linear).toBe('registered')
        expect(result.serverResolutions?.['claude-flow']).toBe('unregistered')
      })

      it('should tag every candidate "unregistered" when registeredServers is an empty array (explicitly checked, found nothing)', () => {
        const content = 'Use mcp__linear__save_issue.'
        const result = extractMcpReferences(content, [])

        expect(result.servers).toEqual(['linear'])
        expect(result.serverResolutions?.linear).toBe('unregistered')
      })

      it('should reproduce the claude-flow -> ruflo stale-rename class: unregistered, but never excluded', () => {
        // Representative excerpt of the real shape found in
        // .claude/skills/{swarm-advanced,hive-mind-advanced,sparc-methodology,
        // hooks-automation,github-release-management,github-project-management,
        // github-multi-repo,performance-analysis}/SKILL.md: this project's own
        // .mcp.json registers "ruflo", not "claude-flow" (SMI-4881 rename).
        const content = [
          '```bash',
          'mcp__claude-flow__swarm_init({ topology: "mesh", maxAgents: 6 })',
          'mcp__claude-flow__agent_spawn({ type: "researcher" })',
          '```',
        ].join('\n')

        const registeredServers = ['skillsmith', 'skillsmith-doc-retrieval', 'ruflo']
        const result = extractMcpReferences(content, registeredServers)

        expect(result.servers).toEqual(['claude-flow'])
        expect(result.serverResolutions?.['claude-flow']).toBe('unregistered')
        // Still present, still counted — DependencyMerger (unchanged) decides
        // advisory-vs-promoted; this extractor only tags, never drops.
        expect(result.references).toHaveLength(2)
      })
    })

    describe('bare tool-name prose without any mcp__ prefix — documented out of scope (SMI-5676)', () => {
      it('does not detect a known ruflo/claude-flow tool name with zero mcp__ prefix (real .claude/skills/hive-mind-execution/SKILL.md shape)', () => {
        // Real "Quick Start" shape from hive-mind-execution/SKILL.md: natural
        // prose invoking a known tool name with no mcp__ prefix at all.
        // Catching this would require matching arbitrary prose against a
        // known-tool-name list (semantic/NLP-ish matching) — out of scope for
        // this hardening pass, whose three acceptance criteria are all
        // mcp__-token-based or JSON-key-based.
        const content = [
          '```',
          '2. Initialize hive mind: swarm_init({ topology: "hierarchical" })',
          '```',
        ].join('\n')

        const result = extractMcpReferences(content)
        expect(result.servers).toEqual([])
      })
    })
  })
})
