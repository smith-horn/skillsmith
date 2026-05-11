/**
 * High-Trust Authors Configuration (Node port)
 * @module scripts/indexer/high-trust-authors
 *
 * SMI-4852: Node-flavored sibling of
 * `supabase/functions/indexer/high-trust-authors.ts`. Body is byte-identical
 * — this file is pure data + types, no Deno-specific surface. Parity guarded
 * by the SMI-4852 cluster-A port; drift would surface in CI typecheck/grep.
 *
 * Original docblock (preserved for context):
 *
 * SMI-2102: Add verified skill sources from trusted publishers
 *
 * These repositories are explicitly indexed as "verified" trust tier.
 * Skills from these sources receive priority indexing and higher trust scores.
 *
 * License Compliance:
 * - All repositories listed here have been verified for compatible licensing
 * - Excluded skills are source-available (not open source) and cannot be indexed
 *
 * @see https://github.com/anthropics/skills - Mixed (Apache 2.0 + Source-Available)
 * @see https://github.com/huggingface/skills - Apache 2.0
 * @see https://github.com/vercel-labs/agent-skills - MIT
 * @see https://github.com/resend/email-best-practices - MIT
 * @see https://github.com/resend/react-email - MIT
 * @see https://github.com/resend/resend-skills - MIT
 * @see https://github.com/addyosmani/web-quality-skills - MIT
 * @see https://github.com/addyosmani/agent-skills - MIT
 * @see https://github.com/amplitude/mcp-marketplace - MIT
 * @see https://github.com/microsoft/skills - MIT (multi-plugin monorepo: .github/skills + .github/plugins/{plugin}/skills)
 * @see https://github.com/google-gemini/gemini-skills - Apache 2.0
 * @see https://github.com/google-gemini/gemini-cli - Apache 2.0 (cross-ecosystem)
 * @see https://github.com/SalesforceCommerceCloud/b2c-developer-tooling - Apache 2.0
 * @see https://github.com/mattpocock/skills - MIT (curated; individual publisher)
 * @see https://github.com/charlie947/social-media-skills - MIT (curated; individual publisher)
 *
 * SMI-4843 + SMI-4846 (2026-05-10): A 32-entry seed expansion was attempted
 * to close the skills.sh top-275 leaderboard gap (research log:
 * docs/internal/research/skills-sh-leaderboard.md). Three trigger attempts
 * (32, 28, 10 entries) all hit the Edge Function 150s timeout with 0 row
 * writes — Phase 1 budget too tight given per-entry Trees API + per-skill
 * validation cost. Hard-rolled back to the 16-entry baseline above. Re-add
 * deferred to SMI-4846 (parallel Phase 1 / content-hash skip optimization).
 *
 * SMI-4843 Phase 5 (2026-05-11): After SMI-4852 (NULL-name regression) and
 * SMI-4858 fixes restored indexer health, 18 verified leaderboard publishers
 * were added in a single batch. Licenses checked 2026-05-11 against the
 * skills.sh top-275 list (research log:
 * docs/internal/research/skills-sh-leaderboard.md). Verification log:
 * `/tmp/smi-4843-phase5-candidates.md`. All entries verified for permissive
 * license + SKILL.md presence. Per-entry `licenseChecked: 2026-05-11`
 * comments inline below. Kill switch (INDEXER_CONCURRENCY_KILL_SWITCH=1)
 * remains engaged for the first post-merge run; disengagement gated on
 * Phase 5 soak (SMI-4854/4855).
 */

export interface HighTrustAuthor {
  /** GitHub org/user name */
  owner: string
  /** Repository name */
  repo: string
  /** License identifier */
  license: 'Apache-2.0' | 'MIT' | 'Mixed'
  /** Base quality score (0-1) for skills from this author */
  baseQualityScore: number
  /**
   * SMI-2381: Trust tier override. Use 'curated' for third-party publishers.
   * Default: 'verified' — applied via `highTrustAuthor.trustTier || 'verified'`
   * in repositoryToSkill() when this field is omitted.
   */
  trustTier?: 'verified' | 'curated'
  /** Skills to explicitly exclude (source-available, not open source) */
  excludeSkills?: string[]
  /** If set, only index these specific skills */
  includeSkills?: string[]
  /** Custom path(s) to check for skills (default: ['', 'skills']) */
  skillsPaths?: string[]
  /** Override installable flag. Default: true. Set false for cross-ecosystem skills. */
  installable?: boolean
  /** Description for audit logs */
  description: string
}

/**
 * High-trust authors configuration
 *
 * These are official company repositories with verified licenses.
 * All skills from these authors are marked as "verified" trust tier.
 */
export const HIGH_TRUST_AUTHORS: HighTrustAuthor[] = [
  {
    owner: 'anthropics',
    repo: 'skills',
    license: 'Mixed',
    baseQualityScore: 0.95,
    excludeSkills: [
      // Source-available, NOT open source - cannot index per license
      'docx',
      'pdf',
      'pptx',
      'xlsx',
    ],
    description: 'Official Anthropic Claude skills (Apache 2.0 licensed only)',
  },
  {
    owner: 'huggingface',
    repo: 'skills',
    license: 'Apache-2.0',
    baseQualityScore: 0.93,
    description: 'Official Hugging Face ML/AI skills',
  },
  {
    owner: 'vercel-labs',
    repo: 'agent-skills',
    license: 'MIT',
    baseQualityScore: 0.94,
    description: 'Official Vercel development and deployment skills',
  },
  {
    owner: 'resend',
    repo: 'email-best-practices',
    license: 'MIT',
    baseQualityScore: 0.94,
    description: 'Resend email best practices - SPF/DKIM/DMARC, compliance, deliverability',
  },
  {
    owner: 'resend',
    repo: 'react-email',
    license: 'MIT',
    baseQualityScore: 0.94,
    description: 'React Email - build production-ready HTML emails with React components',
  },
  {
    owner: 'resend',
    repo: 'resend-skills',
    license: 'MIT',
    baseQualityScore: 0.94,
    description: 'Resend API skills - send emails, batch operations, webhooks',
  },
  {
    owner: 'addyosmani',
    repo: 'web-quality-skills',
    license: 'MIT',
    baseQualityScore: 0.94,
    description:
      'Addy Osmani web quality skills - Core Web Vitals, performance, accessibility, SEO',
  },
  {
    owner: 'addyosmani',
    repo: 'agent-skills',
    license: 'MIT',
    baseQualityScore: 0.94,
    excludeSkills: ['using-agent-skills'],
    description:
      'Addy Osmani agent-skills — production-grade engineering skills (TDD, spec-driven dev, debugging, shipping, security hardening) for AI coding agents',
  },
  {
    owner: 'amplitude',
    repo: 'mcp-marketplace',
    license: 'MIT',
    baseQualityScore: 0.93,
    skillsPaths: ['plugins/amplitude-analysis/skills'],
    description:
      'Amplitude MCP marketplace - product analytics skills for Claude, Cursor, and MCP clients',
  },
  // microsoft/skills — multi-plugin monorepo layout:
  //   .github/skills/{skill-name}/SKILL.md            (11 base-level skills: copilot-sdk, kql, etc.)
  //   .github/plugins/{plugin}/skills/{skill-name}/SKILL.md  (~130 plugin-nested Azure SDK skills)
  // SMI-4245: original config had '.github/skills' only, causing the indexer
  // to build 404 URLs (like .../tree/main/.github/skills/azure-ai-agents-persistent-dotnet)
  // for every plugin-nested skill because checkSkillMdExists happily validates the
  // SKILL.md at the plugin path while the URL template uses the base path.
  // Wildcard '.github/plugins/*/skills' is expanded at index time via the Trees API
  // (trees-search.ts). New plugins require no config changes.
  {
    owner: 'microsoft',
    repo: 'skills',
    license: 'MIT',
    baseQualityScore: 0.94,
    skillsPaths: ['.github/skills', '.github/plugins/*/skills'],
    description:
      'Microsoft Azure SDK skills — 140+ skills across Azure AI, ML, data, messaging, identity for Python, .NET, Java, TypeScript, Rust (multi-plugin monorepo layout)',
  },
  {
    owner: 'google-gemini',
    repo: 'gemini-skills',
    license: 'Apache-2.0',
    baseQualityScore: 0.94,
    description:
      'Google Gemini API skills - SDK usage, multimodal content, function calling, structured outputs',
  },
  // Google Gemini CLI built-in skills (SMI-2664: now installable)
  // These use SKILL.md format (compatible with Claude Code) and Apache-2.0 license.
  // Previously marked installable: false as a conservative placeholder pending
  // format compatibility confirmation. Phase 1 confirmed full SKILL.md parity.
  // @see https://github.com/google-gemini/gemini-cli/tree/main/.gemini/skills
  {
    owner: 'google-gemini',
    repo: 'gemini-cli',
    license: 'Apache-2.0',
    baseQualityScore: 0.93,
    skillsPaths: ['.gemini/skills'],
    installable: true,
    description: 'Google Gemini CLI built-in skills — code review, docs, changelogs, PR creation',
  },
  // awslabs/agent-plugins — multi-plugin monorepo layout:
  //   plugins/{plugin-name}/skills/{skill-name}/SKILL.md
  // Wildcard plugins/star/skills is expanded at index time via the GitHub
  // Trees API (trees-search.ts). New plugins require no config changes.
  {
    owner: 'awslabs',
    repo: 'agent-plugins',
    license: 'Apache-2.0',
    baseQualityScore: 0.93,
    skillsPaths: ['plugins/*/skills'],
    description:
      'AWS Labs agent plugins — multi-plugin monorepo with skills for AWS deployment and infrastructure',
  },
  // SalesforceCommerceCloud/b2c-developer-tooling — multi-collection layout:
  //   skills/{collection}/skills/{skill-name}/SKILL.md  (36 skills across b2c, b2c-cli, b2c-experimental)
  //   .claude/skills/{skill-name}/SKILL.md              (6 dev workflow skills)
  // Wildcard skills/star/skills resolves collection paths via Trees API.
  // .claude/skills is scanned via Contents API directory listing (B2 plain-path support).
  // See: https://github.com/SalesforceCommerceCloud/b2c-developer-tooling
  {
    owner: 'SalesforceCommerceCloud',
    repo: 'b2c-developer-tooling',
    license: 'Apache-2.0',
    baseQualityScore: 0.93,
    skillsPaths: ['.claude/skills', 'skills/*/skills'],
    description:
      'Salesforce B2C Commerce skills — 42 skills for storefront development, SCAPI, ISML, page designer, sandbox management, CLI tooling, and SDK development',
  },
  // SMI-4519: individual publishers — third-party authors curated via trustTier:'curated'
  // (per SMI-2381 convention). Both repos lack GitHub topics, so topic-discovery cannot
  // reach them; HIGH_TRUST_AUTHORS is the only entry path.
  // SMI-4524: mattpocock uses skills/<category>/<skill> 2-level layout — wildcard required.
  // The skills/deprecated/ category lists end-of-life skills and is excluded by name.
  {
    owner: 'mattpocock',
    repo: 'skills',
    license: 'MIT',
    baseQualityScore: 0.9,
    trustTier: 'curated',
    skillsPaths: ['skills/*'],
    excludeSkills: [
      'design-an-interface',
      'qa',
      'request-refactor-plan',
      'triage-issue',
      'ubiquitous-language',
    ],
    description:
      'Matt Pocock\'s Claude Code skills — TDD, refactoring, codebase architecture, scaffolding, and engineering workflows ("Skills for Real Engineers, straight from my .claude directory")',
  },
  {
    owner: 'charlie947',
    repo: 'social-media-skills',
    license: 'MIT',
    baseQualityScore: 0.85,
    trustTier: 'curated',
    skillsPaths: ['skills'],
    description:
      'Charlie 947 social-media skills — 17 skills for content marketing: post writing/scoring/formatting, hook generation, Gemini-powered carousels and infographics, YouTube thumbnails, profile optimization, and analytics',
  },
  // SMI-4843 Phase 5 (2026-05-11): 18 verified leaderboard publishers from
  // skills.sh top-275. Ordered: trustTier=verified (baseQualityScore 0.92)
  // first, then trustTier=curated (0.88), then curated (0.85). All licenses
  // checked 2026-05-11; see docs/internal/research/skills-sh-leaderboard.md.
  // licenseChecked: 2026-05-11
  {
    owner: 'firebase',
    repo: 'agent-skills',
    license: 'Apache-2.0',
    baseQualityScore: 0.92,
    trustTier: 'verified',
    skillsPaths: ['skills'],
    description: 'Agent Skills for Firebase',
  },
  // licenseChecked: 2026-05-11
  {
    owner: 'supabase',
    repo: 'agent-skills',
    license: 'MIT',
    baseQualityScore: 0.92,
    trustTier: 'verified',
    skillsPaths: ['skills'],
    description: 'Agent Skills to help developers using AI agents with Supabase',
  },
  // licenseChecked: 2026-05-11 (org is `shadcn-ui`, not `shadcn`)
  {
    owner: 'shadcn-ui',
    repo: 'ui',
    license: 'MIT',
    baseQualityScore: 0.92,
    trustTier: 'verified',
    skillsPaths: ['skills'],
    description: 'Beautifully-designed accessible components and code distribution platform',
  },
  // licenseChecked: 2026-05-11 (non-standard `plugins` layout)
  {
    owner: 'expo',
    repo: 'skills',
    license: 'MIT',
    baseQualityScore: 0.92,
    trustTier: 'verified',
    skillsPaths: ['plugins'],
    description: 'A collection of AI agent skills for Expo and Expo Application Services',
  },
  // licenseChecked: 2026-05-11 (candidate `sentry/dev` resolves to `getsentry/skills`)
  {
    owner: 'getsentry',
    repo: 'skills',
    license: 'Apache-2.0',
    baseQualityScore: 0.92,
    trustTier: 'verified',
    skillsPaths: ['skills'],
    description: 'Agent Skills used by the Sentry team for development',
  },
  // licenseChecked: 2026-05-11
  {
    owner: 'neondatabase',
    repo: 'agent-skills',
    license: 'Apache-2.0',
    baseQualityScore: 0.92,
    trustTier: 'verified',
    skillsPaths: ['skills'],
    description: 'Agent Skills for Neon Serverless Postgres',
  },
  // licenseChecked: 2026-05-11
  {
    owner: 'browser-use',
    repo: 'browser-use',
    license: 'MIT',
    baseQualityScore: 0.92,
    trustTier: 'verified',
    skillsPaths: ['skills'],
    description: 'Make websites accessible for AI agents — automate tasks online',
  },
  // licenseChecked: 2026-05-11
  {
    owner: 'microsoft',
    repo: 'azure-skills',
    license: 'MIT',
    baseQualityScore: 0.92,
    trustTier: 'verified',
    skillsPaths: ['skills'],
    description: 'Official agent plugin — skills and MCP server configs for Azure scenarios',
  },
  // licenseChecked: 2026-05-11
  {
    owner: 'larksuite',
    repo: 'cli',
    license: 'MIT',
    baseQualityScore: 0.92,
    trustTier: 'verified',
    skillsPaths: ['skills'],
    description: 'Official Lark/Feishu CLI — 200+ commands, 20+ AI Agent Skills',
  },
  // licenseChecked: 2026-05-11
  {
    owner: 'microsoft',
    repo: 'playwright-cli',
    license: 'Apache-2.0',
    baseQualityScore: 0.92,
    trustTier: 'verified',
    skillsPaths: ['skills'],
    description: 'CLI for Playwright actions — record, inspect selectors, screenshots',
  },
  // licenseChecked: 2026-05-11
  {
    owner: 'google-labs-code',
    repo: 'stitch-skills',
    license: 'Apache-2.0',
    baseQualityScore: 0.92,
    trustTier: 'verified',
    skillsPaths: ['skills'],
    description: 'Agent Skills for Stitch MCP server; open standard, multi-agent compatible',
  },
  // licenseChecked: 2026-05-11
  {
    owner: 'vercel-labs',
    repo: 'agent-browser',
    license: 'Apache-2.0',
    baseQualityScore: 0.92,
    trustTier: 'verified',
    skillsPaths: ['skills'],
    description: 'Browser automation CLI for AI agents',
  },
  // licenseChecked: 2026-05-11
  {
    owner: 'heygen-com',
    repo: 'hyperframes',
    license: 'Apache-2.0',
    baseQualityScore: 0.92,
    trustTier: 'verified',
    skillsPaths: ['skills'],
    description: 'Write HTML, render video — built for agents',
  },
  // licenseChecked: 2026-05-11 (individual publisher; curated tier)
  {
    owner: 'obra',
    repo: 'superpowers',
    license: 'MIT',
    baseQualityScore: 0.88,
    trustTier: 'curated',
    skillsPaths: ['skills'],
    description: 'An agentic skills framework & software development methodology',
  },
  // licenseChecked: 2026-05-11 (non-standard `plugins` layout; 80 skills)
  {
    owner: 'wshobson',
    repo: 'agents',
    license: 'MIT',
    baseQualityScore: 0.88,
    trustTier: 'curated',
    skillsPaths: ['plugins'],
    description: 'Intelligent automation and multi-agent orchestration for Claude Code',
  },
  // licenseChecked: 2026-05-11
  {
    owner: 'coreyhaines31',
    repo: 'marketingskills',
    license: 'MIT',
    baseQualityScore: 0.88,
    trustTier: 'curated',
    skillsPaths: ['skills'],
    description: 'Marketing skills for AI agents — CRO, copywriting, SEO, analytics, growth',
  },
  // licenseChecked: 2026-05-11 (non-standard `.claude/skills` layout)
  {
    owner: 'pbakaus',
    repo: 'impeccable',
    license: 'Apache-2.0',
    baseQualityScore: 0.88,
    trustTier: 'curated',
    skillsPaths: ['.claude/skills'],
    description: 'Design language that makes AI harnesses better at design',
  },
  // licenseChecked: 2026-05-11 (51 stars; install-count signal overrides star threshold)
  {
    owner: 'xixu-me',
    repo: 'skills',
    license: 'MIT',
    baseQualityScore: 0.85,
    trustTier: 'curated',
    skillsPaths: ['skills'],
    description: 'Agent Skills for practical engineering work',
  },
]

/**
 * Check if a skill should be excluded from indexing
 * SMI-2413: Case-insensitive comparison for excludeSkills and includeSkills
 */
export function shouldExcludeSkill(author: HighTrustAuthor, skillName: string): boolean {
  const normalizedName = skillName.toLowerCase()

  // Check explicit exclusions (case-insensitive)
  if (author.excludeSkills?.some((e) => e.toLowerCase() === normalizedName)) {
    return true
  }

  // If includeSkills is set, exclude anything not in the list (case-insensitive)
  if (
    author.includeSkills &&
    !author.includeSkills.some((i) => i.toLowerCase() === normalizedName)
  ) {
    return true
  }

  return false
}

/**
 * Get the high-trust author config for a repository
 */
export function getHighTrustAuthor(owner: string, repo: string): HighTrustAuthor | undefined {
  return HIGH_TRUST_AUTHORS.find(
    (a) =>
      a.owner.toLowerCase() === owner.toLowerCase() && a.repo.toLowerCase() === repo.toLowerCase()
  )
}

/**
 * Check if a repository is from a high-trust author
 */
export function isHighTrustRepository(owner: string, repo: string): boolean {
  return getHighTrustAuthor(owner, repo) !== undefined
}
