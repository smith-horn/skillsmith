/**
 * WebhookQueue additional coverage (SMI-4290 / closes #597)
 *
 * Sidecar to WebhookHandler.test.ts — fills three genuine gaps that the
 * primary suite (`WebhookHandler.test.ts:504`, 10 existing tests) does
 * not exercise:
 *
 *   1. Debounce coalescing with `debounceMs > 0` (existing tests all
 *      pass `debounceMs: 0`, which bypasses the debounce timer entirely).
 *   2. `waitForProcessing()` with in-flight items, using a processor
 *      that only resolves after all items are released.
 *   3. Saturation of `maxSize` via the debounced `add()` path (existing
 *      test only exercises saturation via `addImmediate`).
 *
 * Kept as a sidecar so pre-commit's file-length check does not block
 * edits to the main (>500 line) test file.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { WebhookQueue, type WebhookQueueItem } from '../src/webhooks/WebhookQueue.js'

function createQueueItem(overrides: Partial<WebhookQueueItem> = {}): WebhookQueueItem {
  return {
    id: `test-${Math.random()}`,
    type: 'index',
    repoUrl: 'https://github.com/test/repo',
    repoFullName: 'test/repo',
    filePath: 'SKILL.md',
    commitSha: 'sha-default',
    timestamp: Date.now(),
    priority: 'medium',
    retries: 0,
    ...overrides,
  }
}

describe('WebhookQueue — additional coverage (SMI-4290)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  describe('debounce coalescing (debounceMs > 0)', () => {
    it('collapses rapid add() calls sharing a debounceKey into a single enqueue', async () => {
      vi.useFakeTimers()

      const queue = new WebhookQueue({
        debounceMs: 500,
        maxRetries: 0,
        retryDelayMs: 1,
      })

      // Same repo + file path => same debounceKey. Each subsequent add()
      // must cancel the prior timer and replace the queued item.
      const baseTs = Date.now()
      const results = await Promise.all([
        queue.add(
          createQueueItem({
            id: 'coalesce-1',
            commitSha: 'sha-1',
            timestamp: baseTs,
            repoFullName: 'test/coalesce',
            filePath: 'SKILL.md',
          })
        ),
        queue.add(
          createQueueItem({
            id: 'coalesce-2',
            commitSha: 'sha-2',
            timestamp: baseTs + 1,
            repoFullName: 'test/coalesce',
            filePath: 'SKILL.md',
          })
        ),
        queue.add(
          createQueueItem({
            id: 'coalesce-3',
            commitSha: 'sha-3',
            timestamp: baseTs + 2,
            repoFullName: 'test/coalesce',
            filePath: 'SKILL.md',
          })
        ),
      ])

      // All three calls report queued (they set a debounce timer).
      expect(results).toEqual([true, true, true])

      // Before the debounce window fires, nothing is in the queue yet.
      expect(queue.getStats().total).toBe(0)
      // A pending debounce timer is tracked as "pending items".
      expect(queue.hasPendingItems()).toBe(true)

      // Advance past the debounce window — only the latest item lands.
      await vi.advanceTimersByTimeAsync(500)

      const stats = queue.getStats()
      expect(stats.total).toBe(1)
      const queuedIds = queue.getItems().map((i) => i.id)
      expect(queuedIds).toEqual(['coalesce-3'])

      queue.clear()
    })
  })

  describe('waitForProcessing()', () => {
    it('resolves only after every in-flight processor settles', async () => {
      const releases: Array<() => void> = []
      const started: string[] = []
      const finished: string[] = []

      const queue = new WebhookQueue({
        debounceMs: 0,
        concurrency: 5,
        maxRetries: 0,
        retryDelayMs: 1,
        processor: async (item) => {
          started.push(item.id)
          await new Promise<void>((resolve) => {
            releases.push(() => {
              finished.push(item.id)
              resolve()
            })
          })
        },
      })

      // Yield between each addImmediate() so the processor loop has a
      // chance to pick up the item before the next one is enqueued.
      // (WebhookQueue's processQueue() exits when it finds no pending
      //  items, so multiple rapid synchronous addImmediate() calls can
      //  land items 2..N without re-triggering processing until the
      //  event loop yields.)
      for (let i = 0; i < 5; i++) {
        queue.addImmediate(
          createQueueItem({
            id: `inflight-${i}`,
            commitSha: `sha-${i}`,
            repoFullName: `test/inflight-${i}`,
            filePath: 'SKILL.md',
          })
        )
        await new Promise((resolve) => setTimeout(resolve, 5))
      }

      // Wait until all five processors have been entered.
      for (let i = 0; i < 40 && started.length < 5; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(started.length).toBe(5)
      expect(finished.length).toBe(0)

      // waitForProcessing must NOT resolve while processors are in flight.
      let resolved = false
      const waitPromise = queue.waitForProcessing().then(() => {
        resolved = true
      })

      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(resolved).toBe(false)

      // Release every processor.
      for (const release of releases) {
        release()
      }

      await waitPromise
      expect(resolved).toBe(true)
      expect(finished.length).toBe(5)
      expect(queue.getStats().total).toBe(0)
    })
  })

  describe('maxSize saturation via debounced add()', () => {
    it('drops items once the queue reaches maxSize via the debounced path', async () => {
      vi.useFakeTimers()

      const queue = new WebhookQueue({
        maxSize: 2,
        debounceMs: 50,
        maxRetries: 0,
        retryDelayMs: 1,
      })

      // Prime two distinct items through the debounce path (different
      // debounceKeys so they do not coalesce).
      const r1 = await queue.add(
        createQueueItem({
          id: 'a',
          commitSha: 'sha-a',
          repoFullName: 'test/a',
          filePath: 'SKILL.md',
        })
      )
      const r2 = await queue.add(
        createQueueItem({
          id: 'b',
          commitSha: 'sha-b',
          repoFullName: 'test/b',
          filePath: 'SKILL.md',
        })
      )
      expect([r1, r2]).toEqual([true, true])

      // Flush both debounce timers so the items actually land in `items`.
      await vi.advanceTimersByTimeAsync(50)
      expect(queue.getStats().total).toBe(2)

      // A third add() must be dropped because the items Map is saturated.
      const r3 = await queue.add(
        createQueueItem({
          id: 'c',
          commitSha: 'sha-c',
          repoFullName: 'test/c',
          filePath: 'SKILL.md',
        })
      )
      expect(r3).toBe(false)

      await vi.advanceTimersByTimeAsync(50)
      expect(queue.getStats().total).toBe(2)
      expect(
        queue
          .getItems()
          .map((i) => i.id)
          .sort()
      ).toEqual(['a', 'b'])

      queue.clear()
    })
  })
})
