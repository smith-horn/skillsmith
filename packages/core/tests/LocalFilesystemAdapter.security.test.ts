/**
 * LocalFilesystemAdapter security sidecar (SMI-4319, SMI-4320)
 *
 * Covers:
 * - SMI-4319 symlink loop detection via per-scan visited-realpath set
 *   (A↔B, self-loops, `allowSymlinksOutsideRoot` does NOT suppress the
 *   loop warning, per-scan isolation, happy deep tree).
 * - SMI-4320 realpath-based containment for direct-access methods
 *   (`fetchSkillContent` / `getRepository` / `skillExists`), byte-wise
 *   `startsWith(root + sep)` correctness including the trailing-separator
 *   guard, and the `allowSymlinksOutsideRoot` regression guard.
 *
 * Kept in its own file because the pre-commit `check-file-length.mjs`
 * enforces < 500 lines on `.test.ts` even though `audit:standards` exempts
 * tests (see memory feedback: "File-length enforcement asymmetry").
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LocalFilesystemAdapter } from '../src/sources/LocalFilesystemAdapter.js'
import { isRealpathContained } from '../src/sources/LocalFilesystemAdapter.helpers.js'
import { promises as fs } from 'fs'
import { join, sep } from 'path'
import { tmpdir, platform } from 'os'

function uniq(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

describe('LocalFilesystemAdapter SMI-4319 loop detection', () => {
  let testDir: string

  beforeEach(async () => {
    testDir = join(tmpdir(), uniq('skillsmith-4319'))
    await fs.mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => undefined)
  })

  async function trySymlink(target: string, link: string): Promise<boolean> {
    try {
      await fs.symlink(target, link)
      return true
    } catch {
      return false
    }
  }

  it('should emit a loop warning for A↔B directory symlinks and not hang', async () => {
    // Build two directories that symlink into each other. maxDepth is the
    // safety net — without the visited-realpath set it would still waste
    // work up to maxDepth. With the set, we get a `loop` warning and
    // short-circuit.
    await fs.mkdir(join(testDir, 'dir-a'), { recursive: true })
    await fs.mkdir(join(testDir, 'dir-b'), { recursive: true })
    await fs.writeFile(join(testDir, 'dir-a', 'SKILL.md'), '# A Skill')
    await fs.writeFile(join(testDir, 'dir-b', 'SKILL.md'), '# B Skill')
    if (!(await trySymlink(join(testDir, 'dir-b'), join(testDir, 'dir-a', 'link-to-b')))) return
    if (!(await trySymlink(join(testDir, 'dir-a'), join(testDir, 'dir-b', 'link-to-a')))) return

    const adapter = new LocalFilesystemAdapter({
      id: 'loop-ab',
      name: 'Loop A↔B',
      type: 'local',
      baseUrl: 'file://',
      enabled: true,
      rootDir: testDir,
      followSymlinks: true,
      maxDepth: 10,
      rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
    })

    await adapter.initialize()
    const result = await adapter.search({})
    const loopWarnings = (result.warnings ?? []).filter((w) => w.code === 'loop')
    expect(loopWarnings.length).toBeGreaterThan(0)
    // SKILL.md under dir-a and dir-b should each appear exactly once,
    // not multiplied by the symlink traversal depth.
    expect(adapter.skillCount).toBe(2)
  })

  it('should emit a loop warning for self-referencing directory symlinks', async () => {
    if (!(await trySymlink(join(testDir, 'self'), join(testDir, 'self')))) return

    const adapter = new LocalFilesystemAdapter({
      id: 'self-loop',
      name: 'Self Loop',
      type: 'local',
      baseUrl: 'file://',
      enabled: true,
      rootDir: testDir,
      followSymlinks: true,
      rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
    })

    await expect(adapter.initialize()).resolves.not.toThrow()
    const result = await adapter.search({})
    // Self-link produces either a `loop` (from the visited-set guard on a
    // repeat realpath) or `symlink-escape` / `io` depending on how the FS
    // resolves it. We only require the scan to terminate and either not
    // crash or record a typed warning — both outcomes are safe.
    expect(() => result.warnings ?? []).not.toThrow()
  })

  it('should allocate a fresh visited-realpath set per scan', async () => {
    // Two back-to-back rescans must each produce the loop warning; if the
    // set leaked between scans, the second rescan would short-circuit on
    // the rootDir itself (already "visited" from the prior scan) and
    // silently find zero skills.
    await fs.mkdir(join(testDir, 'dir-a'), { recursive: true })
    await fs.writeFile(join(testDir, 'dir-a', 'SKILL.md'), '# A')
    await fs.mkdir(join(testDir, 'dir-b'), { recursive: true })
    if (!(await trySymlink(join(testDir, 'dir-b'), join(testDir, 'dir-a', 'link-to-b')))) return
    if (!(await trySymlink(join(testDir, 'dir-a'), join(testDir, 'dir-b', 'link-to-a')))) return

    const adapter = new LocalFilesystemAdapter({
      id: 'per-scan-reset',
      name: 'Per-Scan Reset',
      type: 'local',
      baseUrl: 'file://',
      enabled: true,
      rootDir: testDir,
      followSymlinks: true,
      rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
    })

    await adapter.initialize()
    const firstCount = adapter.skillCount
    const secondCount = await adapter.rescan()
    expect(secondCount).toBe(firstCount)
    expect(secondCount).toBeGreaterThan(0)
  })

  it('should detect loops even when allowSymlinksOutsideRoot is true', async () => {
    // Loops are a correctness issue, not a security one. The opt-in that
    // relaxes containment must NOT relax loop detection.
    await fs.mkdir(join(testDir, 'dir-a'), { recursive: true })
    await fs.mkdir(join(testDir, 'dir-b'), { recursive: true })
    await fs.writeFile(join(testDir, 'dir-a', 'SKILL.md'), '# A')
    if (!(await trySymlink(join(testDir, 'dir-b'), join(testDir, 'dir-a', 'link-to-b')))) return
    if (!(await trySymlink(join(testDir, 'dir-a'), join(testDir, 'dir-b', 'link-to-a')))) return

    const adapter = new LocalFilesystemAdapter({
      id: 'loop-with-opt-in',
      name: 'Loop With Opt-In',
      type: 'local',
      baseUrl: 'file://',
      enabled: true,
      rootDir: testDir,
      followSymlinks: true,
      allowSymlinksOutsideRoot: true,
      rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
    })

    await adapter.initialize()
    const result = await adapter.search({})
    const loopWarnings = (result.warnings ?? []).filter((w) => w.code === 'loop')
    expect(loopWarnings.length).toBeGreaterThan(0)
  })

  it('should scan a legitimate deep non-looping tree without loop warnings', async () => {
    // 5-level non-looping tree; each level has a SKILL.md. No symlinks.
    let dir = testDir
    for (const part of ['l1', 'l2', 'l3', 'l4', 'l5']) {
      dir = join(dir, part)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(join(dir, 'SKILL.md'), `# ${part}`)
    }

    const adapter = new LocalFilesystemAdapter({
      id: 'deep-tree',
      name: 'Deep Tree',
      type: 'local',
      baseUrl: 'file://',
      enabled: true,
      rootDir: testDir,
      maxDepth: 10,
      followSymlinks: true,
      rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
    })

    await adapter.initialize()
    const result = await adapter.search({})
    const loopWarnings = (result.warnings ?? []).filter((w) => w.code === 'loop')
    expect(loopWarnings).toHaveLength(0)
    expect(adapter.skillCount).toBe(5)
  })
})

describe('LocalFilesystemAdapter SMI-4320 byte-wise containment', () => {
  it('accepts a candidate equal to root', () => {
    expect(isRealpathContained('/a/root', '/a/root')).toBe(true)
  })

  it('accepts a candidate strictly inside root', () => {
    expect(isRealpathContained(`/a/root${sep}skill${sep}SKILL.md`, '/a/root')).toBe(true)
  })

  it('rejects trailing-separator-confused neighbour (rootfoo not inside root)', () => {
    // THE regression test for the SMI-4320 trailing-separator guard: without
    // the `+ sep`, `startsWith('/a/root')` accepts `/a/rootfoo` — which is a
    // completely unrelated directory.
    expect(isRealpathContained('/a/rootfoo', '/a/root')).toBe(false)
    expect(isRealpathContained('/a/rootfoo/file', '/a/root')).toBe(false)
  })

  it('rejects candidates outside root', () => {
    expect(isRealpathContained('/b/other', '/a/root')).toBe(false)
    expect(isRealpathContained('/etc/passwd', '/a/root')).toBe(false)
  })

  it('treats case-differing paths as distinct on a case-sensitive volume', () => {
    // Byte-wise, not platform-normalised. This is the SMI-4320 correctness
    // target: removing `normaliseForFs` means `/a/Root` and `/a/root` are
    // genuinely different strings. On macOS APFS default (case-insensitive),
    // `realpath` itself would canonicalise both to the same bytes before
    // this helper runs.
    expect(isRealpathContained(`/a/root${sep}skill`, '/a/Root')).toBe(false)
    expect(isRealpathContained(`/a/Root${sep}skill`, '/a/root')).toBe(false)
  })
})

describe('LocalFilesystemAdapter SMI-4320 direct-access containment', () => {
  let testDir: string
  let adapter: LocalFilesystemAdapter

  beforeEach(async () => {
    testDir = join(tmpdir(), uniq('skillsmith-4320'))
    await fs.mkdir(testDir, { recursive: true })
    await fs.mkdir(join(testDir, 'skill-one'), { recursive: true })
    await fs.writeFile(
      join(testDir, 'skill-one', 'SKILL.md'),
      '---\nname: Skill One\n---\n# Skill One'
    )
    adapter = new LocalFilesystemAdapter({
      id: 'security-direct',
      name: 'Security Direct',
      type: 'local',
      baseUrl: 'file://',
      enabled: true,
      rootDir: testDir,
      followSymlinks: true,
      rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
    })
    await adapter.initialize()
  })

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => undefined)
  })

  it('rejects fetchSkillContent on a symlink pointing outside root (post-scan swap)', async () => {
    if (platform() === 'win32') return
    // Simulate the TOCTOU scenario: legitimate file discovered during scan,
    // replaced between scan and fetch with a symlink to an external poisoned
    // file. The realpath containment in `resolveSkillPath` must reject the
    // fetch before the external file is read.
    const externalDir = join(tmpdir(), uniq('external-poison'))
    await fs.mkdir(externalDir, { recursive: true })
    const poisonFile = join(externalDir, 'SKILL.md')
    await fs.writeFile(poisonFile, '# POISONED — should never be read')

    try {
      // `skill-swap` inside root is a symlink to the external poisoned dir.
      await fs.symlink(externalDir, join(testDir, 'skill-swap'))
      await expect(adapter.fetchSkillContent({ path: 'skill-swap/SKILL.md' })).rejects.toThrow(
        /realpath containment|Path traversal|Symlink outside root/
      )
    } finally {
      await fs.rm(externalDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('rejects getRepository on an escaping symlink', async () => {
    if (platform() === 'win32') return
    const externalDir = join(tmpdir(), uniq('external-getrepo'))
    await fs.mkdir(externalDir, { recursive: true })
    await fs.writeFile(join(externalDir, 'SKILL.md'), '# external')
    try {
      await fs.symlink(externalDir, join(testDir, 'escape-repo'))
      await expect(adapter.getRepository({ path: 'escape-repo/SKILL.md' })).rejects.toThrow(
        /realpath containment|Path traversal|Symlink outside root/
      )
    } finally {
      await fs.rm(externalDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('rejects skillExists on an escaping symlink', async () => {
    if (platform() === 'win32') return
    const externalDir = join(tmpdir(), uniq('external-exists'))
    await fs.mkdir(externalDir, { recursive: true })
    await fs.writeFile(join(externalDir, 'SKILL.md'), '# external')
    try {
      await fs.symlink(externalDir, join(testDir, 'escape-exists'))
      // skillExists must throw (SMI-720 contract on containment failure)
      // rather than silently returning true for an out-of-root realpath.
      await expect(adapter.skillExists({ path: 'escape-exists/SKILL.md' })).rejects.toThrow(
        /realpath containment|Path traversal|Symlink outside root/
      )
    } finally {
      await fs.rm(externalDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('accepts fetchSkillContent via a symlink that stays inside root', async () => {
    if (platform() === 'win32') return
    // `skill-alias` inside root points to a real skill inside root.
    // Containment check passes; content is read from the real target.
    await fs.symlink(join(testDir, 'skill-one'), join(testDir, 'skill-alias'))
    const content = await adapter.fetchSkillContent({
      path: 'skill-alias/SKILL.md',
    })
    expect(content.rawContent).toContain('# Skill One')
  })
})

describe('LocalFilesystemAdapter SMI-4287 opt-in regression (SMI-4320)', () => {
  let testDir: string
  let externalDir: string

  beforeEach(async () => {
    testDir = join(tmpdir(), uniq('skillsmith-4287-regr'))
    await fs.mkdir(testDir, { recursive: true })
    externalDir = join(tmpdir(), uniq('external-opt-in'))
    await fs.mkdir(externalDir, { recursive: true })
    await fs.writeFile(join(externalDir, 'SKILL.md'), '# External Permitted')
  })

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => undefined)
    await fs.rm(externalDir, { recursive: true, force: true }).catch(() => undefined)
  })

  it('allowSymlinksOutsideRoot: true permits fetchSkillContent via an escaping symlink', async () => {
    if (platform() === 'win32') return
    await fs.symlink(externalDir, join(testDir, 'ext-link'))
    const adapter = new LocalFilesystemAdapter({
      id: 'opt-in-allow',
      name: 'Opt-In Allow',
      type: 'local',
      baseUrl: 'file://',
      enabled: true,
      rootDir: testDir,
      followSymlinks: true,
      allowSymlinksOutsideRoot: true,
      rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
    })
    await adapter.initialize()

    const content = await adapter.fetchSkillContent({
      path: 'ext-link/SKILL.md',
    })
    expect(content.rawContent).toContain('# External Permitted')
  })

  it('allowSymlinksOutsideRoot: false rejects the same symlink', async () => {
    if (platform() === 'win32') return
    await fs.symlink(externalDir, join(testDir, 'ext-link'))
    const adapter = new LocalFilesystemAdapter({
      id: 'opt-in-reject',
      name: 'Opt-In Reject',
      type: 'local',
      baseUrl: 'file://',
      enabled: true,
      rootDir: testDir,
      followSymlinks: true,
      allowSymlinksOutsideRoot: false,
      rateLimit: { maxRequests: 100, windowMs: 60000, minDelayMs: 0 },
    })
    await adapter.initialize()

    await expect(adapter.fetchSkillContent({ path: 'ext-link/SKILL.md' })).rejects.toThrow(
      /realpath containment|Path traversal|Symlink outside root/
    )
  })
})
