/**
 * Tests for the MCP command guard (SMI-5642 bare-command check; SMI-6229
 * plugin-config scan + hosted-scope check).
 *
 * Covers: isBareCommand classification, findBareCommandServers detection +
 * message/remediation correctness, findHostedScopeViolations scope-rule
 * evaluation, auditMcpConfigs source-merging (repo .mcp.json,
 * ~/.claude.json, and every enabled plugin's pinned-cache .mcp.json) +
 * fail-soft behavior + privacy-boundary regression, and filterDebounced's
 * 24h per-finding debounce across both finding shapes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'node:url'

import { makeFixtureEnv, makeFixtureTempDir } from './_lib/git-fixture-env.js'

type Finding = {
  check?: 'bare-command' | 'hosted-scope'
  source: string
  server: string
  command?: string
  url?: string
  message: string
  remediation: string
}

const mod = await import('../lib/mcp-command-guard.mjs')
const {
  isBareCommand,
  findBareCommandServers,
  findHostedScopeViolations,
  auditMcpConfigs,
  filterDebounced,
} = mod as {
  isBareCommand: (command: unknown) => boolean
  findBareCommandServers: (
    mcpServers: Record<string, { command?: string; type?: string; url?: string }> | undefined,
    sourceLabel: string
  ) => Finding[]
  findHostedScopeViolations: (
    mcpServers: Record<string, { url?: string; type?: string }> | undefined,
    sourceLabel: string
  ) => Finding[]
  auditMcpConfigs: (opts: { repoRoot: string; homeDir?: string }) => Finding[]
  filterDebounced: (
    findings: Array<{ source: string; server: string; command?: string; url?: string }>,
    statePath: string,
    hours?: number
  ) => Array<{ source: string; server: string; command?: string; url?: string }>
}

// Real files this suite spawns the shell wrapper against for the disable-var
// regression test (case 24a) — resolved relative to this test file so it
// works regardless of cwd.
const GUARD_MJS = fileURLToPath(new URL('../lib/mcp-command-guard.mjs', import.meta.url))
const PLUGIN_SCAN_MJS = fileURLToPath(
  new URL('../lib/mcp-command-guard.plugin-scan.mjs', import.meta.url)
)
const HOOK_SH = fileURLToPath(new URL('../session-start-mcp-command-guard.sh', import.meta.url))

/** Write `<home>/.claude/settings.json` with the given enabledPlugins map. */
function writeSettings(home: string, enabledPlugins: Record<string, unknown>): void {
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins }))
}

/** Write `<home>/.claude/plugins/cache/<marketplace>/<plugin>/<version>/.mcp.json`. */
function writePluginConfig(
  home: string,
  marketplace: string,
  plugin: string,
  version: string,
  mcpServers: Record<string, unknown>
): string {
  const versionDir = join(home, '.claude', 'plugins', 'cache', marketplace, plugin, version)
  mkdirSync(versionDir, { recursive: true })
  const configPath = join(versionDir, '.mcp.json')
  writeFileSync(configPath, JSON.stringify({ mcpServers }))
  return configPath
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

  describe('findHostedScopeViolations', () => {
    it('1. ?features=docs -> no finding (the real, correct current state)', () => {
      const findings = findHostedScopeViolations(
        { supabase: { url: 'https://mcp.supabase.com/mcp?features=docs' } },
        'plugin:postgres-best-practices@supabase-agent-skills'
      )
      expect(findings).toEqual([])
    })

    it('2. no features param at all -> one finding naming the missing-scoping case', () => {
      const findings = findHostedScopeViolations(
        { supabase: { url: 'https://mcp.supabase.com/mcp' } },
        '.mcp.json'
      )
      expect(findings).toHaveLength(1)
      expect(findings[0]?.check).toBe('hosted-scope')
      expect(findings[0]?.message).toContain('no "features" scoping')
    })

    it('3. ?features=docs,database -> one finding listing the actual groups', () => {
      const findings = findHostedScopeViolations(
        { supabase: { url: 'https://mcp.supabase.com/mcp?features=docs,database' } },
        '.mcp.json'
      )
      expect(findings).toHaveLength(1)
      // Groups are sorted alphabetically in the message ("database,docs"),
      // not in the order the caller supplied them — assert both are named
      // rather than depend on a specific ordering.
      expect(findings[0]?.message).toContain('database')
      expect(findings[0]?.message).toContain('docs')
      expect(findings[0]?.message).toContain('write-capable tool groups')
    })

    it('4. ?features=database -> one finding', () => {
      const findings = findHostedScopeViolations(
        { supabase: { url: 'https://mcp.supabase.com/mcp?features=database' } },
        '.mcp.json'
      )
      expect(findings).toHaveLength(1)
    })

    it('5. ?features=DOCS -> no finding (case/whitespace normalization)', () => {
      const findings = findHostedScopeViolations(
        { supabase: { url: 'https://mcp.supabase.com/mcp?features= DOCS ' } },
        '.mcp.json'
      )
      expect(findings).toEqual([])
    })

    it('6. repeated ?features= param -> one finding (getAll vs get trap)', () => {
      const findings = findHostedScopeViolations(
        { supabase: { url: 'https://mcp.supabase.com/mcp?features=docs&features=database' } },
        '.mcp.json'
      )
      expect(findings).toHaveLength(1)
      expect(findings[0]?.message).toContain('database')
    })

    it('7. ?features= present but empty -> one finding, treated as unscoped', () => {
      const findings = findHostedScopeViolations(
        { supabase: { url: 'https://mcp.supabase.com/mcp?features=' } },
        '.mcp.json'
      )
      expect(findings).toHaveLength(1)
      expect(findings[0]?.message).toContain('no "features" scoping')
    })

    it('8. different host -> no finding', () => {
      const findings = findHostedScopeViolations(
        { linear: { url: 'https://mcp.linear.app/mcp' } },
        '.mcp.json'
      )
      expect(findings).toEqual([])
    })

    it('9. malformed url string -> no finding, does not throw', () => {
      expect(() =>
        findHostedScopeViolations({ bad: { url: 'not a url::: ' } }, '.mcp.json')
      ).not.toThrow()
      expect(findHostedScopeViolations({ bad: { url: 'not a url::: ' } }, '.mcp.json')).toEqual([])
    })

    it('10. a stdio entry -> no finding from this check (ownership boundary)', () => {
      const findings = findHostedScopeViolations({ foo: { command: 'foo' } }, '.mcp.json')
      expect(findings).toEqual([])
    })

    it('10a. documented edge case: a truthy non-string url plus a bare command is skipped by BOTH checks (plan-review Low #11)', () => {
      const entry = { weird: { command: 'bad-bin', url: 12345 } }
      // findBareCommandServers treats a truthy `url` (regardless of type) as
      // hosted and skips it.
      expect(findBareCommandServers(entry as never, '.mcp.json')).toEqual([])
      // findHostedScopeViolations requires typeof url === 'string' and bails.
      expect(findHostedScopeViolations(entry as never, '.mcp.json')).toEqual([])
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

  describe('auditMcpConfigs — plugin source', () => {
    it('11. enabled plugin with an unscoped server surfaces a finding', () => {
      const home = join(tmp, 'home')
      writeSettings(home, { 'foo@bar': true })
      writePluginConfig(home, 'bar', 'foo', 'v1', {
        supabase: { type: 'http', url: 'https://mcp.supabase.com/mcp' },
      })
      const findings = auditMcpConfigs({ repoRoot: tmp, homeDir: home })
      expect(findings).toHaveLength(1)
      expect(findings[0]?.source).toBe('plugin:foo@bar')
    })

    it('12. enabled plugin with ?features=docs -> nothing', () => {
      const home = join(tmp, 'home')
      writeSettings(home, { 'foo@bar': true })
      writePluginConfig(home, 'bar', 'foo', 'v1', {
        supabase: { type: 'http', url: 'https://mcp.supabase.com/mcp?features=docs' },
      })
      expect(auditMcpConfigs({ repoRoot: tmp, homeDir: home })).toEqual([])
    })

    it('13. disabled plugin (false) with an unscoped server does NOT surface — the exact-true gate', () => {
      const home = join(tmp, 'home')
      writeSettings(home, { 'foo@bar': false })
      writePluginConfig(home, 'bar', 'foo', 'v1', {
        supabase: { type: 'http', url: 'https://mcp.supabase.com/mcp' },
      })
      expect(auditMcpConfigs({ repoRoot: tmp, homeDir: home })).toEqual([])
    })

    it('14. non-boolean value ("true") does not surface', () => {
      const home = join(tmp, 'home')
      writeSettings(home, { 'foo@bar': 'true' })
      writePluginConfig(home, 'bar', 'foo', 'v1', {
        supabase: { type: 'http', url: 'https://mcp.supabase.com/mcp' },
      })
      expect(auditMcpConfigs({ repoRoot: tmp, homeDir: home })).toEqual([])
    })

    it('15. no settings.json -> no plugin findings, no stderr', () => {
      const home = join(tmp, 'home')
      mkdirSync(home, { recursive: true })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(auditMcpConfigs({ repoRoot: tmp, homeDir: home })).toEqual([])
        expect(errorSpy).not.toHaveBeenCalled()
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('16. settings.json with no enabledPlugins key -> no plugin findings, no stderr', () => {
      const home = join(tmp, 'home')
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ other: true }))
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(auditMcpConfigs({ repoRoot: tmp, homeDir: home })).toEqual([])
        expect(errorSpy).not.toHaveBeenCalled()
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('17. missing plugins/cache directory entirely -> no plugin findings, no stderr', () => {
      const home = join(tmp, 'home')
      writeSettings(home, { 'foo@bar': true })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(auditMcpConfigs({ repoRoot: tmp, homeDir: home })).toEqual([])
        expect(errorSpy).not.toHaveBeenCalled()
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('18. malformed plugin id shapes are skipped, does not throw', () => {
      const home = join(tmp, 'home')
      writeSettings(home, { noatsign: true, '@bar': true, 'foo@': true })
      expect(() => auditMcpConfigs({ repoRoot: tmp, homeDir: home })).not.toThrow()
      expect(auditMcpConfigs({ repoRoot: tmp, homeDir: home })).toEqual([])
    })

    it('19. zero version directories -> skipped silently', () => {
      const home = join(tmp, 'home')
      writeSettings(home, { 'foo@bar': true })
      mkdirSync(join(home, '.claude', 'plugins', 'cache', 'bar', 'foo'), { recursive: true })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(auditMcpConfigs({ repoRoot: tmp, homeDir: home })).toEqual([])
        expect(errorSpy).not.toHaveBeenCalled()
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('20. two version directories -> skipped silently (no stderr)', () => {
      const home = join(tmp, 'home')
      writeSettings(home, { 'foo@bar': true })
      const pluginDir = join(home, '.claude', 'plugins', 'cache', 'bar', 'foo')
      mkdirSync(join(pluginDir, 'v1'), { recursive: true })
      mkdirSync(join(pluginDir, 'v2'), { recursive: true })
      writeFileSync(
        join(pluginDir, 'v1', '.mcp.json'),
        JSON.stringify({
          mcpServers: { supabase: { type: 'http', url: 'https://mcp.supabase.com/mcp' } },
        })
      )
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(auditMcpConfigs({ repoRoot: tmp, homeDir: home })).toEqual([])
        expect(errorSpy).not.toHaveBeenCalled()
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('21. malformed settings.json JSON does not throw and never leaks adjacent content into findings or stderr', () => {
      const home = join(tmp, 'home')
      mkdirSync(join(home, '.claude'), { recursive: true })
      const secret = 'NOT-A-REAL-SECRET-test-marker-1234567890'
      writeFileSync(join(home, '.claude', 'settings.json'), `{"secret_value": "${secret}", "bad`)

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      let caught: unknown = null
      let findings: unknown[] = []
      try {
        findings = auditMcpConfigs({ repoRoot: tmp, homeDir: home })
      } catch (err) {
        caught = err
      } finally {
        const loggedText = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n')
        errorSpy.mockRestore()
        expect(loggedText).not.toContain(secret)
      }
      expect(caught).toBeNull()
      expect(findings).toEqual([])
      expect(JSON.stringify(findings)).not.toContain(secret)
    })

    it('22. enabledPlugins not an object does not throw, and logs one stderr line', () => {
      const home = join(tmp, 'home')
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(
        join(home, '.claude', 'settings.json'),
        JSON.stringify({ enabledPlugins: 'not-an-object' })
      )
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(() => auditMcpConfigs({ repoRoot: tmp, homeDir: home })).not.toThrow()
        expect(errorSpy).toHaveBeenCalledTimes(1)
        expect(String(errorSpy.mock.calls[0]?.[0])).toContain('enabledPlugins is not an object')
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('23. two enabled plugins each registering a server named "supabase", one scoped and one not -> exactly one finding, correctly attributed', () => {
      const home = join(tmp, 'home')
      writeSettings(home, { 'foo@bar': true, 'baz@bar': true })
      writePluginConfig(home, 'bar', 'foo', 'v1', {
        supabase: { type: 'http', url: 'https://mcp.supabase.com/mcp?features=docs' },
      })
      writePluginConfig(home, 'bar', 'baz', 'v1', {
        supabase: { type: 'http', url: 'https://mcp.supabase.com/mcp' },
      })
      const findings = auditMcpConfigs({ repoRoot: tmp, homeDir: home })
      expect(findings).toHaveLength(1)
      expect(findings[0]?.source).toBe('plugin:baz@bar')
    })

    it('24. a plugin finding and a repo .mcp.json bare-command finding coexist — both returned, neither suppresses the other', () => {
      const home = join(tmp, 'home')
      writeSettings(home, { 'foo@bar': true })
      writePluginConfig(home, 'bar', 'foo', 'v1', {
        supabase: { type: 'http', url: 'https://mcp.supabase.com/mcp' },
      })
      writeFileSync(
        join(tmp, '.mcp.json'),
        JSON.stringify({ mcpServers: { badRepo: { command: 'bad-repo-bin' } } })
      )
      const findings = auditMcpConfigs({ repoRoot: tmp, homeDir: home })
      expect(findings).toHaveLength(2)
      expect(findings.some((f) => f.source === 'plugin:foo@bar')).toBe(true)
      expect(findings.some((f) => f.source === '.mcp.json' && f.server === 'badRepo')).toBe(true)
    })

    it('24a. SKILLSMITH_MCP_COMMAND_GUARD_DISABLE=1 suppresses all three sources and both check types', () => {
      const repo = makeFixtureTempDir('mcpguard-disable')
      try {
        spawnSync('git', ['init', '-q'], { cwd: repo, env: makeFixtureEnv() })

        const scriptsLibDir = join(repo, 'scripts', 'lib')
        mkdirSync(scriptsLibDir, { recursive: true })
        copyFileSync(GUARD_MJS, join(scriptsLibDir, 'mcp-command-guard.mjs'))
        copyFileSync(PLUGIN_SCAN_MJS, join(scriptsLibDir, 'mcp-command-guard.plugin-scan.mjs'))
        const hookPath = join(repo, 'scripts', 'session-start-mcp-command-guard.sh')
        copyFileSync(HOOK_SH, hookPath)
        chmodSync(hookPath, 0o755)

        // Unscoped repo .mcp.json bare-command server — bare-command check.
        writeFileSync(
          join(repo, '.mcp.json'),
          JSON.stringify({ mcpServers: { badRepo: { command: 'bad-repo-bin' } } })
        )

        // Unscoped plugin-sourced hosted server — hosted-scope check, plugin source.
        const fakeHome = join(repo, 'fake-home')
        writeSettings(fakeHome, { 'foo@bar': true })
        writePluginConfig(fakeHome, 'bar', 'foo', 'v1', {
          supabase: { type: 'http', url: 'https://mcp.supabase.com/mcp' },
        })

        const input = JSON.stringify({
          source: 'startup',
          cwd: repo,
          session_id: 't',
          transcript_path: '',
        })

        // Sanity: without the disable var, the fixture actually fires (both
        // a bare-command finding and a hosted-scope finding land on stderr).
        const enabledRun = spawnSync('bash', [hookPath], {
          cwd: repo,
          input,
          env: { ...makeFixtureEnv(), HOME: fakeHome },
          encoding: 'utf-8',
        })
        expect(enabledRun.stderr).toContain('badRepo')
        expect(enabledRun.stderr).toContain('foo@bar')

        // With the disable var, both the pre-existing and the two new
        // finding types across all three sources are fully suppressed.
        const disabledRun = spawnSync('bash', [hookPath], {
          cwd: repo,
          input,
          env: {
            ...makeFixtureEnv(),
            HOME: fakeHome,
            SKILLSMITH_MCP_COMMAND_GUARD_DISABLE: '1',
          },
          encoding: 'utf-8',
        })
        expect(disabledRun.stderr).toBe('')
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
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

    it('25. a hosted-scope finding surfaces once, then is debounced within the window', () => {
      const statePath = join(tmp, 'state.json')
      const findings = [
        { source: 'plugin:foo@bar', server: 'supabase', url: 'https://mcp.supabase.com/mcp' },
      ]
      const first = filterDebounced(findings, statePath, 24)
      expect(first).toHaveLength(1)
      const second = filterDebounced(findings, statePath, 24)
      expect(second).toHaveLength(0)
    })

    it('26. changing only the url re-surfaces a hosted-scope finding immediately (SMI-4861-class regression guard)', () => {
      const statePath = join(tmp, 'state.json')
      filterDebounced(
        [{ source: 'plugin:foo@bar', server: 'supabase', url: 'https://mcp.supabase.com/mcp' }],
        statePath,
        24
      )
      const changed = filterDebounced(
        [
          {
            source: 'plugin:foo@bar',
            server: 'supabase',
            url: 'https://mcp.supabase.com/mcp?features=database',
          },
        ],
        statePath,
        24
      )
      expect(changed).toHaveLength(1)
    })

    it('27. a state file written in the pre-change key format still debounces its bare-command finding', () => {
      const statePath = join(tmp, 'state.json')
      const legacyKey = createHash('sha256').update('.mcp.json aqe aqe-mcp').digest('hex')
      mkdirSync(dirname(statePath), { recursive: true })
      writeFileSync(statePath, JSON.stringify({ [legacyKey]: new Date().toISOString() }))
      const surfaced = filterDebounced(
        [{ source: '.mcp.json', server: 'aqe', command: 'aqe-mcp' }],
        statePath,
        24
      )
      expect(surfaced).toHaveLength(0)
    })
  })
})
