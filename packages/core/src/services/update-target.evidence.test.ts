/**
 * @fileoverview Tests for the update gate's manifest evidence adapter (SMI-6532 A2 §4.1).
 * @module @skillsmith/core/services/update-target.evidence.test
 *
 * These run against the real filesystem for the realpath cases, because the
 * property under test IS kernel path identity. A mocked `realpath` would make
 * the symlink and case cases pass by construction and pin nothing — the exact
 * shape SMI-6358's retro spent four rounds removing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  temporaryManifestEvidenceResolver,
  type ManifestEvidenceInput,
} from './update-target.evidence.js'
import type { SkillManifest, SkillManifestEntry } from './skill-installation.types.js'

const CANONICAL = 'claude-code' as const
const OTHER = 'cursor' as const

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'evidence-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function entryAt(installPath: string, over: Partial<SkillManifestEntry> = {}): SkillManifestEntry {
  return {
    id: 'owner/repo/my-skill',
    name: 'my-skill',
    version: '1.0.0',
    source: 'registry',
    installPath,
    installedAt: '2026-01-01T00:00:00Z',
    lastUpdated: '2026-01-01T00:00:00Z',
    ...over,
  } as SkillManifestEntry
}

function manifestWith(key: string, entry: SkillManifestEntry): SkillManifest {
  return { version: '1', installedSkills: { [key]: entry } } as SkillManifest
}

function input(over: Partial<ManifestEvidenceInput> & { manifest: SkillManifest }) {
  return {
    harness: CANONICAL,
    scannedDir: join(root, 'my-skill'),
    dirName: 'my-skill',
    ...over,
  } as ManifestEvidenceInput
}

describe('keys by harness, not by bare name', () => {
  it('reads the bare name for the canonical client', async () => {
    const dir = join(root, 'my-skill')
    await mkdir(dir)
    const ev = await temporaryManifestEvidenceResolver(
      input({ manifest: manifestWith('my-skill', entryAt(dir)) })
    )
    expect({ key: ev.manifestKey, dq: ev.disqualifiedBy }).toEqual({
      key: 'my-skill',
      dq: null,
    })
  })

  it('reads the client-scoped key for a non-canonical harness', async () => {
    const dir = join(root, 'my-skill')
    await mkdir(dir)
    const ev = await temporaryManifestEvidenceResolver(
      input({ harness: OTHER, manifest: manifestWith(`my-skill::${OTHER}`, entryAt(dir)) })
    )
    expect({ key: ev.manifestKey, dq: ev.disqualifiedBy }).toEqual({
      key: `my-skill::${OTHER}`,
      dq: null,
    })
  })

  it('does NOT read the canonical entry for a non-canonical harness', async () => {
    // The SMI-6358 defect class: a bare-name lookup would find this entry and
    // hand the gate evidence belonging to a different client's install.
    const dir = join(root, 'my-skill')
    await mkdir(dir)
    const ev = await temporaryManifestEvidenceResolver(
      input({ harness: OTHER, manifest: manifestWith('my-skill', entryAt(dir)) })
    )
    expect({ key: ev.manifestKey, dq: ev.disqualifiedBy, entry: ev.entry }).toEqual({
      key: `my-skill::${OTHER}`,
      dq: 'no-entry',
      entry: null,
    })
  })
})

describe('compares realpaths, not strings', () => {
  it('accepts a symlinked scannedDir pointing at the recorded install path', async () => {
    const real = join(root, 'real-skill')
    const link = join(root, 'linked-skill')
    await mkdir(real)
    await symlink(real, link)

    const ev = await temporaryManifestEvidenceResolver(
      input({
        scannedDir: link,
        dirName: 'my-skill',
        manifest: manifestWith('my-skill', entryAt(real)),
      })
    )
    // Same directory to the kernel, different strings. A string compare would
    // report path-mismatch here and skip a legitimately updatable skill.
    expect(ev.disqualifiedBy).toBeNull()
  })

  it('rejects an entry whose installPath is a DIFFERENT directory', async () => {
    const scanned = join(root, 'my-skill')
    const elsewhere = join(root, 'somewhere-else')
    await mkdir(scanned)
    await mkdir(elsewhere)

    const ev = await temporaryManifestEvidenceResolver(
      input({ manifest: manifestWith('my-skill', entryAt(elsewhere)) })
    )
    // ADR-155: a write must land where the comparison happened. Adopting this
    // entry is how an update writes into a directory nobody compared.
    expect({ dq: ev.disqualifiedBy, id: ev.canonicalId }).toEqual({
      dq: 'path-mismatch',
      id: null,
    })
  })
})

describe('refuses unusable install paths before resolving them', () => {
  it.each([
    ['relative', 'not/absolute'],
    ['empty', ''],
  ])('rejects a %s installPath', async (_label, bad) => {
    const dir = join(root, 'my-skill')
    await mkdir(dir)
    const ev = await temporaryManifestEvidenceResolver(
      input({ manifest: manifestWith('my-skill', entryAt(bad)) })
    )
    // A relative path would otherwise resolve against process.cwd() and could
    // accidentally MATCH, turning a malformed entry into usable evidence.
    expect(ev.disqualifiedBy).toBe('invalid-install-path')
  })

  it('rejects a missing installPath without throwing', async () => {
    const dir = join(root, 'my-skill')
    await mkdir(dir)
    const broken = entryAt('x')
    delete (broken as { installPath?: string }).installPath
    const ev = await temporaryManifestEvidenceResolver(
      input({ manifest: manifestWith('my-skill', broken) })
    )
    expect(ev.disqualifiedBy).toBe('invalid-install-path')
  })
})

describe('a manifest missing installedSkills does not crash the gate', () => {
  it('reports no-entry rather than throwing', async () => {
    // `packages/cli/src/utils/manifest.ts:150` casts JSON.parse output to
    // SkillManifest unchecked, so this object is reachable despite the type.
    // Crashing here would fail a safety check OPEN, by aborting the run instead
    // of reporting every skill ineligible.
    const ev = await temporaryManifestEvidenceResolver(
      input({ manifest: { version: '1' } as unknown as SkillManifest })
    )
    expect(ev.disqualifiedBy).toBe('no-entry')
  })
})

describe('carries the ADR-145 axes through verbatim', () => {
  it('surfaces provenance, pin and policy for the gate to decide on', async () => {
    const dir = join(root, 'my-skill')
    await mkdir(dir)
    const ev = await temporaryManifestEvidenceResolver(
      input({
        manifest: manifestWith(
          'my-skill',
          entryAt(dir, { provenance: 'local', pinnedVersion: '1.2.3', updatePolicy: 'never' })
        ),
      })
    )
    // The resolver reports; it does not decide. Eligibility is the gate's call.
    expect({
      provenance: ev.provenance,
      pinned: ev.pinnedVersion,
      policy: ev.updatePolicy,
      dq: ev.disqualifiedBy,
    }).toEqual({ provenance: 'local', pinned: '1.2.3', policy: 'never', dq: null })
  })

  it('reports absent axes as null rather than inventing defaults', async () => {
    const dir = join(root, 'my-skill')
    await mkdir(dir)
    const ev = await temporaryManifestEvidenceResolver(
      input({ manifest: manifestWith('my-skill', entryAt(dir)) })
    )
    // A defaulted `updatePolicy: 'auto'` would silently authorize writes for an
    // entry that never opted in. Absent must stay distinguishable from 'auto'.
    expect({
      provenance: ev.provenance,
      pinned: ev.pinnedVersion,
      policy: ev.updatePolicy,
    }).toEqual({ provenance: null, pinned: null, policy: null })
  })
})
