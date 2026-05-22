/**
 * @fileoverview SMI-5130 — VS Code-local telemetry wrapper.
 *
 * Why local (not `@skillsmith/core/telemetry`): the extension is bundled
 * standalone via `esbuild --bundle` and ships to the Marketplace. Importing the
 * core HOF would inline `posthog-node` + the full OpenTelemetry SDK into the
 * bundle (large; OTel's dynamic requires also break esbuild). This mirrors the
 * core `withTelemetry` / `isTelemetered` contract — so the per-tree coverage gate
 * (SMI-5018/SMI-5040 shape) works identically — but emits through the extension's
 * own `services/Telemetry.ts` `track()`, which already self-gates on
 * `vscode.env.isTelemetryEnabled` + `skillsmith.telemetry.enabled` + endpoint.
 */
import { track } from './Telemetry.js'

type AnyFunction = (...args: never[]) => unknown

const wrapped = new WeakSet<AnyFunction>()

export interface VscodeTelemetryOpts {
  /** Always `'vscode-extension'` — kept for parity with the core HOF shape. */
  source: 'vscode-extension'
  /** Returns the registered command id, e.g. `'skillsmith.searchSkills'`. */
  extractSkillId: () => string
}

/**
 * Wrap a VS Code command handler so its invocation is recorded by the
 * telemetry coverage gate and emitted via `track('vscode_skill_invoke', …)`.
 * Telemetry emission is fire-and-forget and never alters the handler's
 * observable behaviour (errors are swallowed; `track` self-gates + self-times).
 */
// audit:check-48-ack — intentional parallel definition: the extension bundles
// standalone (esbuild) and cannot import the canonical core HOF (would inline
// posthog-node + OTel SDK). See the file header for the full rationale.
export function withTelemetry<TArgs extends readonly unknown[], TReturn>(
  handler: (...args: TArgs) => Promise<TReturn> | TReturn,
  opts: VscodeTelemetryOpts
): (...args: TArgs) => Promise<TReturn> {
  const wrappedFn = async (...args: TArgs): Promise<TReturn> => {
    try {
      // `skill_id` + `source` match the events edge-function field allowlist
      // (supabase/functions/events/index.ts); `surface`/other keys would be dropped.
      track('vscode_skill_invoke', { skill_id: opts.extractSkillId(), source: opts.source })
    } catch {
      // Telemetry must never break a command.
    }
    return handler(...args)
  }
  wrapped.add(wrappedFn as AnyFunction)
  return wrappedFn
}

/**
 * Returns `true` if `fn` was produced by `withTelemetry`. Checks the *wrapped*
 * reference, not the original handler.
 */
export function isTelemetered(fn: AnyFunction): boolean {
  return wrapped.has(fn)
}
