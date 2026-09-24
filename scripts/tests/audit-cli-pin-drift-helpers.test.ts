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
  findUnpinnedRufloLauncherPin,
  findRufloSeedPinDrift,
  findProcScanCmdHintDrift,
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

describe('findUnpinnedRufloLauncherPin (SMI-5746 Check 59, sub-check 3; SMI-6744 ADR-170 §7)', () => {
  // ADR-170 § 7: the pin moved from .mcp.json's npx entry (retired --
  // ruflo is now invoked via scripts/mcp-ruflo-launcher.sh, which docker
  // execs into an image-baked tree) into one RUFLO_CLI_PIN=<semver>
  // assignment in that launcher script itself.
  it('flags a launcher with no RUFLO_CLI_PIN line at all', () => {
    const dir = scratchDir()
    const launcherPath = join(dir, 'mcp-ruflo-launcher.sh')
    writeFileSync(launcherPath, '#!/usr/bin/env bash\nset -euo pipefail\necho hi\n')

    expect(findUnpinnedRufloLauncherPin(launcherPath)).toEqual({
      reason: `RUFLO_CLI_PIN not found in ${launcherPath}`,
      launcherPath,
    })
  })

  it('flags a RUFLO_CLI_PIN pinned to a non-exact-semver value', () => {
    const dir = scratchDir()
    const launcherPath = join(dir, 'mcp-ruflo-launcher.sh')
    writeFileSync(launcherPath, '#!/usr/bin/env bash\nRUFLO_CLI_PIN=latest\necho hi\n')

    expect(findUnpinnedRufloLauncherPin(launcherPath)).toEqual({
      reason: `RUFLO_CLI_PIN 'latest' in ${launcherPath} is not an exact semver`,
      launcherPath,
      pin: 'latest',
    })
  })

  it('does not flag a RUFLO_CLI_PIN pinned to an exact semver', () => {
    const dir = scratchDir()
    const launcherPath = join(dir, 'mcp-ruflo-launcher.sh')
    writeFileSync(launcherPath, '#!/usr/bin/env bash\nRUFLO_CLI_PIN=3.42.4\necho hi\n')

    expect(findUnpinnedRufloLauncherPin(launcherPath)).toBeNull()
  })

  it('requires the assignment to be anchored to its own line (not embedded in other text)', () => {
    const dir = scratchDir()
    const launcherPath = join(dir, 'mcp-ruflo-launcher.sh')
    // A reference to RUFLO_CLI_PIN inside a comment or a larger line (not a
    // bare "RUFLO_CLI_PIN=<value>" line by itself) must not satisfy the
    // anchored regex -- this is what "found" actually means for Check 59
    // and for cli-pin-drift-check.sh's own grep, which read the same shape.
    writeFileSync(launcherPath, '# see RUFLO_CLI_PIN=3.42.4 below for context\necho hi\n')

    expect(findUnpinnedRufloLauncherPin(launcherPath)).toEqual({
      reason: `RUFLO_CLI_PIN not found in ${launcherPath}`,
      launcherPath,
    })
  })

  it('flags a missing launcher file by name', () => {
    const launcherPath = join(scratchDir(), 'nonexistent-launcher.sh')

    expect(findUnpinnedRufloLauncherPin(launcherPath)).toEqual({
      reason: `RUFLO_CLI_PIN launcher not found at ${launcherPath}`,
      launcherPath,
    })
  })

  it('does not flag the real, committed scripts/mcp-ruflo-launcher.sh', () => {
    // End-to-end regression anchor: this check must actually pass against
    // the real launcher this PR ships, not only against fixtures.
    const realLauncherPath = join(process.cwd(), 'scripts', 'mcp-ruflo-launcher.sh')

    expect(findUnpinnedRufloLauncherPin(realLauncherPath)).toBeNull()
  })
})

describe('findRufloSeedPinDrift (SMI-6744 M-3, post-merge governance retro on PR #2931)', () => {
  function writeLauncher(dir: string, pin: string): string {
    const p = join(dir, 'mcp-ruflo-launcher.sh')
    writeFileSync(p, `#!/usr/bin/env bash\nRUFLO_CLI_PIN=${pin}\necho hi\n`)
    return p
  }
  function writeSeedPackageJson(dir: string, pin: string | undefined): string {
    mkdirSync(join(dir, 'ruflo-seed'), { recursive: true })
    const p = join(dir, 'ruflo-seed', 'package.json')
    const body = pin === undefined ? {} : { dependencies: { '@claude-flow/cli': pin } }
    writeFileSync(p, JSON.stringify(body))
    return p
  }

  it('does not flag matching pins', () => {
    const dir = scratchDir()
    const launcherPath = writeLauncher(dir, '3.42.4')
    const seedPath = writeSeedPackageJson(dir, '3.42.4')

    expect(findRufloSeedPinDrift(launcherPath, seedPath)).toBeNull()
  })

  it('flags a seed package.json pin that differs from the launcher pin, naming both values and both paths', () => {
    const dir = scratchDir()
    const launcherPath = writeLauncher(dir, '3.42.4')
    const seedPath = writeSeedPackageJson(dir, '3.41.0')

    expect(findRufloSeedPinDrift(launcherPath, seedPath)).toEqual({
      reason: `RUFLO_CLI_PIN=3.42.4 in ${launcherPath} does not match dependencies["@claude-flow/cli"]=3.41.0 in ${seedPath}`,
      launcherPath,
      seedPackageJsonPath: seedPath,
      launcherPin: '3.42.4',
      seedPin: '3.41.0',
    })
  })

  it('flags a missing dependencies["@claude-flow/cli"] entry in the seed package.json', () => {
    const dir = scratchDir()
    const launcherPath = writeLauncher(dir, '3.42.4')
    const seedPath = writeSeedPackageJson(dir, undefined)

    expect(findRufloSeedPinDrift(launcherPath, seedPath)).toEqual({
      reason: `${seedPath} has no dependencies["@claude-flow/cli"] entry`,
      launcherPath,
      seedPackageJsonPath: seedPath,
      launcherPin: '3.42.4',
    })
  })

  it('flags a missing seed package.json file by name', () => {
    const dir = scratchDir()
    const launcherPath = writeLauncher(dir, '3.42.4')
    const seedPath = join(dir, 'ruflo-seed', 'package.json')

    expect(findRufloSeedPinDrift(launcherPath, seedPath)).toEqual({
      reason: `seed package.json not found at ${seedPath}`,
      launcherPath,
      seedPackageJsonPath: seedPath,
      launcherPin: '3.42.4',
    })
  })

  it('does not flag the real, committed pair (scripts/mcp-ruflo-launcher.sh, scripts/ruflo-seed/package.json)', () => {
    // End-to-end regression anchor, same convention as
    // findUnpinnedRufloLauncherPin's own real-file test above.
    const realLauncherPath = join(process.cwd(), 'scripts', 'mcp-ruflo-launcher.sh')
    const realSeedPath = join(process.cwd(), 'scripts', 'ruflo-seed', 'package.json')

    expect(findRufloSeedPinDrift(realLauncherPath, realSeedPath)).toBeNull()
  })
})

describe('findProcScanCmdHintDrift (rec 2, SMI-6744 A1.8 retro)', () => {
  // Deliberately escape-free: this string needs no \' or \\ handling, so
  // these arms isolate the extract-and-compare LOGIC from the escape
  // decoding, which gets its own dedicated arm below with hand-verified
  // escape sequences.
  const TEST_HINT = 'sh -c "scan procs for launchers"'
  function writeGuard(dir: string, hintLiteralBody: string = TEST_HINT): string {
    const p = join(dir, 'ruflo-launch-guard.mjs')
    writeFileSync(
      p,
      `#!/usr/bin/env node\nconst PROC_SCAN_CMD_HINT =\n  '${hintLiteralBody}'\nconsole.log(PROC_SCAN_CMD_HINT)\n`
    )
    return p
  }
  function writeGuide(dir: string, body: string): string {
    const p = join(dir, 'claude-flow-guide.md')
    writeFileSync(p, body)
    return p
  }

  it('does not flag a guide that carries the guard literal verbatim', () => {
    const dir = scratchDir()
    const guardPath = writeGuard(dir)
    const guidePath = writeGuide(dir, `# guide\n\nrun \`docker exec c ${TEST_HINT}\`\n`)

    expect(findProcScanCmdHintDrift(guardPath, guidePath)).toBeNull()
  })

  it('flags a guide whose prose has drifted from the guard literal', () => {
    const dir = scratchDir()
    const guardPath = writeGuard(dir)
    const guidePath = writeGuide(dir, `# guide\n\nrun \`ps -eo pid,args\` to list live launchers\n`)

    const result = findProcScanCmdHintDrift(guardPath, guidePath)
    expect(result).not.toBeNull()
    expect(result.reason).toContain('does not appear verbatim')
    expect(result.hintLiteral).toBe(TEST_HINT)
  })

  it('flags a missing guard file by name', () => {
    const dir = scratchDir()
    const guardPath = join(dir, 'ruflo-launch-guard.mjs')
    const guidePath = writeGuide(dir, '# guide\n')

    expect(findProcScanCmdHintDrift(guardPath, guidePath)).toEqual({
      reason: `guard not found at ${guardPath}`,
      guardPath,
      guideMdPath: guidePath,
    })
  })

  it('flags a missing guide file by name once the guard parses cleanly', () => {
    const dir = scratchDir()
    const guardPath = writeGuard(dir)
    const guidePath = join(dir, 'claude-flow-guide.md')

    expect(findProcScanCmdHintDrift(guardPath, guidePath)).toEqual({
      reason: `guide not found at ${guidePath}`,
      guardPath,
      guideMdPath: guidePath,
      hintLiteral: TEST_HINT,
    })
  })

  it('decodes escaped single-quotes and backslashes the same way the real constant uses them', () => {
    const dir = scratchDir()
    const guardPath = join(dir, 'ruflo-launch-guard.mjs')
    // Written directly (not via this test file's own string-escaping of a
    // shared constant) so the exact source bytes under test are visible
    // here: the guard source literal is `'it\'s a \\test'`, which JS
    // decodes to `it's a \test` (one backslash) -- the same two escape
    // kinds (`\'`, `\\`) the real PROC_SCAN_CMD_HINT constant uses.
    writeFileSync(
      guardPath,
      "const PROC_SCAN_CMD_HINT =\n  'it\\'s a \\\\test'\nconsole.log(PROC_SCAN_CMD_HINT)\n"
    )
    const guidePath = writeGuide(dir, "# guide\n\nliteral: it's a \\test\n")

    expect(findProcScanCmdHintDrift(guardPath, guidePath)).toBeNull()
  })

  it('does not flag the real, committed pair (scripts/ruflo-launch-guard.mjs, .claude/development/claude-flow-guide.md)', () => {
    // End-to-end regression anchor, same convention as
    // findRufloSeedPinDrift's own real-file test above -- exercises the
    // ACTUAL escaped literal (`\'` and `\\0`) this constant carries in
    // production, not just the simplified fixtures above.
    const realGuardPath = join(process.cwd(), 'scripts', 'ruflo-launch-guard.mjs')
    const realGuidePath = join(process.cwd(), '.claude', 'development', 'claude-flow-guide.md')

    expect(findProcScanCmdHintDrift(realGuardPath, realGuidePath)).toBeNull()
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
