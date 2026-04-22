/**
 * validate-next-redirect.ts
 *
 * SMI-4401 Wave 2 — OWASP redirect validation helper.
 *
 * Callers pass an untrusted `next` query param (plus an optional `source` hint) and
 * receive a safe absolute-path URL (always starts with `/`) suitable for `window.location.href`.
 *
 * Rejected inputs fall back to a source-aware default:
 *   - `source === 'cli'` → `/return-to-cli`
 *   - otherwise          → `/account/cli-token`
 *
 * OWASP rejection classes (spec §4.4 A-NEXT-1):
 *   (a) absolute URLs with a different origin              → `https://evil.com/x`
 *   (b) protocol-relative                                  → `//evil.com/x`
 *   (c) `javascript:` / `data:` / `vbscript:` schemes      → `javascript:alert(1)`
 *   (d) encoded variants                                   → `%2F%2Fevil.com`
 *   (e) self-reference as a post-submit REDIRECT DEST      → `/complete-profile`, `/login`, `/signin`, `/auth/*`
 *
 * Self-reference scope (M5): (e) applies ONLY when this validator resolves a POST-SUBMIT
 * redirect destination. Form-internal navigation (hash anchors, inline error links, back-to-edit)
 * is not this validator's concern — callers that need a self-reference should use `location.hash`
 * or a purpose-built helper.
 *
 * Parameter precedence (H6, spec §5.1):
 *   1. `source=cli` wins over a bare `next=` (CLI-originated redirect takes the cli default).
 *   2. Otherwise a valid `next=` wins over the default.
 *   3. Otherwise fall through to the no-params default.
 *
 * Unknown query-param handling (H2, spec §4.4 A-NEXT-1):
 *   - By default, unknown query params on `next` are stripped (prevents encoded
 *     path-traversal via open-redirect).
 *   - Exception: when the destination path is exactly `/device`, the `user_code` query
 *     parameter is preserved. Wave 3 RFC 8628 device-code flow relies on
 *     `/device?user_code=<BCDF-GHJK-or-uuid>` as the canonical approval URL; dropping
 *     `user_code` would strand CLI users mid-flow.
 *
 * Explicit unit test (spec §4.4 A-NEXT-1):
 *   validateNextParam('/device?user_code=BCDF-GHJK', 'cli') === '/device?user_code=BCDF-GHJK'
 */

/** Paths that must never be used as a post-submit redirect destination (self-reference guard). */
const SELF_REFERENCE_PATHS = new Set<string>([
  '/complete-profile',
  '/login',
  '/signin', // legacy alias; intentionally rejected
])

/** Prefixes whose subtree is rejected as a post-submit redirect destination. */
const SELF_REFERENCE_PREFIXES: readonly string[] = ['/auth/']

/** Resolve the default destination based on the caller's source hint. */
function defaultFor(source: string | null | undefined): string {
  return source === 'cli' ? '/return-to-cli' : '/account/cli-token'
}

/** True when the destination path is rejected as a self-reference. */
function isSelfReference(pathname: string): boolean {
  if (SELF_REFERENCE_PATHS.has(pathname)) return true
  for (const prefix of SELF_REFERENCE_PREFIXES) {
    // Match both "/auth" (bare) and "/auth/<anything>" — the auth subtree is never a post-submit destination.
    const bare = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
    if (pathname === bare || pathname.startsWith(prefix)) return true
  }
  return false
}

/**
 * Validate an untrusted `next` redirect target and return a safe same-origin path.
 *
 * @param next   - Untrusted query-param value (may be null, undefined, or an attacker-controlled string).
 * @param source - Optional hint; when `'cli'` it steers the default toward `/return-to-cli`.
 * @returns      - A safe absolute path that always starts with `/`.
 */
export function validateNextParam(
  next: string | null | undefined,
  source: string | null | undefined,
): string {
  const fallback = defaultFor(source)

  if (typeof next !== 'string' || next.length === 0) return fallback

  // Trim whitespace; extremely long inputs are suspicious — cap at 2048 chars.
  const trimmed = next.trim()
  if (trimmed.length === 0 || trimmed.length > 2048) return fallback

  // Reject obviously dangerous schemes on the raw string before any decode.
  // Case-insensitive; tolerate leading whitespace/tab/newline that may bypass naive checks.
  if (/^(?:[a-z][a-z0-9+.-]*:)/i.test(trimmed)) {
    // Any explicit scheme is rejected. We only accept same-origin absolute paths.
    // This covers javascript:, data:, vbscript:, file:, http:, https:, etc.
    return fallback
  }

  // Reject protocol-relative early (raw or encoded).
  if (trimmed.startsWith('//')) return fallback

  // Decode once to catch encoded protocol-relative / encoded scheme attacks.
  // If decoding fails, the input is malformed — fall back.
  let decoded: string
  try {
    decoded = decodeURIComponent(trimmed)
  } catch {
    return fallback
  }
  if (decoded.startsWith('//')) return fallback
  if (/^(?:[a-z][a-z0-9+.-]*:)/i.test(decoded)) return fallback

  // Same-origin absolute paths must begin with a single `/`.
  if (!trimmed.startsWith('/')) return fallback

  // Parse as a URL against an arbitrary same-origin base to extract pathname + searchParams safely.
  // Any URL constructor failure → fall back.
  let parsed: URL
  try {
    parsed = new URL(trimmed, 'https://example.invalid')
  } catch {
    return fallback
  }

  // Belt-and-suspenders: confirm parsing did not relocate us off-origin.
  if (parsed.origin !== 'https://example.invalid') return fallback

  const { pathname } = parsed

  // Reject self-reference (e) for post-submit destinations.
  if (isSelfReference(pathname)) return fallback

  // Build the sanitized output path. By default, strip all query params.
  // Exception (H2): preserve `user_code` when pathname is exactly `/device`.
  if (pathname === '/device') {
    const userCode = parsed.searchParams.get('user_code')
    if (userCode && userCode.length > 0 && userCode.length <= 128) {
      // Re-encode `user_code` to neutralize any injected ampersands or fragments.
      return `/device?user_code=${encodeURIComponent(userCode)}`
    }
    return '/device'
  }

  // All other paths: pathname only, no query, no fragment.
  return pathname
}
