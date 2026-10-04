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

  it('a new nested package that would shadow a hoisted dependency changes the digest', () => {
    const t = buildTree(root, { override: null }) // canary off: only the digest can see it
    const digest = install(t)
    smolToml(join(t.ws, 'node_modules/vercel/node_modules/smol-toml'), '1.9.0')
    const r = verify(t, digest)
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('cli-digest: the CLI closure changed')
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
