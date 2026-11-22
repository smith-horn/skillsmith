/**
 * SMI-6531 (A1 step 8-i-a-2, governance round): a fresh install's record
 * marked by doctor's own full-device stop. FI0 `--undo` keeps N into a backup
 * area on another device (`/dev/shm`, a real `EXDEV`), so the keep is a copy;
 * the copy is stopped by `ENOSPC` at its second file (the seam the update's
 * marker tests use, `recovery.xdev.gov.test.ts`). Doctor records the marker in
 * the adopted record through `sealWithMarker`'s install branch: the record
 * still parses as an install, carries the marker, and still classifies FI0.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseRecordBytes } from '../../../../src/services/skill-swap.record-schema.js'
import { areaOf, useTmpCleanup } from '../skill-swap.helpers.js'
import {
  errnoError,
  isCreateUnder,
  otherDevice,
  useOtherDeviceCleanup,
  useStubs,
} from '../skill-swap.xdev.helpers.js'
import { opReport } from './recovery.helpers.js'
import { act } from './recovery.act.helpers.js'
import { fi0, installFixture } from './install.helpers.js'

useTmpCleanup()
useOtherDeviceCleanup()
const stub = useStubs()
type AnyFn = (...a: unknown[]) => unknown

describe('an install record marked by a full device', () => {
  it('stays an install record with the marker, and still classifies FI0', async () => {
    const st = fi0(installFixture({ stateRoot: otherDevice() }))
    expect(fs.statSync(st.fx.stateRoot).dev).not.toBe(fs.statSync(st.fx.skillsDir).dev)
    const copyTemp = path.join(areaOf(st.fx), `.tmp-${st.opId}.unused-new`)
    let creates = 0
    let failing = true
    stub(fs.promises, 'open', (orig: AnyFn) => async (...a: unknown[]) => {
      if (failing && isCreateUnder(a, copyTemp) && ++creates === 2) throw errnoError('ENOSPC')
      return orig(...a)
    })
    const a = await act(st, 'undo')
    failing = false
    expect(creates).toBe(2)
    expect(a.result).toMatchObject({ status: 'stopped' })
    const bytes = fs.readFileSync(path.join(st.opDir, 'record.json'))
    const parsed = parseRecordBytes(bytes)
    expect(parsed).toMatchObject({
      ok: true,
      record: {
        op: 'install',
        opId: st.opId,
        postTree: st.record.postTree,
        fullDevice: { cause: 'ENOSPC', stage: 'copy', opId: st.opId },
      },
    })
    // The rewrite went through the adopted record, not around it: same body, marker added.
    if (!parsed.ok || parsed.record.op !== 'install') throw new Error('unreachable')
    const { recordSha256: _a, fullDevice: _m, ...now } = parsed.record
    const { recordSha256: _b, ...was } = st.record
    expect(now).toEqual(was)
    expect((await opReport(st)).cls).toMatchObject({
      kind: 'state',
      state: 'FI0',
      facts: { fullDevice: { cause: 'ENOSPC' } },
    })
  })
})
