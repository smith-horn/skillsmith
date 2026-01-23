# Blog Implementation Plan

**Project:** Skillsmith Blog System
**Created:** 2026-01-23
**Status:** Ready for Execution

---

## Overview

Implement a blog system for skillsmith.app with the first article "Composing Agents, Sub-Agents, Skills, and Sub-Skills: A Decision Framework for Product Builders".

### Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Content Management | Astro Content Collections | Type-safe frontmatter, built-in querying, future-proof |
| URL Structure | Flat slug (`/blog/[slug]`) | Clean, shareable, SEO-friendly |
| Nav Position | Before Docs | Groups content-focused items together |

---

## Risk Register

| # | Risk | Likelihood | Impact | Mitigation | Status |
|---|------|------------|--------|------------|--------|
| R1 | Image Path Mismatch | HIGH | HIGH | Copy images to `public/blog/images/`, update markdown paths | Open |
| R2 | Content Collections Setup | MEDIUM | HIGH | Create `src/content/config.ts` with Zod schema | Open |
| R3 | TypeScript Strict Mode | MEDIUM | MEDIUM | Define proper collection types | Open |
| R4 | Markdown Processing | LOW | MEDIUM | Verify `<sup>` tags, tables, code blocks render | Open |
| R5 | Build Failure | LOW | HIGH | Docker build verification before merge | Open |
| R6 | Missing OG Image | LOW | LOW | Use first diagram as OG image | Open |

---

## Wave Structure

### Wave 1: Infrastructure (~45K tokens)

**Goal:** Set up foundation for blog system

| ID | Task | Files | Agent | Est. |
|----|------|-------|-------|------|
| 1.1 | Create Content Collections config with Zod schema | `src/content/config.ts` | backend-developer | 8K |
| 1.2 | Create BlogLayout component (extends BaseLayout, adds TOC, reading time) | `src/layouts/BlogLayout.astro` | frontend-developer | 12K |
| 1.3 | Copy 10 blog images to public directory | `public/blog/images/*.png` | devops-engineer | 2K |
| 1.4 | Add "Blog" to header navigation (before Docs) | `src/components/Header.astro` | frontend-developer | 3K |

**Acceptance Criteria:**
- [ ] Content collection schema validates frontmatter
- [ ] BlogLayout renders with proper styling
- [ ] All 10 images accessible at `/blog/images/*.png`
- [ ] Header shows: Skills | Pricing | Blog | Docs

**TDD Test Cases:**
```typescript
// Wave 1 verification
describe('Blog Infrastructure', () => {
  it('should have content collection config', () => {
    expect(fs.existsSync('src/content/config.ts')).toBe(true);
  });

  it('should render BlogLayout', async () => {
    const html = await render(BlogLayout, { title: 'Test' });
    expect(html).toContain('article');
  });

  it('should serve blog images', async () => {
    const res = await fetch('/blog/images/01-agent-skill-matrix.png');
    expect(res.status).toBe(200);
  });

  it('should show Blog in nav', async () => {
    const html = await render(Header);
    expect(html).toContain('href="/blog"');
  });
});
```

---

### Wave 2: Content & Pages (~65K tokens)

**Goal:** Implement blog pages and publish first article

| ID | Task | Files | Agent | Est. |
|----|------|-------|-------|------|
| 2.1 | Create BlogPostCard component | `src/components/BlogPostCard.astro` | frontend-developer | 8K |
| 2.2 | Create blog listing page with filtering | `src/pages/blog/index.astro` | frontend-developer | 15K |
| 2.3 | Create blog post dynamic route with SEO | `src/pages/blog/[...slug].astro` | frontend-developer | 20K |
| 2.4 | Add first article (convert markdown, fix image paths) | `src/content/blog/agent-skill-framework.md` | documentation-writer | 12K |
| 2.5 | Docker build verification | - | devops-engineer | 5K |

**Acceptance Criteria:**
- [ ] `/blog` shows article listing with cards
- [ ] `/blog/agent-skill-framework` renders full article
- [ ] All 10 images display correctly in article
- [ ] Reading time shows (e.g., "15 min read")
- [ ] JSON-LD BlogPosting schema present
- [ ] Open Graph tags render correctly
- [ ] Docker build passes without errors

**TDD Test Cases:**
```typescript
describe('Blog Pages', () => {
  it('should list blog posts', async () => {
    const html = await fetch('/blog').then(r => r.text());
    expect(html).toContain('agent-skill-framework');
  });

  it('should render article with images', async () => {
    const html = await fetch('/blog/agent-skill-framework').then(r => r.text());
    expect(html).toContain('Agent vs Skill Matrix');
    expect(html).toContain('/blog/images/01-agent-skill-matrix.png');
  });

  it('should have BlogPosting JSON-LD', async () => {
    const html = await fetch('/blog/agent-skill-framework').then(r => r.text());
    expect(html).toContain('"@type":"BlogPosting"');
  });

  it('should show reading time', async () => {
    const html = await fetch('/blog/agent-skill-framework').then(r => r.text());
    expect(html).toMatch(/\d+ min read/);
  });
});
```

---

## File Structure (Final State)

```
packages/website/src/
├── content/
│   ├── config.ts                          # NEW: Content collection schema
│   └── blog/
│       └── agent-skill-framework.md       # NEW: First article
├── layouts/
│   └── BlogLayout.astro                   # NEW: Blog-specific layout
├── pages/
│   └── blog/
│       ├── index.astro                    # REPLACE: Blog listing
│       └── [...slug].astro                # NEW: Dynamic post route
├── components/
│   ├── Header.astro                       # MODIFY: Add Blog nav
│   └── BlogPostCard.astro                 # NEW: Card component
└── ...

packages/website/public/
└── blog/
    └── images/
        ├── 01-agent-skill-matrix.png      # COPY from docs/articles/images/
        ├── 02-context-window-economics.png
        ├── 03-delegation-architecture.png
        ├── 04-decision-framework.png
        ├── 05-progressive-disclosure.png
        ├── 06-daisy-chain-sequence.png
        ├── 07-git-worktrees.png
        ├── 08-claude-flow-orchestration.png
        ├── 09-patterns-antipatterns.png
        └── 10-skill-lifecycle.png
```

---

## Content Collection Schema

```typescript
// src/content/config.ts
import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    author: z.string().default('Skillsmith Team'),
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
    category: z.enum(['Guides', 'Tutorials', 'Case Studies', 'News']).default('Guides'),
    tags: z.array(z.string()).default([]),
    featured: z.boolean().default(false),
    draft: z.boolean().default(false),
    ogImage: z.string().optional(),
  }),
});

export const collections = { blog };
```

---

## Article Frontmatter

```yaml
---
title: "Composing Agents, Sub-Agents, Skills, and Sub-Skills: A Decision Framework for Product Builders"
description: "The architecture decisions that determine whether your AI workflow scales or collapses"
author: "William Smith"
date: 2026-01-23
category: "Guides"
tags: ["agents", "skills", "architecture", "claude-code", "context-window"]
featured: true
ogImage: "/blog/images/01-agent-skill-matrix.png"
---
```

---

## Execution Commands

```bash
# Pre-flight check
./scripts/wave-preflight.sh

# Wave 1: Infrastructure
docker exec skillsmith-dev-1 npm run build  # Verify base state

# Wave 2: After implementation
docker exec skillsmith-dev-1 npm run build
docker exec skillsmith-dev-1 npm run typecheck

# Local preview
cd packages/website && npm run dev

# Verify pages
curl -s http://localhost:4321/blog | grep -q "agent-skill-framework" && echo "OK"
curl -s http://localhost:4321/blog/agent-skill-framework | grep -q "BlogPosting" && echo "OK"
```

---

## Linear Issue

**Title:** Implement blog system with first article
**Project:** Skillsmith Phase 6: Website & Portal
**Priority:** P1-High
**Labels:** feature, frontend, documentation

---

## Definition of Done

- [ ] Blog link appears in header navigation (before Docs)
- [ ] `/blog` shows article listing with cards
- [ ] `/blog/agent-skill-framework` renders full article
- [ ] All 10 diagrams display correctly
- [ ] Reading time calculated and displayed
- [ ] JSON-LD BlogPosting schema present
- [ ] Open Graph tags configured
- [ ] Docker build passes
- [ ] No TypeScript errors
- [ ] Mobile responsive
