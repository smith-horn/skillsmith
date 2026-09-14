/**
 * SMI-6618: platform-skip + Tier-B mount-source guard regression tests for
 * scripts/mcp-doc-retrieval-launcher.sh (plan's Wave 1 Step 1 table, T1-T8).
 *
 * T9 ("empty container nested dir fails despite a healthy container-hoisted
 * copy") is the PRE-EXISTING case of that name in
 * mcp-doc-retrieval-launcher.test.ts -- unaffected by this change and not
 * duplicated here.
 *
 * Sibling file, not folded into mcp-doc-retrieval-launcher.test.ts, purely
 * to keep that file's line count from growing further; fixture helpers are
 * reused via import, per that file's own module-level exports.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  addDocRetrievalPackageJson,
  addHoistedDep,
  addLockfile,
  addNestedDep,
  addNodeModules,
  makeContainerRoot,
  makeDockerStub,
  makeHealthyHost,
  removeLinuxOptionalPackagesModule,
  runLauncher,
} from './mcp-doc-retrieval-launcher.test.js'

/**
 * Descriptor map shared across T1/T2/T3/T7/T8: the two REAL nested-path
 * shapes SMI-6618's own incident involved, plus two fixture-only
 * descriptors isolating win32-only (T7) and negated-cpu (T8) matching.
 * deriveLinuxOptionalPackagePaths() only lists os===["linux"] exactly
 * entries, so the win32 and cpu-only descriptors are intentionally NOT
 * Tier-B paths -- T7/T8 exercise the platform-skip predicate itself, not
 * the Tier-B override.
 */
const PKG_PREFIX = 'packages/doc-retrieval-mcp/node_modules/'
const TIER_B_FIXTURE_PACKAGES = {
  [`${PKG_PREFIX}ruvector-core-linux-x64-gnu`]: { version: '1.0.0', os: ['linux'], cpu: ['x64'] },
  [`${PKG_PREFIX}ruvector-core-linux-arm64-gnu`]: {
    version: '1.0.0',
    os: ['linux'],
    cpu: ['arm64'],
  },
  [`${PKG_PREFIX}__smi-6618-fixture-win32-only__`]: { version: '1.0.0', os: ['win32'] },
  [`${PKG_PREFIX}__smi-6618-fixture-not-arm64__`]: { version: '1.0.0', cpu: ['!arm64'] },
}

/** Container with the node_modules sentinel + a resolvable zod-to-json-schema, ready for one nested-dep scenario. */
function makeTierBContainer(): string {
  const root = makeContainerRoot()
  addNodeModules(root)
  addHoistedDep(root, 'zod-to-json-schema')
  return root
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

const LINUX_ARM64_TEST_ENV = {
  SKILLSMITH_LAUNCHER_PROBE_TEST: '1',
  SKILLSMITH_LAUNCHER_PROBE_PLATFORM: 'linux',
  SKILLSMITH_LAUNCHER_PROBE_ARCH: 'arm64',
}

describe('mcp-doc-retrieval-launcher.sh — SMI-6618 platform-skip + Tier-B guard', () => {
  const roots: string[] = []
  const stubs: string[] = []

  beforeEach(() => {
    roots.length = 0
    stubs.length = 0
  })

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
    for (const stub of stubs) rmSync(stub, { recursive: true, force: true })
  })

  it('T1: skips an empty Tier-B placeholder for a foreign arch (arm64 probe, x64 dir)', () => {
    const host = makeHealthyHost()
    const container = makeTierBContainer()
    roots.push(host, container)
    addLockfile(container, TIER_B_FIXTURE_PACKAGES)
    const dep = 'ruvector-core-linux-x64-gnu'
    addDocRetrievalPackageJson(container, { [dep]: '1.0.0' })
    addNestedDep(container, dep, { empty: true })

    const { binDir, execMarker } = makeDockerStub({ running: true, containerRoot: container })
    stubs.push(binDir)

    const result = runLauncher(host, binDir, LINUX_ARM64_TEST_ENV)

    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain('nested-corrupt')
    expect(existsSync(execMarker)).toBe(true)
  })

  it('T2: a genuinely empty Tier-B dir for THIS arch is tier-b-mount-source, not nested-corrupt', () => {
    const host = makeHealthyHost()
    const container = makeTierBContainer()
    roots.push(host, container)
    addLockfile(container, TIER_B_FIXTURE_PACKAGES)
    const dep = 'ruvector-core-linux-arm64-gnu'
    addDocRetrievalPackageJson(container, { [dep]: '1.0.0' })
    addNestedDep(container, dep, { empty: true })

    const { binDir } = makeDockerStub({ running: true, containerRoot: container })
    stubs.push(binDir)

    const result = runLauncher(host, binDir, LINUX_ARM64_TEST_ENV)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`FAIL ${dep} tier-b-mount-source`)
    expect(result.stderr).toContain('must not be removed')
  })

  it('T3: the tier-b-mount-source remedy never prints rm -rf', () => {
    const host = makeHealthyHost()
    const container = makeTierBContainer()
    roots.push(host, container)
    addLockfile(container, TIER_B_FIXTURE_PACKAGES)
    const dep = 'ruvector-core-linux-arm64-gnu'
    addDocRetrievalPackageJson(container, { [dep]: '1.0.0' })
    addNestedDep(container, dep, { empty: true })

    const { binDir } = makeDockerStub({ running: true, containerRoot: container })
    stubs.push(binDir)

    const result = runLauncher(host, binDir, LINUX_ARM64_TEST_ENV)

    expect(result.status).toBe(1)
    expect(result.stderr).not.toContain('rm -rf')
  })

  it('T4: an empty non-Tier-B nested dir on a matching platform stays nested-corrupt, rm -rf intact', () => {
    const host = makeHealthyHost()
    const container = makeTierBContainer()
    roots.push(host, container)
    addLockfile(container, TIER_B_FIXTURE_PACKAGES) // present + valid, just has no entry for this name
    const dep = '__smi-6618-fixture-non-tier-b__'
    addDocRetrievalPackageJson(container, { [dep]: '1.0.0' })
    addNestedDep(container, dep, { empty: true })

    const { binDir } = makeDockerStub({ running: true, containerRoot: container })
    stubs.push(binDir)

    const result = runLauncher(host, binDir, LINUX_ARM64_TEST_ENV)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`FAIL ${dep} nested-corrupt`)
    expect(result.stderr).toContain(
      `docker exec skillsmith-dev-1 rm -rf /app/packages/doc-retrieval-mcp/node_modules/${dep}`
    )
  })

  it('T5: an unparseable lockfile fails closed and emits exactly one lockfile PROBE_WARN line', () => {
    const host = makeHealthyHost()
    const container = makeTierBContainer()
    roots.push(host, container)
    writeFileSync(join(container, 'package-lock.json'), '{ not valid json', 'utf8')
    const dep = 'ruvector-core-linux-x64-gnu'
    addDocRetrievalPackageJson(container, { [dep]: '1.0.0' })
    addNestedDep(container, dep, { empty: true })

    const { binDir } = makeDockerStub({ running: true, containerRoot: container })
    stubs.push(binDir)

    const result = runLauncher(host, binDir, LINUX_ARM64_TEST_ENV)

    expect(result.status).toBe(1)
    expect(countOccurrences(result.stderr, '[doc-retrieval] preflight: lockfile unreadable')).toBe(
      1
    )
  })

  it('T6: an unavailable Tier-B module list fails safe — no rm -rf, exactly one warning line', () => {
    const host = makeHealthyHost()
    const container = makeTierBContainer()
    roots.push(host, container)
    addLockfile(container, TIER_B_FIXTURE_PACKAGES) // valid lockfile...
    removeLinuxOptionalPackagesModule(container) // ...but the derivation module is gone
    const dep = '__smi-6618-fixture-non-tier-b-2__'
    addDocRetrievalPackageJson(container, { [dep]: '1.0.0' })
    addNestedDep(container, dep, { empty: true })

    const { binDir } = makeDockerStub({ running: true, containerRoot: container })
    stubs.push(binDir)

    const result = runLauncher(host, binDir, LINUX_ARM64_TEST_ENV)

    expect(result.status).toBe(1)
    expect(result.stderr).not.toContain('rm -rf')
    expect(
      countOccurrences(result.stderr, '[doc-retrieval] preflight: tier-b list unavailable')
    ).toBe(1)
  })

  it('T7: the platform override is ignored without the test gate — honouring it would FAIL, ignoring it skips', () => {
    const host = makeHealthyHost()
    const container = makeTierBContainer()
    roots.push(host, container)
    addLockfile(container, TIER_B_FIXTURE_PACKAGES)
    const dep = '__smi-6618-fixture-win32-only__'
    addDocRetrievalPackageJson(container, { [dep]: '1.0.0' })
    addNestedDep(container, dep, { empty: true })

    const { binDir, execMarker, invocationsLog } = makeDockerStub({
      running: true,
      containerRoot: container,
    })
    stubs.push(binDir)

    // Deliberately NO SKILLSMITH_LAUNCHER_PROBE_TEST=1 -- the gate is unset,
    // so the override below must be ignored. No real test runner is win32,
    // so the REAL platform excludes this win32-only descriptor -- skip.
    const result = runLauncher(host, binDir, { SKILLSMITH_LAUNCHER_PROBE_PLATFORM: 'win32' })

    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain(dep)
    expect(existsSync(execMarker)).toBe(true)

    const invocations = readFileSync(invocationsLog, 'utf8').trim().split('\n')
    const probeInvocation = invocations.find((line) =>
      line.includes('SKILLSMITH_LAUNCHER_REPO_ROOT=/app')
    )
    expect(probeInvocation).toBeDefined()
    // Only the docker-exec ARGV prefix (flags + env), not the JS payload
    // after `-e`, which legitimately contains this substring as literal
    // source text (process.env.SKILLSMITH_LAUNCHER_PROBE_*) regardless of
    // whether any -e flag forwarded it.
    const argvPrefix = (probeInvocation ?? '').split('node --input-type=module -e')[0]
    expect(argvPrefix).not.toContain('SKILLSMITH_LAUNCHER_PROBE_')
  })

  it('T8: a negated cpu descriptor (!arm64) skips on an arm64 probe', () => {
    const host = makeHealthyHost()
    const container = makeTierBContainer()
    roots.push(host, container)
    addLockfile(container, TIER_B_FIXTURE_PACKAGES)
    const dep = '__smi-6618-fixture-not-arm64__'
    addDocRetrievalPackageJson(container, { [dep]: '1.0.0' })
    addNestedDep(container, dep, { empty: true })

    const { binDir, execMarker } = makeDockerStub({ running: true, containerRoot: container })
    stubs.push(binDir)

    const result = runLauncher(host, binDir, LINUX_ARM64_TEST_ENV)

    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain(dep)
    expect(existsSync(execMarker)).toBe(true)
  })

  it('T10: valid JSON with no "packages" map counts as an unavailable Tier-B list — no rm -rf for a real Tier-B dir', () => {
    const host = makeHealthyHost()
    const container = makeTierBContainer()
    roots.push(host, container)
    // Parses fine, but has no packages map: must NOT read as "zero Tier-B paths".
    writeFileSync(join(container, 'package-lock.json'), '{"lockfileVersion":3}', 'utf8')
    const dep = 'ruvector-core-linux-arm64-gnu'
    addDocRetrievalPackageJson(container, { [dep]: '1.0.0' })
    addNestedDep(container, dep, { empty: true })

    const { binDir } = makeDockerStub({ running: true, containerRoot: container })
    stubs.push(binDir)

    const result = runLauncher(host, binDir, LINUX_ARM64_TEST_ENV)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`FAIL ${dep}`)
    expect(result.stderr).not.toContain('rm -rf')
    expect(countOccurrences(result.stderr, '[doc-retrieval] preflight: lockfile unreadable')).toBe(
      1
    )
  })
})
