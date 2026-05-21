/**
 * SMI-5039: Canonical embedding-capability probe.
 *
 * Extracted from `packages/mcp-server/src/index.ts` (originally landed in
 * SMI-5009) to give all consumers — MCP servers, CLIs, future tooling — a
 * single source of truth for the "is the @huggingface/transformers stack
 * available at boot?" question.
 *
 * Design contract (preserved verbatim from the mcp-server origin so behavior
 * is bit-for-bit identical for that consumer; new options are additive):
 *
 *   - Hard 2 s default timeout via `Promise.race` against a `Symbol` sentinel.
 *     Bound applies even if `EmbeddingService.checkAvailability()` hangs.
 *   - try/catch wraps the probe; a throw is logged and never propagates.
 *   - Logs to **stderr only** via the supplied `logger` (default
 *     `console.error`). MCP servers communicate over stdio — polluting stdout
 *     would corrupt protocol framing. This invariant is asserted by spawn-
 *     based "stdout pollution" tests in each consumer package.
 *   - Silent on success (real embeddings active); only emits a line when
 *     mock fallback is engaged, the probe times out, or the probe throws.
 *   - Honors `SKILLSMITH_QUIET=true` env var (case-insensitive) AND the
 *     explicit `quiet` option — when set, the log line is suppressed even on
 *     mock fallback. The probe still **runs** (it warms the module-load
 *     cache); only the operator-visible warning is silenced.
 *   - Never throws. Probe failure must never block server / CLI boot.
 *
 * @see SMI-5009 — original probe in mcp-server.
 * @see SMI-5039 — extraction to core.
 * @see ADR-009 — embedding service fallback policy.
 */

import { EmbeddingService } from './index.js'

/** Hard upper bound on probe execution (preserved from SMI-5009). */
const DEFAULT_TIMEOUT_MS = 2000

export interface ProbeEmbeddingCapabilityOptions {
  /**
   * Override the hard probe timeout (milliseconds). Defaults to 2 000 ms.
   * The bound applies even if `EmbeddingService.checkAvailability()` never
   * resolves — that is the entire point of the probe.
   */
  timeoutMs?: number

  /**
   * Custom log sink. Defaults to `console.error`. MUST write to stderr (or a
   * stderr-equivalent sink) — see the "stdio invariant" note in this file's
   * docstring. Provided primarily for unit tests + future structured-logging
   * consumers.
   */
  logger?: (msg: string) => void

  /**
   * When `true`, suppress the warning log line even on mock fallback.
   * The probe still runs and warms the module-load cache; only the
   * operator-visible warning is silenced. Equivalent to setting
   * `SKILLSMITH_QUIET=true` in the environment.
   */
  quiet?: boolean
}

/** Detect SKILLSMITH_QUIET env var (case-insensitive truthy match). */
function envQuiet(): boolean {
  const v = process.env.SKILLSMITH_QUIET
  if (v == null) return false
  return v.toLowerCase() === 'true' || v === '1'
}

/**
 * Probe `@huggingface/transformers` availability with a hard timeout +
 * structured stderr warning when the mock fallback engages.
 *
 * NEVER throws. Returns within `timeoutMs` even if the underlying capability
 * check hangs. Safe to `await` directly before connecting an MCP transport or
 * dispatching a CLI command that depends on embeddings.
 */
export async function probeEmbeddingCapability(
  opts: ProbeEmbeddingCapabilityOptions = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const log = opts.logger ?? ((msg: string) => console.error(msg))
  const quiet = opts.quiet === true || envQuiet()
  const emit = (msg: string): void => {
    if (!quiet) log(msg)
  }

  const TIMEOUT_SENTINEL: unique symbol = Symbol('probe-timeout')
  let timeoutHandle: NodeJS.Timeout | undefined

  try {
    const result = await Promise.race<boolean | typeof TIMEOUT_SENTINEL>([
      EmbeddingService.checkAvailability(),
      new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs)
      }),
    ])

    if (result === TIMEOUT_SENTINEL) {
      emit(
        '[skillsmith] embeddings: mock (transformers unavailable: probe-timeout after 2s; install @huggingface/transformers or set SKILLSMITH_USE_MOCK_EMBEDDINGS=true to silence)'
      )
      return
    }

    if (result === true) {
      // Silent on success — avoid noise on healthy boots.
      return
    }

    // checkAvailability returned false → derive reason from cached load error.
    const loadErr = EmbeddingService.getTransformersLoadError()
    const reason = loadErr?.message ?? 'module-load-failed'
    emit(
      `[skillsmith] embeddings: mock (transformers unavailable: ${reason}; install @huggingface/transformers or set SKILLSMITH_USE_MOCK_EMBEDDINGS=true to silence)`
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    emit(
      `[skillsmith] embeddings: probe-failed (${msg}; install @huggingface/transformers or set SKILLSMITH_USE_MOCK_EMBEDDINGS=true to silence)`
    )
    // Continue boot — probe failure must NEVER block server start.
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }
}
