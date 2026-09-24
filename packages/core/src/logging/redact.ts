/**
 * SMI-883 / SMI-5615: Sensitive-data redaction, ported VERBATIM from the dead
 * `packages/mcp-server/src/logger.ts` (lines 11-107) into the shared
 * `@skillsmith/core` logging module. Same regex patterns, same behavior,
 * same test coverage (see `redact.test.ts`) — this is tested, working code
 * relocated, not rewritten.
 */

/**
 * Strips ANSI/SGR escape sequences (`\x1b[...m` — the `chalk`-style color
 * codes CLI call sites wrap error text in). SMI-5615 Mode-B diff-audit
 * (Wave 2 pass): the disk-persisted record must not embed raw escape codes
 * as log noise, AND a secret sitting immediately after an escape code's
 * trailing letter (e.g. `\x1b[31msk_live_...`) can defeat
 * `redactSensitiveData`'s leading `\b` word-boundary check — the `m`→`s`
 * transition is word-to-word, not a boundary. Stripping ANSI BEFORE redacting
 * closes that gap. Only applied on the DISK-persisted path (`logger.ts`'s
 * `buildRecord`/`normalizeError`) — deliberately NOT applied to the
 * console-mirrored path, which must keep chalk's colors for CLI terminal UX.
 * Covers chalk's actual output (SGR codes only); not a full ANSI/VT100 strip.
 */
// \x1b is the intentional ESC byte an SGR sequence always starts with; this
// is the same pattern the widely-used `strip-ansi` npm package uses (also
// eslint-disabled there).
// eslint-disable-next-line no-control-regex
const ANSI_SGR_PATTERN = /\x1b\[[0-9;]*m/g

export function stripAnsi(text: string): string {
  if (!text) return text
  return text.replace(ANSI_SGR_PATTERN, '')
}

/**
 * SMI-883: Sensitive data patterns to redact before logging
 * Prevents API keys, tokens, passwords, and secrets from being written to disk
 */
const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // GitHub tokens
  { pattern: /\b(ghp_[a-zA-Z0-9]{36})\b/g, replacement: 'ghp_[REDACTED]' },
  { pattern: /\b(github_pat_[a-zA-Z0-9_]{22,})\b/g, replacement: 'github_pat_[REDACTED]' },
  { pattern: /\b(gho_[a-zA-Z0-9]{36})\b/g, replacement: 'gho_[REDACTED]' },
  { pattern: /\b(ghs_[a-zA-Z0-9]{36})\b/g, replacement: 'ghs_[REDACTED]' },
  { pattern: /\b(ghu_[a-zA-Z0-9]{36})\b/g, replacement: 'ghu_[REDACTED]' },
  { pattern: /\b(ghr_[a-zA-Z0-9]{36})\b/g, replacement: 'ghr_[REDACTED]' },
  // Linear API keys
  { pattern: /\b(lin_api_[a-zA-Z0-9]{32,})\b/g, replacement: 'lin_api_[REDACTED]' },
  // SMI-6840: `sk_live_` is shared by two issuers with DIFFERENT alphabets. Stripe's live
  // secret keys are alphanumeric, but Skillsmith mints its own `sk_live_` keys as base64url
  // (`_shared/license.ts` generateLicenseKey: btoa(...) with +/ -> -_ and = stripped), so the
  // body can contain `-` and `_`.
  //
  // The previous `\b(sk_live_[a-zA-Z0-9]{24,})\b` failed on both counts, for most keys. The rate
  // is derivable rather than merely sampled: a base64url body draws from 64 symbols, 62 of them
  // alphanumeric, so the chance that the first 24 body characters contain no `-` or `_` is
  // (62/64)^24, and the pattern fails to match outright for the remaining 1 - (62/64)^24 =
  // **53.3%**. The true leak rate is higher still, because a `_` later in the body defeats the
  // trailing `\b` as well (mechanism 2 below). A 10,000-key sample agreed: 6,353 not redacted at
  // all and 1,024 redacted only up to the first `-`, leaving the tail beside a `[REDACTED]`
  // marker that made the leak look handled. Prefer the closed form when citing this; the sample
  // was unseeded and is corroboration, not provenance.
  //
  // Two independent mechanisms, and the second is the subtle one:
  //
  //   1. A `-` or `_` inside the first 24 body characters ends the run below the {24,} minimum,
  //      so the whole match fails.
  //   2. `_` is itself a WORD character, so no `\b` can ever exist between an alphanumeric run
  //      and a following `_`. Backtracking cannot rescue this — every shorter run is also
  //      followed by a word character — so a `_` anywhere in the body killed the match.
  //
  // Hence: widen the class to the emitted alphabet, and drop the trailing `\b`. The greedy
  // quantifier already consumes the whole body, so no terminator is needed here. Note the
  // precise claim: it is `\b` SPECIFICALLY that is incompatible with a base64url body, because
  // `_` is a word character. A base64url-aware assertion such as `(?![A-Za-z0-9_-])` would be
  // correct — it is simply redundant after a greedy match. Do not read this as "trailing
  // assertions are wrong"; re-adding `\b` is what must not happen.
  //
  // The cost, stated honestly: the match now runs on into any adjacent `[A-Za-z0-9_-]` text, so
  // `sk_live_<key>_status_ok` redacts the trailing `_status_ok` too. That is the deliberate
  // failure direction, but "safe" holds only on the CONFIDENTIALITY axis — no secret survives.
  // On the DIAGNOSTIC axis it is a real cost: adjacent log content can be swallowed. Accepted
  // because under-redaction leaks a credential while over-redaction loses context, and only one
  // of those is recoverable. `redactSensitiveObject` returns a new object and never mutates its
  // input, so this is confined to the emitted copy.
  //
  // Widening is monotonic: alphanumeric is a subset of this class, so Stripe's own live keys
  // stay covered. Do not "simplify" this back to `[a-zA-Z0-9]` or re-add a trailing `\b`.
  // `redact.test.ts` pins both mechanisms against keys from the real generator, and pins the
  // `{24,}` minimum at its two boundaries.
  { pattern: /\b(sk_live_[A-Za-z0-9_-]{24,})/g, replacement: 'sk_live_[REDACTED]' },
  // Stripe keys. These three are Stripe-only — nothing in this repo mints an `sk_test_`,
  // `pk_live_` or `pk_test_` key (SMI-6840: every occurrence is Stripe's own STRIPE_SECRET_KEY
  // or a test fixture), and Stripe's key bodies are alphanumeric. Left narrow deliberately:
  // changing an issuer's pattern without a case table for THAT issuer is how the bug above
  // survived. Widen only against measured evidence of a wider alphabet.
  { pattern: /\b(sk_test_[a-zA-Z0-9]{24,})\b/g, replacement: 'sk_test_[REDACTED]' },
  { pattern: /\b(pk_live_[a-zA-Z0-9]{24,})\b/g, replacement: 'pk_live_[REDACTED]' },
  { pattern: /\b(pk_test_[a-zA-Z0-9]{24,})\b/g, replacement: 'pk_test_[REDACTED]' },
  // OpenAI API keys
  { pattern: /\b(sk-[a-zA-Z0-9]{48,})\b/g, replacement: 'sk-[REDACTED]' },
  // Anthropic API keys
  { pattern: /\b(sk-ant-[a-zA-Z0-9-]{32,})\b/g, replacement: 'sk-ant-[REDACTED]' },
  // AWS keys
  { pattern: /\b(AKIA[A-Z0-9]{16})\b/g, replacement: 'AKIA[REDACTED]' },
  // Slack tokens
  { pattern: /\b(xox[boaprs]-[a-zA-Z0-9-]{10,})\b/g, replacement: 'xox*-[REDACTED]' },
  // npm tokens
  { pattern: /\b(npm_[a-zA-Z0-9]{36})\b/g, replacement: 'npm_[REDACTED]' },
  // Bearer tokens
  { pattern: /\bBearer\s+([a-zA-Z0-9_\-.]{20,})/gi, replacement: 'Bearer [REDACTED]' },
  // Basic auth
  { pattern: /\bBasic\s+([a-zA-Z0-9+/=]{20,})/gi, replacement: 'Basic [REDACTED]' },
  // JWT tokens
  {
    pattern: /\beyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]+\b/g,
    replacement: '[JWT_REDACTED]',
  },
  // Generic API key patterns
  {
    pattern: /\b(api[_-]?key|apikey)\s*[=:]\s*["']?([a-zA-Z0-9_-]{8,})["']?/gi,
    replacement: 'api_key=[REDACTED]',
  },
  {
    pattern: /\b(token|auth[_-]?token)\s*[=:]\s*["']?([a-zA-Z0-9_-]{8,})["']?/gi,
    replacement: 'token=[REDACTED]',
  },
  {
    pattern: /\b(password|passwd|pwd)\s*[=:]\s*["']?([^"'\s]{4,})["']?/gi,
    replacement: 'password=[REDACTED]',
  },
  {
    pattern: /\b(secret|client[_-]?secret)\s*[=:]\s*["']?([a-zA-Z0-9_-]{8,})["']?/gi,
    replacement: 'secret=[REDACTED]',
  },
  // Connection strings with passwords
  { pattern: /(:\/\/[^:]+:)([^@]+)(@)/gi, replacement: '$1[REDACTED]$3' },
  // Private keys
  {
    pattern:
      /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(RSA\s+)?PRIVATE\s+KEY-----/gi,
    replacement: '-----[PRIVATE KEY REDACTED]-----',
  },
]

/**
 * SMI-883: Redact sensitive data from text before logging
 * Exported for testing purposes
 */
export function redactSensitiveData(text: string): string {
  if (!text) return text
  let redacted = text
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    // Reset lastIndex for global regex patterns to ensure all matches are found
    pattern.lastIndex = 0
    redacted = redacted.replace(pattern, replacement)
  }
  return redacted
}

/**
 * SMI-883: Recursively redact sensitive data from objects
 * Exported for testing purposes
 *
 * SMI-5615 Mode-B diff-audit NEW-2: `seen` guards against circular
 * references. The original (dead) `mcp-server/src/logger.ts` version this was
 * ported from had no cycle guard — harmless there since it was never called
 * in production, but this module IS the production write path now, so a
 * circular `details`/`err` object (e.g. a thrown object with a `cause` cycle)
 * must degrade to `'[Circular]'` rather than stack-overflowing, which would
 * otherwise abort the whole record (including the redacted `msg` and
 * `correlationId`) and fall through to the raw-message console fallback.
 *
 * `seen` tracks only the CURRENT recursion path (ancestors), not every object
 * visited overall — each object is removed again once its own subtree
 * finishes (the `finally` below). This is deliberate: the same object
 * appearing twice at sibling positions (a shared, non-cyclic reference — a
 * DAG, not a cycle) must redact normally both times, not get falsely flagged
 * `'[Circular]'` just because it was visited once already elsewhere.
 */
export function redactSensitiveObject(
  obj: unknown,
  seen: WeakSet<object> = new WeakSet()
): unknown {
  if (obj === null || obj === undefined) return obj
  if (typeof obj === 'string') return redactSensitiveData(obj)
  if (typeof obj !== 'object') return obj
  if (seen.has(obj)) return '[Circular]'
  seen.add(obj)
  try {
    if (Array.isArray(obj)) return obj.map((item) => redactSensitiveObject(item, seen))
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      result[key] = redactSensitiveObject(value, seen)
    }
    return result
  } finally {
    seen.delete(obj)
  }
}
