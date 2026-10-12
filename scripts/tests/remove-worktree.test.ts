/**
 * Integration tests for remove-worktree.sh.
 *
 * History: SMI-4653 added per-worktree Docker cleanup, SMI-6401 made it
 * profile-aware, SMI-5145 added the reclaimable report, SMI-5750 the targeted
 * orphan prune. SMI-7089 then removed every delete from this script except the
 * orphan prune: `compose down` no longer carries `--volumes`/`--rmi`, and the
 * name-based `docker rmi` / `docker volume rm` fallback is gone, because both
 * acted on a Compose project by NAME and a second directory resolving to the same
 * project lost its resources. The attribution and ordering guarantees are tested
 * in remove-worktree-attribution.test.ts; this file keeps the per-feature
 * behaviour.
 *
 * The script runs from a COPY inside a throwaway repo (_lib/worktree-attribution-fixture.ts)
 * with a recording `docker` on PATH. No real Docker daemon is needed.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

import {
  addWt,
  makeAttrFixture,
  primeAttribution,
  readRegLog,
  runRemove,
  setExit,
  setExitSequence,
  setResp,
  type AttrFixture,
} from './_lib/worktree-attribution-fixture.js'
import { volumeLabels, volumeListResponse } from './prune-orphaned-docker-volumes.helpers.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
  tempDirs.length = 0
})

function mk(prefix: string): AttrFixture {
  const fx = makeAttrFixture(prefix)
  tempDirs.push(fx.tempRoot)
  return fx
}

const deletes = (c: string): boolean => /^(rmi|image rm|volume rm|volume remove)\b/.test(c)

describe('SMI-4653/SMI-7089: remove-worktree.sh Docker cleanup', () => {
  it('stops the containers with a plain `down` and issues no delete of its own', () => {
    const fx = mk('rmwt-default')
    const wt = addWt(fx, 'wt-feature')
    primeAttribution(fx, wt)

    const result = runRemove(fx, [wt, '--force'])

    expect(result.status).toBe(0)
    // Presence: the stop path reached Compose.
    expect(result.dockerCalls).toContain('compose --profile dev down')
    // The flags that made Path A delete by project are gone, and so is Path B.
    expect(result.dockerCalls.some((c) => c.includes('--volumes') || c.includes('--rmi'))).toBe(
      false
    )
    expect(result.dockerCalls.some(deletes)).toBe(false)
  })

  it('--keep-docker stops the containers but never deletes or prunes anything', () => {
    const fx = mk('rmwt-keep')
    const wt = addWt(fx, 'wt-keep')
    primeAttribution(fx, wt)

    const result = runRemove(fx, [wt, '--force', '--keep-docker'])

    expect(result.status).toBe(0)
    expect(result.dockerCalls).toContain('compose --profile dev down')
    expect(result.dockerCalls.some(deletes)).toBe(false)
    expect(result.dockerCalls.some((c) => c.startsWith('volume ls'))).toBe(false)
  })

  it('compose down failing does not block the worktree removal', () => {
    const fx = mk('rmwt-down-fail')
    const wt = addWt(fx, 'wt-fail')
    primeAttribution(fx, wt)
    setExit(fx, 'down', 1)

    const result = runRemove(fx, [wt, '--force'])

    expect(result.status).toBe(0)
    // Presence: the failing `down` really was attempted.
    expect(result.dockerCalls).toContain('compose --profile dev down')
    expect(existsSync(wt)).toBe(false)
    expect(result.stderr + result.stdout).toContain('Could not stop Docker containers')
  })

  it('refuses to operate on the main repo before any docker call', () => {
    const fx = mk('rmwt-main-guard')
    addWt(fx, 'wt-main')
    primeAttribution(fx, fx.repoDir)

    const result = runRemove(fx, [fx.repoDir])

    expect(result.status).not.toBe(0)
    expect(result.stderr + result.stdout).toMatch(/Refusing to remove the main repo as a worktree/)
    expect(result.dockerCalls.length).toBe(0)
  })

  it('sanitizes uppercase/special-char dir names to match the Docker Compose project name', () => {
    const fx = mk('rmwt-sanitize')
    const wt = addWt(fx, 'SMI-4700_Test')
    primeAttribution(fx, wt)

    const result = runRemove(fx, [wt, '--force'])

    expect(result.status).toBe(0)
    // SMI-4700_Test -> smi-4700_test: the pruner announces the scope it was handed.
    expect(result.stdout).toContain('Orphan prune scope: smi-4700_test')
  })
})

describe('SMI-6401: profile-aware `down`', () => {
  it('discovers the declared profiles and applies them to `down`, with no delete flags', () => {
    const fx = mk('rmwt-6401-profiles')
    const wt = addWt(fx, 'wt-derive')
    primeAttribution(fx, wt)
    setResp(fx, 'profiles', 'dev\ntest')

    const result = runRemove(fx, [wt, '--force'])

    expect(result.status).toBe(0)
    expect(result.dockerCalls).toContain('compose --profile dev --profile test down')
  })

  it('does not crash and makes no Compose call when the worktree has no Compose files', () => {
    const fx = mk('rmwt-6401-no-override')
    const wt = addWt(fx, 'wt-noover', { override: false })
    primeAttribution(fx, wt)

    const result = runRemove(fx, [wt, '--force'])

    expect(result.status).toBe(0)
    // Presence: Docker was reachable (R0) and the pruner ran after the removal.
    expect(result.dockerCalls).toContain('info')
    expect(result.dockerCalls.some((c) => c.startsWith('volume ls'))).toBe(true)
    expect(result.dockerCalls.some((c) => c.startsWith('compose'))).toBe(false)
    expect(existsSync(wt)).toBe(false)
  })
})

describe('SMI-5145: reclaimable Docker report + safe --prune', () => {
  it('reports reclaimable resources (docker system df) on a default run, without pruning', () => {
    const fx = mk('rmwt-reclaim-check')
    const wt = addWt(fx, 'wt-reclaim')
    primeAttribution(fx, wt)

    const result = runRemove(fx, [wt, '--force'])

    expect(result.status).toBe(0)
    expect(result.dockerCalls).toContain('system df')
    expect(result.dockerCalls.some((c) => c.startsWith('image prune'))).toBe(false)
    expect(result.dockerCalls.some((c) => c.startsWith('builder prune'))).toBe(false)
    expect(result.dockerCalls.some((c) => c.startsWith('network prune'))).toBe(false)
  })

  it('--prune runs network + dangling-image + build-cache prune (safe categories only)', () => {
    const fx = mk('rmwt-prune-safe')
    const wt = addWt(fx, 'wt-prunesafe')
    primeAttribution(fx, wt)

    const result = runRemove(fx, [wt, '--force', '--prune'])

    expect(result.status).toBe(0)
    expect(result.dockerCalls).toContain('network prune -f')
    expect(result.dockerCalls).toContain('image prune -f')
    expect(result.dockerCalls).toContain('builder prune -f')
    expect(result.dockerCalls).toContain('system df')
    // SAFETY GUARD (non-optional): aggressive reclaim is NEVER auto-run.
    expect(result.dockerCalls.some((c) => c.includes('volume prune'))).toBe(false)
    expect(result.dockerCalls.some((c) => c.includes('image prune -a'))).toBe(false)
  })

  it('never auto-runs aggressive reclaim on a default (no --prune) run either', () => {
    const fx = mk('rmwt-no-aggressive')
    const wt = addWt(fx, 'wt-noaggr')
    primeAttribution(fx, wt)

    const result = runRemove(fx, [wt, '--force'])

    expect(result.status).toBe(0)
    expect(result.dockerCalls.some((c) => c.includes('volume prune'))).toBe(false)
    expect(result.dockerCalls.some((c) => c.includes('image prune -a'))).toBe(false)
  })
})

describe('SMI-5750: remove-worktree.sh targeted orphan-prune wiring (Step 3.5)', () => {
  it('a default run reaches the pruner: it lists volumes after the worktree is gone', () => {
    const fx = mk('rmwt-orphan-prune')
    const wt = addWt(fx, 'wt-orphanprune')
    primeAttribution(fx, wt)

    const result = runRemove(fx, [wt, '--force'])

    expect(result.status).toBe(0)
    // `volume ls` is the pruner's own enumeration. Inside this fixture the pruner
    // resolves its main checkout to the throwaway repo, so it really runs (run
    // from the real tree in a container it refuses before listing anything).
    expect(result.dockerCalls.some((c) => c.startsWith('volume ls'))).toBe(true)
  })

  it('--no-orphan-prune suppresses the targeted orphan prune (pruner never runs)', () => {
    const fx = mk('rmwt-no-orphan-prune')
    const wt = addWt(fx, 'wt-noorphanprune')
    primeAttribution(fx, wt)

    const result = runRemove(fx, [wt, '--force', '--no-orphan-prune'])

    expect(result.status).toBe(0)
    // Presence: Docker was reached (R0 + the stop), so the absence below is not
    // "docker never ran".
    expect(result.dockerCalls).toContain('compose --profile dev down')
    expect(result.dockerCalls.some((c) => c.startsWith('volume ls'))).toBe(false)
    // The removed worktree's own resources are KEPT, and the output says so.
    expect(result.stdout).toContain('image and volumes are kept')
  })

  it.each([
    ['wt-scoped', 'wt-scoped'],
    ['_Lead.Wt', 'leadwt'],
    ['-Dash_Wt', 'dash_wt'],
  ])("passes the removed worktree's Compose project to the pruner (%s -> %s)", (dir, project) => {
    const fx = mk('rmwt-scope')
    const wt = addWt(fx, dir)
    primeAttribution(fx, wt)

    const result = runRemove(fx, [wt, '--force'])

    expect(result.status).toBe(0)
    // Whole-line match (optional ANSI colour around it): a prefix match would let
    // `leadwt-extra` satisfy `leadwt`.
    const ansi = '(?:\\x1b\\[[0-9;]*m)*'
    expect(result.stdout).toMatch(new RegExp(`^${ansi}Orphan prune scope: ${project}${ansi}$`, 'm'))
  })

  it('--keep-docker never reaches the orphan prune: the kept volumes are unattached after compose down (D-A)', () => {
    const fx = mk('rmwt-keep-noprune')
    const wt = addWt(fx, 'wt-keepnoprune')
    primeAttribution(fx, wt)

    const result = runRemove(fx, [wt, '--force', '--keep-docker'])

    expect(result.status).toBe(0)
    // Presence: the stop path DID reach docker.
    expect(result.dockerCalls.some((c) => c.includes('compose') && c.includes('down'))).toBe(true)
    expect(result.dockerCalls.some((c) => c.startsWith('volume ls'))).toBe(false)
  })

  it("deletes the removed worktree's own owned volume, and only after it is deregistered", () => {
    const fx = mk('rmwt-own-volume')
    const wt = addWt(fx, 'foo')
    primeAttribution(fx, wt)
    const vol = 'foo_website-vercel-output'
    volumeListResponse(fx, [vol])
    volumeLabels(fx, vol, { volume: 'website-vercel-output', project: 'foo', owned: 'true' })

    const result = runRemove(fx, [wt, '--force'])

    expect(result.status).toBe(0)
    expect(result.dockerCalls).toContain(`volume rm ${vol}`)
    const rm = readRegLog(fx).filter((l) => l.startsWith('volume rm'))
    expect(rm.length).toBeGreaterThan(0)
    expect(rm.every((l) => l.endsWith('registered=no'))).toBe(true)
  })
})

describe('SMI-7089: global --prune steps and an unusable Docker never abort a removal half-way', () => {
  const pruneCalls = (calls: string[]): string[] =>
    calls.filter((c) => /^(network prune|image prune|builder prune)/.test(c))

  it('(a) daemon unreachable + --prune: worktree gone, no global prune attempted, run ends incomplete (exit 1)', () => {
    const fx = mk('rmwt-prune-unreachable')
    const wt = addWt(fx, 'wt-unreach')
    primeAttribution(fx, wt)
    setExit(fx, 'info', 1)
    setExit(fx, 'network_ls', 1)
    setExit(fx, 'network_prune', 1)

    const result = runRemove(fx, [wt, '--force', '--prune'])

    // Presence: R0 ran, so the absences below are not "docker never ran".
    expect(result.dockerCalls).toContain('info')
    expect(existsSync(wt)).toBe(false)
    expect(pruneCalls(result.dockerCalls)).toEqual([])
    // The Step 3 report is gated the same way.
    expect(result.dockerCalls).not.toContain('network ls --format {{.Name}}')
    expect(result.dockerCalls).not.toContain('system df')
    expect(result.stdout).toContain('global prune was skipped because Docker is unreachable')
    expect(result.stderr + result.stdout).toContain('Worktree removed; Docker cleanup incomplete')
    expect(result.stderr + result.stdout).toContain(
      'prune-orphaned-docker-volumes.sh --only-project wt-unreach'
    )
    expect(result.stdout).not.toContain('Worktree removal complete!')
    expect(result.status).toBe(1)
  })

  it('(b) a failing `network prune` warns and the run continues to the targeted prune', () => {
    const fx = mk('rmwt-netprune-fails')
    const wt = addWt(fx, 'wt-netfail')
    primeAttribution(fx, wt)
    setExit(fx, 'network_prune', 1)

    const result = runRemove(fx, [wt, '--force', '--prune'])

    // Presence: the failing call really was made, and the later steps still ran.
    expect(result.dockerCalls).toContain('network prune -f')
    expect(result.dockerCalls).toContain('image prune -f')
    expect(result.dockerCalls.some((c) => c.startsWith('volume ls'))).toBe(true)
    expect(result.stdout).toContain('Orphan prune scope: wt-netfail')
    expect(result.stderr + result.stdout).toContain('network prune failed')
    expect(result.stdout).toContain('Worktree removal complete!')
    expect(result.status).toBe(0)
  })

  it('(b2) a failing `network ls` in the Step 3 report does not abort either', () => {
    const fx = mk('rmwt-netls-fails')
    const wt = addWt(fx, 'wt-netls')
    primeAttribution(fx, wt)
    setExit(fx, 'network_ls', 1)

    const result = runRemove(fx, [wt, '--force'])

    expect(result.dockerCalls).toContain('network ls --format {{.Name}}')
    expect(result.stderr + result.stdout).toContain('Could not list Docker networks')
    expect(result.dockerCalls.some((c) => c.startsWith('volume ls'))).toBe(true)
    expect(result.stdout).toContain('Worktree removal complete!')
    expect(result.status).toBe(0)
  })

  it('(b3) stderr from a SUCCESSFUL `network ls` is not counted as networks', () => {
    const fx = mk('rmwt-netls-stderr')
    const wt = addWt(fx, 'wt-netstderr')
    primeAttribution(fx, wt)
    writeFileSync(join(fx.responsesDir, 'network_ls_out'), 'bridge\nhost\n')
    writeFileSync(
      join(fx.responsesDir, 'network_ls_err'),
      Array.from({ length: 10 }, (_, i) => `daemon warning ${i}`).join('\n') + '\n'
    )

    const result = runRemove(fx, [wt, '--force'])

    expect(result.dockerCalls).toContain('network ls --format {{.Name}}')
    expect(result.stdout).toContain('Docker network count OK (2 networks)')
    expect(result.stdout).not.toContain('Docker has')
    expect(result.status).toBe(0)
  })

  it('(c) Docker reachable at Step 0 but unusable for the pruner: exit 1 with the re-run hint', () => {
    const fx = mk('rmwt-pruner-docker-gone')
    const wt = addWt(fx, 'wt-prunergone')
    primeAttribution(fx, wt)
    // 1st `docker info` is Step 0 (R0); the 2nd is the pruner's own check.
    setExitSequence(fx, 'info', [0, 1])

    const result = runRemove(fx, [wt, '--force'])

    // Presence: both info calls happened, the worktree is gone, no volume was listed.
    expect(result.dockerCalls.filter((c) => c === 'info')).toHaveLength(2)
    expect(existsSync(wt)).toBe(false)
    expect(result.dockerCalls.some((c) => c.startsWith('volume ls'))).toBe(false)
    expect(result.stderr + result.stdout).toContain('Docker cleanup incomplete')
    expect(result.stdout).not.toContain('Worktree removal complete!')
    expect(result.status).toBe(1)
  })
})
