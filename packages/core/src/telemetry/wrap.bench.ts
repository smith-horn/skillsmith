/**
 * SMI-5016 / Risk #7: withTelemetry overhead microbenchmark.
 *
 * Uses vitest `bench()` for reporting. Run via:
 *   docker exec skillsmith-dev-1 \
 *     npx vitest bench --run packages/core/src/telemetry/wrap.bench.ts
 *
 * NOTE: `bench()` is reporting-only — it does NOT fail CI on regression.
 * The assertable p99 < 1ms gate lives in `wrap.test.ts` ('overhead' suite)
 * and runs in every CI test pass.
 */

import { describe, bench, vi, beforeAll } from 'vitest'
import { withTelemetry } from './wrap.js'

vi.mock('./posthog.js', () => ({
  trackSkillInvoke: vi.fn(),
}))

const noopHandler = async (): Promise<number> => 42

const wrappedNoop = withTelemetry(noopHandler, {
  source: 'mcp-tool',
  extractSkillId: () => 'bench/skill',
})

const wrappedWithFramework = withTelemetry(noopHandler, {
  source: 'mcp-tool',
  extractSkillId: () => 'bench/skill',
  extractFramework: () => 'cursor',
})

beforeAll(async () => {
  // JIT warm-up before measurement begins
  for (let i = 0; i < 200; i++) {
    await (wrappedNoop as unknown as () => Promise<unknown>)()
  }
})

describe('withTelemetry HOF overhead', () => {
  bench(
    'no-op handler — no extractFramework',
    async () => {
      await (wrappedNoop as unknown as () => Promise<unknown>)()
    },
    { iterations: 500, warmupIterations: 50 }
  )

  bench(
    'no-op handler — with extractFramework',
    async () => {
      await (wrappedWithFramework as unknown as () => Promise<unknown>)()
    },
    { iterations: 500, warmupIterations: 50 }
  )
})
