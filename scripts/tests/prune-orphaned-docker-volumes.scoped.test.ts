/**
 * SMI-7089: the orphan pruner is remove-worktree.sh's ONLY deleter, so under
 * `--only-project P` it must cover everything a worktree leaves behind (a
 * `P_website-vercel-output` volume and the `P-test` image used to leak on every
 * removal) WITHOUT ever selecting another project's resources. A name is only a
 * name: a volume or image is P's only when the OBJECT says so (its compose project
 * label), not when its name happens to start with `P`.
 *
 * Row ids (T11, T11b-g, T12) are the plan's. Every "not deleted" assertion is
 * paired with a delete from the same run, so it cannot be explained by the fixture
 * never qualifying.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

import {
  addWorktree,
  imageIdFor,
  imageLabels,
  imagesResponse,
  runPrune,
  setupFixture,
  volumeLabels,
  volumeListResponse,
  volumePsResponse,
  type FixtureRepo,
} from './prune-orphaned-docker-volumes.helpers.js'
import { hookRan, setDockerHook } from './worktree-lifecycle.helpers.js'
import { shimDockerFailures } from './prune-orphaned-docker-volumes.shims.js'
import { pathWithoutDocker } from './_lib/worktree-attribution-fixture.js'

const only = (project: string): string[] => ['--only-project', project]
const rmiOf = (calls: string[], tag: string): boolean => calls.includes(`rmi ${imageIdFor(tag)}`)
const volRm = (calls: string[], name: string): boolean => calls.includes(`volume rm ${name}`)

const tempDirs: string[] = []

afterEach(() => {
  for (const d of tempDirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true })
  tempDirs.length = 0
})

function fixture(prefix: string): FixtureRepo {
  const f = setupFixture(prefix)
  tempDirs.push(f.tempRoot)
  return f
}

describe('SMI-7089: --only-project volume selection', () => {
  it('T11. P’s own website-vercel-output volume is deleted; another project’s lookalike is not', () => {
    const f = fixture('sc-t11')
    const names = [
      'foo_website-vercel-output', // P's own, a shape classify_volume never knew
      'foo_data', // P_ prefix, but the OBJECT says it belongs to another project
      'foo_bar_node_modules', // project foo_bar's volume
      'foo-x_node_modules', // project foo-x's volume
      'foo_mislabelled', // P_ prefix and project, but the volume label is not the suffix
    ]
    volumeListResponse(f, names)
    volumeLabels(f, 'foo_website-vercel-output', {
      volume: 'website-vercel-output',
      project: 'foo',
      owned: 'true',
    })
    volumeLabels(f, 'foo_data', { volume: 'data', project: 'other-proj', owned: 'true' })
    volumeLabels(f, 'foo_bar_node_modules', {
      volume: 'node_modules',
      project: 'foo_bar',
      owned: 'true',
    })
    volumeLabels(f, 'foo-x_node_modules', {
      volume: 'node_modules',
      project: 'foo-x',
      owned: 'true',
    })
    volumeLabels(f, 'foo_mislabelled', { volume: 'something-else', project: 'foo', owned: 'true' })

    const r = runPrune(f, only('foo'))

    expect(r.status).toBe(0)
    // The delete that proves the fixture qualifies...
    expect(volRm(r.dockerCalls, 'foo_website-vercel-output')).toBe(true)
    // ...and the ones that must not happen.
    expect(volRm(r.dockerCalls, 'foo_data')).toBe(false)
    expect(volRm(r.dockerCalls, 'foo_bar_node_modules')).toBe(false)
    expect(volRm(r.dockerCalls, 'foo-x_node_modules')).toBe(false)
    expect(volRm(r.dockerCalls, 'foo_mislabelled')).toBe(false)
    // Another project's orphan is still REPORTED, not silently dropped.
    expect(r.stdout).toContain('REPORT-ONLY orphan: foo_bar_node_modules')
  })

  it('T12. an UNOWNED P volume is reported UNCONFIRMED and never deleted; an owned one is', () => {
    const f = fixture('sc-t12')
    volumeListResponse(f, ['foo_website-vercel-output', 'foo_native-seed-x'])
    volumeLabels(f, 'foo_website-vercel-output', {
      volume: 'website-vercel-output',
      project: 'foo',
      owned: '',
    })
    volumeLabels(f, 'foo_native-seed-x', { volume: 'native-seed-x', project: 'foo', owned: 'true' })

    const r = runPrune(f, only('foo'))

    expect(r.status).toBe(0)
    expect(volRm(r.dockerCalls, 'foo_native-seed-x')).toBe(true)
    expect(r.stdout).toContain('UNCONFIRMED ownership: foo_website-vercel-output')
    expect(volRm(r.dockerCalls, 'foo_website-vercel-output')).toBe(false)
  })

  it('without --only-project the new shapes stay report-only (nothing is deleted)', () => {
    const f = fixture('sc-t11-report')
    volumeListResponse(f, ['foo_website-vercel-output'])
    volumeLabels(f, 'foo_website-vercel-output', {
      volume: 'website-vercel-output',
      project: 'foo',
      owned: 'true',
    })

    const r = runPrune(f, [])

    expect(r.status).toBe(0)
    // Presence: the run enumerated volumes.
    expect(r.dockerCalls.some((c) => c.startsWith('volume ls'))).toBe(true)
    expect(r.dockerCalls.some((c) => /^volume rm\b/.test(c))).toBe(false)
  })
})

describe('SMI-7089: --only-project image selection', () => {
  const setup = (prefix: string, tags: string[]): FixtureRepo => {
    const f = fixture(prefix)
    imagesResponse(f, tags)
    return f
  }

  it('T11b. P’s -test image is deleted by ID, beside its -dev image', () => {
    const f = setup('sc-t11b', ['foo-dev', 'foo-test'])
    imageLabels(f, 'foo-dev', { service: 'dev', owned: 'true' })
    imageLabels(f, 'foo-test', { service: 'test', owned: 'true' })

    const r = runPrune(f, only('foo'))

    expect(r.status).toBe(0)
    expect(rmiOf(r.dockerCalls, 'foo-dev')).toBe(true)
    expect(rmiOf(r.dockerCalls, 'foo-test')).toBe(true)
    // Never by tag.
    expect(r.dockerCalls).not.toContain('rmi foo-test')
  })

  it.each([
    ['foo-x', 'a project whose name extends P with a dash'],
    ['foo_x', 'a project whose name extends P with an underscore'],
  ])(
    'T11c/d. a `foo-test` tag retargeted onto an owned image of project %s (%s) is not deleted',
    (otherProject) => {
      const f = setup('sc-t11cd', ['foo-dev', 'foo-test'])
      imageLabels(f, 'foo-dev', { service: 'dev', owned: 'true' })
      imageLabels(f, 'foo-test', { service: 'test', owned: 'true', project: otherProject })

      const r = runPrune(f, only('foo'))

      expect(r.status).toBe(0)
      expect(rmiOf(r.dockerCalls, 'foo-dev')).toBe(true)
      expect(rmiOf(r.dockerCalls, 'foo-test')).toBe(false)
      expect(r.stdout).toContain('UNCONFIRMED project: foo-test')
    }
  )

  it('T11e. a `foo-dev` tag on an image whose service label is `test` is not deleted', () => {
    const f = setup('sc-t11e', ['foo-dev', 'foo-test'])
    imageLabels(f, 'foo-dev', { service: 'test', owned: 'true' })
    imageLabels(f, 'foo-test', { service: 'test', owned: 'true' })

    const r = runPrune(f, only('foo'))

    expect(r.status).toBe(0)
    expect(rmiOf(r.dockerCalls, 'foo-test')).toBe(true)
    expect(rmiOf(r.dockerCalls, 'foo-dev')).toBe(false)
  })

  it('T11f. an image with NO labels is reported UNCONFIRMED, does not fail the run, and is not deleted', () => {
    const f = setup('sc-t11f', ['foo-dev', 'foo-test'])
    imageLabels(f, 'foo-test', { service: 'test', owned: 'true' })
    imageLabels(f, 'foo-dev', {})
    // Docker prints `null` for a label map that does not exist.
    writeFileSync(join(f.responsesDir, `image_inspect__${imageIdFor('foo-dev')}__labels`), 'null\n')

    const r = runPrune(f, only('foo'))

    // Exit 0 (an unlabelled image is not an operational failure) with a delete in
    // the same run, so the 0 is not the exit of a run that did nothing.
    expect(r.status).toBe(0)
    expect(rmiOf(r.dockerCalls, 'foo-test')).toBe(true)
    expect(r.stdout).toContain('UNCONFIRMED ownership: foo-dev')
    expect(rmiOf(r.dockerCalls, 'foo-dev')).toBe(false)
    expect(r.stderr).not.toContain('Could not inspect')
  })

  it('T11g. a tag retargeted between selection and the section is skipped, not deleted', () => {
    const f = setup('sc-t11g', ['foo-test'])
    imageLabels(f, 'foo-test', { service: 'test', owned: 'true' })
    const idFile = join(f.responsesDir, 'image_inspect__foo-test__id')
    const other = imageIdFor('someone-elses-image')
    setDockerHook(f, 'image_id_after__foo-test__1', `printf '%s\\n' '${other}' > "${idFile}"`)

    const r = runPrune(f, only('foo'))

    // Presence: the retarget fired after selection resolved the tag.
    expect(hookRan(f, 'image_id_after__foo-test__1')).toBe(true)
    expect(r.stdout).toContain('SKIPPED image foo-test')
    expect(r.dockerCalls.some((c) => /^rmi\b/.test(c))).toBe(false)
  })
})

describe('SMI-7089 (OD-5): --report-containers lists projects shared by two or more checkouts', () => {
  it('names a shared project and every checkout in it; leaves near misses and unique names out', () => {
    const f = fixture('sc-od5')
    const foo = join(f.tempRoot, 'foo')
    const underscoreFoo = join(f.tempRoot, '_foo')
    addWorktree(f.repoDir, foo, 'od5-a')
    addWorktree(f.repoDir, underscoreFoo, 'od5-b')
    // Near misses: `bar_` and `bar` are DIFFERENT Compose projects.
    addWorktree(f.repoDir, join(f.tempRoot, 'bar_'), 'od5-c')
    addWorktree(f.repoDir, join(f.tempRoot, 'bar'), 'od5-d')
    // An unregistered .worktrees directory beside a registered one.
    const stray = join(f.repoDir, '.worktrees', 'baz')
    mkdirSync(stray, { recursive: true })
    const registeredBaz = join(f.repoDir, '.worktrees', '_baz')
    addWorktree(f.repoDir, registeredBaz, 'od5-e')
    // A dot-named unregistered directory: `.dot` sanitizes to `dot`.
    const strayDot = join(f.repoDir, '.worktrees', '.dot')
    mkdirSync(strayDot, { recursive: true })
    const registeredDot = join(f.repoDir, '.worktrees', 'dot')
    addWorktree(f.repoDir, registeredDot, 'od5-f')

    const r = runPrune(f, ['--report-containers'])

    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Shared Compose projects (SMI-7089)')
    const lineFor = (project: string): string =>
      r.stdout.split('\n').find((l) => l.startsWith(`  ${project}: `)) ?? ''
    // Paths are listed in sorted order, so assert membership, not sequence.
    expect(lineFor('foo')).toContain(foo)
    expect(lineFor('foo')).toContain(underscoreFoo)
    expect(lineFor('baz')).toContain(stray)
    expect(lineFor('baz')).toContain(registeredBaz)
    expect(lineFor('dot')).toContain(strayDot)
    expect(lineFor('dot')).toContain(registeredDot)
    expect(r.stdout).not.toMatch(/^\s+bar:/m)
    expect(r.stdout).not.toMatch(/^\s+bar_:/m)
  })

  it('prints no section when every checkout has its own project', () => {
    const f = fixture('sc-od5-none')
    addWorktree(f.repoDir, join(f.tempRoot, 'one'), 'od5-n1')
    addWorktree(f.repoDir, join(f.tempRoot, 'two'), 'od5-n2')

    const r = runPrune(f, ['--report-containers'])

    expect(r.status).toBe(0)
    // Presence: the run reached the container report (it asked Docker for containers).
    expect(r.dockerCalls.some((c) => c.startsWith('ps -q'))).toBe(true)
    expect(r.stdout).not.toContain('Shared Compose projects')
  })
})

describe('SMI-7089: an unusable Docker is a failure when a project was named, a skip otherwise', () => {
  it('docker missing: --only-project exits non-zero and says nothing was removed; a bare run still exits 0', () => {
    const f = fixture('sc-nodocker')
    const nodocker = pathWithoutDocker(f)

    const scoped = runPrune(f, only('foo'), { PATH: nodocker })
    const bare = runPrune(f, [], { PATH: nodocker })

    // Presence: the bare run really reached the "docker not found" branch.
    expect(bare.stderr).toContain('Docker not found')
    expect(bare.status).toBe(0)
    expect(scoped.status).toBe(1)
    expect(scoped.stderr).toContain('NOT removed')
  })

  it('docker info failing: --only-project exits non-zero; a bare run still exits 0', () => {
    const f = fixture('sc-info-fails')
    shimDockerFailures(f, [{ glob: 'info', stderr: 'Cannot connect to the Docker daemon' }])

    const bare = runPrune(f, [])
    const scoped = runPrune(f, only('foo'))

    expect(bare.dockerCalls).toContain('info')
    expect(bare.stderr).toContain('Docker daemon not reachable')
    expect(bare.status).toBe(0)
    expect(scoped.dockerCalls).toContain('info')
    expect(scoped.status).toBe(1)
    expect(scoped.stderr).toContain('NOT removed')
  })
})

describe('SMI-7089: an attached in-scope resource fails a named-project run', () => {
  it('an attached image of the named project: SKIPPED (attached) with the ids, exit 1; a bare run exits 0', () => {
    const f = fixture('sc-attached-img')
    imagesResponse(f, ['foo-dev'])
    imageLabels(f, 'foo-dev', { service: 'dev', owned: 'true' })
    writeFileSync(join(f.responsesDir, `ps_ancestor__${imageIdFor('foo-dev')}`), 'cA\ncB\n')

    const scoped = runPrune(f, only('foo'))
    const bare = runPrune(f, [])

    expect(scoped.dockerCalls.some((c) => /^rmi\b/.test(c))).toBe(false)
    expect(scoped.stderr).toContain('SKIPPED (attached): foo-dev by cA cB')
    expect(scoped.status).toBe(1)
    expect(bare.dockerCalls.some((c) => c.startsWith('images'))).toBe(true)
    expect(bare.stderr).not.toContain('SKIPPED (attached)')
    expect(bare.status).toBe(0)
  })

  it('an attached volume of ANOTHER project is reported nowhere as a failure of this run', () => {
    const f = fixture('sc-attached-other')
    volumeListResponse(f, ['foo_website-vercel-output', 'bar_node_modules'])
    volumeLabels(f, 'foo_website-vercel-output', {
      volume: 'website-vercel-output',
      project: 'foo',
      owned: 'true',
    })
    volumeLabels(f, 'bar_node_modules', { volume: 'node_modules', project: 'bar', owned: 'true' })
    volumePsResponse(f, 'bar_node_modules', 'cZ')

    const r = runPrune(f, only('foo'))

    // Presence: foo's own volume was deleted in the same run.
    expect(volRm(r.dockerCalls, 'foo_website-vercel-output')).toBe(true)
    expect(r.stderr).not.toContain('SKIPPED (attached)')
    expect(r.status).toBe(0)
  })
})
