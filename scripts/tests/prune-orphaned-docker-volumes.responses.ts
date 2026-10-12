/**
 * Canned-response setters for the prune-orphaned-docker-volumes docker shim
 * (SMI-5750). Split out of the sibling .helpers.ts for the 500-line gate
 * (SMI-7089); the helpers file re-exports every name, so existing imports keep
 * working. Each setter writes one file the shim reads by key.
 */

import { createHash } from 'crypto'
import { writeFileSync } from 'fs'
import { join } from 'path'

import type { FixtureRepo } from './prune-orphaned-docker-volumes.helpers.js'

export function setResponse(responsesDir: string, key: string, value: string): void {
  writeFileSync(join(responsesDir, key), value.endsWith('\n') ? value : `${value}\n`)
}

export function volumeListResponse(fixture: FixtureRepo, names: string[]): void {
  setResponse(fixture.responsesDir, 'volume_ls', names.join('\n'))
}

/**
 * Serve a DIFFERENT value for each successive read of one volume label, so a
 * test can model a label that changes mid-run. Takes precedence over any
 * static value set by `volumeLabels` for the same label.
 *
 * Pass fewer values than there are reads to model the label VANISHING: once
 * the sequence runs dry, `emit` produces nothing, which is what `docker volume
 * inspect` yields for an absent label.
 */
export function volumeLabelSequence(
  fixture: FixtureRepo,
  vol: string,
  label: 'volume' | 'project' | 'owned',
  values: string[]
): void {
  setResponse(fixture.responsesDir, `volume_inspect__${vol}__${label}.seq`, values.join('\n'))
}

export function imagesResponse(fixture: FixtureRepo, repos: string[]): void {
  setResponse(fixture.responsesDir, 'images', repos.join('\n'))
}

export function volumeLabels(
  fixture: FixtureRepo,
  vol: string,
  labels: { volume?: string; project?: string; owned?: string }
): void {
  if (labels.volume !== undefined) {
    setResponse(fixture.responsesDir, `volume_inspect__${vol}__volume`, labels.volume)
  }
  if (labels.project !== undefined) {
    setResponse(fixture.responsesDir, `volume_inspect__${vol}__project`, labels.project)
  }
  if (labels.owned !== undefined) {
    setResponse(fixture.responsesDir, `volume_inspect__${vol}__owned`, labels.owned)
  }
}

/** A stable, sha256-shaped image ID for a tag (SMI-6981: images are deleted by ID). */
export function imageIdFor(tag: string): string {
  return `sha256:${createHash('sha256').update(tag).digest('hex')}`
}

/**
 * Set an image's labels. Also registers the tag's ID (`imageIdFor(tag)` unless
 * `id` is given) and the same labels under that ID, which is what the in-lock
 * re-inspect reads.
 */
export function imageLabels(
  fixture: FixtureRepo,
  img: string,
  labels: { service?: string; owned?: string; project?: string },
  id: string = imageIdFor(img)
): void {
  setResponse(fixture.responsesDir, `image_inspect__${img}__id`, id)
  // SMI-7089: a Compose-built image carries its project label, equal to the tag's
  // `<project>` prefix. Default to that so a test that only sets the service and
  // ownership describes a real build; pass `project` to model a retagged image.
  const project = labels.project ?? img.replace(/-(dev|test)$/, '')
  setResponse(fixture.responsesDir, `image_inspect__${img}__project`, project)
  setResponse(fixture.responsesDir, `image_inspect__${id}__project`, project)
  if (labels.service !== undefined) {
    setResponse(fixture.responsesDir, `image_inspect__${img}__service`, labels.service)
    setResponse(fixture.responsesDir, `image_inspect__${id}__service`, labels.service)
  }
  if (labels.owned !== undefined) {
    setResponse(fixture.responsesDir, `image_inspect__${img}__owned`, labels.owned)
    setResponse(fixture.responsesDir, `image_inspect__${id}__owned`, labels.owned)
  }
}

export function volumePsResponse(fixture: FixtureRepo, vol: string, containerIds: string): void {
  setResponse(fixture.responsesDir, `ps_volume__${vol}`, containerIds)
}

export function setVolumeRmExit(fixture: FixtureRepo, vol: string, code: number): void {
  writeFileSync(join(fixture.responsesDir, `exit__volume_rm__${vol}`), String(code))
}
