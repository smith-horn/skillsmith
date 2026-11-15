/**
 * SMI-6531 (A1 step 6c-ii-b): `parkedLockPath` is the PLAN:915 formula,
 * `<stateRoot>/locks/parked-<first 16 hex of sha256(areaReal)>.lock` (M-L1).
 */
import { describe, expect, it } from 'vitest'
import { parkedLockPath } from '../../../src/config/file-lock.parked.js'

describe('parkedLockPath', () => {
  it('is the PLAN:915 formula on a fixed realpath', () => {
    // sha256('/srv/skillsmith/area') = e2b1ec75336d8f3d..., measured with shasum -a 256.
    expect(parkedLockPath('/state', '/srv/skillsmith/area')).toBe(
      '/state/locks/parked-e2b1ec75336d8f3d.lock'
    )
  })

  it('keys on the area, so two areas never share a lock and one area always does', () => {
    const a = parkedLockPath('/state', '/srv/a')
    expect(parkedLockPath('/state', '/srv/b')).not.toBe(a)
    expect(parkedLockPath('/state', '/srv/a')).toBe(a)
  })

  it('hashes the UTF-8 bytes of the realpath', () => {
    expect(parkedLockPath('/s', '/srv/\u{1F600}')).toMatch(
      /^\/s\/locks\/parked-[0-9a-f]{16}\.lock$/
    )
    expect(parkedLockPath('/s', '/srv/\u{1F600}')).not.toBe(parkedLockPath('/s', '/srv/ｚ'))
  })
})
