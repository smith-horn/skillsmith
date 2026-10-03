/**
 * Keep a response's `structuredContent` in lock-step with the envelope fields
 * spliced into its text block.
 *
 * @module @skillsmith/mcp-server/middleware/structured-content
 *
 * SMI-6472 (cross-model pre-merge review finding). Wave 3 gave `search`,
 * `get_skill` and `skill_validate` an `outputSchema` and made `ok()` emit
 * `structuredContent` alongside the existing JSON text block. Two response
 * decorators — `annotateResponseWithWelcome` (first-run-welcome.ts) and the
 * consent annotator (telemetry-consent.ts) — splice extra top-level fields
 * (`welcome_message`, `tier1_install_failures`, `consent_required`,
 * `privacy_url`) into `content[0].text` AFTER the tool has already returned.
 *
 * Before this helper existed, those decorators rebuilt only `content` and
 * passed `structuredContent` through untouched, so the two representations
 * of the SAME response disagreed: a text-reading client saw the consent
 * notice and a structured-output client silently did not. That is worse than
 * cosmetic for consent in particular — a structured client would never
 * surface the privacy notice at all.
 *
 * The three `outputSchema`s deliberately do NOT set `additionalProperties:
 * false`, so these envelope fields validate cleanly against them (JSON Schema
 * permits extra properties by default). If a future schema ever tightens
 * that, this helper is the single place that has to change — and the SDK
 * client would start throwing on the spliced field, which is a loud failure
 * rather than a silent divergence.
 */
/**
 * `response` is deliberately `unknown` rather than `CallToolResult` or an
 * all-optional `{ structuredContent?: unknown }` shape. The two callers do
 * not share a type: `annotateResponseWithWelcome` takes a real
 * `CallToolResult`, while `annotateResponseWithConsent` is generic over
 * `T extends { content?: unknown }` and returns `T`. An all-optional
 * parameter type would additionally trip TypeScript's weak-type detection
 * ("has no properties in common") at that second call site. Accepting
 * `unknown` and narrowing here is both honest about what the helper reads
 * and the only shape that satisfies both callers.
 */

/**
 * Build the `structuredContent` patch for a response whose text block was
 * just re-serialized from `annotated`.
 *
 * Returns an EMPTY object when the response carries no `structuredContent`
 * (the ~40 tools with no declared `outputSchema`), so spreading the result is
 * a no-op for them and their envelope stays byte-identical.
 *
 * `annotated` is the already-parsed text payload WITH the decorator's fields
 * spliced in. Because `ok()` derives the text block and `structuredContent`
 * from the same object, re-using `annotated` here keeps the two exactly
 * equal rather than merely similar.
 *
 * @param response   The response being decorated.
 * @param annotated  Parsed text payload including the newly spliced fields.
 */
export function spliceStructured(
  response: unknown,
  annotated: Record<string, unknown>
): { structuredContent?: Record<string, unknown> } {
  const existing = (response as { structuredContent?: unknown } | null | undefined)
    ?.structuredContent
  if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
    return {}
  }
  return { structuredContent: annotated }
}
