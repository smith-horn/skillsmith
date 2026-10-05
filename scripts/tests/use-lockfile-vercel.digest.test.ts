/**
 * SMI-6944 review round 2: the content digest of the Vercel CLI's runtime closure.
 *
 * Identity (path, realpath, version, canary) proves WHICH file runs, not WHAT it
 * holds. These tests pin that `--verify-only` recomputes a digest over the CLI's
 * closure and compares it against the value the install step published as a STEP
 * OUTPUT, never against anything a later step can rewrite in the workspace or in
 * RUNNER_TEMP.
 *
 * Every refusal is paired with a control from the same fixture that passes, so a
 * red result cannot come from a verifier that refuses everything.
 *
 * @see docs/internal/implementation/smi-6944-vercel-cli-from-lockfile.md
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  BUILD_UTILS_JS,
  buildTree,
  install,
  outputDigests,
  run,
  smolToml,
  verify,
  type Tree,
} from './use-lockfile-vercel.fixture'

const VC_JS = 'node_modules/vercel/dist/vc.js'
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/

/** Flip one byte of a file in place (same length, same version output). */
function flipByte(t: Tree, rel: string, at = -2) {
  const p = join(t.ws, rel)
  const buf = readFileSync(p)
  const i = at < 0 ? buf.length + at : at
  buf[i] = buf[i] === 0x20 ? 0x09 : 0x20
  writeFileSync(p, buf)
}

describe('SMI-6944 round 2: content digest of the CLI closure', () => {
  let root: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ulvd-')))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('install mode publishes exactly one sha256 digest as a step output, and it is deterministic', () => {
    const t = buildTree(root)
    const d1 = install(t)
    expect(d1).toMatch(DIGEST_RE)
    writeFileSync(t.ghOutput, '')
    expect(install(t)).toBe(d1)
  })

  it('control: verify-only with the published digest passes on the untouched tree', () => {
    const t = buildTree(root)
    const r = verify(t, install(t))
    expect(r.err).toBe('')
    expect(r.status).toBe(0)
    expect(r.out).toContain('digest matches')
  })

  it('(a) a one-byte rewrite of vc.js that keeps the locked version is refused by the digest', () => {
    const t = buildTree(root)
    const digest = install(t)
    flipByte(t, VC_JS)
    // Presence: identity and version still hold, so only the content check can refuse.
    expect(run(t, undefined, [], { GITHUB_OUTPUT: join(root, 'scratch-out') }).status).toBe(0)
    const r = verify(t, digest)
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('::error::use-lockfile-vercel: cli-digest: the CLI closure changed')
  })

  it('(c) a one-byte change to a hoisted dependency file (not vc.js, outside node_modules/vercel) is refused', () => {
    const t = buildTree(root)
    const digest = install(t)
    flipByte(t, BUILD_UTILS_JS)
    const r = verify(t, digest)
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('use-lockfile-vercel: cli-digest: the CLI closure changed')
    // The diagnostic names the file, from the RUNNER_TEMP manifest (untrusted, naming only).
    expect(r.err).toContain(BUILD_UTILS_JS)
  })

  it('(b) rewriting the tree AND every file the installer writes still fails: the expected value is the step output', () => {
    const t = buildTree(root)
    const recorded = install(t)
    flipByte(t, VC_JS)
    // The attacker re-runs the installer against the tampered tree, which rewrites the
    // RUNNER_TEMP manifest, the shim dir and any workspace/RUNNER_TEMP file the
    // installer might keep, and drops a digest file at the obvious workspace paths.
    const attackerOut = join(root, 'attacker-output')
    writeFileSync(attackerOut, '')
    const rerun = run(t, undefined, [], { GITHUB_OUTPUT: attackerOut, GITHUB_PATH: attackerOut })
    expect(rerun.status).toBe(0)
    const forged = outputDigests(attackerOut)[0]
    expect(forged).toMatch(DIGEST_RE)
    expect(forged).not.toBe(recorded)
    for (const p of [join(t.ws, '.vercel-cli-digest'), join(t.temp, 'vercel-cli-digest')]) {
      writeFileSync(p, `${forged}\n`)
    }
    // The deploy step still gets the ORIGINAL output through env, and refuses.
    const r = verify(t, recorded)
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('cli-digest: the CLI closure changed')
    // Control: had the forged value been the step output, verify would pass, so the
    // refusal above is due to where the expected value comes from.
    expect(verify(t, forged).status).toBe(0)
  })

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not a sha256 value', 'deadbeef'],
  ])('verify-only fails closed when VERCEL_CLI_DIGEST is %s', (_n, value) => {
    const t = buildTree(root)
    install(t)
    const r = verify(t, value)
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('use-lockfile-vercel: cli-digest: VERCEL_CLI_DIGEST')
  })

  it('a new nested package that would shadow a hoisted dependency is refused by path', () => {
    const t = buildTree(root, { override: null }) // canary off: only the digest step can see it
    const digest = install(t)
    const nested = join(t.ws, 'node_modules/vercel/node_modules/smol-toml')
    smolToml(nested, '1.9.0')
    // It sits at a level Node consults before the hoisted copy, so the shadow check
    // names it (the digest would also have changed: the N line for it is new).
    const r = verify(t, digest)
    expect(r.status).not.toBe(0)
    expect(r.err).toContain(`but ${nested} exists`)
    expect(r.err).toContain('use-lockfile-vercel: cli-digest')
  })

  it('a symlink inside the hashed tree is refused by name, not followed', () => {
    const t = buildTree(root)
    symlinkSync('/etc/hosts', join(t.ws, 'node_modules/@vercel/build-utils/dist/link.js'))
    const r = run(t)
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('digest-symlink: node_modules/@vercel/build-utils/dist/link.js')
    expect(r.err).toContain('use-lockfile-vercel: cli-digest')
    expect(readFileSync(t.ghOutput, 'utf-8')).toBe('')
  })

  it('a required closure package missing on disk is refused at install', () => {
    const t = buildTree(root)
    rmSync(join(t.ws, 'node_modules/@vercel/build-utils'), { recursive: true })
    const r = run(t)
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('digest-missing: node_modules/@vercel/build-utils')
  })

  // ---- M1: an optional edge the lockfile does not resolve ---------------------
  const U_LINE = 'U node_modules/@vercel/build-utils encoding unresolved-optional absent'
  const plantEncoding = (dir: string) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{"name":"encoding","version":"0.1.13"}')
    writeFileSync(join(dir, 'index.js'), 'module.exports = {}\n')
  }

  it('an unresolved optional edge is recorded in the manifest and counted on stdout', () => {
    const t = buildTree(root)
    const r = run(t)
    expect(r.status).toBe(0)
    expect(r.out).toContain(' unresolved=1;')
    const manifest = readFileSync(join(t.temp, 'vercel-cli-digest.manifest'), 'utf-8')
    expect(manifest.split('\n')).toContain(U_LINE)
  })

  it.each([
    ['the workspace root node_modules', (t: Tree) => join(t.ws, 'node_modules/encoding')],
    ['a node_modules above the workspace', (t: Tree) => join(t.root, 'node_modules/encoding')],
    [
      "the requiring package's own node_modules",
      (t: Tree) => join(t.ws, 'node_modules/@vercel/build-utils/node_modules/encoding'),
    ],
  ])('a package planted in %s for an unresolved optional edge is refused by path', (_n, where) => {
    const t = buildTree(root)
    const digest = install(t)
    const planted = where(t)
    plantEncoding(planted)
    const v = verify(t, digest)
    expect(v.status).not.toBe(0)
    expect(v.err).toContain(`digest-unresolved: node_modules/@vercel/build-utils optionally`)
    expect(v.err).toContain(`but ${planted} exists`)
    expect(v.err).toContain('use-lockfile-vercel: cli-digest')
    const out = join(root, 'out-planted')
    writeFileSync(out, '')
    const i = run(t, undefined, [], { GITHUB_OUTPUT: out })
    expect(i.status).not.toBe(0)
    expect(i.err).toContain(`but ${planted} exists`)
    expect(readFileSync(out, 'utf-8')).toBe('')
    // Control: removing the planted package restores the recorded digest.
    rmSync(planted, { recursive: true })
    expect(verify(t, digest).status).toBe(0)
  })

  // ---- file forms and absent-optional packages on a lookup path ----------------
  /** Rewrite the fixture lockfile in place. */
  const editLock = (t: Tree, fn: (pkgs: Record<string, Record<string, unknown>>) => void) => {
    const p = join(t.ws, 'package-lock.json')
    const lock = JSON.parse(readFileSync(p, 'utf-8'))
    fn(lock.packages)
    writeFileSync(p, JSON.stringify(lock))
  }
  /** `plat-x`: lockfile-optional, resolved by the lockfile, and not installed. */
  const addAbsentOptional = (t: Tree) =>
    editLock(t, (pkgs) => {
      pkgs['node_modules/vercel'].optionalDependencies = { 'plat-x': '1.0.0' }
      pkgs['node_modules/plat-x'] = { version: '1.0.0', optional: true }
    })
  const plantFile = (file: string, body = 'module.exports = {}\n') => {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, body)
  }
  const expectRefused = (t: Tree, digest: string, planted: string) => {
    const v = verify(t, digest)
    expect(v.status).not.toBe(0)
    expect(v.err).toContain(`but ${planted} exists`)
    expect(v.err).toContain('use-lockfile-vercel: cli-digest')
    const out = join(t.root, 'out-file-form')
    writeFileSync(out, '')
    const i = run(t, undefined, [], { GITHUB_OUTPUT: out })
    expect(i.status).not.toBe(0)
    expect(i.err).toContain(`but ${planted} exists`)
    expect(readFileSync(out, 'utf-8')).toBe('')
  }

  it.each(['.js', '.json', '.node'])(
    'a planted encoding%s file (not a directory) is refused by path, at the workspace root and above it',
    (suffix) => {
      for (const where of [
        (t: Tree) => join(t.ws, `node_modules/encoding${suffix}`),
        (t: Tree) => join(t.root, `node_modules/encoding${suffix}`),
      ]) {
        const t = buildTree(realpathSync(mkdtempSync(join(root, 'case-'))))
        const digest = install(t)
        const planted = where(t)
        plantFile(planted)
        expectRefused(t, digest, planted)
        // Control: removing it restores the recorded digest.
        rmSync(planted)
        expect(verify(t, digest).status).toBe(0)
      }
    }
  )

  it('a dangling symlink named encoding.js is refused too: presence is lstat, not a followed stat', () => {
    const t = buildTree(root)
    const digest = install(t)
    const planted = join(t.ws, 'node_modules/encoding.js')
    symlinkSync(join(root, 'does-not-exist'), planted)
    expectRefused(t, digest, planted)
  })

  it('a planted scoped @s/x.js file is refused by path for an unresolved scoped optional edge', () => {
    const t = buildTree(root)
    editLock(t, (pkgs) => {
      pkgs['node_modules/@vercel/build-utils'].peerDependencies = { '@s/x': '^1.0.0' }
      pkgs['node_modules/@vercel/build-utils'].peerDependenciesMeta = { '@s/x': { optional: true } }
    })
    const digest = install(t)
    const planted = join(t.ws, 'node_modules/@s/x.js')
    plantFile(planted)
    expectRefused(t, digest, planted)
    rmSync(planted)
    expect(verify(t, digest).status).toBe(0)
  })

  it('an absent-optional package is recorded, and anything planted on its lookup path is refused', () => {
    const t = buildTree(root)
    addAbsentOptional(t)
    const digest = install(t)
    const manifest = readFileSync(join(t.temp, 'vercel-cli-digest.manifest'), 'utf-8')
    expect(manifest.split('\n')).toContain('S node_modules/plat-x absent-optional')
    // Control: the clean tree verifies, and the digest is stable across installs.
    expect(verify(t, digest).status).toBe(0)
    writeFileSync(t.ghOutput, '')
    expect(install(t)).toBe(digest)
    // Each of these is a lookup path for `plat-x` that is NOT the lockfile key itself,
    // so nothing hashes it: only the path check can see it.
    for (const [file, named] of [
      [join(t.ws, 'node_modules/plat-x.js'), join(t.ws, 'node_modules/plat-x.js')],
      [join(t.ws, 'node_modules/plat-x.json'), join(t.ws, 'node_modules/plat-x.json')],
      [join(t.root, 'node_modules/plat-x/index.js'), join(t.root, 'node_modules/plat-x')],
    ]) {
      plantFile(file)
      expectRefused(t, digest, named)
      rmSync(named, { recursive: true })
      expect(verify(t, digest).status).toBe(0)
    }
  })

  // ---- a closure package shadowed by a file form or a nearer level --------------
  /** An installed, hoisted closure package `name`, required by `requirer`. */
  const addClosurePkg = (t: Tree, name: string, requirer = 'node_modules/vercel') => {
    editLock(t, (pkgs) => {
      const r = pkgs[requirer]
      r.dependencies = { ...((r.dependencies as object) || {}), [name]: '1.0.0' }
      pkgs[`node_modules/${name}`] = { version: '1.0.0' }
    })
    const dir = join(t.ws, 'node_modules', name)
    plantFile(join(dir, 'index.js'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
  }

  it.each(['.js', '.json', '.node'])(
    'a file foo%s beside the installed closure package foo/ is refused by path',
    (suffix) => {
      const t = buildTree(root)
      addClosurePkg(t, 'foo')
      const digest = install(t)
      expect(verify(t, digest).status).toBe(0) // control: foo/ alone is recorded and verifies
      const planted = join(t.ws, `node_modules/foo${suffix}`)
      plantFile(planted)
      expectRefused(t, digest, planted)
      rmSync(planted)
      expect(verify(t, digest).status).toBe(0)
    }
  )

  it('a file @s/x.js beside the installed scoped closure package @s/x/ is refused by path', () => {
    const t = buildTree(root)
    addClosurePkg(t, '@s/x')
    const digest = install(t)
    const planted = join(t.ws, 'node_modules/@s/x.js')
    plantFile(planted)
    expectRefused(t, digest, planted)
    rmSync(planted)
    expect(verify(t, digest).status).toBe(0)
  })

  it('a copy at a level nearer than the package for one of its requirers is refused; one farther away is not', () => {
    const t = buildTree(root)
    addClosurePkg(t, 'foo', 'node_modules/@vercel/build-utils')
    const digest = install(t)
    // Farther than the real location (above the workspace): Node never reaches it.
    plantFile(join(t.root, 'node_modules/foo.js'))
    expect(verify(t, digest).status).toBe(0)
    // Nearer for @vercel/build-utils: node_modules/@vercel/node_modules is consulted first.
    const planted = join(t.ws, 'node_modules/@vercel/node_modules/foo')
    plantFile(join(planted, 'index.js'))
    expectRefused(t, digest, planted)
  })

  it('an absent-optional package that appears at its own key is hashed, so the digest changes', () => {
    const t = buildTree(root)
    addAbsentOptional(t)
    const digest = install(t)
    plantFile(join(t.ws, 'node_modules/plat-x/index.js'))
    const v = verify(t, digest)
    expect(v.status).not.toBe(0)
    expect(v.err).toContain('cli-digest: the CLI closure changed')
    expect(v.err).toContain('+ F node_modules/plat-x/index.js')
  })

  it('the RUNNER_TEMP manifest is diagnostic only: deleting or forging it does not change the verdict', () => {
    const t = buildTree(root)
    const digest = install(t)
    const manifest = join(t.temp, 'vercel-cli-digest.manifest')
    expect(readdirSync(t.temp)).toContain('vercel-cli-digest.manifest')
    rmSync(manifest)
    expect(verify(t, digest).status).toBe(0)
    flipByte(t, VC_JS)
    writeFileSync(manifest, 'forged\n')
    expect(verify(t, digest).status).not.toBe(0)
  })
})
