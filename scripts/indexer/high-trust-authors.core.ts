/**
 * High-Trust Authors — founding verified-org + curated set.
 *
 * SMI-2102: verified skill sources from trusted publishers. These repositories
 * are explicitly indexed as "verified" trust tier (curated for third-party
 * individual publishers per SMI-2381). Skills from these sources receive
 * priority indexing and higher trust scores.
 *
 * Extracted from high-trust-authors.ts (SMI-4843 Phase 5b) for the 500-line
 * file limit. The skills.sh top-275 leaderboard expansion lives in
 * `./high-trust-authors.leaderboard.ts`; both are re-assembled into
 * `HIGH_TRUST_AUTHORS` by `./high-trust-authors.ts`.
 *
 * License Compliance:
 * - All repositories listed here have been verified for compatible licensing.
 * - Excluded skills are source-available (not open source) and cannot be indexed.
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
 * @see https://github.com/openai/codex - Apache 2.0 (cross-ecosystem; SMI-4962)
 * @see https://github.com/bytedance/deer-flow - MIT (cross-ecosystem; SMI-4962)
 */

import type { HighTrustAuthor } from './high-trust-authors.types.ts'

/**
 * Founding high-trust authors — official company repositories with verified
 * licenses, plus the first curated individual publishers (SMI-2381).
 */
export const CORE_HIGH_TRUST_AUTHORS: HighTrustAuthor[] = [
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
  // SMI-4962: round-N cross-ecosystem additions from the SMI-4961 skillsmp.com
  // cross-reference — high-star verified-org repos the indexer's topic rotation
  // never reached (topic-less or topic-mismatched). HIGH_TRUST_AUTHORS is the
  // only entry path. License + skillsPaths probed against the live GitHub Trees
  // API on 2026-05-19 (licenseChecked: 2026-05-19). NousResearch/hermes-agent
  // (171 skills) is staged separately — see SMI-4962 for the Phase-1 budget
  // rationale.
  {
    owner: 'openai',
    repo: 'codex',
    license: 'Apache-2.0',
    baseQualityScore: 0.94,
    skillsPaths: ['.codex/skills'],
    description:
      'OpenAI Codex CLI skills — 12 skills under .codex/skills for PR review, code workflows, and agent tooling',
  },
  // bytedance/deer-flow — public skills live under skills/public; the single
  // .agent/skills/smoke-test entry is an internal CI harness artifact and is
  // excluded by scoping skillsPaths to skills/public only.
  {
    owner: 'bytedance',
    repo: 'deer-flow',
    license: 'MIT',
    baseQualityScore: 0.93,
    skillsPaths: ['skills/public'],
    description:
      'ByteDance DeerFlow skills — 21 public skills for deep-research workflows: planning, search, academic paper review, and report generation',
  },
]
