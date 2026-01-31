/**
 * Lighthouse CI Configuration
 * @see https://github.com/GoogleChrome/lighthouse-ci/blob/main/docs/configuration.md
 */
module.exports = {
  ci: {
    collect: {
      // Number of runs per URL for stability (median is used)
      numberOfRuns: 3,
      // Use temporary directory for output
      settings: {
        output: 'html',
        outputPath: './lighthouse-results',
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
        // SEO budget: > 90
        'categories:seo': ['error', { minScore: 0.9 }],
      },
    },
    upload: {
      // Output to temporary directory (no external server)
      target: 'temporary-public-storage',
    },
  },
};
