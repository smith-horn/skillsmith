/**
 * SMI-6618: platform-skip + Tier-B mount-source guard regression tests for
 * scripts/mcp-skillsmith-launcher.sh.
 *
 * Per the plan (Wave 1 Step 1): "The skillsmith launcher suite gets
 * T1-style (darwin/arm64 probe, empty linux-x64-gnu placeholder under
 * packages/mcp-server/node_modules), T3/T4 and T7 equivalents." The T3
 * equivalent below necessarily also exercises the T2 classification (a
 * matching-platform Tier-B dir reports tier-b-mount-source, never
 * nested-corrupt) since "no rm -rf" is only a meaningful assertion once
 * that classification has actually fired.
 *
 * Sibling file, not folded into mcp-skillsmith-launcher.test.ts, purely to
 * keep that file's line count from growing further; fixture helpers are
 * reused via import, per that file's own module-level exports.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  addDist,
  addLockfile,
  addMcpServerPackageJson,
  addNestedDep,
  addNodeModules,
  makeNodeStub,
  makeRoot,
  runLauncher,
} from './mcp-skillsmith-launcher.test.js'

const PKG_PREFIX = 'packages/mcp-server/node_modules/'
const TIER_B_FIXTURE_PACKAGES = {
  [`${PKG_PREFIX}ruvector-core-linux-x64-gnu`]: { version: '1.0.0', os: ['linux'], cpu: ['x64'] },
  [`${PKG_PREFIX}__smi-6618-fixture-win32-only__`]: { version: '1.0.0', os: ['win32'] },
}

/** Root with the node_modules sentinel + dist entry, ready for one nested-dep scenario. */
function makeTierBRoot(): string {
  const root = makeRoot()
  addNodeModules(root)
  addDist(root)
  return root
}

describe('mcp-skillsmith-launcher.sh — SMI-6618 platform-skip + Tier-B guard', () => {
  const roots: string[] = []
  const stubs: string[] = []

  beforeEach(() => {
    roots.length = 0
    stubs.length = 0
  })

  afterEach(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true })
    for (const s of stubs) rmSync(s, { recursive: true, force: true })
  })

  it('T1-style: skips an empty Tier-B placeholder on a darwin/arm64 probe', () => {
    const root = makeTierBRoot()
    roots.push(root)
    addLockfile(root, TIER_B_FIXTURE_PACKAGES)
    const dep = 'ruvector-core-linux-x64-gnu'
    addMcpServerPackageJson(root, { [dep]: '1.0.0' })
    addNestedDep(root, dep, { empty: true })

    const { binDir, marker } = makeNodeStub()
    stubs.push(binDir)

    const res = runLauncher(root, binDir, {
      SKILLSMITH_LAUNCHER_PROBE_TEST: '1',
      SKILLSMITH_LAUNCHER_PROBE_PLATFORM: 'darwin',
      SKILLSMITH_LAUNCHER_PROBE_ARCH: 'arm64',
    })

    expect(res.status).toBe(0)
    expect(res.stderr).not.toContain('nested-corrupt')
    expect(existsSync(marker)).toBe(true)
  })

  it('T3-equivalent: a matching-platform Tier-B dir is tier-b-mount-source, and its remedy never prints rm -rf', () => {
    const root = makeTierBRoot()
    roots.push(root)
    addLockfile(root, TIER_B_FIXTURE_PACKAGES)
    const dep = 'ruvector-core-linux-x64-gnu'
    addMcpServerPackageJson(root, { [dep]: '1.0.0' })
    addNestedDep(root, dep, { empty: true })

    // Override to linux/x64 so this matching-platform FAIL is reachable even
    // though the real host here is darwin (the plan notes this state "can
    // only occur on a Linux host" in production, since every Tier-B path is
    // os:["linux"] and gets skipped on macOS).
    const res = runLauncher(root, undefined, {
      SKILLSMITH_LAUNCHER_PROBE_TEST: '1',
      SKILLSMITH_LAUNCHER_PROBE_PLATFORM: 'linux',
      SKILLSMITH_LAUNCHER_PROBE_ARCH: 'x64',
    })

    expect(res.status).toBe(1)
    expect(res.stderr).toContain(`FAIL ${dep} tier-b-mount-source`)
    expect(res.stderr).toContain('must not be removed')
    expect(res.stderr).not.toContain('rm -rf')
    expect(res.stderr).toContain('./scripts/repair-worktrees.sh')
  })

  it('T10-equivalent: valid JSON with no "packages" map counts as an unavailable Tier-B list — no rm -rf', () => {
    const root = makeTierBRoot()
    roots.push(root)
    // Parses fine, but has no packages map: must NOT read as "zero Tier-B paths".
    writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}', 'utf8')
    const dep = 'ruvector-core-linux-x64-gnu'
    addMcpServerPackageJson(root, { [dep]: '1.0.0' })
    addNestedDep(root, dep, { empty: true })

    const res = runLauncher(root, undefined, {
      SKILLSMITH_LAUNCHER_PROBE_TEST: '1',
      SKILLSMITH_LAUNCHER_PROBE_PLATFORM: 'linux',
      SKILLSMITH_LAUNCHER_PROBE_ARCH: 'x64',
    })

    expect(res.status).toBe(1)
    expect(res.stderr).toContain(`FAIL ${dep}`)
    expect(res.stderr).not.toContain('rm -rf')
    expect(res.stderr.split('[skillsmith] preflight: lockfile unreadable').length - 1).toBe(1)
  })

  it('T4-equivalent: an empty non-Tier-B nested dir stays nested-corrupt, rm -rf intact', () => {
    const root = makeTierBRoot()
    roots.push(root)
    addLockfile(root, TIER_B_FIXTURE_PACKAGES) // present + valid, no entry for this name
    const dep = '__smi-6618-fixture-non-tier-b__'
    addMcpServerPackageJson(root, { [dep]: '1.0.0' })
    addNestedDep(root, dep, { empty: true })

    const res = runLauncher(root)

    expect(res.status).toBe(1)
    expect(res.stderr).toContain(`FAIL ${dep} nested-corrupt`)
    expect(res.stderr).toContain(`rm -rf packages/mcp-server/node_modules/${dep}`)
  })

  it('T7-equivalent: the platform override is ignored without the test gate', () => {
    const root = makeTierBRoot()
    roots.push(root)
    addLockfile(root, TIER_B_FIXTURE_PACKAGES)
    const dep = '__smi-6618-fixture-win32-only__'
    addMcpServerPackageJson(root, { [dep]: '1.0.0' })
    addNestedDep(root, dep, { empty: true })

    const { binDir, marker } = makeNodeStub()
    stubs.push(binDir)

    // Deliberately NO SKILLSMITH_LAUNCHER_PROBE_TEST=1 — the gate is unset.
    // No real test runner is win32, so the REAL platform excludes this
    // win32-only descriptor regardless (honouring the override would FAIL).
    // This launcher runs the probe host-side (no docker exec / -e forwarding
    // step to assert an argv shape on, unlike the doc-retrieval sibling), so
    // the discriminating check is the outcome itself: skip -> exit 0.
    const res = runLauncher(root, binDir, { SKILLSMITH_LAUNCHER_PROBE_PLATFORM: 'win32' })

    expect(res.status).toBe(0)
    expect(res.stderr).not.toContain(dep)
    expect(existsSync(marker)).toBe(true)
  })
})
