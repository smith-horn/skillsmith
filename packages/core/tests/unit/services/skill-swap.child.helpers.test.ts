/**
 * SMI-6531: `spawnChild` reports a spawn that fails at once, not after the
 * child-start deadline.
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { spawnChild } from './skill-swap.child.helpers.js'

describe('spawnChild', () => {
  it('a missing executable rejects waitForFile at once with the spawn error', async () => {
    const child = spawnChild(['hold'], path.join('/nonexistent-dir', 'no-such-node'))
    const t0 = Date.now()
    await expect(
      child.waitForFile('/nonexistent-dir/marker', 'take the lock', 5_000)
    ).rejects.toThrow(/could not be spawned before take the lock: .*ENOENT/)
    expect(Date.now() - t0).toBeLessThan(1_000)
    await child.exited
  })
})
