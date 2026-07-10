/**
 * Tests for the MCP bare-command guard (SMI-5642).
 *
 * Covers: isBareCommand classification, findBareCommandServers detection +
 * message/remediation correctness, auditMcpConfigs source-merging + fail-
 * soft behavior + privacy-boundary regression, and filterDebounced's 24h
 * per-finding debounce.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'

import { makeFixtureTempDir } from './_lib/git-fixture-env.js'

const mod = await import('../lib/mcp-command-guard.mjs')
const { isBareCommand, findBareCommandServers, auditMcpConfigs, filterDebounced } = mod as {
  isBareCommand: (command: unknown) => boolean
  findBareCommandServers: (
    mcpServers: Record<string, { command?: string; type?: string; url?: string }> | undefined,
    sourceLabel: string
  ) => Array<{
    source: string
    server: string
    command: string
    message: string
    remediation: string
  }>
  auditMcpConfigs: (opts: { repoRoot: string; homeDir?: string }) => Array<{
    source: string
    server: string
    command: string
    message: string
    remediation: string
  }>
  filterDebounced: (
    findings: Array<{ source: string; server: string; command: string }>,
    statePath: string,
    hours?: number
  ) => Array<{ source: string; server: string; command: string }>
}

describe('SMI-5642: mcp-command-guard', () => {
  let tmp: string

  beforeEach(() => {
    tmp = makeFixtureTempDir('mcpguard')
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  describe('isBareCommand', () => {
    it('flags a plain bin name with no path', () => {
      expect(isBareCommand('aqe-mcp')).toBe(true)
    })

    it('does not flag npx/docker/node', () => {
      expect(isBareCommand('npx')).toBe(false)
      expect(isBareCommand('docker')).toBe(false)
      expect(isBareCommand('node')).toBe(false)
    })

    it('does not flag non-Node interpreters/launchers', () => {
      for (const cmd of ['python3', 'python', 'uv', 'uvx', 'bash', 'sh', 'zsh', 'ruby', 'go']) {
        expect(isBareCommand(cmd)).toBe(false)
      }
    })

    it('does not flag absolute or relative paths', () => {
      expect(isBareCommand('/usr/local/bin/foo')).toBe(false)
      expect(isBareCommand('./scripts/mcp-skillsmith-launcher.sh')).toBe(false)
      expect(isBareCommand('$CLAUDE_PROJECT_DIR/scripts/foo.sh')).toBe(false)
    })

    it('does not flag Windows absolute or UNC paths', () => {
      expect(isBareCommand('C:\\Users\\foo\\bin.exe')).toBe(false)
      expect(isBareCommand('\\\\server\\share\\bin.exe')).toBe(false)
    })

    it('returns false for non-string/empty input', () => {
      expect(isBareCommand(undefined)).toBe(false)
      expect(isBareCommand('')).toBe(false)
    })
  })

  describe('findBareCommandServers', () => {
    it('flags a bare-command entry with correct message/remediation', () => {
      const findings = findBareCommandServers(
        { aqe: { command: 'aqe-mcp' } },
        '~/.claude.json (project scope)'
      )
      expect(findings).toHaveLength(1)
      expect(findings[0]?.server).toBe('aqe')
      expect(findings[0]?.command).toBe('aqe-mcp')
      // Remediation must NOT assert the bin name is npx-installable as-is
      // (the aqe-mcp bin belongs to the "agentic-qe" package, not "aqe-mcp").
      expect(findings[0]?.remediation).not.toContain('npx aqe-mcp@')
      expect(findings[0]?.remediation).toContain('package name may differ')
    })

    it('skips hosted (type: http / url) entries', () => {
      const findings = findBareCommandServers(
        { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } },
        '.mcp.json'
      )
      expect(findings).toEqual([])
    })

    it('skips npx/docker/interpreter-fronted entries', () => {
      const findings = findBareCommandServers(
        {
          ruflo: { command: 'npx' },
          skillsmithDocRetrieval: { command: 'docker' },
          pythonServer: { command: 'python3' },
        },
        '.mcp.json'
      )
      expect(findings).toEqual([])
    })
  })

  describe('auditMcpConfigs', () => {
    it('reads and merges findings from both .mcp.json and ~/.claude.json project scope', () => {
      const home = join(tmp, 'home')
      mkdirSync(home, { recursive: true })
      writeFileSync(
        join(tmp, '.mcp.json'),
        JSON.stringify({ mcpServers: { badRepo: { command: 'bad-repo-bin' } } })
      )
      writeFileSync(
        join(home, '.claude.json'),
        JSON.stringify({
          projects: { [tmp]: { mcpServers: { badUser: { command: 'bad-user-bin' } } } },
        })
      )

      const findings = auditMcpConfigs({ repoRoot: tmp, homeDir: home })
      expect(findings.map((f) => f.server).sort()).toEqual(['badRepo', 'badUser'])
    })

    it('fails soft on missing files', () => {
      const home = join(tmp, 'home')
      mkdirSync(home, { recursive: true })
      expect(auditMcpConfigs({ repoRoot: tmp, homeDir: home })).toEqual([])
    })

    it('fails soft on malformed JSON without throwing', () => {
      const home = join(tmp, 'home')
      mkdirSync(home, { recursive: true })
      writeFileSync(join(tmp, '.mcp.json'), '{not valid json')
      writeFileSync(join(home, '.claude.json'), '{not valid json')
      expect(() => auditMcpConfigs({ repoRoot: tmp, homeDir: home })).not.toThrow()
      expect(auditMcpConfigs({ repoRoot: tmp, homeDir: home })).toEqual([])
    })

    it('privacy boundary: a secret adjacent to malformed JSON in ~/.claude.json never reaches findings or thrown errors', () => {
      const home = join(tmp, 'home')
      mkdirSync(home, { recursive: true })
      // Deliberately NOT shaped like a real secret-key format (no
      // "sk_live_"-style prefix) so this fixture can't trip GitHub's
      // secret-scanning push protection — the test only cares that
      // arbitrary adjacent content never leaks, not that this specific
      // string looks like a Stripe key.
      const secret = 'NOT-A-REAL-SECRET-test-marker-1234567890'
      // Malformed JSON (trailing garbage) with a secret-shaped string nearby —
      // JSON.parse's SyntaxError would embed a raw snippet of this if we
      // ever regress to surfacing err.message (see mcp-command-guard.mjs's
      // comment on why this catch block is deliberately silent).
      writeFileSync(join(home, '.claude.json'), `{"secret_value": "${secret}", "bad`)

      let caught: unknown = null
      let findings: unknown[] = []
      try {
        findings = auditMcpConfigs({ repoRoot: tmp, homeDir: home })
      } catch (err) {
        caught = err
      }
      expect(caught).toBeNull()
      expect(JSON.stringify(findings)).not.toContain(secret)
    })

    it('warns (does not throw) when projects has an unexpected shape', () => {
      const home = join(tmp, 'home')
      mkdirSync(home, { recursive: true })
      writeFileSync(join(home, '.claude.json'), JSON.stringify({ projects: 'not-an-object' }))
      expect(() => auditMcpConfigs({ repoRoot: tmp, homeDir: home })).not.toThrow()
    })

    it('documents entry.args blindness: a node/npx-fronted entry pointing at a stale global-bin path via args is NOT detected (scope limitation, not a bug)', () => {
      const home = join(tmp, 'home')
      mkdirSync(home, { recursive: true })
      writeFileSync(
        join(tmp, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            staleViaArgs: {
              command: 'node',
              args: ['/Users/x/.nvm/versions/node/v22.21.1/lib/node_modules/some-pkg/bin.js'],
            },
          },
        })
      )
      const findings = auditMcpConfigs({ repoRoot: tmp, homeDir: home })
      expect(findings).toEqual([]) // current heuristic only inspects `command`, not `args`
    })
  })

  describe('filterDebounced', () => {
    it('surfaces a finding on first run and persists state', () => {
      const statePath = join(tmp, 'state.json')
      const findings = [{ source: '.mcp.json', server: 'aqe', command: 'aqe-mcp' }]
      const surfaced = filterDebounced(findings, statePath)
      expect(surfaced).toHaveLength(1)
      const state = JSON.parse(readFileSync(statePath, 'utf-8'))
      expect(Object.keys(state)).toHaveLength(1)
    })

    it('suppresses the same finding on a second run within the debounce window', () => {
      const statePath = join(tmp, 'state.json')
      const findings = [{ source: '.mcp.json', server: 'aqe', command: 'aqe-mcp' }]
      filterDebounced(findings, statePath, 24)
      const secondRun = filterDebounced(findings, statePath, 24)
      expect(secondRun).toHaveLength(0)
    })

    it('re-surfaces immediately when the command changes, even within the debounce window', () => {
      const statePath = join(tmp, 'state.json')
      filterDebounced([{ source: '.mcp.json', server: 'aqe', command: 'aqe-mcp' }], statePath, 24)
      const changed = filterDebounced(
        [{ source: '.mcp.json', server: 'aqe', command: 'aqe-mcp-v2' }],
        statePath,
        24
      )
      expect(changed).toHaveLength(1)
    })

    it('drops a finding that is no longer present from the next state write', () => {
      const statePath = join(tmp, 'state.json')
      filterDebounced([{ source: '.mcp.json', server: 'aqe', command: 'aqe-mcp' }], statePath, 24)
      filterDebounced([], statePath, 24)
      const state = JSON.parse(readFileSync(statePath, 'utf-8'))
      expect(Object.keys(state)).toHaveLength(0)
    })

    it('re-surfaces after the debounce window has passed', () => {
      const statePath = join(tmp, 'state.json')
      const findings = [{ source: '.mcp.json', server: 'aqe', command: 'aqe-mcp' }]
      // 0-hour debounce means "already expired" for any elapsed time.
      filterDebounced(findings, statePath, 24)
      const afterExpiry = filterDebounced(findings, statePath, 0)
      expect(afterExpiry).toHaveLength(1)
    })
  })
})
