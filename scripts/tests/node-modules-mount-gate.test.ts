/**
 * SMI-6614 (ADR-158, round-2b/round-3/round-4) — tests for
 * scripts/lib/node-modules-mount-gate.sh.
 *
 * The helper checks EVERY node_modules path docker-compose.yml declares
 * (root + one per packages/*), not just root — SMI-6516 detached nine of
 * ten individually, so a root-only check misses exactly that shape.
 *
 * round-3: the helper no longer shells out to `mountpoint` at all (it
 * followed symlinks and returned 0 for ANY mount reachable at a path,
 * including a writable host bind — see the helper's own header for the
 * measured worktree-container false negative that motivated this). It now
 * parses /proc/self/mountinfo directly. This file drives the real POSIX-sh
 * script via spawnSync, pointing its NODE_MODULES_MOUNT_GATE_MOUNTINFO test
 * seam at a small fixture mountinfo file per test (mirrors
 * regen-lockfile.test.ts's identical round-3 migration) rather than
 * PATH-shimming `mountpoint` — that shim is dead code against the rewritten
 * helper (the SMI-6598 trap: every one of this file's PRE-round-3 cases
 * would either fail loudly or pass for the wrong reason once the helper
 * stopped calling `mountpoint`, since the shim would simply never be
 * invoked).
 *
 * round-4: two changes.
 *   (1) "Named volume" is renamed to "volume-shaped root" everywhere in
 *       this file's titles/comments — the helper cannot prove a mount is
 *       Docker/Podman-managed from inside the container, only that its
 *       root is SHAPED like one (`.../volumes/<name>/_data`).
 *   (2) Which mountinfo line is "visible" at a stacked target used to be
 *       "the last line in file order" — an unstated assumption about
 *       kernel output ordering. It's now resolved by mount TOPOLOGY (field
 *       1 = a mount's own ID, field 2 = its parent's ID; the visible mount
 *       is whichever candidate's ID is not another candidate's parent ID),
 *       which is order-independent — the four "stacked mounts" cases below
 *       prove this by writing the identical stacking relationship in BOTH
 *       file orders and asserting the same outcome either way.
 *       mountedVolumeLine()/hostBindLine() gained an optional `parentId`
 *       parameter to construct real stacking relationships.
 *
 * Picked up automatically by vitest (scripts/tests/**\/*.test.ts, per
 * CLAUDE.md's Test File Locations table) — no separate CI wiring needed,
 * unlike a `.test.sh` file, which would need adding to an existing shell
 * suite's own run list.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(__dirname, '..', 'lib', 'node-modules-mount-gate.sh')

const tempDirs: string[] = []
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true })
  }
})

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `node-modules-mount-gate-${prefix}-`))
  tempDirs.push(dir)
  return dir
}

/** An npm workspace: a packages/<name> dir holding a package.json. */
function mkPkg(appRoot: string, name: string, withNodeModules = true): void {
  const dir = join(appRoot, 'packages', name)
  mkdirSync(withNodeModules ? join(dir, 'node_modules') : dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }) + '\n')
}

/** Mountinfo-escapes a path field the same way the helper's own
 * `_gate_escape()` does (space/tab/backslash -> \040/\011/\134, proc(5)) —
 * used to build a fixture line for a target whose real path contains a
 * space, proving the helper's escape-then-compare logic actually works
 * rather than just asserting on the unescaped detached-path message. */
function escapeMountinfoField(s: string): string {
  return s.replace(/\\/g, '\\134').replace(/ /g, '\\040').replace(/\t/g, '\\011')
}

/** One mountinfo line for `mountPoint` (already escaped by the caller if it
 * contains a space/tab/backslash) with a volume-shaped root (ending in
 * `.../volumes/<volumeName>/_data`) — the "properly mounted" case the
 * helper accepts. `parentId` (field 2, default '1' — an ID no test's
 * candidate set ever uses, i.e. "no relevant parent") lets a caller model a
 * REAL stacking relationship: pass another line's own `id` to say "this
 * mount was stacked on top of that one," per proc(5)'s field-2 semantics. */
function mountedVolumeLine(
  id: number,
  mountPoint: string,
  volumeName: string,
  parentId: number | string = 1
): string {
  return `${id} ${parentId} 254:1 /docker/volumes/${volumeName}/_data ${mountPoint} rw,relatime master:1 - ext4 /dev/vda1 rw,discard`
}

/** One mountinfo line for `mountPoint` as a HOST bind mount (root is a
 * plain host path, fstype virtiofs) — a REAL mount at the target, but its
 * root is not volume-shaped; the helper must reject this (MOUNT_NOT_VOLUME).
 * `parentId` — see mountedVolumeLine()'s doc. */
function hostBindLine(
  id: number,
  mountPoint: string,
  hostPath = '/host/path',
  parentId: number | string = 1
): string {
  return `${id} ${parentId} 0:43 ${hostPath} ${mountPoint} ro,nosuid,nodev,relatime - virtiofs virtiofs0 rw`
}

/** Write `lines` (mountinfo-format strings) to `path`, one per line. */
function writeMountinfoFixture(path: string, lines: string[]): void {
  writeFileSync(path, lines.join('\n') + '\n', 'utf8')
}

function runGate(
  appRoot: string,
  mountinfoPath: string
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('sh', [SCRIPT], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      PATH: '/usr/bin:/bin',
      APP_ROOT: appRoot,
      NODE_MODULES_MOUNT_GATE_MOUNTINFO: mountinfoPath,
    },
  })
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

describe('scripts/lib/node-modules-mount-gate.sh', () => {
  it('all mounted -> exit 0', () => {
    const appRoot = makeTempDir('all-mounted')
    mkdirSync(join(appRoot, 'node_modules'), { recursive: true })
    mkPkg(appRoot, 'core')
    mkPkg(appRoot, 'cli')
    const mountinfoPath = join(makeTempDir('all-mounted-mi'), 'mountinfo')
    writeMountinfoFixture(mountinfoPath, [
      mountedVolumeLine(100, join(appRoot, 'node_modules'), 'root_nm'),
      mountedVolumeLine(101, join(appRoot, 'packages', 'core', 'node_modules'), 'core_nm'),
      mountedVolumeLine(102, join(appRoot, 'packages', 'cli', 'node_modules'), 'cli_nm'),
    ])

    const r = runGate(appRoot, mountinfoPath)
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
  })

  it('root detached -> exit 32, names the root path', () => {
    const appRoot = makeTempDir('root-detached')
    mkdirSync(join(appRoot, 'node_modules'), { recursive: true })
    mkPkg(appRoot, 'core')
    const mountinfoPath = join(makeTempDir('root-detached-mi'), 'mountinfo')
    // No entry for root at all; core IS mounted.
    writeMountinfoFixture(mountinfoPath, [
      mountedVolumeLine(100, join(appRoot, 'packages', 'core', 'node_modules'), 'core_nm'),
    ])

    const r = runGate(appRoot, mountinfoPath)
    expect(r.status).toBe(32)
    expect(r.stderr).toContain(`MOUNT_DETACHED ${join(appRoot, 'node_modules')}`)
    // The core package was never flagged.
    expect(r.stderr).not.toContain('packages/core/node_modules')
  })

  it('only ONE package detached (root attached) -> exit 32, names ONLY that package', () => {
    const appRoot = makeTempDir('one-pkg-detached')
    mkdirSync(join(appRoot, 'node_modules'), { recursive: true })
    mkPkg(appRoot, 'core')
    mkPkg(appRoot, 'doc-retrieval-mcp')
    const mountinfoPath = join(makeTempDir('one-pkg-detached-mi'), 'mountinfo')
    // Root and core mounted; doc-retrieval-mcp has no entry at all.
    writeMountinfoFixture(mountinfoPath, [
      mountedVolumeLine(100, join(appRoot, 'node_modules'), 'root_nm'),
      mountedVolumeLine(101, join(appRoot, 'packages', 'core', 'node_modules'), 'core_nm'),
    ])

    const r = runGate(appRoot, mountinfoPath)
    expect(r.status).toBe(32)
    expect(r.stderr).toContain('packages/doc-retrieval-mcp/node_modules')
    expect(r.stderr).not.toContain('packages/core/node_modules')
    expect(r.stderr).not.toContain(`MOUNT_DETACHED ${join(appRoot, 'node_modules')}\n`)
  })

  it('a package dir with no node_modules -> exit 32 (missing dir counts as not mounted)', () => {
    const appRoot = makeTempDir('missing-nm')
    mkdirSync(join(appRoot, 'node_modules'), { recursive: true })
    // packages/enterprise is a workspace, but its node_modules subdirectory does not exist.
    mkPkg(appRoot, 'enterprise', false)
    const mountinfoPath = join(makeTempDir('missing-nm-mi'), 'mountinfo')
    writeMountinfoFixture(mountinfoPath, [
      mountedVolumeLine(100, join(appRoot, 'node_modules'), 'root_nm'),
    ])

    const r = runGate(appRoot, mountinfoPath)
    expect(r.status).toBe(32)
    expect(r.stderr).toContain(
      `MOUNT_DETACHED ${join(appRoot, 'packages', 'enterprise', 'node_modules')}`
    )
  })

  it('zero packages -> the root check alone decides (root mounted -> 0)', () => {
    const appRoot = makeTempDir('zero-packages')
    mkdirSync(join(appRoot, 'node_modules'), { recursive: true })
    // No packages/ directory at all.
    const mountinfoPath = join(makeTempDir('zero-packages-mi'), 'mountinfo')
    writeMountinfoFixture(mountinfoPath, [
      mountedVolumeLine(100, join(appRoot, 'node_modules'), 'root_nm'),
    ])

    const r = runGate(appRoot, mountinfoPath)
    expect(r.status).toBe(0)
  })

  it('zero packages, root detached -> exit 32', () => {
    const appRoot = makeTempDir('zero-packages-detached')
    mkdirSync(join(appRoot, 'node_modules'), { recursive: true })
    const mountinfoPath = join(makeTempDir('zero-packages-detached-mi'), 'mountinfo')
    writeMountinfoFixture(mountinfoPath, [])

    const r = runGate(appRoot, mountinfoPath)
    expect(r.status).toBe(32)
  })

  it('mountinfo unreadable -> exit 127, MOUNT_CHECK_UNAVAILABLE token', () => {
    const appRoot = makeTempDir('no-mountinfo')
    mkdirSync(join(appRoot, 'node_modules'), { recursive: true })
    // Points at a path that was never written — unreadable, not merely absent
    // of matching entries.
    const mountinfoPath = join(makeTempDir('no-mountinfo-mi'), 'does-not-exist')

    const r = runGate(appRoot, mountinfoPath)
    expect(r.status).toBe(127)
    expect(r.stderr).toContain('MOUNT_CHECK_UNAVAILABLE 127')
  })

  it('a package directory name containing a space -> escaped exact match works (exit 0)', () => {
    const appRoot = makeTempDir('space-in-name')
    mkdirSync(join(appRoot, 'node_modules'), { recursive: true })
    mkPkg(appRoot, 'my pkg')
    const mountinfoPath = join(makeTempDir('space-in-name-mi'), 'mountinfo')
    const pkgPath = join(appRoot, 'packages', 'my pkg', 'node_modules')
    // A positive proof, not just "detached path message contains the raw
    // space": the fixture line ESCAPES the space (\040) exactly the way a
    // real mountinfo would, and the helper's own _gate_escape() must
    // produce the identical escaping of the raw target to match it — if
    // escaping were broken (wrong code point, missed a byte), this would
    // fall through to MOUNT_DETACHED instead of matching.
    writeMountinfoFixture(mountinfoPath, [
      mountedVolumeLine(100, join(appRoot, 'node_modules'), 'root_nm'),
      mountedVolumeLine(101, escapeMountinfoField(pkgPath), 'my_pkg_nm'),
    ])

    const r = runGate(appRoot, mountinfoPath)
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
  })

  it('a leftover packages/ dir without package.json is not a workspace -> skipped, exit 0', () => {
    // Measured 2026-09-14: the main checkout holds an empty packages/billing-types
    // left by SMI-5119's package removal. npm does not treat it as a workspace
    // (npm query .workspace lists 8), so it must not block every install.
    const appRoot = makeTempDir('leftover-dir')
    mkdirSync(join(appRoot, 'node_modules'), { recursive: true })
    mkPkg(appRoot, 'core')
    mkdirSync(join(appRoot, 'packages', 'billing-types'), { recursive: true })
    const mountinfoPath = join(makeTempDir('leftover-dir-mi'), 'mountinfo')
    writeMountinfoFixture(mountinfoPath, [
      mountedVolumeLine(100, join(appRoot, 'node_modules'), 'root_nm'),
      mountedVolumeLine(101, join(appRoot, 'packages', 'core', 'node_modules'), 'core_nm'),
    ])

    const r = runGate(appRoot, mountinfoPath)
    expect(r.status).toBe(0)
    expect(r.stderr).not.toContain('billing-types')
  })

  // ── round-3: the actual bug this rewrite exists to fix ──────────────────

  it('host bind mounted at the target (real mount, root not volume-shaped) -> exit 32 MOUNT_NOT_VOLUME', () => {
    const appRoot = makeTempDir('host-bind')
    mkdirSync(join(appRoot, 'node_modules'), { recursive: true })
    const mountinfoPath = join(makeTempDir('host-bind-mi'), 'mountinfo')
    // A REAL mount is present at the exact target — `mountpoint -q` would
    // have returned 0 here (wrongly treating a writable host bind as safe).
    // The mountinfo-based check must distinguish "a mount is there" from
    // "the mount's root is SHAPED like a volume data directory" and reject it.
    writeMountinfoFixture(mountinfoPath, [
      hostBindLine(100, join(appRoot, 'node_modules'), '/Users/x/repo/node_modules'),
    ])

    const r = runGate(appRoot, mountinfoPath)
    expect(r.status).toBe(32)
    expect(r.stderr).toContain(`MOUNT_NOT_VOLUME ${join(appRoot, 'node_modules')}`)
    expect(r.stderr).toContain('fstype=virtiofs')
  })

  it('target only present as a mount of its symlink destination -> exit 32 (the exact worktree-container bug measured 2026-09-14)', () => {
    const appRoot = makeTempDir('symlink-target')
    mkdirSync(join(appRoot, 'node_modules'), { recursive: true })
    const mountinfoPath = join(makeTempDir('symlink-target-mi'), 'mountinfo')
    // Mirrors the measured post-merge-lockfile-drift-classifier-dev-1 case:
    // a real named-volume mount exists at /node_modules, but NONE at
    // $APP_ROOT/node_modules (which is a symlink to it). `mountpoint -q`
    // follows the symlink and would report this as mounted (a false
    // negative for the detached-mount check); exact field-5 string matching
    // against the UNRESOLVED target must reject it.
    writeMountinfoFixture(mountinfoPath, [mountedVolumeLine(100, '/node_modules', 'root_nm')])

    const r = runGate(appRoot, mountinfoPath)
    expect(r.status).toBe(32)
    expect(r.stderr).toContain(`MOUNT_DETACHED ${join(appRoot, 'node_modules')}`)
  })

  // ── round-4 finding 2: stacked mounts are resolved by TOPOLOGY (mount
  // ID / parent ID, proc(5) fields 1/2), never by file order. Each of the
  // two stacking relationships below (bind-over-volume, volume-over-bind)
  // is written in BOTH file orders — natural (earlier mount's line first)
  // and reversed — and must resolve to the SAME visible mount either way.
  // A bare `parentId` of 1 (mountedVolumeLine/hostBindLine's default) on
  // the SECOND line would NOT model real stacking (the kernel always sets
  // a covering mount's parent to whatever was already at that mountpoint),
  // so these four cases explicitly pass the earlier line's own `id` as the
  // later line's `parentId`.

  it('stacked: volume mounted, then a host bind stacked on top (natural file order) -> exit 32 MOUNT_NOT_VOLUME', () => {
    const appRoot = makeTempDir('stacked-vol-under-bind-natural')
    mkdirSync(join(appRoot, 'node_modules'), { recursive: true })
    const mountinfoPath = join(makeTempDir('stacked-vol-under-bind-natural-mi'), 'mountinfo')
    const target = join(appRoot, 'node_modules')
    // id=100 is the volume; id=101 (the bind) declares parentId=100 —
    // it was mounted ON TOP of the volume already at this exact path.
    writeMountinfoFixture(mountinfoPath, [
      mountedVolumeLine(100, target, 'root_nm'),
      hostBindLine(101, target, '/host/shadow', 100),
    ])

    const r = runGate(appRoot, mountinfoPath)
    expect(r.status).toBe(32)
    expect(r.stderr).toContain(`MOUNT_NOT_VOLUME ${target}`)
  })

  it('stacked: volume mounted, then a host bind stacked on top (REVERSED file order) -> same outcome, exit 32 MOUNT_NOT_VOLUME', () => {
    const appRoot = makeTempDir('stacked-vol-under-bind-reversed')
    mkdirSync(join(appRoot, 'node_modules'), { recursive: true })
    const mountinfoPath = join(makeTempDir('stacked-vol-under-bind-reversed-mi'), 'mountinfo')
    const target = join(appRoot, 'node_modules')
    // Identical relationship to the natural-order case above (bind's
    // parentId=100=the volume's own id) — only the LINE ORDER in the file
    // is swapped. The topology resolution must not care.
    writeMountinfoFixture(mountinfoPath, [
      hostBindLine(101, target, '/host/shadow', 100),
      mountedVolumeLine(100, target, 'root_nm'),
    ])

    const r = runGate(appRoot, mountinfoPath)
    expect(r.status).toBe(32)
    expect(r.stderr).toContain(`MOUNT_NOT_VOLUME ${target}`)
  })

  it('stacked: host bind mounted, then a volume stacked on top (natural file order) -> exit 0', () => {
    const appRoot = makeTempDir('stacked-bind-under-vol-natural')
    mkdirSync(join(appRoot, 'node_modules'), { recursive: true })
    const mountinfoPath = join(makeTempDir('stacked-bind-under-vol-natural-mi'), 'mountinfo')
    const target = join(appRoot, 'node_modules')
    // id=200 is the host bind; id=201 (the volume) declares parentId=200 —
    // it was mounted ON TOP of the bind already at this exact path.
    writeMountinfoFixture(mountinfoPath, [
      hostBindLine(200, target, '/host/shadow'),
      mountedVolumeLine(201, target, 'root_nm', 200),
    ])

    const r = runGate(appRoot, mountinfoPath)
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
  })

  it('stacked: host bind mounted, then a volume stacked on top (REVERSED file order) -> same outcome, exit 0', () => {
    const appRoot = makeTempDir('stacked-bind-under-vol-reversed')
    mkdirSync(join(appRoot, 'node_modules'), { recursive: true })
    const mountinfoPath = join(makeTempDir('stacked-bind-under-vol-reversed-mi'), 'mountinfo')
    const target = join(appRoot, 'node_modules')
    writeMountinfoFixture(mountinfoPath, [
      mountedVolumeLine(201, target, 'root_nm', 200),
      hostBindLine(200, target, '/host/shadow'),
    ])

    const r = runGate(appRoot, mountinfoPath)
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
  })

  it('ambiguous: two mounts at the same target, neither the others parent -> exit 32 MOUNT_AMBIGUOUS', () => {
    const appRoot = makeTempDir('ambiguous-pair')
    mkdirSync(join(appRoot, 'node_modules'), { recursive: true })
    const mountinfoPath = join(makeTempDir('ambiguous-pair-mi'), 'mountinfo')
    const target = join(appRoot, 'node_modules')
    // Both lines share the SAME (irrelevant) parentId — neither is
    // stacked on the other, so the topology resolution can't tell which
    // one is visible. A cycle or otherwise inconsistent mountinfo hits
    // this same path — fail closed rather than guessing (SMI-6598: this
    // is a genuinely reachable state, not a defensive-only branch —
    // verified live before writing the helper's own resolution logic).
    writeMountinfoFixture(mountinfoPath, [
      mountedVolumeLine(300, target, 'vol_a', 1),
      hostBindLine(301, target, '/host/y', 1),
    ])

    const r = runGate(appRoot, mountinfoPath)
    expect(r.status).toBe(32)
    expect(r.stderr).toContain(`MOUNT_AMBIGUOUS ${target}`)
  })

  // ── round-4 finding 1: the documented residual, PINNED ──────────────────

  it('RESIDUAL (documented in the helper header, not closed by this check): a host directory shaped like a volume data directory passes -> exit 0', () => {
    const appRoot = makeTempDir('residual-disguised-bind')
    mkdirSync(join(appRoot, 'node_modules'), { recursive: true })
    const mountinfoPath = join(makeTempDir('residual-disguised-bind-mi'), 'mountinfo')
    const target = join(appRoot, 'node_modules')
    // This PINS the residual the helper's own header states plainly: this
    // check can only detect the SHAPE of a mount's root
    // (`.../volumes/<name>/_data`), not cryptographically prove Docker or
    // Podman created it — Docker/Podman's own metadata is unreachable from
    // inside the container. A host directory deliberately laid out with
    // this shape and bind-mounted over a target passes. Titled and pinned
    // deliberately: a future change that closes this gap must update THIS
    // test on purpose, rather than an incidental behavior change silently
    // altering what it asserts.
    writeMountinfoFixture(mountinfoPath, [
      `400 1 0:99 /Users/x/volumes/fake/_data ${target} ro,nosuid,nodev,relatime - fakeowner fakeowner0 rw`,
    ])

    const r = runGate(appRoot, mountinfoPath)
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
  })

  it('a real mountinfo excerpt captured from skillsmith-dev-1 (docker exec skillsmith-dev-1 cat /proc/self/mountinfo, 2026-09-14) -> exit 0', () => {
    // The nine node_modules lines plus a few unrelated real lines (root
    // overlayfs, /app's own virtiofs bind), verbatim from the running
    // main-checkout container — not a synthetic approximation.
    const REAL_MOUNTINFO_EXCERPT = [
      '598 382 0:53 / / rw,relatime - overlay overlay rw,lowerdir=38025/fs,upperdir=/var/lib/desktop-containerd/daemon/io.containerd.snapshotter.v1.overlayfs/snapshots/38026/fs,workdir=/var/lib/desktop-containerd/daemon/io.containerd.snapshotter.v1.overlayfs/snapshots/38026/work',
      '801 598 0:83 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw',
      '1505 598 0:84 / /dev rw,nosuid - tmpfs tmpfs rw,size=65536k,mode=755',
      '1517 598 0:43 /williamsmith/Documents/GitHub/Smith-Horn/skillsmith /app rw,nosuid,nodev,relatime - virtiofs virtiofs0 rw,ignore_atime,no_xattr',
      '1523 1517 254:1 /docker/volumes/skillsmith_node_modules/_data /app/node_modules rw,relatime master:1 - ext4 /dev/vda1 rw,discard',
      '1896 1517 254:1 /docker/volumes/skillsmith_vscode-extension-node-modules/_data /app/packages/vscode-extension/node_modules rw,relatime master:1 - ext4 /dev/vda1 rw,discard',
      '1897 1517 254:1 /docker/volumes/skillsmith_enterprise-node-modules/_data /app/packages/enterprise/node_modules rw,relatime master:1 - ext4 /dev/vda1 rw,discard',
      '1898 1517 254:1 /docker/volumes/skillsmith_core-node-modules/_data /app/packages/core/node_modules rw,relatime master:1 - ext4 /dev/vda1 rw,discard',
      '1899 1517 254:1 /docker/volumes/skillsmith_doc-retrieval-mcp-node-modules/_data /app/packages/doc-retrieval-mcp/node_modules rw,relatime master:1 - ext4 /dev/vda1 rw,discard',
      '1900 1517 254:1 /docker/volumes/skillsmith_website-node-modules/_data /app/packages/website/node_modules rw,relatime master:1 - ext4 /dev/vda1 rw,discard',
      '1902 1517 254:1 /docker/volumes/skillsmith_skillsmith-cli-node-modules/_data /app/packages/skillsmith-cli/node_modules rw,relatime master:1 - ext4 /dev/vda1 rw,discard',
      '1903 1517 254:1 /docker/volumes/skillsmith_mcp-server-node-modules/_data /app/packages/mcp-server/node_modules rw,relatime master:1 - ext4 /dev/vda1 rw,discard',
      '1904 1517 254:1 /docker/volumes/skillsmith_cli-node-modules/_data /app/packages/cli/node_modules rw,relatime master:1 - ext4 /dev/vda1 rw,discard',
    ]
    const appRoot = makeTempDir('real-excerpt')
    mkdirSync(join(appRoot, 'node_modules'), { recursive: true })
    for (const pkg of [
      'vscode-extension',
      'enterprise',
      'core',
      'doc-retrieval-mcp',
      'website',
      'skillsmith-cli',
      'mcp-server',
      'cli',
    ]) {
      mkPkg(appRoot, pkg)
    }
    const mountinfoPath = join(makeTempDir('real-excerpt-mi'), 'mountinfo')
    // Self-contained: rewrite the excerpt's /app prefix to this test's own
    // temp appRoot rather than depending on the real container's /app
    // filesystem existing at test-run time — every OTHER byte (volume
    // names, device numbers, fstype, mount options) stays exactly as
    // captured live.
    writeMountinfoFixture(
      mountinfoPath,
      REAL_MOUNTINFO_EXCERPT.map((line) => line.replaceAll('/app', appRoot))
    )

    const r = runGate(appRoot, mountinfoPath)
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
  })
})
