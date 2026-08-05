/**
 * Deterministic dead-PID helper for owned-lock tests (SMI-5883 §8).
 * @module @skillsmith/core/tests/helpers/deterministic-dead-pid
 *
 * Replaces the round-3 assumption that a hard-coded PID (e.g. `'99999'`) is
 * dead — flaky on any machine whose PID space reaches that value. Spawns a
 * real, short-lived child process, waits for it to exit, then verifies
 * `process.kill(pid, 0)` throws `ESRCH` before handing the PID back. Retries
 * (PID reuse) up to 5 times, then fails loudly with a clear message rather
 * than silently returning a live PID.
 */

import { spawnSync } from 'node:child_process'

export function mintDeadPid(): number {
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = spawnSync(process.execPath, ['-e', ''])
    const pid = result.pid
    if (typeof pid !== 'number') continue
    try {
      process.kill(pid, 0)
      continue // still signalable somehow (should not happen for an exited child) -- retry
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return pid
    }
  }
  throw new Error(
    '[owned-lock tests] could not mint a deterministically-dead PID after 5 attempts -- ' +
      'every spawned child still answered a liveness probe.'
  )
}
