import { describe, it, expect } from 'vitest'

import type { DependencyDeclaration } from '../types/dependencies.js'
import type { McpExtractionResult } from './McpReferenceExtractor.js'
import { mergeDependencies, type MergedDependency } from './DependencyMerger.js'

/** Helper: create an empty McpExtractionResult */
function emptyInferred(): McpExtractionResult {
  return { references: [], servers: [], highConfidenceServers: [] }
}

/** Helper: create a McpExtractionResult with servers */
function inferredServers(servers: string[], highConfidence: string[] = []): McpExtractionResult {
  return {
    references: servers.map((s) => ({
      server: s,
      tool: 'some_tool',
      line: 1,
      inCodeBlock: !highConfidence.includes(s),
    })),
    servers,
    highConfidenceServers: highConfidence,
  }
}

describe('DependencyMerger', () => {
  describe('mergeDependencies', () => {
    it('should return empty array for undefined declared and empty inferred', () => {
      const result = mergeDependencies(undefined, emptyInferred())
      expect(result).toEqual([])
    })

    it('should include declared skill dependencies', () => {
      const declared: DependencyDeclaration = {
        skills: [
          { name: 'auth-helper', type: 'hard', version: '^1.0.0' },
          { name: 'logger', type: 'soft' },
          { name: 'formatter', type: 'peer', reason: 'shared config' },
        ],
      }

      const result = mergeDependencies(declared, emptyInferred())

      expect(result).toHaveLength(3)

      expect(result[0]).toMatchObject({
        depType: 'skill_hard',
        depTarget: 'auth-helper',
        depVersion: '^1.0.0',
        depSource: 'declared',
        confidence: 1.0,
      })

      expect(result[1]).toMatchObject({
        depType: 'skill_soft',
        depTarget: 'logger',
        depVersion: null,
        depSource: 'declared',
      })

      expect(result[2]).toMatchObject({
        depType: 'skill_peer',
        depTarget: 'formatter',
        metadata: JSON.stringify({ reason: 'shared config' }),
      })
    })

    it('should include declared MCP servers', () => {
      const declared: DependencyDeclaration = {
        platform: {
          mcp_servers: [
            { name: 'linear', required: true, package: '@linear/mcp' },
            { name: 'slack', required: false },
          ],
        },
      }

      const result = mergeDependencies(declared, emptyInferred())

      expect(result).toHaveLength(2)

      expect(result[0]).toMatchObject({
        depType: 'mcp_server',
        depTarget: 'linear',
        depSource: 'declared',
        confidence: 1.0,
      })
      expect(JSON.parse(result[0].metadata!)).toEqual({
        package: '@linear/mcp',
        required: true,
      })

      expect(result[1]).toMatchObject({
        depType: 'mcp_server',
        depTarget: 'slack',
        depSource: 'declared',
      })
      expect(JSON.parse(result[1].metadata!)).toEqual({ required: false })
    })

    it('should add inferred MCP servers when no declared deps', () => {
      const inferred = inferredServers(['linear', 'claude-flow'], ['linear'])

      const result = mergeDependencies(undefined, inferred)

      expect(result).toHaveLength(2)

      const linear = result.find((d) => d.depTarget === 'linear')!
      expect(linear.depType).toBe('mcp_server')
      expect(linear.depSource).toBe('inferred_static')
      expect(linear.confidence).toBe(0.9) // high confidence

      const cf = result.find((d) => d.depTarget === 'claude-flow')!
      expect(cf.depSource).toBe('inferred_static')
      expect(cf.confidence).toBe(0.5) // low confidence (code block only)
    })

    it('should skip inferred server when already declared (declared trumps)', () => {
      const declared: DependencyDeclaration = {
        platform: {
          mcp_servers: [{ name: 'linear', required: true }],
        },
      }

      const inferred = inferredServers(['linear', 'slack'], ['linear', 'slack'])

      const result = mergeDependencies(declared, inferred)

      // linear: declared only (not duplicated from inferred)
      // slack: inferred (not declared)
      const linearEntries = result.filter((d) => d.depTarget === 'linear')
      expect(linearEntries).toHaveLength(1)
      expect(linearEntries[0].depSource).toBe('declared')
      expect(linearEntries[0].confidence).toBe(1.0)

      const slackEntries = result.filter((d) => d.depTarget === 'slack')
      expect(slackEntries).toHaveLength(1)
      expect(slackEntries[0].depSource).toBe('inferred_static')
      expect(slackEntries[0].confidence).toBe(0.9)
    })

    it('should assign correct confidence: 0.9 high, 0.5 code-block-only', () => {
      const inferred = inferredServers(
        ['high-server', 'low-server'],
        ['high-server'] // only high-server is high confidence
      )

      const result = mergeDependencies(undefined, inferred)

      const high = result.find((d) => d.depTarget === 'high-server')!
      expect(high.confidence).toBe(0.9)

      const low = result.find((d) => d.depTarget === 'low-server')!
      expect(low.confidence).toBe(0.5)
    })

    it('should include declared CLI version', () => {
      const declared: DependencyDeclaration = {
        platform: { cli: '>=1.0.0' },
      }

      const result = mergeDependencies(declared, emptyInferred())

      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        depType: 'cli_version',
        depTarget: 'claude',
        depVersion: '>=1.0.0',
        depSource: 'declared',
        confidence: 1.0,
      })
    })

    it('should include model dependencies', () => {
      const declared: DependencyDeclaration = {
        models: {
          minimum: 'claude-3-sonnet',
          capabilities: ['tool_use', 'vision'],
          context_window: 200000,
        },
      }

      const result = mergeDependencies(declared, emptyInferred())

      expect(result).toHaveLength(3)

      const minimum = result.find((d) => d.depType === 'model_minimum')!
      expect(minimum.depTarget).toBe('claude-3-sonnet')
      expect(JSON.parse(minimum.metadata!)).toEqual({
        context_window: 200000,
      })

      const capabilities = result.filter((d) => d.depType === 'model_capability')
      expect(capabilities).toHaveLength(2)
      expect(capabilities.map((c) => c.depTarget)).toEqual(['tool_use', 'vision'])
    })

    it('should include environment dependencies', () => {
      const declared: DependencyDeclaration = {
        environment: {
          tools: [
            { name: 'git', required: true, check: 'git --version' },
            { name: 'docker', required: false },
          ],
          os: ['linux', 'darwin'],
          node: '>=20.0.0',
        },
      }

      const result = mergeDependencies(declared, emptyInferred())

      const tools = result.filter((d) => d.depType === 'env_tool')
      expect(tools).toHaveLength(2)
      expect(JSON.parse(tools[0].metadata!)).toEqual({
        required: true,
        check: 'git --version',
      })
      expect(JSON.parse(tools[1].metadata!)).toEqual({ required: false })

      const osEntries = result.filter((d) => d.depType === 'env_os')
      expect(osEntries).toHaveLength(2)
      expect(osEntries.map((o) => o.depTarget)).toEqual(['linux', 'darwin'])

      const nodeEntry = result.find((d) => d.depType === 'env_node')!
      expect(nodeEntry.depTarget).toBe('node')
      expect(nodeEntry.depVersion).toBe('>=20.0.0')
    })

    it('should merge full declared + inferred with no duplicates', () => {
      const declared: DependencyDeclaration = {
        skills: [{ name: 'auth', type: 'hard' }],
        platform: {
          cli: '>=1.0.0',
          mcp_servers: [{ name: 'linear', required: true }],
        },
        models: { minimum: 'claude-3-sonnet' },
      }

      const inferred = inferredServers(
        ['linear', 'claude-flow', 'skillsmith'],
        ['claude-flow', 'skillsmith']
      )

      const result = mergeDependencies(declared, inferred)

      // Declared: skill_hard(auth) + cli_version + mcp_server(linear) + model_minimum
      // Inferred: mcp_server(claude-flow, skillsmith) — linear skipped
      expect(result).toHaveLength(6)

      const mcpServers = result.filter((d) => d.depType === 'mcp_server')
      expect(mcpServers).toHaveLength(3)

      const linearEntry = mcpServers.find((d) => d.depTarget === 'linear')!
      expect(linearEntry.depSource).toBe('declared')

      const cfEntry = mcpServers.find((d) => d.depTarget === 'claude-flow')!
      expect(cfEntry.depSource).toBe('inferred_static')
      expect(cfEntry.confidence).toBe(0.9)

      const ssEntry = mcpServers.find((d) => d.depTarget === 'skillsmith')!
      expect(ssEntry.depSource).toBe('inferred_static')
      expect(ssEntry.confidence).toBe(0.9)
    })

    it('should handle declared-only with no inferred', () => {
      const declared: DependencyDeclaration = {
        skills: [{ name: 'helper', type: 'soft' }],
      }

      const result = mergeDependencies(declared, emptyInferred())

      expect(result).toHaveLength(1)
      expect(result[0].depType).toBe('skill_soft')
    })

    it('should ensure metadata is always a string or null', () => {
      const declared: DependencyDeclaration = {
        skills: [
          { name: 'with-reason', type: 'hard', reason: 'needed for auth' },
          { name: 'no-reason', type: 'soft' },
        ],
        platform: {
          mcp_servers: [{ name: 'linear', required: true }],
        },
      }

      const result = mergeDependencies(declared, emptyInferred())

      for (const dep of result) {
        expect(dep.metadata === null || typeof dep.metadata === 'string').toBe(true)

        // If metadata is a string, it must be valid JSON
        if (dep.metadata !== null) {
          expect(() => JSON.parse(dep.metadata!)).not.toThrow()
        }
      }
    })

    it('should handle conflicts', () => {
      // Use type assertion for forward-looking conflicts field
      const declared = {
        conflicts: [
          {
            name: 'bad-skill',
            versions: '>=2.0.0',
            reason: 'incompatible API',
          },
        ],
      } as unknown as DependencyDeclaration

      const result = mergeDependencies(declared, emptyInferred())

      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject<MergedDependency>({
        depType: 'conflict',
        depTarget: 'bad-skill',
        depVersion: '>=2.0.0',
        depSource: 'declared',
        confidence: 1.0,
        metadata: JSON.stringify({ reason: 'incompatible API' }),
      })
    })
  })
})
