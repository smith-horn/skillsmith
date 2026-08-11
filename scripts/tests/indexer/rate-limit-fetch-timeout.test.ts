/**
 * SMI-5964 §1a: per-request fetch timeout at the `withRateLimitTracking`
 * chokepoint (Cases 11, 12, 14).
 *
 * MUST NOT mock `_shared/rate-limit.ts` -- `subdirectory-search.helpers.test.ts`
 * mocks it wholesale (module-level `vi.mock`), which is exactly why these
 * cases live in their own file. Cases 11/12 exercise the REAL platform
 * `fetch`/`AbortSignal`/`ReadableStream` wiring against a real, in-process,
 * deliberately-hanging `node:http` server -- a wired `global.fetch` stub
 * cannot prove the body-read phase, because it never produces a genuine
 * `ReadableStream` whose abort propagation is governed by the runtime rather
 * than by the stub's own bookkeeping. Case 14 only needs to inspect what
 * `init` a stubbed `fetch` received, so it stubs `global.fetch` directly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { withRateLimitTracking, newRateLimitTelemetry } from '../../indexer/_shared/rate-limit.ts'

const ENV_VAR = 'SKILLSMITH_INDEXER_FETCH_TIMEOUT_MS'

describe('_shared/rate-limit.ts -- SMI-5964 per-request fetch timeout (§1a)', () => {
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env[ENV_VAR]
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[ENV_VAR]
    else process.env[ENV_VAR] = originalEnv
  })

  describe('Case 11: a stalled HEADER phase', () => {
    let server: Server
    let baseUrl: string

    beforeEach(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      server = createServer((_req, _res) => {
        // Deliberately never call res.writeHead/res.end -- the header phase
        // hangs forever on its own.
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address() as AddressInfo
      baseUrl = `http://127.0.0.1:${port}`
    })

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    it('`withRateLimitTracking` rejects within the configured timeout instead of hanging', async () => {
      process.env[ENV_VAR] = '50'
      const telemetry = newRateLimitTelemetry()
      await expect(withRateLimitTracking(telemetry, baseUrl)).rejects.toThrow()
    }, 2_000)
  })

  describe('Case 12: a stalled BODY phase', () => {
    let server: Server
    let baseUrl: string

    beforeEach(async () => {
      server = createServer((_req, res) => {
        // Flush headers + one chunk (chunked transfer -- no Content-Length),
        // then hang -- the body phase stalls after the response resolves.
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.write('partial')
        // Deliberately no res.end() -- the stream never completes on its own.
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address() as AddressInfo
      baseUrl = `http://127.0.0.1:${port}`
    })

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    it("the response resolves (header phase fine) but a pending reader.read() aborts within the configured timeout -- proves §1a bounds readResponseWithLimit's reader.read() loop (skill-processor.security.ts:80) WITHOUT editing it", async () => {
      process.env[ENV_VAR] = '50'
      const telemetry = newRateLimitTelemetry()
      const response = await withRateLimitTracking(telemetry, baseUrl)
      expect(response.status).toBe(200)

      const reader = response.body!.getReader()
      // The already-flushed first chunk reads immediately.
      const first = await reader.read()
      expect(first.done).toBe(false)
      // The NEXT read() would hang on the network forever -- the SAME
      // AbortSignal that bounded the header phase must also bound this.
      await expect(reader.read()).rejects.toThrow()
    }, 2_000)
  })

  describe('Case 14: disable + caller-supplied signal passthrough', () => {
    let originalFetch: typeof global.fetch

    beforeEach(() => {
      originalFetch = global.fetch
    })
    afterEach(() => {
      global.fetch = originalFetch
    })

    it('SKILLSMITH_INDEXER_FETCH_TIMEOUT_MS=0 -- fetch receives an init with NO signal (byte-identical to pre-5964 behavior)', async () => {
      process.env[ENV_VAR] = '0'
      let capturedInit: RequestInit | undefined
      global.fetch = (async (_url: string, init?: RequestInit) => {
        capturedInit = init
        return new Response('{}', { status: 200 })
      }) as unknown as typeof global.fetch

      const telemetry = newRateLimitTelemetry()
      await withRateLimitTracking(telemetry, 'https://api.github.com/x')

      expect(capturedInit?.signal).toBeUndefined()
    })

    it('a caller-supplied signal (the org-verification.ts:94 shape) is passed through UNMODIFIED, never overridden', async () => {
      process.env[ENV_VAR] = '30' // active default -- must still not override a caller-supplied signal
      let capturedInit: RequestInit | undefined
      global.fetch = (async (_url: string, init?: RequestInit) => {
        capturedInit = init
        return new Response('{}', { status: 200 })
      }) as unknown as typeof global.fetch

      const callerSignal = AbortSignal.timeout(60_000)
      const telemetry = newRateLimitTelemetry()
      await withRateLimitTracking(telemetry, 'https://api.github.com/x', { signal: callerSignal })

      expect(capturedInit?.signal).toBe(callerSignal)
    })
  })
})
