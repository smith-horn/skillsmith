/**
 * Lighthouse CI Configuration
 * @see https://github.com/GoogleChrome/lighthouse-ci/blob/main/docs/configuration.md
 */
module.exports = {
  ci: {
    collect: {
      // Number of runs per URL for stability (median is used)
      numberOfRuns: 3,
      // Settings for Chrome/Lighthouse
      settings: {
        // Use mobile preset for realistic performance testing
        preset: 'desktop',
        // Bypass Vercel Deployment Protection for staging URLs (SMI-3740)
        extraHeaders: process.env.LHCI_BYPASS_SECRET
          ? { 'x-vercel-protection-bypass': process.env.LHCI_BYPASS_SECRET }
          : {},
      },
    },
    assert: {
      assertions: {
        // Performance budget: > 90
        'categories:performance': ['error', { minScore: 0.9 }],
        // Accessibility budget: > 95
        'categories:accessibility': ['error', { minScore: 0.95 }],
        // Best practices budget: > 90
        'categories:best-practices': ['error', { minScore: 0.9 }],
        // SEO: individual audit assertions instead of aggregate score (SMI-3747)
        // Vercel staging deployments add x-robots-tag: noindex and block /robots.txt
        // with 401, which breaks is-crawlable and robots-txt audits. These are
        // expected staging behaviors, not production bugs. We assert on remaining
        // SEO audits individually to maintain coverage.
        'meta-description': 'warn',
        'http-status-code': 'warn',
        'link-text': 'warn',
        'crawlable-anchors': 'warn',
        // Skipped on staging — Vercel platform behaviors:
        // 'is-crawlable': Vercel sends x-robots-tag: noindex on preview deploys
        // 'robots-txt': Vercel returns 401 for /robots.txt behind Deployment Protection
        hreflang: 'warn',
        canonical: 'warn',
        plugins: 'warn',
        'tap-targets': 'warn',
      },
    },
    upload: {
      // Output to temporary directory (no external server)
      target: 'temporary-public-storage',
    },
  },
}
