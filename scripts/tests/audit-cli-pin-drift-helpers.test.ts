/**
 * Tests for the SMI-5746 CLI-tool pin invariant helpers (Check 59 in
 * audit-standards.mjs).
 *
 * Background: Dependabot only scans package.json/package-lock.json,
 * GitHub Actions versions, and the root Dockerfile base image — it has no
 * visibility into standalone CLI-tool binaries pinned outside those
 * manifests. Two real production incidents (SMI-4741, SMI-4353/SMI-4947)
 * trace back to an unpinned Supabase CLI install floating on `latest` in
 * CI. See docs/internal/implementation/cli-tool-version-drift-remediation.md
 * for the full incident history and design rationale.
 *
 * Each helper is a pure detector — it never modifies a pin. Check 59 itself
 * only wires these into pass()/warn()/fail() calls (warn during the
 * two-week shadow burn-in, fail after).
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error - .mjs helper has no typings
import {
  findFloatingSupabaseCliInstalls,
  findUnpinnedBareNpxCliInPackageJson,
  findUnpinnedRufloMcpEntry,
  findClaudeFlowReintroductions,
} from '../audit-cli-pin-drift-helpers.mjs'

const scratchDirs: string[] = []
function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-pin-drift-test-'))
  scratchDirs.push(dir)
  return dir
}

afterEach(() => {
  while (scratchDirs.length) {
    const dir = scratchDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('findFloatingSupabaseCliInstalls (SMI-5746 Check 59, sub-check 1)', () => {
  it('flags a supabase/setup-cli step pinned to version: latest', () => {
    const dir = scratchDir()
    writeFileSync(
      join(dir, 'deploy.yml'),
      [
        'jobs:',
        '  x:',
        '    steps:',
        '      - name: Install Supabase CLI',
        '        uses: supabase/setup-cli@abc123',
        '        with:',
        '          version: latest',
      ].join('\n')
    )

    const findings = findFloatingSupabaseCliInstalls(dir)

    expect(findings).toEqual([{ file: 'deploy.yml', line: 5, versionLine: 'latest' }])
  })

  it('flags a supabase/setup-cli step with no version: input at all', () => {
    const dir = scratchDir()
    writeFileSync(
      join(dir, 'deploy.yml'),
      [
        'jobs:',
        '  x:',
        '    steps:',
        '      - uses: supabase/setup-cli@abc123',
        '      - name: Deploy',
      ].join('\n')
    )

    const findings = findFloatingSupabaseCliInstalls(dir)

    expect(findings).toEqual([{ file: 'deploy.yml', line: 4, versionLine: null }])
  })

  it('does not flag a step pinned to an exact version or a step-output expression', () => {
    const dir = scratchDir()
    writeFileSync(
      join(dir, 'deploy.yml'),
      [
        'jobs:',
        '  x:',
        '    steps:',
        '      - uses: supabase/setup-cli@abc123',
        '        with:',
        '          version: 2.107.0',
        '      - uses: supabase/setup-cli@abc123',
        '        with:',
        '          version: ${{ steps.supabase-pin.outputs.version }}',
      ].join('\n')
    )

    expect(findFloatingSupabaseCliInstalls(dir)).toEqual([])
  })

  it('returns no findings when the workflows directory does not exist', () => {
    expect(findFloatingSupabaseCliInstalls(join(scratchDir(), 'nonexistent'))).toEqual([])
  })
})

describe('findUnpinnedBareNpxCliInPackageJson (SMI-5746 Check 59, sub-check 2)', () => {
  it('flags a bare "npx wrangler" script with no matching devDependency pin', () => {
    const dir = scratchDir()
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { deploy: 'npx wrangler deploy' }, devDependencies: {} })
    )

    const findings = findUnpinnedBareNpxCliInPackageJson(dir)

    expect(findings).toEqual([{ file: 'package.json', script: 'deploy', tool: 'wrangler' }])
  })

  it('does not flag "npx wrangler" when wrangler is an exact-pinned devDependency', () => {
    const dir = scratchDir()
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        scripts: { deploy: 'npx wrangler deploy' },
        devDependencies: { wrangler: '4.112.0' },
      })
    )

    expect(findUnpinnedBareNpxCliInPackageJson(dir)).toEqual([])
  })

  it('does not flag an already-pinned "npx supabase@<version>" invocation', () => {
    const dir = scratchDir()
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { deploy: 'npx supabase@2.107.0 db push' }, devDependencies: {} })
    )

    expect(findUnpinnedBareNpxCliInPackageJson(dir)).toEqual([])
  })

  it('resolves a workspace package devDependency via the root package.json (hoisting)', () => {
    const dir = scratchDir()
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ devDependencies: { supabase: '2.107.0' } })
    )
    mkdirSync(join(dir, 'packages', 'website'), { recursive: true })
    writeFileSync(
      join(dir, 'packages', 'website', 'package.json'),
      JSON.stringify({ scripts: { deploy: 'npx supabase functions deploy' }, devDependencies: {} })
    )

    expect(findUnpinnedBareNpxCliInPackageJson(dir)).toEqual([])
  })
})

describe('findUnpinnedRufloMcpEntry (SMI-5746 Check 59, sub-check 3)', () => {
  it('flags a ruflo npx entry pinned to a non-exact-semver tag', () => {
    const dir = scratchDir()
    const mcpPath = join(dir, 'mcp.json')
    writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: { ruflo: { command: 'npx', args: ['ruflo@latest', 'mcp', 'start'] } },
      })
    )

    const finding = findUnpinnedRufloMcpEntry(mcpPath)

    expect(finding).toEqual({
      reason: "ruflo npx entry pinned to a non-exact-semver tag 'latest'",
      pkgArg: 'ruflo@latest',
    })
  })

  it('flags a ruflo npx entry missing an @version suffix entirely', () => {
    const dir = scratchDir()
    const mcpPath = join(dir, 'mcp.json')
    writeFileSync(
      mcpPath,
      JSON.stringify({ mcpServers: { ruflo: { command: 'npx', args: ['ruflo', 'mcp'] } } })
    )

    expect(findUnpinnedRufloMcpEntry(mcpPath)).toEqual({
      reason: 'ruflo npx entry missing an @version suffix',
      pkgArg: 'ruflo',
    })
  })

  it('does not flag a ruflo entry pinned to an exact semver', () => {
    const dir = scratchDir()
    const mcpPath = join(dir, 'mcp.json')
    writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: { ruflo: { command: 'npx', args: ['ruflo@3.14.2', 'mcp', 'start'] } },
      })
    )

    expect(findUnpinnedRufloMcpEntry(mcpPath)).toBeNull()
  })

  it('does not flag a non-npx server entry (the worktree .mcp.json auto-patch case)', () => {
    // Regression guard for Codex plan-review finding #2: create-worktree.sh
    // step 6 auto-patches the `skillsmith` entry to a bare unversioned npx
    // command in a worktree's local .mcp.json (skip-worktree, never
    // committed). Check 59 is deliberately scoped to `ruflo` only so that
    // worktree-local artifact is never mistaken for a real violation.
    const dir = scratchDir()
    const mcpPath = join(dir, 'mcp.json')
    writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          skillsmith: { command: 'npx', args: ['-y', '@skillsmith/mcp-server'] },
          ruflo: { command: 'npx', args: ['ruflo@3.14.2', 'mcp', 'start'] },
        },
      })
    )

    expect(findUnpinnedRufloMcpEntry(mcpPath)).toBeNull()
  })

  it('returns null when .mcp.json does not exist', () => {
    expect(findUnpinnedRufloMcpEntry(join(scratchDir(), 'nonexistent.json'))).toBeNull()
  })
})

describe('findClaudeFlowReintroductions (SMI-5746 Check 59, sub-check 4)', () => {
  it('flags a bare "npx claude-flow" invocation in a scripts/*.sh file', () => {
    const dir = scratchDir()
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'scripts', 'launch.sh'), 'echo start\nnpx claude-flow swarm "test"\n')

    const findings = findClaudeFlowReintroductions(dir)

    expect(findings).toEqual([{ file: join('scripts', 'launch.sh'), line: 2 }])
  })

  it('excludes scripts/prompts/ — historical planning docs, not live invocations', () => {
    const dir = scratchDir()
    mkdirSync(join(dir, 'scripts', 'prompts'), { recursive: true })
    writeFileSync(
      join(dir, 'scripts', 'prompts', 'old-plan.md'),
      'npx claude-flow@alpha swarm "historical"\n'
    )

    expect(findClaudeFlowReintroductions(dir)).toEqual([])
  })

  it('excludes a comment line referencing a historical SMI migration ticket', () => {
    const dir = scratchDir()
    mkdirSync(join(dir, 'packages', 'core', 'src'), { recursive: true })
    writeFileSync(
      join(dir, 'packages', 'core', 'src', 'session.ts'),
      '/**\n * @see SMI-3601: Migrate npx claude-flow CLI calls to npx ruflo\n */\n'
    )

    expect(findClaudeFlowReintroductions(dir)).toEqual([])
  })

  it('flags a real (non-comment) reintroduction in packages/*/src', () => {
    const dir = scratchDir()
    mkdirSync(join(dir, 'packages', 'core', 'src'), { recursive: true })
    writeFileSync(
      join(dir, 'packages', 'core', 'src', 'launcher.ts'),
      "export const cmd = 'npx claude-flow swarm'\n"
    )

    expect(findClaudeFlowReintroductions(dir)).toEqual([
      { file: join('packages', 'core', 'src', 'launcher.ts'), line: 1 },
    ])
  })

  it('flags a reintroduction in .claude/helpers/*.sh', () => {
    const dir = scratchDir()
    mkdirSync(join(dir, '.claude', 'helpers'), { recursive: true })
    writeFileSync(
      join(dir, '.claude', 'helpers', 'setup.sh'),
      'echo "  - npx claude-flow github swarm"\n'
    )

    expect(findClaudeFlowReintroductions(dir)).toEqual([
      { file: join('.claude', 'helpers', 'setup.sh'), line: 1 },
    ])
  })

  it('flags a reintroduction in .claude/settings.json and docker-compose.yml directly', () => {
    const dir = scratchDir()
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(
      join(dir, '.claude', 'settings.json'),
      '{"permissions":{"allow":["Bash(npx claude-flow:*)"]}}'
    )
    writeFileSync(
      join(dir, 'docker-compose.yml'),
      "test: ['CMD', 'npx', 'claude-flow', '--version']\n"
    )

    const findings = findClaudeFlowReintroductions(dir)

    expect(findings).toEqual(
      expect.arrayContaining([
        { file: '.claude/settings.json', line: 1 },
        { file: 'docker-compose.yml', line: 1 },
      ])
    )
    expect(findings).toHaveLength(2)
  })
})
