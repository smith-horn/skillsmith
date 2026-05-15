---
title: "Skillsmith as an Enterprise Reference Architecture"
description: "A blueprint for running Skillsmith on your own infrastructure — source-available under the Elastic License 2.0 — with Supabase (or an equivalent), edge functions, local SQLite, the MCP server, CLI, and VS Code extension, plus a private registry and an IAM/RBAC access model."
author: "Skillsmith Team"
date: 2026-05-15
updated: 2026-05-15
category: "Engineering"
tags: ["architecture", "enterprise", "supabase", "rbac", "sso", "private-registry", "mcp", "reference-architecture", "elastic-license"]
featured: true
draft: false
ogImage: "https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200,h_630,c_fill/blog/enterprise-reference-architecture/01-system-overview"
---

Most teams meet Skillsmith as a hosted product: point Claude Code at our MCP
server, search for skills, install them. But the same architecture is something
you can stand up inside your own cloud. This post is the reference architecture
for that — what the pieces are, how they fit, and what changes when Skillsmith
runs on infrastructure you control.

A note on honesty up front: **this is a target-state blueprint.** The discovery,
indexing, and distribution layers ship today. The access-control layer —
IAM/RBAC and SSO — is partially built: the tools and a Supabase-backed data path
exist, but maturity varies. Where that matters, the text says so.

![Architecture diagram of Skillsmith showing three developer surfaces — CLI, MCP server, and VS Code extension — reading from a per-developer local SQLite database, which is synced from a hosted Supabase registry of Postgres tables and edge functions.](https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200/blog/enterprise-reference-architecture/01-system-overview)

## Licensing, in one paragraph

Skillsmith is source-available under the [Elastic License 2.0](https://www.elastic.co/licensing/elastic-license).
Every package — core, the MCP server, the CLI, the VS Code extension, and the
enterprise package — ships under the same license. Running Skillsmith on your own
infrastructure for your team's internal use is permitted at no charge: the
copyright grant is royalty-free and worldwide. A paid Team or Enterprise
subscription issues a JWT license key that unlocks the enterprise feature tier —
it is not a license to self-host, because self-hosting for internal use is
already granted. The one use that requires a separate commercial agreement is
offering Skillsmith to third parties as a hosted or managed service. That is the
whole model.

## Available today vs. designed

| Component | Status |
|-----------|--------|
| `@skillsmith/core`, MCP server, CLI, VS Code extension | Shipped |
| Supabase data layer + edge functions | Shipped |
| Per-developer local SQLite index | Shipped |
| GitHub indexer + `skillsmith sync` | Shipped |
| Private internal registry | Tooling shipped; backend matures with a configured database |
| IAM/RBAC enforcement, SSO/SAML | Designed; Supabase-backed mode exists, maturity varies |

## The entities that make up Skillsmith

Skillsmith is a small number of cooperating parts:

- **`@skillsmith/core`** — the database layer, repositories, and domain services.
- **`@skillsmith/mcp-server`** — the [Model Context Protocol](https://modelcontextprotocol.io)
  surface Claude Code talks to, exposing two-dozen-plus tools (`search`,
  `install_skill`, `recommend`, and the rest).
- **`@skillsmith/cli`** — the terminal interface.
- **VS Code extension** — the same capabilities inside the editor.
- **`@smith-horn/enterprise`** — SSO, RBAC, audit logging, and the private
  registry.
- **Supabase** — a Postgres skill registry plus a set of edge functions
  (`skills-search`, `skills-get`, `skills-recommend`, the `indexer`, and roughly
  thirty more).
- **A local SQLite database** — one per developer, with an FTS5 full-text index
  for fast offline search.

Every skill in the registry carries a **trust tier** — `verified`, `curated`,
`community`, `experimental`, `unknown`, or `local` — which downstream policy can
key off.

## The same architecture on your infrastructure

![Diagram of Skillsmith deployed inside a customer's own cloud VPC — the CLI, MCP server, VS Code extension, per-developer SQLite databases, a Supabase-or-equivalent data layer, and a private internal registry all enclosed in a customer-owned boundary, with an optional dashed link to the public Skillsmith registry.](https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200/blog/enterprise-reference-architecture/02-enterprise-deployment)

When a partner deploys Skillsmith, the entity list does not change — only who
owns the infrastructure. The MCP server, CLI, and extension run as before. The
data layer becomes *your* Supabase project (or an equivalent Postgres host with
edge functions). The local SQLite index stays where it always was: on each
developer's machine. And a **private internal registry** gives your organization
a place to publish skills that never leave your boundary.

The point worth underlining for a security review: it is the *same code*. There
is no fork, no parallel "enterprise build" to keep in sync. What differs is the
data plane — and it is yours.

## Indexer & registry data flow

![Left-to-right data flow diagram: the server-side indexer edge function crawls GitHub repositories and writes skills into the Supabase Postgres registry; the client-side skillsmith sync command then pulls that curated registry into each developer's local SQLite database.](https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200/blog/enterprise-reference-architecture/03-indexer-data-flow)

Two distinct mechanisms keep skills flowing, and it is worth being precise about
which does what:

1. **The indexer** is a server-side edge function. On a schedule (four times a
   day in our hosted deployment) it crawls GitHub via the Search and Code Search
   APIs, under rate-limit budgets, and writes discovered skills into the Supabase
   Postgres registry.
2. **`skillsmith sync`** is a client-side command. It pulls the curated registry
   from the hosted API into each developer's local SQLite database — fast,
   offline-capable search without re-crawling anything.

A partner deployment can do either or both: run the indexer against GitHub to
build its own registry, and/or seed from the public Skillsmith registry so
developers start with a curated set instead of an empty index.

## Provisioning and access control

![Access-control diagram: users are provisioned by tiered API key or OAuth/SSO, both feeding an IAM/RBAC policy engine of roles and permissions that decides — keyed off trust tier and registry source — which skills a user may install, with all activity written to an audit log.](https://res.cloudinary.com/diqcbcmaq/image/upload/f_auto,q_auto,w_1200/blog/enterprise-reference-architecture/04-auth-iam-rbac)

Users reach the system one of two ways. **API keys** are tiered — Community,
Individual, Team, Enterprise — and rate-limited accordingly. **OAuth / SSO /
SAML** integrates with the identity providers an enterprise already runs (Okta,
Azure AD, Google Workspace).

On top of provisioning sits the **IAM/RBAC layer**: roles and permissions that
govern *which skills a user may install*, with policy keyed off a skill's trust
tier and its registry source. A `community`-tier skill from the public registry
and a `verified` skill from your private registry are different risk profiles,
and the model lets you treat them differently. Every action is written to an
audit log, queryable and exportable to a SIEM.

To be straight about maturity: the RBAC, SSO, and private-registry **tools**
exist and are wired into the MCP server, with a Supabase-backed live mode that
activates when a database is configured and a stub fallback when one is not.
Treat this layer as the *designed* access-control model of the reference
architecture — real, in progress, and not yet something to put in front of an
auditor as finished.

## Why this matters for partners

- **Data sovereignty.** Skills, registry, audit log, and developer indexes all
  live inside your boundary.
- **No fork.** You run the same source-available code we do; upgrades are
  upgrades, not merges.
- **A compliance story.** Trust tiers, RBAC, and an exportable audit log give a
  security team something concrete to evaluate.
- **Gradual adoption.** Start with the hosted registry and the CLI; add a private
  registry; add SSO and RBAC as that layer matures — without re-platforming.

If you are evaluating Skillsmith for an enterprise deployment, this is the shape
of what you would be running. [Get in touch](https://skillsmith.app) and we can
walk through it against your environment.
