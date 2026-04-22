/**
 * validate-next-redirect.test.ts
 *
 * SMI-4401 Wave 2 — unit coverage for the OWASP `next=` redirect validator
 * defined in `validate-next-redirect.ts`. Spec §4.4 A-NEXT-1/2/3 + §5.1 H6
 * precedence cross-product.
 *
 * Acceptance requirements driving this suite:
 *   - 20+ assertions covering every OWASP rejection class (a-e)
 *   - `/device?user_code=...` passthrough preserved ONLY on `/device` (H2)
 *   - Source-aware defaults: `source='cli'` → `/return-to-cli`,
 *     else → `/account/cli-token` (A-NEXT-2)
 *   - Precedence cross-product (H6 post-Option-A): 3 branches
 *
 * These tests encode the public contract of `validateNextParam`; they should
 * stay green across refactors of the internal helpers. Worker 1 builds the
 * helper in parallel — until that implementation lands and is wired up with
 * the expected defaults, a subset of these assertions will fail. That is
 * intentional: the spec contract is the source of truth.
 */

import { describe, expect, it } from 'vitest'
import { validateNextParam } from './validate-next-redirect'

// Defaults per spec §4.4 A-NEXT-2. Centralized so a default-move shows up as
// a single assertion edit instead of 20 scattered string updates.
const CLI_DEFAULT = '/return-to-cli'
const NON_CLI_DEFAULT = '/account/cli-token'

describe('validateNextParam — happy paths (same-origin absolute paths)', () => {
  it('accepts a bare absolute path', () => {
    expect(validateNextParam('/foo', null)).toBe('/foo')
  })

  it('accepts a nested absolute path', () => {
    expect(validateNextParam('/account/cli-token', null)).toBe('/account/cli-token')
  })

  it('strips unknown query params on non-/device paths (H2 default)', () => {
    // Any query string on a non-/device path is stripped to eliminate
    // open-redirect-via-encoded-path-traversal.
    expect(validateNextParam('/foo?x=1', null)).toBe('/foo')
  })

  it('strips a hash fragment on non-/device paths', () => {
    expect(validateNextParam('/foo#bar', null)).toBe('/foo')
  })

  it('accepts a single "/" as a safe path', () => {
    expect(validateNextParam('/', null)).toBe('/')
  })
})

describe('validateNextParam — OWASP rejection class (a) absolute cross-origin', () => {
  it('rejects https://evil.com/x → default', () => {
    expect(validateNextParam('https://evil.com/x', null)).toBe(NON_CLI_DEFAULT)
  })

  it('rejects http://evil.com/x → default', () => {
    expect(validateNextParam('http://evil.com/x', null)).toBe(NON_CLI_DEFAULT)
  })

  it('rejects a uppercase-scheme variant HTTPS://evil.com → default (case-insensitive scheme check)', () => {
    expect(validateNextParam('HTTPS://evil.com/x', null)).toBe(NON_CLI_DEFAULT)
  })
})

describe('validateNextParam — OWASP rejection class (b) protocol-relative', () => {
  it('rejects //evil.com/x → default', () => {
    expect(validateNextParam('//evil.com/x', null)).toBe(NON_CLI_DEFAULT)
  })

  it('rejects ///evil.com/x (triple-slash variant) → default', () => {
    // Browsers normalize triple-slash to protocol-relative-like behavior;
    // the URL constructor rebases, but defense-in-depth rejects the prefix.
    expect(validateNextParam('///evil.com/x', null)).toBe(NON_CLI_DEFAULT)
  })
})

describe('validateNextParam — OWASP rejection class (c) dangerous schemes', () => {
  it('rejects javascript:alert(1) → default', () => {
    expect(validateNextParam('javascript:alert(1)', null)).toBe(NON_CLI_DEFAULT)
  })

  it('rejects data:text/html,<script>... → default', () => {
    expect(validateNextParam('data:text/html,<script>alert(1)</script>', null)).toBe(
      NON_CLI_DEFAULT,
    )
  })

  it('rejects vbscript:msgbox(1) → default', () => {
    expect(validateNextParam('vbscript:msgbox(1)', null)).toBe(NON_CLI_DEFAULT)
  })

  it('rejects file:///etc/passwd → default', () => {
    expect(validateNextParam('file:///etc/passwd', null)).toBe(NON_CLI_DEFAULT)
  })
})

describe('validateNextParam — OWASP rejection class (d) encoded variants', () => {
  it('rejects %2F%2Fevil.com (encoded protocol-relative) → default', () => {
    expect(validateNextParam('%2F%2Fevil.com/x', null)).toBe(NON_CLI_DEFAULT)
  })

  it('rejects javascript%3Aalert(1) (encoded scheme) → default', () => {
    // After single decode this becomes `javascript:alert(1)`, which the
    // post-decode scheme check rejects.
    expect(validateNextParam('javascript%3Aalert(1)', null)).toBe(NON_CLI_DEFAULT)
  })

  it('rejects malformed percent-encoding → default', () => {
    // Triggers decodeURIComponent to throw; the helper must fall back safely
    // instead of letting the exception propagate.
    expect(validateNextParam('%E0%A4%A', null)).toBe(NON_CLI_DEFAULT)
  })
})

describe('validateNextParam — OWASP rejection class (e) self-reference (POST-submit scope, M5)', () => {
  it('rejects /complete-profile → default', () => {
    expect(validateNextParam('/complete-profile', null)).toBe(NON_CLI_DEFAULT)
  })

  it('rejects /login → default', () => {
    expect(validateNextParam('/login', null)).toBe(NON_CLI_DEFAULT)
  })

  it('rejects /signin (legacy alias) → default', () => {
    expect(validateNextParam('/signin', null)).toBe(NON_CLI_DEFAULT)
  })

  it('rejects /auth/callback → default', () => {
    expect(validateNextParam('/auth/callback', null)).toBe(NON_CLI_DEFAULT)
  })

  it('rejects any /auth/* subtree → default', () => {
    expect(validateNextParam('/auth/otp', null)).toBe(NON_CLI_DEFAULT)
  })
})

describe('validateNextParam — empty / missing input', () => {
  it('treats empty string as missing → default', () => {
    expect(validateNextParam('', null)).toBe(NON_CLI_DEFAULT)
  })

  it('treats null as missing → default', () => {
    expect(validateNextParam(null, null)).toBe(NON_CLI_DEFAULT)
  })

  it('treats undefined as missing → default', () => {
    expect(validateNextParam(undefined, null)).toBe(NON_CLI_DEFAULT)
  })

  it('treats whitespace-only as missing → default', () => {
    expect(validateNextParam('    ', null)).toBe(NON_CLI_DEFAULT)
  })

  it('rejects a non-absolute path ("foo") lacking a leading slash → default', () => {
    expect(validateNextParam('foo', null)).toBe(NON_CLI_DEFAULT)
  })
})

describe('validateNextParam — /device user_code passthrough (H2)', () => {
  it('preserves user_code on /device?user_code=BCDF-GHJK', () => {
    expect(validateNextParam('/device?user_code=BCDF-GHJK', 'cli')).toBe(
      '/device?user_code=BCDF-GHJK',
    )
  })

  it('preserves user_code without source hint too (validator is source-agnostic for /device)', () => {
    expect(validateNextParam('/device?user_code=BCDF-GHJK', null)).toBe(
      '/device?user_code=BCDF-GHJK',
    )
  })

  it('returns bare /device when user_code is missing', () => {
    expect(validateNextParam('/device', null)).toBe('/device')
  })

  it('drops other unknown params on /device but keeps user_code', () => {
    // Ampersand injection attempts: anything other than user_code is stripped.
    // The rebuilt URL must contain only the expected query.
    const out = validateNextParam('/device?user_code=BCDF-GHJK&foo=bar', null)
    expect(out).toBe('/device?user_code=BCDF-GHJK')
  })

  it('does NOT preserve user_code on non-/device paths', () => {
    // /foo is not a special-case path; all query params must be stripped.
    expect(validateNextParam('/foo?user_code=BCDF-GHJK', null)).toBe('/foo')
  })
})

describe('validateNextParam — source-aware defaults (A-NEXT-2)', () => {
  it('source=cli + rejected next → /return-to-cli', () => {
    expect(validateNextParam('https://evil.com/x', 'cli')).toBe(CLI_DEFAULT)
  })

  it('source=cli + null next → /return-to-cli', () => {
    expect(validateNextParam(null, 'cli')).toBe(CLI_DEFAULT)
  })

  it('source="" + rejected next → /account/cli-token', () => {
    expect(validateNextParam('javascript:alert(1)', '')).toBe(NON_CLI_DEFAULT)
  })

  it('source=null + rejected next → /account/cli-token', () => {
    expect(validateNextParam('//evil.com', null)).toBe(NON_CLI_DEFAULT)
  })

  it('source=undefined + rejected next → /account/cli-token', () => {
    expect(validateNextParam('//evil.com', undefined)).toBe(NON_CLI_DEFAULT)
  })

  it('source="web" (unknown hint) + rejected next → /account/cli-token', () => {
    // Any source value other than the literal 'cli' uses the non-CLI default.
    expect(validateNextParam('//evil.com', 'web')).toBe(NON_CLI_DEFAULT)
  })
})

describe('validateNextParam — precedence cross-product (H6 post-Option-A)', () => {
  /*
   * Three explicit branches per spec §5.1:
   *   1. source=cli wins over a bare next= (CLI originates redirect URL)
   *   2. next= wins over no-params default when source != 'cli'
   *   3. No params → no-params default
   */

  it('branch 1: source=cli AND next=/x → cli default (cli wins over bare next)', () => {
    // Even with a valid /x, cli source forces the CLI default because the
    // CLI originates the redirect URL itself. Validated next is discarded.
    expect(validateNextParam('/x', 'cli')).toBe(CLI_DEFAULT)
  })

  it('branch 1: source=cli AND next=/account/settings → cli default', () => {
    // Second assertion for branch 1 using a longer path — guards against
    // accidentally tuning the behavior to the fixture /x string above.
    expect(validateNextParam('/account/settings', 'cli')).toBe(CLI_DEFAULT)
  })

  it('branch 2: no source AND next=/x → /x (validated next wins)', () => {
    expect(validateNextParam('/x', null)).toBe('/x')
  })

  it('branch 2: source="" AND next=/x → /x (empty source is not "cli")', () => {
    expect(validateNextParam('/x', '')).toBe('/x')
  })

  it('branch 3: no source AND no next → /account/cli-token', () => {
    expect(validateNextParam(null, null)).toBe(NON_CLI_DEFAULT)
  })

  it('branch 3: no source AND empty next → /account/cli-token', () => {
    expect(validateNextParam('', null)).toBe(NON_CLI_DEFAULT)
  })
})

describe('validateNextParam — belt-and-suspenders misc', () => {
  it('rejects an overly long input (>2048 chars) → default', () => {
    const huge = '/' + 'a'.repeat(2100)
    expect(validateNextParam(huge, null)).toBe(NON_CLI_DEFAULT)
  })

  it('accepts a maximum-length input at the 2048-char boundary', () => {
    const atBoundary = '/' + 'a'.repeat(2047)
    expect(validateNextParam(atBoundary, null)).toBe(atBoundary)
  })

  it('never returns a value that does not start with "/"', () => {
    // Regression guard: the output contract is "always absolute same-origin".
    const outputs = [
      validateNextParam('/foo', null),
      validateNextParam('https://evil.com', null),
      validateNextParam(null, 'cli'),
      validateNextParam('/device?user_code=BCDF-GHJK', null),
      validateNextParam('', ''),
    ]
    for (const out of outputs) {
      expect(out.startsWith('/')).toBe(true)
    }
  })
})
