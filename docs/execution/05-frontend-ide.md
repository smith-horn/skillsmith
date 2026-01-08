# Frontend & IDE Implementation Plan

**Project:** Skillsmith
**Domain:** Frontend & IDE Integration
**Owner:** Frontend Specialist
**Date:** December 26, 2025
**Status:** Planned

---

## Executive Summary

This document provides the comprehensive implementation plan for the web application (skillsmith.app) and IDE integrations (VS Code extension, terminal UI) for Phases 0-2.

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Web Framework | Astro 4.x | Static-first, partial hydration, SEO |
| Search | Client-side sql.js | Offline capable, no backend |
| Styling | Tailwind CSS | Utility-first, consistent |
| VS Code Extension | TypeScript + Webview | Native VS Code APIs |
| Terminal UI | Claude Code native | No separate UI needed |

### Deployment Phases

| Phase | Web Hosting | Features |
|-------|-------------|----------|
| Phase 1 | GitHub Pages | Static skill browser, search |
| Phase 2+ | Vercel | Analytics, edge functions |

---

## Phase 0: Foundation Sprint (Weeks 1-8)

### Epic FE-001: Terminal Integration

**Description:** Claude Code is the terminal UI - no additional terminal interface needed. Focus on MCP tool discoverability and output formatting.

**Business Value:** Zero-friction discovery within existing Claude Code workflow.

**Dependencies:** MCP-001 (discovery-core)

**Definition of Done:**
- [ ] MCP tools visible to Claude Code
- [ ] Tool responses formatted clearly
- [ ] Progress indicators for long operations
- [ ] Error messages actionable

---

#### Story FE-001-01: MCP Tool Discoverability

**As a** Claude Code user
**I want** to discover available skill tools
**So that** I know what operations I can perform

**Acceptance Criteria:**
- [ ] Tools listed in Claude Code's tool discovery
- [ ] Tool descriptions clear and concise
- [ ] Examples provided in descriptions
- [ ] Parameters documented

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| FE-001-01-T1 | Write tool descriptions | 3h | P0 |
| FE-001-01-T2 | Add usage examples to descriptions | 2h | P0 |
| FE-001-01-T3 | Document all parameters | 2h | P0 |
| FE-001-01-T4 | Create tool usage guide | 3h | P1 |

**Code Pattern - Tool Description:**

```typescript
// src/mcp/discovery-core/tools/search.ts
export const searchTool: Tool = {
  name: 'search',
  description: `Search for Claude Code skills by keyword or description.

Examples:
- "react testing" - Find React testing skills
- "documentation generator" - Find doc generation skills
- "python linting" - Find Python linting skills

Filters available: categories, trust_tier, min_score
Returns: Ranked list of matching skills with quality scores`,

  inputSchema: {
    // ... schema
  },
};
```

---

#### Story FE-001-02: Response Formatting

**As a** user
**I want** clear, formatted tool responses
**So that** I can quickly understand results

**Acceptance Criteria:**
- [ ] Search results show skill name, description, score
- [ ] Trust tiers displayed with badges
- [ ] Quality scores shown as percentages
- [ ] Long lists truncated with "show more"

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| FE-001-02-T1 | Create SkillSummary formatter | 3h | P0 |
| FE-001-02-T2 | Add trust tier badge formatter | 2h | P0 |
| FE-001-02-T3 | Format quality score breakdown | 2h | P0 |
| FE-001-02-T4 | Add list truncation | 1h | P1 |

---

## Phase 1: Foundation + Safety (Weeks 9-12)

### Epic FE-002: Static Skill Browser Website

**Description:** Build the skillsmith.app static website for SEO-friendly skill browsing.

**Business Value:** Public discoverability for skills outside Claude Code.

**Dependencies:** PROD-101 (50K Index), INFRA-004

**Definition of Done:**
- [ ] Astro static site deployed
- [ ] All 50K+ skill pages generated
- [ ] Client-side search works
- [ ] Lighthouse score > 90
- [ ] Mobile responsive

---

#### Story FE-002-01: Astro Project Setup

**As a** developer
**I want** a well-structured Astro project
**So that** the website is maintainable

**Acceptance Criteria:**
- [ ] Astro 4.x project initialized
- [ ] Tailwind CSS configured
- [ ] Component library created
- [ ] Build pipeline working

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| FE-002-01-T1 | Initialize Astro project | 2h | P0 |
| FE-002-01-T2 | Configure Tailwind CSS | 2h | P0 |
| FE-002-01-T3 | Set up component structure | 3h | P0 |
| FE-002-01-T4 | Configure static generation | 2h | P0 |
| FE-002-01-T5 | Add TypeScript support | 1h | P0 |

**Code Pattern - Astro Configuration:**

```typescript
// astro.config.mjs
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://skillsmith.app',
  integrations: [
    tailwind(),
    sitemap(),
  ],
  output: 'static',
  build: {
    format: 'file', // Clean URLs
  },
});
```

---

#### Story FE-002-02: Skill Page Template

**As a** visitor
**I want** detailed skill pages
**So that** I can evaluate skills before using

**Acceptance Criteria:**
- [ ] Skill name, description, author displayed
- [ ] Quality score with breakdown
- [ ] Trust tier with explanation
- [ ] Install command shown
- [ ] Similar skills listed

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| FE-002-02-T1 | Create SkillPage layout | 4h | P0 |
| FE-002-02-T2 | Add QualityScore component | 3h | P0 |
| FE-002-02-T3 | Add TrustBadge component | 2h | P0 |
| FE-002-02-T4 | Add InstallCommand component | 2h | P0 |
| FE-002-02-T5 | Add SimilarSkills component | 3h | P1 |
| FE-002-02-T6 | Generate static pages for all skills | 4h | P0 |

**Code Pattern - Skill Page:**

```astro
---
// src/pages/skill/[id].astro
import { getSkill, getSimilarSkills } from '../../data/skills';
import Layout from '../../layouts/Layout.astro';
import QualityScore from '../../components/QualityScore.astro';
import TrustBadge from '../../components/TrustBadge.astro';
import InstallCommand from '../../components/InstallCommand.astro';

export async function getStaticPaths() {
  const skills = await getAllSkills();
  return skills.map(skill => ({
    params: { id: skill.id },
    props: { skill },
  }));
}

const { skill } = Astro.props;
const similarSkills = await getSimilarSkills(skill.id);
---

<Layout title={skill.name} description={skill.description}>
  <main class="max-w-4xl mx-auto px-4 py-8">
    <header class="mb-8">
      <div class="flex items-center gap-4">
        <h1 class="text-3xl font-bold">{skill.name}</h1>
        <TrustBadge tier={skill.trust_tier} />
      </div>
      <p class="text-gray-600 mt-2">{skill.description}</p>
    </header>

    <section class="mb-8">
      <h2 class="text-xl font-semibold mb-4">Quality Score</h2>
      <QualityScore
        overall={skill.final_score}
        quality={skill.quality_score}
        popularity={skill.popularity_score}
        maintenance={skill.maintenance_score}
      />
    </section>

    <section class="mb-8">
      <h2 class="text-xl font-semibold mb-4">Install</h2>
      <InstallCommand skillId={skill.id} />
    </section>

    <section>
      <h2 class="text-xl font-semibold mb-4">Similar Skills</h2>
      <!-- Similar skills list -->
    </section>
  </main>
</Layout>
```

---

#### Story FE-002-03: Client-Side Search

**As a** visitor
**I want** to search skills on the website
**So that** I can find what I need

**Acceptance Criteria:**
- [ ] Search box on homepage
- [ ] Results update as you type
- [ ] Filters by category, trust tier
- [ ] Works offline (sql.js)

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| FE-002-03-T1 | Set up sql.js with WASM | 4h | P0 |
| FE-002-03-T2 | Create SearchBox component | 3h | P0 |
| FE-002-03-T3 | Implement search results list | 3h | P0 |
| FE-002-03-T4 | Add filter controls | 3h | P0 |
| FE-002-03-T5 | Add debounced search | 2h | P1 |
| FE-002-03-T6 | Pre-load search index | 2h | P1 |

**Code Pattern - Client-Side Search:**

```typescript
// src/lib/search.ts
import initSqlJs, { Database } from 'sql.js';

let db: Database | null = null;

export async function initSearch(): Promise<void> {
  const SQL = await initSqlJs({
    locateFile: file => `/sql.js/${file}`
  });

  const response = await fetch('/data/skills-search.db');
  const buffer = await response.arrayBuffer();
  db = new SQL.Database(new Uint8Array(buffer));
}

export async function search(query: string, filters: SearchFilters): Promise<SkillSummary[]> {
  if (!db) await initSearch();

  let sql = `
    SELECT id, name, description, final_score, trust_tier
    FROM skills_fts
    WHERE skills_fts MATCH ?
  `;

  const params: any[] = [query];

  if (filters.trustTier?.length) {
    sql += ` AND trust_tier IN (${filters.trustTier.map(() => '?').join(',')})`;
    params.push(...filters.trustTier);
  }

  if (filters.minScore) {
    sql += ` AND final_score >= ?`;
    params.push(filters.minScore);
  }

  sql += ` ORDER BY rank LIMIT 20`;

  const results = db!.exec(sql, params);
  return results[0]?.values.map(row => ({
    id: row[0] as string,
    name: row[1] as string,
    description: row[2] as string,
    final_score: row[3] as number,
    trust_tier: row[4] as string,
  })) ?? [];
}
```

---

#### Story FE-002-04: SEO Optimization

**As a** skill author
**I want** my skill discoverable via search engines
**So that** more users can find it

**Acceptance Criteria:**
- [ ] All pages have unique title/description
- [ ] JSON-LD structured data
- [ ] Sitemap generated
- [ ] OG tags for social sharing

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| FE-002-04-T1 | Add meta tag component | 2h | P0 |
| FE-002-04-T2 | Implement JSON-LD for skills | 3h | P0 |
| FE-002-04-T3 | Configure sitemap generation | 2h | P0 |
| FE-002-04-T4 | Add OG image generation | 4h | P1 |
| FE-002-04-T5 | Submit to search engines | 1h | P1 |

**Code Pattern - JSON-LD:**

```astro
---
// src/components/SkillJsonLd.astro
const { skill } = Astro.props;
---

<script type="application/ld+json" set:html={JSON.stringify({
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": skill.name,
  "description": skill.description,
  "applicationCategory": "DeveloperTool",
  "operatingSystem": "Any",
  "author": {
    "@type": "Person",
    "name": skill.author_name,
    "url": skill.author_url,
  },
  "aggregateRating": {
    "@type": "AggregateRating",
    "ratingValue": skill.final_score * 5,
    "bestRating": 5,
    "worstRating": 0,
  },
  "offers": {
    "@type": "Offer",
    "price": "0",
    "priceCurrency": "USD",
  },
})} />
```

---

## Phase 2: Recommendations + Entry Points (Weeks 13-16)

### Epic FE-003: VS Code Extension

**Description:** Build VS Code extension for in-IDE skill discovery and recommendations.

**Business Value:** Reach VS Code users where they work.

**Dependencies:** PROD-201 (Codebase Scanner), FE-002

**Definition of Done:**
- [ ] Extension published to marketplace
- [ ] Sidebar shows recommendations
- [ ] Install command works
- [ ] Context-aware suggestions

---

#### Story FE-003-01: Extension Setup

**As a** VS Code user
**I want** to install from marketplace
**So that** setup is easy

**Acceptance Criteria:**
- [ ] Extension activates on workspace open
- [ ] Connects to MCP server
- [ ] Sidebar panel added
- [ ] Commands registered

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| FE-003-01-T1 | Initialize extension project | 3h | P0 |
| FE-003-01-T2 | Create sidebar webview | 4h | P0 |
| FE-003-01-T3 | Implement MCP client | 5h | P0 |
| FE-003-01-T4 | Register commands | 2h | P0 |
| FE-003-01-T5 | Add activation events | 2h | P0 |

**Code Pattern - Extension Activation:**

```typescript
// src/extension.ts
import * as vscode from 'vscode';
import { DiscoveryClient } from './client';
import { RecommendationsPanel } from './panels/recommendations';

let client: DiscoveryClient;

export async function activate(context: vscode.ExtensionContext) {
  // Connect to MCP server
  client = new DiscoveryClient();
  await client.connect();

  // Register sidebar
  const provider = new RecommendationsPanel(client);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('skillsmith.recommendations', provider)
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('skillsmith.search', async () => {
      const query = await vscode.window.showInputBox({
        prompt: 'Search for skills',
        placeHolder: 'e.g., react testing',
      });
      if (query) {
        const results = await client.search(query);
        provider.showSearchResults(results);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('skillsmith.recommend', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (workspaceFolder) {
        const recommendations = await client.recommend(workspaceFolder.uri.fsPath);
        provider.showRecommendations(recommendations);
      }
    })
  );
}

export function deactivate() {
  client?.disconnect();
}
```

---

#### Story FE-003-02: Recommendations Panel

**As a** VS Code user
**I want** to see skill recommendations in sidebar
**So that** I discover relevant skills while coding

**Acceptance Criteria:**
- [ ] Panel shows after workspace scan
- [ ] Skills listed with scores
- [ ] Click to view details
- [ ] Install button works

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| FE-003-02-T1 | Create webview HTML template | 3h | P0 |
| FE-003-02-T2 | Style with VS Code theme | 3h | P0 |
| FE-003-02-T3 | Implement skill list component | 3h | P0 |
| FE-003-02-T4 | Add install button handler | 2h | P0 |
| FE-003-02-T5 | Show loading state during scan | 2h | P1 |

---

#### Story FE-003-03: Context-Aware Suggestions

**As a** VS Code user
**I want** suggestions based on current file
**So that** recommendations are contextual

**Acceptance Criteria:**
- [ ] Detect language of active file
- [ ] Show relevant skills for language
- [ ] Update when file changes
- [ ] Show in status bar

**Tasks:**

| ID | Task | Estimate | Priority |
|----|------|----------|----------|
| FE-003-03-T1 | Detect active file language | 2h | P0 |
| FE-003-03-T2 | Query relevant skills | 3h | P0 |
| FE-003-03-T3 | Add status bar item | 2h | P1 |
| FE-003-03-T4 | Debounce file change events | 1h | P1 |
| FE-003-03-T5 | Cache suggestions per language | 2h | P1 |

---

## UI Components

### Trust Tier Badges

| Tier | Color | Icon | Description |
|------|-------|------|-------------|
| Official | Green | ✓ | Anthropic-verified |
| Verified | Blue | ✓ | Known publisher |
| Community | Yellow | - | Public GitHub |
| Unverified | Red | ⚠ | Unknown source |

### Quality Score Display

```
Overall: ████████░░ 82%
├── Quality:     ███████░░░ 75%
├── Popularity:  █████████░ 90%
└── Maintenance: ████████░░ 80%
```

---

## Related Documents

| Document | Purpose |
|----------|---------|
| [Integrations Architecture](../architecture/integrations.md) | Architecture source |
| [Design Brief](../design/design-brief.md) | UX specifications |
| [Infrastructure](./03-infrastructure-devops.md) | Deployment details |

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | December 26, 2025 | Frontend Specialist | Initial implementation plan |
