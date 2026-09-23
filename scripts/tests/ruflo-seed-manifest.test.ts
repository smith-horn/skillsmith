/**
 * SMI-6744 / ADR-170 § 7 -- scripts/ruflo-seed/manifest.mjs test suite.
 *
 * Runnable on the HOST: `npx vitest run scripts/tests/ruflo-seed-manifest.test.ts`
 * from the worktree root. manifest.mjs is pure Node builtins (fs, crypto,
 * path, url) with no dependencies and no native modules, so unlike most of
 * this repo's Docker-only surfaces (better-sqlite3, onnxruntime-node), host
 * execution is a faithful test of its actual behaviour, not an approximation
 * of container behaviour.
 *
 * manifest.mjs is invoked as a REAL child process (execFileSync/spawnSync)
 * against real scratch filesystem trees under a temp directory -- never
 * mocked fs calls -- matching this repo's SMI-6015-derived convention for
 * SQL/graph-correctness-shaped logic (see scripts/tests/check-submodule-pointer.test.ts).
 *
 * Twelve correctness properties (one `it()` each; 1-10 match the task's own
 * original numbering, 11-12 were added for the SMI-6744 governance review
 * round, 2026-09-23, finding L-20 a/b/c):
 *   1. two generations of the same tree are byte-identical
 *   2. modifying one file's content changes the digest
 *   3. adding an empty directory changes the digest
 *   4. changing one directory's mode changes the digest
 *   5. a newline-containing filename and a non-ASCII filename are both
 *      covered, and ordered by bytes
 *   6. a setuid/setgid/sticky-only change to a regular file changes the digest
 *   7. a FIFO under the root makes generation FAIL, naming path and type,
 *      and exits 3 (L-20b: distinct from an uncaught-exception's exit 1)
 *   8. two same-content files hard-linked to one inode make generation FAIL,
 *      naming path, link count and type, and exits 3 (L-20b, as above)
 *   9. a dangling symlink is accepted, and its raw target is recorded
 *   10. ordering is unsigned BYTE comparison, not locale collation
 *   11. chmod of the COVERED ROOT ITSELF changes the digest (L-20a: the
 *       root's own mode is now the manifest's leading ROOT_MODE field)
 *   12. a symlink's mode is masked to a fixed constant -- a symlink's mode
 *       never affects the digest, while its target still does (L-20c)
 *
 * Then eight RED-ARM tests (SMI-6598's "revert the fix, watch it fail"
 * rule, applied to a generator rather than a bug fix): each takes the
 * generator's own source, applies ONE targeted mutation that disables the
 * invariant a specific `it()` above depends on, runs the MUTATED copy
 * against a fixture that would normally exercise that invariant, and
 * asserts the property named above now FAILS to hold. Every mutation runs
 * against a throwaway file under the test's own temp dir -- the committed
 * scripts/ruflo-seed/manifest.mjs is never written to. The mutation
 * `describe` block's own `afterAll` re-reads the real file and asserts its
 * md5 is unchanged from what was read at the start of the suite, so "the
 * file restored, its md5 compared" is verified directly rather than merely
 * assumed from "we only touched a copy". Three of the eight (L-20 a/b/c)
 * were added for the same governance round as properties 11-12 above; the
 * L-20c arm degrades to a documented no-op assertion on a platform where a
 * fresh symlink's real mode is already 0777 (e.g. Linux), since there is no
 * way to construct a symlink whose real mode differs from the masked
 * constant on such a platform -- an intrinsic platform limitation, not a
 * gap in the test.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  chmodSync,
  lchmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MANIFEST_SCRIPT = resolve(__dirname, '..', 'ruflo-seed', 'manifest.mjs')

// ---------------------------------------------------------------------------
// Fixture + invocation plumbing
// ---------------------------------------------------------------------------

/** A small base tree: one file, one subdirectory with a nested file, one symlink. */
function buildBaseTree(dir: string): void {
  writeFileSync(join(dir, 'a.txt'), 'hello')
  mkdirSync(join(dir, 'sub'))
  writeFileSync(join(dir, 'sub', 'nested.txt'), 'nested')
  symlinkSync('a.txt', join(dir, 'link-to-a'))
}

function runFull(root: string): SpawnSyncReturns<Buffer> {
  return spawnSync(process.execPath, [MANIFEST_SCRIPT, root])
}

function runDigestOnly(root: string): string {
  return execFileSync(process.execPath, [MANIFEST_SCRIPT, root, '--digest']).toString('utf8').trim()
}

interface ManifestRecord {
  path: Buffer
  type: string
  mode: string
  target?: Buffer
}

/**
 * Independent decoder for manifest.mjs's own documented wire format
 * (manifest.mjs's header comment). Written fresh from the spec, not by
 * importing manifest.mjs's internals, so a test using it is a genuine check
 * of the ON-THE-WIRE bytes, not a check that agrees with itself by
 * construction.
 *
 * L-20a: `rootMode` is the 4-byte ROOT_MODE field emitted right after
 * VERSION_BYTES, before any record -- decoded independently here too, not
 * inferred from manifest.mjs's own source.
 */
function parseManifest(buf: Buffer): {
  version: string
  rootMode: string
  records: ManifestRecord[]
} {
  let offset = 0
  function readLP(): Buffer {
    const len = buf.readUInt32BE(offset)
    offset += 4
    const b = buf.subarray(offset, offset + len)
    offset += len
    return b
  }
  const version = readLP().toString('ascii')
  const rootMode = buf.subarray(offset, offset + 4).toString('ascii')
  offset += 4
  const records: ManifestRecord[] = []
  while (offset < buf.length) {
    const path = readLP()
    const type = String.fromCharCode(buf[offset])
    offset += 1
    const mode = buf.subarray(offset, offset + 4).toString('ascii')
    offset += 4
    if (type === 'd') {
      records.push({ path, type, mode })
    } else if (type === 'f') {
      offset += 8 // size (uint64 BE)
      offset += 64 // sha256 hex
      records.push({ path, type, mode })
    } else if (type === 'l') {
      const target = readLP()
      records.push({ path, type, mode, target })
    } else {
      throw new Error(
        `parseManifest: unrecognised record type byte 0x${buf[offset - 5].toString(16)}`
      )
    }
  }
  return { version, rootMode, records }
}

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(realpathSync(tmpdir()), 'ruflo-manifest-test-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1-10: correctness properties
// ---------------------------------------------------------------------------

describe('ruflo-seed manifest generator (SMI-6744, ADR-170 § 7)', () => {
  it('1. two generations of the same tree are byte-identical', () => {
    buildBaseTree(workDir)
    const r1 = runFull(workDir)
    const r2 = runFull(workDir)
    expect(r1.status).toBe(0)
    expect(r2.status).toBe(0)
    expect(Buffer.compare(r1.stdout, r2.stdout)).toBe(0)
    expect(r1.stderr.toString('utf8').trim()).toBe(r2.stderr.toString('utf8').trim())
  })

  it("2. modifying one file's content changes the digest", () => {
    buildBaseTree(workDir)
    const base = runDigestOnly(workDir)
    writeFileSync(join(workDir, 'a.txt'), 'hello, mutated')
    expect(runDigestOnly(workDir)).not.toBe(base)
  })

  it('3. adding an empty directory changes the digest', () => {
    buildBaseTree(workDir)
    const base = runDigestOnly(workDir)
    mkdirSync(join(workDir, 'empty-dir'))
    expect(runDigestOnly(workDir)).not.toBe(base)
  })

  it("4. changing one directory's mode changes the digest", () => {
    buildBaseTree(workDir)
    const base = runDigestOnly(workDir)
    chmodSync(join(workDir, 'sub'), 0o700)
    expect(runDigestOnly(workDir)).not.toBe(base)
  })

  it('5. a newline filename and a non-ASCII filename are both covered, ordered by bytes', () => {
    writeFileSync(join(workDir, 'weird\nname.txt'), 'a')
    writeFileSync(join(workDir, 'café.txt'), 'b')
    const result = runFull(workDir)
    expect(result.status).toBe(0)
    const { records } = parseManifest(result.stdout)
    const paths = records.map((r) => r.path.toString('utf8'))
    expect(paths).toContain('weird\nname.txt')
    expect(paths).toContain('café.txt')
    // 'café.txt' starts 0x63 ('c'); 'weird\nname.txt' starts 0x77 ('w') -- byte order puts café first
    expect(paths.indexOf('café.txt')).toBeLessThan(paths.indexOf('weird\nname.txt'))
    // and the whole record sequence is exactly the unsigned-byte sort of its own paths
    const sorted = records.map((r) => r.path).sort(Buffer.compare)
    records.forEach((r, i) => expect(Buffer.compare(r.path, sorted[i])).toBe(0))
  })

  it('6. a setuid/setgid/sticky-only change to a regular file changes the digest', () => {
    buildBaseTree(workDir)
    const target = join(workDir, 'a.txt')
    const baseMode = statSync(target).mode & 0o777
    const base = runDigestOnly(workDir)

    for (const bit of [0o4000, 0o2000, 0o1000]) {
      chmodSync(target, baseMode | bit)
      expect(runDigestOnly(workDir)).not.toBe(base)
      chmodSync(target, baseMode)
    }
    expect(runDigestOnly(workDir)).toBe(base) // restored cleanly between bits
  })

  it('7. a FIFO under the root makes generation FAIL (exit 3, L-20b), naming the path and type', () => {
    buildBaseTree(workDir)
    execFileSync('mkfifo', [join(workDir, 'myfifo')])
    const result = runFull(workDir)
    expect(result.status).toBe(3) // ManifestRefusal, not an uncaught exception's exit 1
    const stderr = result.stderr.toString('utf8')
    expect(stderr).toContain('myfifo')
    expect(stderr).toContain('FIFO')
  })

  it('8. two same-content files hard-linked to one inode make generation FAIL (exit 3, L-20b), naming path, link count and type', () => {
    buildBaseTree(workDir)
    const orig = join(workDir, 'dup-orig.txt')
    writeFileSync(orig, 'same content')
    linkSync(orig, join(workDir, 'dup-link.txt'))
    const result = runFull(workDir)
    expect(result.status).toBe(3) // ManifestRefusal, not an uncaught exception's exit 1
    const stderr = result.stderr.toString('utf8')
    expect(stderr).toMatch(/dup-(orig|link)\.txt/)
    expect(stderr).toContain('st_nlink=2')
    expect(stderr).toContain('type=regular file')
  })

  it('9. a dangling symlink is accepted, and its raw target is recorded', () => {
    buildBaseTree(workDir)
    symlinkSync('this-target-does-not-exist.txt', join(workDir, 'dangling'))
    const result = runFull(workDir)
    expect(result.status).toBe(0)
    const { records } = parseManifest(result.stdout)
    const rec = records.find((r) => r.path.toString('utf8') === 'dangling')
    expect(rec).toBeDefined()
    expect(rec?.type).toBe('l')
    expect(rec?.target?.toString('utf8')).toBe('this-target-does-not-exist.txt')
  })

  it('10. ordering is unsigned byte comparison, not locale collation', () => {
    writeFileSync(join(workDir, 'zebra.txt'), 'z')
    writeFileSync(join(workDir, 'émile.txt'), 'e')
    // Sanity: locale collation orders these the OTHER way (measured, not assumed).
    expect(['zebra.txt', 'émile.txt'].sort((a, b) => a.localeCompare(b))).toEqual([
      'émile.txt',
      'zebra.txt',
    ])

    const result = runFull(workDir)
    expect(result.status).toBe(0)
    const { records } = parseManifest(result.stdout)
    const paths = records.map((r) => r.path.toString('utf8'))
    expect(paths).toContain('zebra.txt')
    expect(paths).toContain('émile.txt')
    // byte order: 'z' (0x7a) < first byte of 'é' (0xc3) -- zebra.txt sorts FIRST
    expect(paths.indexOf('zebra.txt')).toBeLessThan(paths.indexOf('émile.txt'))
  })

  it('11. chmod of the covered root itself changes the digest (L-20a: the root has its own ROOT_MODE field)', () => {
    buildBaseTree(workDir)
    const base = runDigestOnly(workDir)
    const baseRootMode = statSync(workDir).mode & 0o777
    // Pick a target mode guaranteed to differ from whatever this platform's
    // mkdtempSync happened to default to (measured: 0700 on this host, but
    // never assumed) rather than hardcoding a specific "before" value.
    const newRootMode = baseRootMode === 0o755 ? 0o700 : 0o755
    chmodSync(workDir, newRootMode)
    try {
      expect(runDigestOnly(workDir)).not.toBe(base)
    } finally {
      chmodSync(workDir, baseRootMode)
    }
  })

  it("12. a symlink's mode is masked to a fixed constant, so a symlink's mode never affects the digest while its target still does (L-20c)", () => {
    buildBaseTree(workDir)
    const linkPath = join(workDir, 'link-to-a')

    const result = runFull(workDir)
    expect(result.status).toBe(0)
    const { records } = parseManifest(result.stdout)
    const rec = records.find((r) => r.path.toString('utf8') === 'link-to-a')
    // Masked to the fixed constant regardless of the real filesystem mode
    // (which is itself platform-dependent -- see manifest.mjs's own header).
    expect(rec?.mode).toBe('0777')

    const base = runDigestOnly(workDir)

    // Best-effort: where the platform actually supports changing a
    // symlink's own mode (macOS via fs.lchmodSync), prove the masked
    // digest really is unaffected by a real mode change. Linux has no such
    // capability at all -- every symlink is unconditionally reported as
    // 0777 -- so this block legitimately no-ops there.
    let lchmodSupported = true
    try {
      lchmodSync(linkPath, 0o700)
    } catch {
      lchmodSupported = false
    }
    if (lchmodSupported) {
      expect(runDigestOnly(workDir)).toBe(base)
      lchmodSync(linkPath, 0o755) // restore before the target-change assertion below
    }

    // The target, unlike the mode, is never masked -- changing it changes the digest.
    rmSync(linkPath)
    symlinkSync('sub/nested.txt', linkPath)
    expect(runDigestOnly(workDir)).not.toBe(base)
  })
})

// ---------------------------------------------------------------------------
// Red-arm tests: mutate a scratch copy, watch the named property fail
// ---------------------------------------------------------------------------

describe('manifest.mjs red-arm tests (scratch-copy mutations)', () => {
  const originalSource = readFileSync(MANIFEST_SCRIPT, 'utf8')
  const originalMd5 = createHash('md5').update(originalSource).digest('hex')

  afterAll(() => {
    const finalSource = readFileSync(MANIFEST_SCRIPT, 'utf8')
    const finalMd5 = createHash('md5').update(finalSource).digest('hex')
    expect(finalMd5).toBe(originalMd5)
  })

  /** Apply `mutate` to the real source, write the result to a scratch file, return its path. */
  function writeMutant(mutate: (src: string) => string): string {
    const mutated = mutate(originalSource)
    expect(mutated).not.toBe(originalSource)
    const mutantPath = join(workDir, `manifest-mutant-${Math.random().toString(36).slice(2)}.mjs`)
    writeFileSync(mutantPath, mutated)
    return mutantPath
  }

  function replaceOnce(src: string, needle: string, replacement: string): string {
    expect(src.split(needle).length - 1).toBe(1) // needle must be unique, or the mutation is ambiguous
    return src.replace(needle, replacement)
  }

  it('masking high mode bits (& 0o777) makes property 6 (setuid/setgid/sticky) fail to hold', () => {
    buildBaseTree(workDir)
    const mutantPath = writeMutant((src) => replaceOnce(src, 'st.mode & 0o7777', 'st.mode & 0o777'))
    const target = join(workDir, 'a.txt')
    const baseMode = statSync(target).mode & 0o777

    const baseDigest = execFileSync(process.execPath, [mutantPath, workDir, '--digest'])
      .toString('utf8')
      .trim()
    chmodSync(target, baseMode | 0o4000)
    const setuidDigest = execFileSync(process.execPath, [mutantPath, workDir, '--digest'])
      .toString('utf8')
      .trim()
    expect(setuidDigest).toBe(baseDigest) // property 6 FAILS under this mutant
  })

  it('skipping the nlink check makes property 8 (hard-link refusal) fail to refuse', () => {
    buildBaseTree(workDir)
    const orig = join(workDir, 'dup-orig.txt')
    writeFileSync(orig, 'same content')
    linkSync(orig, join(workDir, 'dup-link.txt'))
    const mutantPath = writeMutant((src) =>
      replaceOnce(src, 'if (st.nlink !== 1) {', 'if (false) {')
    )
    const result = spawnSync(process.execPath, [mutantPath, workDir])
    expect(result.status).toBe(0) // property 8's refusal FAILS under this mutant
  })

  it('skipping the FIFO refusal makes property 7 (FIFO refusal) fail to refuse', () => {
    buildBaseTree(workDir)
    execFileSync('mkfifo', [join(workDir, 'myfifo')])
    const mutantPath = writeMutant((src) =>
      replaceOnce(
        src,
        '      } else {\n        const kind = st.isFIFO()',
        '      } else if (st.isFIFO()) {\n        continue\n      } else {\n        const kind = st.isFIFO()'
      )
    )
    const result = spawnSync(process.execPath, [mutantPath, workDir])
    expect(result.status).toBe(0) // property 7's refusal FAILS under this mutant
  })

  it('sorting with a locale comparator makes property 10 (byte order) fail to hold', () => {
    writeFileSync(join(workDir, 'zebra.txt'), 'z')
    writeFileSync(join(workDir, 'émile.txt'), 'e')
    const mutantPath = writeMutant((src) =>
      replaceOnce(
        src,
        '(a, b) => Buffer.compare(a.pathBuf, b.pathBuf)',
        "(a, b) => a.pathBuf.toString('utf8').localeCompare(b.pathBuf.toString('utf8'))"
      )
    )
    const result = spawnSync(process.execPath, [mutantPath, workDir])
    expect(result.status).toBe(0)
    const { records } = parseManifest(result.stdout)
    const paths = records.map((r) => r.path.toString('utf8'))
    expect(paths).toContain('zebra.txt')
    expect(paths).toContain('émile.txt')
    // locale order now wins: émile before zebra -- property 10 FAILS under this mutant
    expect(paths.indexOf('émile.txt')).toBeLessThan(paths.indexOf('zebra.txt'))
  })

  it('dropping directories from coverage makes properties 3 and 4 (empty dir / dir mode) fail to hold', () => {
    buildBaseTree(workDir)
    const mutantPath = writeMutant((src) =>
      replaceOnce(
        src,
        "        records.push({ pathBuf: entryRelBuf, type: 'd', modeField, payload: Buffer.alloc(0) })\n        recurse(entryAbsBuf, entryRelBuf)",
        '        recurse(entryAbsBuf, entryRelBuf)'
      )
    )
    const baseDigest = execFileSync(process.execPath, [mutantPath, workDir, '--digest'])
      .toString('utf8')
      .trim()

    mkdirSync(join(workDir, 'empty-dir'))
    const afterEmptyDir = execFileSync(process.execPath, [mutantPath, workDir, '--digest'])
      .toString('utf8')
      .trim()
    expect(afterEmptyDir).toBe(baseDigest) // property 3 FAILS under this mutant
    rmSync(join(workDir, 'empty-dir'), { recursive: true })

    chmodSync(join(workDir, 'sub'), 0o700)
    const afterModeChange = execFileSync(process.execPath, [mutantPath, workDir, '--digest'])
      .toString('utf8')
      .trim()
    expect(afterModeChange).toBe(baseDigest) // property 4 FAILS under this mutant
  })

  // -------------------------------------------------------------------------
  // L-20 a/b/c red arms (SMI-6744 governance review, 2026-09-23)
  // -------------------------------------------------------------------------

  it('dropping ROOT_MODE from serialize() makes property 11 (root chmod) fail to hold', () => {
    buildBaseTree(workDir)
    const mutantPath = writeMutant((src) =>
      replaceOnce(
        src,
        'const parts = [lp(VERSION_BYTES), rootModeField]',
        'const parts = [lp(VERSION_BYTES)]'
      )
    )
    const baseDigest = execFileSync(process.execPath, [mutantPath, workDir, '--digest'])
      .toString('utf8')
      .trim()

    const baseRootMode = statSync(workDir).mode & 0o777
    const newRootMode = baseRootMode === 0o755 ? 0o700 : 0o755
    chmodSync(workDir, newRootMode)
    try {
      const afterChmod = execFileSync(process.execPath, [mutantPath, workDir, '--digest'])
        .toString('utf8')
        .trim()
      expect(afterChmod).toBe(baseDigest) // property 11 FAILS under this mutant
    } finally {
      chmodSync(workDir, baseRootMode)
    }
  })

  it('reverting exit 3 to exit 1 makes the refusal-exit-code distinction (properties 7/8) fail to hold', () => {
    buildBaseTree(workDir)
    execFileSync('mkfifo', [join(workDir, 'myfifo')])
    const mutantPath = writeMutant((src) => replaceOnce(src, 'process.exit(3)', 'process.exit(1)'))
    const result = spawnSync(process.execPath, [mutantPath, workDir])
    expect(result.status).toBe(1) // the exit-3-vs-1 distinction FAILS under this mutant
  })

  it('using the real fs mode for symlinks instead of the masked constant makes property 12 fail to hold where the platform allows it', () => {
    buildBaseTree(workDir)
    const linkPath = join(workDir, 'link-to-a')
    const realModeOctal = (lstatSync(linkPath).mode & 0o7777).toString(8).padStart(4, '0')

    const mutantPath = writeMutant((src) =>
      replaceOnce(src, 'modeField: SYMLINK_MODE_MASK,', 'modeField,')
    )
    const result = spawnSync(process.execPath, [mutantPath, workDir])
    expect(result.status).toBe(0)
    const { records } = parseManifest(result.stdout)
    const rec = records.find((r) => r.path.toString('utf8') === 'link-to-a')

    if (realModeOctal === '0777') {
      // On a platform where a fresh symlink is ALREADY reported as 0777
      // (e.g. Linux -- manifest.mjs's own header measurement), this specific
      // mutation is a no-op: there is no way to construct a Linux symlink
      // whose real mode differs from the masked constant, so the mutant and
      // the correct implementation are indistinguishable by mode alone here.
      // Intrinsic platform limitation, not a gap in this test.
      expect(rec?.mode).toBe('0777')
    } else {
      // On a platform where the real mode differs (macOS defaults a fresh
      // symlink to 0755), the un-masked mutant diverges from the constant --
      // property 12 (mode is always masked) FAILS under this mutant.
      expect(rec?.mode).toBe(realModeOctal)
      expect(rec?.mode).not.toBe('0777')
    }
  })
})
