/**
 * complete-profile-copy.ts
 *
 * SMI-4401 Wave 2 — Copy matrix + name-validation helpers for /complete-profile.astro.
 * Extracted per spec §5.1 "If /complete-profile grows past 450, split copy blocks into
 * a companion complete-profile-copy.ts module."
 *
 * Keep this module free of Astro / DOM imports so it remains pure-TS and testable.
 */

/** Context parsed from the page URL (via the injected __COMPLETE_PROFILE_CONTEXT__ bridge). */
export interface CompleteProfileContext {
  /** `'cli'` when the CLI originated the redirect; empty string otherwise. */
  source: string
  /** Raw (untrusted) `next` query-param value; validate via validateNextParam before redirecting. */
  next: string
}

/** Base-copy constants that do NOT vary by context. */
export const COPY = {
  heading: 'Almost there — tell us who you are.',
  submitLabel: 'Activate free access',
  submittingLabel: 'Activating…',
  fineprint: 'You’ll get 1,000 free API calls per month. No card required.',
  legalPrefix: 'We use this for your CLI identity only.',
  legalLinkText: 'Privacy policy →',
  legalLinkHref: '/privacy',
  githubHelper: 'We grabbed this from your GitHub. Edit if wrong.',
  toastSuccess: 'Free tier activated',
  errorGeneric:
    'Something went wrong saving your profile. Retry in a moment, or <a href="/contact?topic=signup-help" class="profile-link">contact us</a>.',
  errorProfileLoad:
    'We could not load your profile. Refresh to try again, or <a href="/contact?topic=signup-help" class="profile-link">contact us</a>.',
  errorSupabaseInit:
    'We could not initialize authentication. Please refresh and try again, or <a href="/contact?topic=signup-help" class="profile-link">contact us</a>.',
  errorSessionLost:
    'Your session expired. Please <a href="/login" class="profile-link">sign in again</a>.',
  errorKeyIssuance:
    'We saved your profile but could not issue your CLI key. Retry in a moment, or <a href="/contact?topic=signup-help" class="profile-link">contact us</a>.',
  errorConcurrent:
    'Your key is still being issued. Refresh in a few seconds, or <a href="/contact?topic=signup-help" class="profile-link">contact us</a>.',
  errorProfileIncomplete:
    'We saw your profile as incomplete. Please check the fields above and resubmit.',
  errorUnexpected:
    'Something unexpected happened. Retry in a moment, or <a href="/contact?topic=signup-help" class="profile-link">contact us</a>.',
} as const

/**
 * Map a validated same-origin path to friendly prose for the "one more step" subhead.
 * Falls back to the bare pathname for unrecognized targets.
 */
export function humanizePath(path: string): string {
  // Strip query and fragment. `split()` always yields at least one element; `?? ''` keeps TS happy
  // under noUncheckedIndexedAccess.
  const beforeQuery = path.split('?')[0] ?? ''
  const cleaned = beforeQuery.split('#')[0] ?? ''
  switch (cleaned) {
    case '/account/cli-token':
      return 'your CLI token'
    case '/account':
      return 'your dashboard'
    case '/skills':
      return 'the skills catalog'
    case '/return-to-cli':
      return 'your terminal'
    default:
      return cleaned.replace(/^\//, '') || 'the next step'
  }
}

/**
 * Wave 1 SQL-parity name validator (spec §5.1 M2).
 * Returns a human-readable error message, or `null` if the name passes.
 *
 * Rules (exactly matching Wave 1 SQL gate `valid_name(x)`):
 *   - min 2 characters after trimming
 *   - max 64 characters after trimming
 *   - at least one letter `/[A-Za-z]/`
 *
 * DROP: "no sequential (aa, ab)" and "no repeat (xxx)" rules — do not client-reject names
 * Wave 1 SQL accepts.
 */
export function validateName(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length < 2) return 'Please enter at least 2 characters.'
  if (trimmed.length > 64) return 'Please keep this under 64 characters.'
  if (!/[A-Za-z]/.test(trimmed)) return 'Please include at least one letter.'
  return null
}

/**
 * Subhead copy resolution (precedence per spec §5.1 H6):
 *   1. source=cli wins over a bare next
 *   2. else bare next resolves via humanizePath
 *   3. else the no-params default
 *
 * Returns an object with either `.text` (plain) or `.html` (safe, curated markup).
 */
export interface SubheadCopy {
  /** Plain-text variant (source=cli). */
  text?: string
  /** Curated HTML variant (safe — produced from a small allowlist of known paths). */
  html?: string
}

export function resolveSubhead(ctx: CompleteProfileContext, validatedNext: string): SubheadCopy {
  if (ctx.source === 'cli') {
    return { text: 'Almost there — re-run your terminal command after this.' }
  }
  if (ctx.next && ctx.next.length > 0) {
    return {
      html: `One more step before we take you to <strong>${humanizePath(validatedNext)}</strong>.`,
    }
  }
  return {
    html: 'Takes 30 seconds. <a href="/privacy" class="profile-link">We use this for your CLI identity only.</a>',
  }
}
