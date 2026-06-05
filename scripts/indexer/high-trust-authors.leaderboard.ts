/**
 * High-Trust Authors — skills.sh top-275 leaderboard expansion.
 *
 * Verified leaderboard publishers seeded to close the skills.sh top-275 gap
 * (research log: docs/internal/research/skills-sh-leaderboard.md). Extracted
 * from high-trust-authors.ts (SMI-4843 Phase 5b) for the 500-line file limit;
 * re-assembled into `HIGH_TRUST_AUTHORS` by `./high-trust-authors.ts`.
 *
 * SMI-4843 + SMI-4846 (2026-05-10): A 32-entry seed expansion was attempted
 * to close the leaderboard gap. Three trigger attempts (32, 28, 10 entries)
 * all hit the Edge Function 150s timeout with 0 row writes — Phase 1 budget
 * too tight given per-entry Trees API + per-skill validation cost. Hard
 * rollback to the 16-entry baseline (`CORE_HIGH_TRUST_AUTHORS`).
 *
 * SMI-4843 Phase 5 (2026-05-11): After SMI-4852 / SMI-4858 fixes restored
 * indexer health, 18 verified leaderboard publishers were added. Licenses
 * checked 2026-05-11; per-entry `licenseChecked` comments inline below.
 *
 * SMI-4843 Phase 5b (2026-05-18): The indexer's migration to a GitHub Actions
 * runner (SMI-4852) plus tree-hash caching (SMI-4861) and the per-phase cron
 * split (SMI-4870) removed the original blockers; the remaining 12 indexable
 * leaderboard publishers were added. Licenses + skillsPaths verified
 * 2026-05-18 against the live GitHub Trees API; see
 * docs/internal/research/smi-4843-phase5b-candidates.md.
 */

import type { HighTrustAuthor } from './high-trust-authors.types.ts'

/**
 * skills.sh top-275 leaderboard publishers. Ordered: Phase 5 verified
 * (baseQualityScore 0.92) then Phase 5 curated (0.88 / 0.85), then garrytan
 * (SMI-4841), then Phase 5b verified (0.92) and curated (0.88).
 */
export const LEADERBOARD_HIGH_TRUST_AUTHORS: HighTrustAuthor[] = [
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
  // licenseChecked: 2026-05-11 (SMI-4860: SKILL.md at plugins/expo/skills/<name>/SKILL.md — 13 skills)
  {
    owner: 'expo',
    repo: 'skills',
    license: 'MIT',
    baseQualityScore: 0.92,
    trustTier: 'verified',
    skillsPaths: ['plugins/expo/skills'],
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
  // licenseChecked: 2026-05-11 (SMI-4860: SKILL.md at plugins/<plugin>/skills/<name>/SKILL.md — 153 skills across 80 plugins)
  {
    owner: 'wshobson',
    repo: 'agents',
    license: 'MIT',
    baseQualityScore: 0.88,
    trustTier: 'curated',
    skillsPaths: ['plugins/*/skills'],
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
  // SMI-4841 (licenseChecked: 2026-05-17): garrytan/gstack — zero GitHub topics; skillsPaths omitted so default ['', 'skills'] root-scan reaches the ~48 flat root-level skills.
  {
    owner: 'garrytan',
    repo: 'gstack',
    license: 'MIT',
    baseQualityScore: 0.88,
    trustTier: 'curated',
    description: "Garry Tan's gstack — Claude Code skills for planning, QA, review, and shipping",
  },
  // SMI-4843 Phase 5b (2026-05-18): 12 remaining indexable skills.sh top-275
  // leaderboard publishers. Ordered: trustTier=verified (baseQualityScore 0.92)
  // first, then trustTier=curated (0.88). All licenses + skillsPaths shapes
  // verified 2026-05-18 against the live GitHub Trees API; see
  // docs/internal/research/smi-4843-phase5b-candidates.md. Two leaderboard
  // candidates (vercel-labs/agent-browser, microsoft/playwright-cli) were
  // dropped as already-present Phase 5 entries.
  // licenseChecked: 2026-05-18
  // @see https://skills.sh/nextlevelbuilder/ui-ux-pro-max-skill
  {
    owner: 'nextlevelbuilder',
    repo: 'ui-ux-pro-max-skill',
    license: 'MIT',
    baseQualityScore: 0.92,
    trustTier: 'verified',
    skillsPaths: ['.claude/skills'],
    description:
      'UI/UX Pro Max — design skills for banners, branding, design systems, slides, and UI styling',
  },
  // licenseChecked: 2026-05-18
  // @see https://skills.sh/sleekdotdesign/agent-skills
  {
    owner: 'sleekdotdesign',
    repo: 'agent-skills',
    license: 'MIT',
    baseQualityScore: 0.92,
    trustTier: 'verified',
    skillsPaths: ['skills'],
    description: 'Sleek design agent skills — mobile app design for AI agents',
  },
  // licenseChecked: 2026-05-18
  // @see https://skills.sh/scrapegraphai/just-scrape
  {
    owner: 'scrapegraphai',
    repo: 'just-scrape',
    license: 'MIT',
    baseQualityScore: 0.92,
    trustTier: 'verified',
    skillsPaths: ['skills'],
    description: 'ScrapeGraphAI just-scrape — web scraping skill for AI agents',
  },
  // licenseChecked: 2026-05-18 (flat repo-root layout: <skill-name>/SKILL.md — skillsPaths omitted so default ['', 'skills'] root-scan reaches them)
  // @see https://skills.sh/squirrelscan/skills
  {
    owner: 'squirrelscan',
    repo: 'skills',
    license: 'MIT',
    baseQualityScore: 0.92,
    trustTier: 'verified',
    description: 'SquirrelScan agent skills — website auditing for AI agents',
  },
  // licenseChecked: 2026-05-18 (flat repo-root layout: <skill-name>/SKILL.md — skillsPaths omitted so default ['', 'skills'] root-scan reaches them)
  // @see https://skills.sh/agentspace-so/agent-skills
  {
    owner: 'agentspace-so',
    repo: 'agent-skills',
    license: 'MIT',
    baseQualityScore: 0.92,
    trustTier: 'verified',
    description: 'Agentspace agent skills — GPT image generation for AI agents',
  },
  // licenseChecked: 2026-05-18 (flat repo-root layout: <skill-name>/SKILL.md — skillsPaths omitted so default ['', 'skills'] root-scan reaches them)
  // @see https://skills.sh/agentspace-so/runcomfy-agent-skills
  {
    owner: 'agentspace-so',
    repo: 'runcomfy-agent-skills',
    license: 'MIT',
    baseQualityScore: 0.92,
    trustTier: 'verified',
    description:
      'Agentspace RunComfy agent skills — 30 skills for image, video, music, and avatar generation',
  },
  // licenseChecked: 2026-05-18 (flat repo-root layout: <skill-name>/SKILL.md — skillsPaths omitted so default ['', 'skills'] root-scan reaches them)
  // @see https://skills.sh/agentspace-so/skills
  {
    owner: 'agentspace-so',
    repo: 'skills',
    license: 'MIT',
    baseQualityScore: 0.92,
    trustTier: 'verified',
    description: 'Agentspace skills — agent workspace skills for AI agents',
  },
  // licenseChecked: 2026-05-18 (single root-level SKILL.md — flat layout; skillsPaths omitted so default ['', 'skills'] root-scan reaches it)
  // @see https://skills.sh/currents-dev/playwright-best-practices-skill
  {
    owner: 'currents-dev',
    repo: 'playwright-best-practices-skill',
    license: 'MIT',
    baseQualityScore: 0.92,
    trustTier: 'verified',
    description: 'Currents Playwright best-practices skill — E2E testing guidance for AI agents',
  },
  // licenseChecked: 2026-05-18 (curated; individual publisher; canonical skills/ root only — plugin and other-harness copies ignored)
  // @see https://skills.sh/juliusbrussee/caveman
  {
    owner: 'juliusbrussee',
    repo: 'caveman',
    license: 'MIT',
    baseQualityScore: 0.88,
    trustTier: 'curated',
    skillsPaths: ['skills'],
    description:
      'Caveman — Claude Code skills for commits, compression, review, and stats workflows',
  },
  // licenseChecked: 2026-05-18 (curated; individual publisher)
  // @see https://skills.sh/lllllllama/ai-paper-reproduction-skill
  {
    owner: 'lllllllama',
    repo: 'ai-paper-reproduction-skill',
    license: 'MIT',
    baseQualityScore: 0.88,
    trustTier: 'curated',
    skillsPaths: ['skills'],
    description:
      'AI paper reproduction skills — 11 skills for research exploration, code reproduction, and training runs',
  },
  // licenseChecked: 2026-05-18 (curated; individual publisher)
  // @see https://skills.sh/arvindrk/extract-design-system
  {
    owner: 'arvindrk',
    repo: 'extract-design-system',
    license: 'MIT',
    baseQualityScore: 0.88,
    trustTier: 'curated',
    skillsPaths: ['skills'],
    description: 'Extract design system — derive design tokens and components for AI agents',
  },
  // licenseChecked: 2026-05-18 (curated; individual publisher)
  // @see https://skills.sh/leonxlnx/taste-skill
  {
    owner: 'leonxlnx',
    repo: 'taste-skill',
    license: 'MIT',
    baseQualityScore: 0.88,
    trustTier: 'curated',
    skillsPaths: ['skills'],
    description:
      'Taste skill — 12 design and frontend-generation skills covering branding, redesign, and image-to-code',
  },
]
