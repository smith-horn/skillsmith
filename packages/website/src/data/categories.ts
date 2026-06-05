/**
 * Static metadata for the skills directory category pages.
 *
 * Each entry drives one route under `skills/[id].astro` when the slug
 * matches a known category (e.g. `/skills/development`). The data includes
 * the SEO copy (meta description, JSON-LD description) and the human-readable
 * heading used on the category landing page.
 *
 * Previously inlined as a 78-line `CATEGORIES` array at the top of
 * `skills/[id].astro`; extracted here so it can be imported by both the
 * page component and any sitemap or static-path generation that needs the
 * full category list.
 */

export interface CategoryMeta {
  slug: string
  label: string
  h1: string
  metaDescription: string
  description: string
  jsonLdDescription: string
}

export interface SkillItem {
  id: string
  name: string
  description: string
  trust_tier: string
}

export const CATEGORIES: CategoryMeta[] = [
  {
    slug: 'development',
    label: 'Development',
    h1: 'Development Agent Skills',
    metaDescription:
      'Browse 14,000+ development skills for MCP-compatible agents (Claude Code, Cursor, Copilot, Codex, Windsurf). Code generation, refactoring, PR reviews, and IDE integrations. Free to try.',
    description:
      'Skills for software development workflows — code generation, refactoring, PR reviews, and IDE integrations that make your coding agent a better partner.',
    jsonLdDescription:
      'Agent skills for software development workflows including code generation, refactoring, and PR reviews.',
  },
  {
    slug: 'integrations',
    label: 'Integrations',
    h1: 'Integration Skills — MCP Servers & APIs',
    metaDescription:
      'Connect your agent to your tools. Browse MCP server skills, API integrations, and protocol implementations. Free to try.',
    description:
      'MCP servers, API integrations, and protocol implementations that connect your agent (Claude Code, Cursor, Copilot, Codex, Windsurf, and others) to your existing tools and services.',
    jsonLdDescription:
      'Agent skills for MCP servers, API integrations, and protocol implementations.',
  },
  {
    slug: 'testing',
    label: 'Testing',
    h1: 'Testing Agent Skills',
    metaDescription:
      'Automate your tests with agent skills. Browse skills for Vitest, Jest, Playwright, and more testing frameworks. Free to try.',
    description:
      'Testing frameworks and utilities for unit, integration, and end-to-end test automation across all major testing tools.',
    jsonLdDescription:
      'Agent skills for automated testing including unit tests, integration tests, and end-to-end test automation.',
  },
  {
    slug: 'devops',
    label: 'DevOps',
    h1: 'DevOps Agent Skills',
    metaDescription:
      'Automate your DevOps pipelines. Browse skills for Docker, CI/CD, Kubernetes, and infrastructure tools. Free to try.',
    description:
      'CI/CD, Docker, Kubernetes, and infrastructure automation skills for DevOps workflows and deployment pipelines.',
    jsonLdDescription:
      'Agent skills for DevOps including CI/CD automation, Docker, Kubernetes, and infrastructure management.',
  },
  {
    slug: 'documentation',
    label: 'Documentation',
    h1: 'Documentation Agent Skills',
    metaDescription:
      'Generate docs automatically. Browse skills for changelogs, API docs, and README generation. Free to try.',
    description:
      'Documentation generation, changelog automation, and API doc skills that keep your docs current with your code.',
    jsonLdDescription:
      'Agent skills for documentation generation including changelogs, API docs, and README automation.',
  },
  {
    slug: 'productivity',
    label: 'Productivity',
    h1: 'Productivity Agent Skills',
    metaDescription:
      'Work smarter with agent skills. Browse skills for workflow automation, task management, and developer productivity. Free to try.',
    description:
      'Workflow automation, task management, and productivity skills for developers who want to move faster on every task.',
    jsonLdDescription:
      'Agent skills for developer productivity including workflow automation and task management.',
  },
  {
    slug: 'security',
    label: 'Security',
    h1: 'Security Agent Skills',
    metaDescription:
      'Harden your codebase. Browse agent skills for security scanning, vulnerability detection, and compliance. Free to try.',
    description:
      'Security scanning, vulnerability detection, and compliance skills that help you build secure by default.',
    jsonLdDescription:
      'Agent skills for security scanning, vulnerability detection, and compliance automation.',
  },
]
