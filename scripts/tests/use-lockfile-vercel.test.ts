/**
 * SMI-6944 Test 4: scripts/ci/use-lockfile-vercel.sh against fake trees.
 *
 * Fixture (fake tree, env, the fake CLI that logs its invocation path) lives in
 * use-lockfile-vercel.fixture.ts; the content-digest tests live in
 * use-lockfile-vercel.digest.test.ts.
 *
 * @see docs/internal/implementation/smi-6944-vercel-cli-from-lockfile.md
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  VERSION,
  buildTree,
  fakeCli,
  install,
  run,
  smolToml,
  verify,
  writeJson,
} from './use-lockfile-vercel.fixture'

// The build-log fixtures reproduce what vercel 52.2.0 actually prints, derived from
// its dist (not guessed): the builder installer calls
//   output.log(`Installing ${pluralize("Builder", n)}: ${[...builders].join(", ")}`)
// (dist/chunks/chunk-7L7NSLYK.js), and Output.log is
//   (str, color = chalk.grey) => print(`${color(">")} ${str}\n`)
// (dist/chunks/chunk-ZQKJVHXY.js), where the bundled ansi-styles defines
// grey = gray = [90, 39]. pluralize("Builder", 1) is "Builder", else "Builders".
const GREY = (s: string) => `\x1b[90m${s}\x1b[39m`
const cliLog = (str: string, colour = true) => `${colour ? GREY('>') : '>'} ${str}\n`
const installingBuilders = (b: string[]) =>
  `Installing ${b.length === 1 ? 'Builder' : 'Builders'}: ${b.join(', ')}`
const NODE_BUILDER = '@vercel/node@5.0.0'
const STATIC = '@vercel/static-build@2.0.0'
const REAL_LINE = cliLog(installingBuilders([NODE_BUILDER]))

describe('SMI-6944 Test 4: use-lockfile-vercel.sh', () => {
  let root: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ulv-')))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('green: hoisted smol-toml 1.9.0 passes and prints versions and path', () => {
    const t = buildTree(root)
    const r = run(t)
    expect(r.err).toBe('')
    expect(r.status).toBe(0)
    expect(r.out).toMatch(
      new RegExp(
        `vercel ${VERSION} from lockfile; sha256:[0-9a-f]{64} files=\\d+ packages=3 unresolved=1; smol-toml 1\\.9\\.0 at `
      )
    )
    expect(r.out).toContain(join(t.ws, 'node_modules/smol-toml'))
  })

  it('red: hoisted >= 1.8.0 PLUS nested 1.5.2 fails and names the nested path', () => {
    const t = buildTree(root, { nested: '1.5.2' })
    const r = run(t)
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('::error::use-lockfile-vercel: smol-toml-canary')
    expect(r.err).toContain('vercel/node_modules/smol-toml')
    expect(readFileSync(t.ghPath, 'utf-8')).toBe('') // a failed run leaves PATH untouched
    expect(readFileSync(t.ghOutput, 'utf-8')).toBe('') // ...and publishes no digest
  })

  it('fails when the installed version differs from the lockfile version', () => {
    const t = buildTree(root, { installed: '51.0.0' })
    const r = run(t)
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('use-lockfile-vercel: installed-version')
  })

  it('fails when package.json pin and lockfile version disagree', () => {
    const t = buildTree(root, { pinned: '52.2.1' })
    const r = run(t)
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('use-lockfile-vercel: pin-matches-lockfile')
  })

  it('binary identity: shim resolves to vc.js and the version check ran through the shim', () => {
    const t = buildTree(root)
    const shim = join(t.temp, 'vercel-bin', 'vercel')
    const r = run(t)
    expect(existsSync(shim)).toBe(true)
    expect(realpathSync(shim)).toBe(realpathSync(join(t.ws, 'node_modules/vercel/dist/vc.js')))
    expect(r.status).toBe(0)
    const calls = readFileSync(t.log, 'utf-8').trim().split('\n')
    expect(calls.some((c) => c === shim)).toBe(true)
  })

  it('wrong binary: a decoy with the right version but another realpath is refused', () => {
    const t = buildTree(root, { binTarget: 'decoy' })
    const r = run(t)
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('use-lockfile-vercel: binary-identity')
    expect(readFileSync(t.ghPath, 'utf-8')).toBe('')
  })

  it('GITHUB_PATH holds exactly the shim dir and nothing else', () => {
    const t = buildTree(root)
    expect(run(t).status).toBe(0)
    expect(readFileSync(t.ghPath, 'utf-8')).toBe(join(t.temp, 'vercel-bin') + '\n')
  })

  it('no global fallback: .bin/vercel absent plus a global vercel on PATH still fails', () => {
    const t = buildTree(root, { binTarget: 'none' })
    const globalDir = join(root, 'global-bin')
    mkdirSync(globalDir)
    fakeCli(join(globalDir, 'vercel'), VERSION)
    const r = run(t, globalDir)
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('run npm ci')
    expect(readFileSync(t.ghPath, 'utf-8')).toBe('')
  })

  it('canary skip: no smol-toml override prints the skip message and still passes a green tree', () => {
    const t = buildTree(root, { override: null })
    const r = run(t)
    expect(r.status).toBe(0)
    expect(r.out).toContain('smol-toml canary skipped: no override recorded')
    expect(r.out).not.toContain('smol-toml 1.')
  })

  it('canary skip does not hide a binary-identity failure', () => {
    const t = buildTree(root, { override: null, binTarget: 'decoy' })
    const r = run(t)
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('use-lockfile-vercel: binary-identity')
  })
  // ---- M2: identity must not compare the CLI against itself ----------------
  it('symlinked node_modules/vercel (out-of-tree CLI) fails closed with a named error', () => {
    const t = buildTree(root)
    const evil = join(root, 'evil-vercel')
    mkdirSync(join(evil, 'dist'), { recursive: true })
    writeJson(join(evil, 'package.json'), { name: 'vercel', version: VERSION })
    fakeCli(join(evil, 'dist/vc.js'), VERSION)
    smolToml(join(evil, 'node_modules/smol-toml'), '1.9.0')
    rmSync(join(t.ws, 'node_modules/vercel'), { recursive: true })
    symlinkSync(evil, join(t.ws, 'node_modules/vercel'))
    const r = run(t)
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('use-lockfile-vercel: binary-identity')
    expect(r.err).toContain('is a symlink')
    expect(readFileSync(t.ghPath, 'utf-8')).toBe('')
  })

  it('symlinked dist/vc.js (file elsewhere) fails closed with a named error', () => {
    const t = buildTree(root)
    const elsewhere = join(root, 'elsewhere-vc.js')
    fakeCli(elsewhere, VERSION)
    rmSync(join(t.ws, 'node_modules/vercel/dist/vc.js'))
    symlinkSync(elsewhere, join(t.ws, 'node_modules/vercel/dist/vc.js'))
    const r = run(t)
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('use-lockfile-vercel: binary-identity')
    expect(r.err).toContain('is a symlink')
  })

  it('control: the same fixture without either symlink passes (the symlink is the only difference)', () => {
    const t = buildTree(root)
    expect(run(t).status).toBe(0)
  })

  // ---- Lvc: the shim dir also exposes `vc` ---------------------------------
  it('shim dir also links vc, resolving to the lockfile vc.js', () => {
    const t = buildTree(root)
    expect(run(t).status).toBe(0)
    const vc = join(t.temp, 'vercel-bin', 'vc')
    expect(existsSync(vc)).toBe(true)
    expect(realpathSync(vc)).toBe(join(t.ws, 'node_modules/vercel/dist/vc.js'))
  })

  // ---- M3: re-verification and the build-log guard --------------------------
  it('verify-only: passes on a good tree, needs no RUNNER_TEMP/GITHUB_PATH, writes no shim and no PATH', () => {
    const t = buildTree(root)
    const digest = install(t)
    rmSync(join(t.temp, 'vercel-bin'), { recursive: true })
    writeFileSync(t.ghPath, '')
    const r = verify(t, digest, { RUNNER_TEMP: undefined })
    expect(r.err).toBe('')
    expect(r.status).toBe(0)
    expect(r.out).toContain('(verify-only, digest matches)')
    expect(existsSync(join(t.temp, 'vercel-bin'))).toBe(false)
    expect(readFileSync(t.ghPath, 'utf-8')).toBe('')
  })

  it('verify-only: a decoy binary is refused', () => {
    const t = buildTree(root, { binTarget: 'decoy' })
    const r = verify(t, `sha256:${'0'.repeat(64)}`)
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('use-lockfile-vercel: binary-identity')
  })

  it('verify-only: catches a CLI that changed after the install step (vercel build ran npm install)', () => {
    const t = buildTree(root)
    const digest = install(t)
    fakeCli(join(t.ws, 'node_modules/vercel/dist/vc.js'), '60.1.3')
    const r = verify(t, digest)
    expect(r.status).not.toBe(0)
    // The digest is checked before the binary runs, so the content check names it.
    expect(r.err).toContain('use-lockfile-vercel: cli-digest: the CLI closure changed')
  })

  // ---- L3: verify-only never executes a binary whose digest does not match ----
  it('verify-only: a tampered binary is refused by the digest before it is ever executed', () => {
    const t = buildTree(root)
    const digest = install(t)
    const marker = join(root, 'tampered-binary-ran')
    const vc = join(t.ws, 'node_modules/vercel/dist/vc.js')
    writeFileSync(
      vc,
      `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\nconsole.log('${VERSION}')\n`
    )
    chmodSync(vc, 0o755)
    const r = verify(t, digest)
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('use-lockfile-vercel: cli-digest: the CLI closure changed')
    expect(existsSync(marker)).toBe(false)
    // Presence: the same binary DOES run (and writes the marker) once its digest is
    // the recorded one, so the absence above is due to the ordering, not a dead marker.
    const reinstalled = run(t, undefined, [], { GITHUB_OUTPUT: join(root, 'out2') })
    expect(reinstalled.status).toBe(0)
    expect(existsSync(marker)).toBe(true)
    rmSync(marker)
    const d2 = readFileSync(join(root, 'out2'), 'utf-8')
      .trim()
      .replace(/^digest=/, '')
    expect(verify(t, d2).status).toBe(0)
    expect(existsSync(marker)).toBe(true)
  })

  it('verify-only: a nested vulnerable smol-toml that appeared after install is named', () => {
    const t = buildTree(root)
    const digest = install(t)
    smolToml(join(t.ws, 'node_modules/vercel/node_modules/smol-toml'), '1.5.2')
    const r = verify(t, digest)
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('use-lockfile-vercel: smol-toml-canary')
  })

  describe('--check-build-log', () => {
    const logAt = (name: string, text: string) => {
      const p = join(root, name)
      writeFileSync(p, text)
      return p
    }
    it('control: a non-empty clean log passes', () => {
      const t = buildTree(root)
      const r = run(t, undefined, [
        '--check-build-log',
        logAt('clean.log', 'Build Completed in .vercel/output [2s]\n'),
      ])
      expect(r.status).toBe(0)
      expect(r.out).toContain('holds no runtime builder install')
    })
    it.each([
      ['one builder (coloured)', cliLog(installingBuilders([NODE_BUILDER])), 'Builder'],
      ['two builders (coloured)', cliLog(installingBuilders([NODE_BUILDER, STATIC])), 'Builders'],
      ['one builder (no colour)', cliLog(installingBuilders([NODE_BUILDER]), false), 'Builder'],
    ])("fails on the CLI's real install line: %s, and names it", (_n, line, noun) => {
      const t = buildTree(root)
      const text = `Running "install" command: \`npm install\`...\n${line}${cliLog('done')}`
      const r = run(t, undefined, ['--check-build-log', logAt('evil.log', text)])
      expect(r.status).not.toBe(0)
      expect(r.err).toContain('use-lockfile-vercel: builder-install')
      expect(r.err).toContain(`> Installing ${noun}: ${NODE_BUILDER}`)
    })
    it.each([
      ['an ESC-prefixed (ANSI CSI) line', `ok\n\x1b[2K\x1b[1G${REAL_LINE}`],
      ['a \\r-overwritten line', `Installing deps 10%\r${REAL_LINE}`],
      ['an OSC title before the line', `\x1b]0;vc\x07${REAL_LINE}`],
    ])('fails on %s and names the stripped line', (_n, text) => {
      const t = buildTree(root)
      const r = run(t, undefined, ['--check-build-log', logAt('ansi.log', text)])
      expect(r.status).not.toBe(0)
      expect(r.err).toContain(
        `use-lockfile-vercel: builder-install: vercel build fetched a builder at runtime (outside the lockfile): > Installing Builder: ${NODE_BUILDER}`
      )
    })
    it('control: unrelated `> ` CLI lines, colour codes, and the phrase mid-line stay clean', () => {
      const t = buildTree(root)
      const text =
        '\x1b[32mBuild Completed\x1b[0m\r\n' +
        cliLog('Build Completed in .vercel/output [2s]') +
        'note: not Installing Builder here\n' +
        cliLog('note: not Installing Builders here either')
      const r = run(t, undefined, ['--check-build-log', logAt('ansi-clean.log', text)])
      expect(r.err).toBe('')
      expect(r.status).toBe(0)
    })
    it('an empty or missing log is NOT EVALUATED, never clean', () => {
      const t = buildTree(root)
      const empty = run(t, undefined, ['--check-build-log', logAt('empty.log', '')])
      expect(empty.status).not.toBe(0)
      expect(empty.err).toContain('use-lockfile-vercel: build-log')
      const missing = run(t, undefined, ['--check-build-log', join(root, 'nope.log')])
      expect(missing.status).not.toBe(0)
      expect(missing.err).toContain('use-lockfile-vercel: build-log')
    })
  })

  it('rejects an unknown argument', () => {
    const r = run(buildTree(root), undefined, ['--bogus'])
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('use-lockfile-vercel: usage')
  })

  // ---- L2: a relative or unset GITHUB_WORKSPACE fails before any node call ----
  it('relative GITHUB_WORKSPACE: named error and node is never invoked', () => {
    const t = buildTree(root)
    const spyBin = join(root, 'spy-bin')
    mkdirSync(spyBin)
    const spyLog = join(root, 'node-called')
    writeFileSync(join(spyBin, 'node'), `#!/bin/sh\necho called >> '${spyLog}'\nexit 99\n`)
    chmodSync(join(spyBin, 'node'), 0o755)
    const r = run(t, spyBin, [], { GITHUB_WORKSPACE: 'ws' })
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('use-lockfile-vercel: environment')
    expect(r.err).toContain('must be an absolute path')
    expect(existsSync(spyLog)).toBe(false)
    // presence control: the spy IS reached when the workspace is absolute.
    const ok = run(t, spyBin)
    expect(existsSync(spyLog)).toBe(true)
    expect(ok.status).not.toBe(0)
  })

  it('unset GITHUB_WORKSPACE: named error', () => {
    const r = run(buildTree(root), undefined, [], { GITHUB_WORKSPACE: undefined })
    expect(r.status).not.toBe(0)
    expect(r.err).toContain('GITHUB_WORKSPACE is not set')
  })
})
