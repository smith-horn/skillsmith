/**
 * @fileoverview CallTool request handler for the Skillsmith MCP server.
 * @module @skillsmith/mcp-server/call-tool-handler
 *
 * Extracted from `index.ts`'s `CallToolRequestSchema` registration (SMI-5479
 * Step 3, plan H-3) to keep `index.ts` under the 500-LOC `audit:standards`
 * file-size gate.
 *
 * SMI-5479 also wires the dispatch-level consent + emission gate here: every
 * dispatched tool call now resolves consent ONCE
 * (`resolveConsent(toolContext.distinctId)`, process-cached) and runs the
 * dispatch inside `runWithEmissionGate(consent.enabled, ...)`. This is the
 * change that flips the 18 previously-never-emitting direct-dispatch tools
 * (12 agent-profile + 6 non-profile — see
 * `docs/internal/implementation/smi-5479-emission-gate-dispatch.md`) to
 * emit-when-consent-on. Gated tools (routed through `withLicenseAndQuota` in
 * `middleware/license.gate.ts`) already install their OWN nested
 * `runWithEmissionGate` scope from the SAME cached consent value — that
 * inner scope simply shadows this outer one for the gated handler's own
 * emit; see the double-gate note in `license.gate.ts` and
 * `packages/core/src/telemetry/wrap.ts`.
 *
 * LATE-BINDING TRAP (plan pass-2, load-bearing): `toolContext` is a
 * module-level `let` in `index.ts`, assigned inside `main()` AFTER the
 * CallTool handler registers with the SDK server. `handleCallToolRequest`
 * therefore takes `deps` as a plain PARAMETER, read fresh on every
 * invocation — the registration call site
 * (`server.setRequestHandler(CallToolRequestSchema, (request) =>
 * handleCallToolRequest(request, { toolContext, ... }))`) re-reads the
 * module-level `toolContext` binding on every call. Do NOT refactor this to
 * capture `deps` once at registration time — that would freeze `toolContext`
 * at its pre-`main()` value (`undefined`), passing typecheck but breaking at
 * runtime on the very first tool call.
 */

import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ToolContext } from './context.js'
import { dispatchToolCall } from './tool-dispatch.js'
import {
  resolveAgentMarker,
  runWithMarkerContext,
  runWithEmissionGate,
} from '@skillsmith/core/telemetry'
import type { LicenseMiddleware } from './middleware/license.js'
import type { QuotaMiddleware } from './middleware/quota.js'
import {
  resolveConsent,
  annotateResponseWithConsent,
  wasConsentPrompted,
  markConsentPrompted,
  type ConsentState,
} from './middleware/telemetry-consent.js'
// SMI-5573/5582: one-shot first-run welcome message injection. Called
// UNCONDITIONALLY on every dispatched response (see below) — the annotator
// internally declines to consume the pending message on an error envelope.
import { annotateResponseWithWelcome } from './middleware/first-run-welcome.js'

/**
 * Per-call dependencies for {@link handleCallToolRequest}. See the
 * LATE-BINDING TRAP note above — callers MUST read `toolContext` fresh at
 * the registration call site, never capture it once ahead of time.
 */
export interface CallToolHandlerDeps {
  toolContext: ToolContext
  licenseMiddleware: LicenseMiddleware
  quotaMiddleware: QuotaMiddleware
}

/**
 * Success-only consent annotation (plan H-1 / H-2): splice `consent_required`
 * + `privacy_url` into a SUCCESS envelope, at most once per process per
 * anonymousId (SMI-5479 pass-2 Option A, ratified at plan kickoff — avoids
 * per-call prompt-noise on agent loops that call `search` / `get_skill` /
 * `skill_recommend` repeatedly).
 *
 * Marks the id as "prompted" ONLY when `annotateResponseWithConsent` actually
 * mutated the response (reference inequality — it returns the SAME reference
 * on every no-op path: consent already resolved, non-JSON body, already
 * annotated by the middleware, etc). This matters for the `inventory_push`
 * prose-body carve-out: a fail-open no-op must never consume the one-shot
 * prompt for a user who never actually saw it — otherwise their next,
 * JSON-bodied call would silently skip the prompt too.
 */
function maybeAnnotate(
  result: CallToolResult,
  consent: ConsentState,
  distinctId: string | undefined
): CallToolResult {
  if (!consent.consentRequired) return result
  if (wasConsentPrompted(distinctId)) return result
  const annotated = annotateResponseWithConsent(result, consent)
  if (annotated !== result) {
    markConsentPrompted(distinctId)
  }
  return annotated
}

/**
 * Handle a single `CallToolRequestSchema` request. Extracted from
 * `index.ts` (SMI-5479 Step 3) — see the module doc for the late-binding
 * dependency contract callers must honor.
 */
export async function handleCallToolRequest(
  request: CallToolRequest,
  deps: CallToolHandlerDeps
): Promise<CallToolResult> {
  const { toolContext, licenseMiddleware, quotaMiddleware } = deps
  const { name, arguments: args } = request.params

  // SMI-5456: resolve the agent-mediation marker BEFORE dispatch and run the
  // dispatch inside its AsyncLocalStorage scope so the withTelemetry emit
  // (which fires in the wrapped handler's `finally`, inside this continuation)
  // reads THIS call's marker. `_meta` is a loose passthrough field;
  // resolveAgentMarker validates it defensively and falls back to the session
  // marker file. ALS auto-scopes — no manual clearing, and parallel tool calls
  // (harnesses batch them routinely) cannot observe or clear each other's
  // marker.
  const requestMeta = (request.params as { _meta?: unknown })._meta

  try {
    // SMI-5479: resolve consent INSIDE the try. Defensive: `resolveConsent`
    // never rejects today (every internal branch resolves to a `DEFAULT_*`
    // state) — placing it here guards a future edit from escaping this
    // handler as an unhandled rejection instead of the existing
    // error-envelope path below. Process-cached: one round-trip on first
    // call for a given anonymousId, zero-cost after.
    const consent = await resolveConsent(toolContext.distinctId)
    const result = await runWithEmissionGate(consent.enabled, () =>
      runWithMarkerContext(resolveAgentMarker(requestMeta), () =>
        dispatchToolCall(
          name,
          args as Record<string, unknown> | undefined,
          toolContext,
          licenseMiddleware,
          quotaMiddleware
        )
      )
    )
    // SMI-5573/5582: splice the pending first-run welcome message
    // (welcome_message + tier1_install_failures) FIRST, unconditionally.
    // annotateResponseWithWelcome is a cheap no-op when nothing is pending and,
    // critically, leaves an error envelope untouched WITHOUT consuming the
    // pending state — so we call it even on the error path (unlike the
    // success-only consent annotation) precisely so a transient first-call
    // failure re-delivers the welcome on the next success.
    const withWelcome = annotateResponseWithWelcome(result)
    // Consent stays success-envelopes ONLY (plan H-1) — matches the sole
    // existing precedent (`license.gate.ts` annotates `ok(handlerResult)`
    // only). Chained off `withWelcome`; the two annotators touch disjoint
    // top-level JSON fields (welcome_message/tier1_install_failures vs
    // consent_required/privacy_url), so neither clobbers the other. Every error
    // envelope — validation, quota -32050, profile_incomplete -32001,
    // gated-tool errors — stays byte-identical apart from the welcome splice
    // (which no-ops on error).
    return withWelcome.isError
      ? withWelcome
      : maybeAnnotate(withWelcome, consent, toolContext.distinctId)
  } catch (error) {
    // SMI-4313: Validation now runs through `safeParseOrError` at every
    // dispatch site, so a `ZodError` reaching this catch is a regression
    // signal (a new site was added without going through the helper).
    // Log a warn on stderr so production telemetry surfaces it within a
    // day; the outer envelope still returns an isError response so
    // clients aren't broken by the observability alarm.
    if (error instanceof Error && error.name === 'ZodError') {
      console.error(
        `[skillsmith:dispatch] Unexpected ZodError reached outer catch — validation helper missed a site (tool=${name}): ${error.message}`
      )
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Error: ' + (error instanceof Error ? error.message : 'Unknown error'),
        },
      ],
      isError: true,
    }
  }
}
