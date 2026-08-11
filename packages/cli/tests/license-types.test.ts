/**
 * Regression test: TIER_FEATURES.enterprise (license-types.ts) has no
 * compiler backstop — it's `Record<LicenseTier, string[]>`, not
 * `Record<FeatureFlag, ...>` like the enterprise package's own
 * `FEATURE_TIERS` / `ENTERPRISE_FEATURES` — so a new enterprise FeatureFlag
 * added to the canonical @smith-horn/enterprise package can silently drift
 * out of sync here with no build error to catch it. This test cross-checks
 * TIER_FEATURES.enterprise against the canonical package at runtime.
 *
 * @see docs/internal/implementation/smi-5949-approval-gate.md Wave 2 Step 6
 *   item 6 / plan-review finding M6
 */

import { describe, it, expect } from 'vitest'
import { TIER_FEATURES } from '../src/utils/license-types.js'

describe('TIER_FEATURES.enterprise / @smith-horn/enterprise parity (SMI-5949 D-11)', () => {
  it('contains every feature flag the canonical enterprise package assigns to the enterprise tier', async () => {
    // Dynamic import with a variable, mirroring license-validation.ts's
    // tryLoadEnterpriseValidator() — @smith-horn/enterprise is an optional
    // peer dependency, so this must not become a compile-time dependency of
    // the CLI package.
    const packageName = '@smith-horn/enterprise'
    let enterpriseModule: Record<string, unknown>
    try {
      enterpriseModule = (await import(/* webpackIgnore: true */ packageName)) as Record<
        string,
        unknown
      >
    } catch (error) {
      // Within this monorepo's own test run, @smith-horn/enterprise is
      // always present as a workspace package. A failure to load it here
      // means a real environment problem (e.g. its dist was never built),
      // not an expected "optional dependency absent" skip — fail loudly
      // rather than silently passing without having checked anything.
      throw new Error(
        `Expected @smith-horn/enterprise to be resolvable in this monorepo's test run, ` +
          `but the dynamic import failed: ${String(error)}. Build it first: ` +
          `npm run build -w @smith-horn/enterprise`
      )
    }

    const enterpriseFeatures = enterpriseModule['ENTERPRISE_FEATURES'] as string[] | undefined
    expect(
      enterpriseFeatures,
      'ENTERPRISE_FEATURES export missing from @smith-horn/enterprise'
    ).toBeDefined()

    for (const feature of enterpriseFeatures ?? []) {
      expect(
        TIER_FEATURES.enterprise,
        `TIER_FEATURES.enterprise (packages/cli/src/utils/license-types.ts) is missing ` +
          `'${feature}', which the canonical @smith-horn/enterprise package assigns to the ` +
          `enterprise tier. This file has no compiler backstop (Record<LicenseTier, string[]>, ` +
          `not Record<FeatureFlag, ...>) — update it by hand.`
      ).toContain(feature)
    }

    const featureTiers = enterpriseModule['FEATURE_TIERS'] as
      | Record<string, readonly string[]>
      | undefined
    expect(featureTiers, 'FEATURE_TIERS export missing from @smith-horn/enterprise').toBeDefined()

    for (const [feature, tiers] of Object.entries(featureTiers ?? {})) {
      if (tiers.includes('enterprise')) {
        expect(
          TIER_FEATURES.enterprise,
          `TIER_FEATURES.enterprise is missing '${feature}', which FEATURE_TIERS in the ` +
            `canonical @smith-horn/enterprise package assigns to the enterprise tier.`
        ).toContain(feature)
      }
    }
  })

  it('includes the SMI-5949 registry_approval flag specifically', () => {
    expect(TIER_FEATURES.enterprise).toContain('registry_approval')
  })
})
