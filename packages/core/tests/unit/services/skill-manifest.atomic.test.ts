/**
 * SMI-7143 (A1 step 0): `writeManifestAtomic` (E6). The bytes land through a
 * temp file in the same directory; the temp file is synced before the rename
 * and the directory after it; a refusing `beforeRename` leaves the manifest as
 * it was; and a failed open never removes a file this call did not create.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const trace = vi.hoisted(() => ({ events: [] as string[], failOpenWith: null as string | null }))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  const label = (p: string) => (p.includes('.tmp.') ? 'temp' : 'dir')
  const open = (async (...args: Parameters<typeof actual.open>) => {
    const p = String(args[0])
    if (trace.failOpenWith !== null && p.includes('.tmp.')) {
      throw Object.assign(new Error(`${trace.failOpenWith}: forced`), { code: trace.failOpenWith })
    }
    const handle = await actual.open(...args)
    const realSync = handle.sync.bind(handle)
    Object.defineProperty(handle, 'sync', {
      value: async () => {
        trace.events.push(`sync:${label(p)}`)
        return realSync()
      },
    })
    return handle
  }) as typeof actual.open
  const rename = (async (...args: Parameters<typeof actual.rename>) => {
    trace.events.push('rename')
    return actual.rename(...args)
  }) as typeof actual.rename
  const unlink = (async (...args: Parameters<typeof actual.unlink>) => {
    trace.events.push(`unlink:${path.basename(String(args[0]))}`)
    return actual.unlink(...args)
  }) as typeof actual.unlink
  return { ...actual, open, rename, unlink }
})

import { writeManifestAtomic } from '../../../src/services/skill-manifest.atomic.js'

const roots: string[] = []
afterEach(() => {
  trace.events.length = 0
  trace.failOpenWith = null
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})
const tmp = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'matomic-')))
  roots.push(root)
  return { root, manifestPath: path.join(root, 'manifest.json') }
}
const temps = (root: string) => fs.readdirSync(root).filter((n) => n.includes('.tmp.'))

describe('writeManifestAtomic', () => {
  it('writes the bytes, syncs the temp before the rename and the directory after, and leaves no temp', async () => {
    const { root, manifestPath } = tmp()
    await writeManifestAtomic(manifestPath, '{"a":1}')
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe('{"a":1}')
    expect(trace.events).toEqual(['sync:temp', 'rename', 'sync:dir'])
    expect(temps(root)).toEqual([])
  })

  it('a refusing beforeRename leaves the manifest unchanged, removes only its temp, and rethrows', async () => {
    const { root, manifestPath } = tmp()
    fs.writeFileSync(manifestPath, 'before')
    let seenTemp = ''
    const refusal = new Error('lock lost')
    await expect(
      writeManifestAtomic(manifestPath, 'after', {
        beforeRename: (tempPath) => {
          seenTemp = tempPath
          expect(fs.readFileSync(tempPath, 'utf8')).toBe('after')
          throw refusal
        },
      })
    ).rejects.toBe(refusal)
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe('before')
    expect(path.dirname(seenTemp)).toBe(root)
    expect(trace.events).toEqual(['sync:temp', `unlink:${path.basename(seenTemp)}`])
    expect(temps(root)).toEqual([])
  })

  it('an open that fails (EEXIST: the name is taken) removes nothing and rethrows', async () => {
    const { manifestPath } = tmp()
    fs.writeFileSync(manifestPath, 'before')
    trace.failOpenWith = 'EEXIST'
    await expect(writeManifestAtomic(manifestPath, 'after')).rejects.toMatchObject({
      code: 'EEXIST',
    })
    expect(trace.events).toEqual([])
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe('before')
  })
})
