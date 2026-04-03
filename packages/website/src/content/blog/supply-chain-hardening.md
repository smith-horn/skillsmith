---
title: "How We Hardened Skillsmith's Supply Chain"
description: "We pinned every external dependency to exact versions, SHA-locked all CI actions, and built a staging environment — here's why and what it means for you."
author: "Skillsmith Team"
date: 2026-04-03
category: "Engineering"
tags: ["security", "supply-chain", "infrastructure", "dependencies"]
featured: true
draft: false
---

Every npm install, every CI run, every edge function deploy pulls code from external sources you don't control. A single compromised package or retargeted action tag can inject malicious code into your build pipeline — silently, without changing a single line of your own code.

This week, we locked down four attack surfaces across Skillsmith's infrastructure. Nothing was exploited. No users were affected. We did this because supply chain security is too important to wait for an incident.

---

## What's a Supply Chain Attack?

A supply chain attack compromises software by targeting its dependencies rather than its source code directly. Instead of breaking into your application, an attacker poisons something your application trusts.

This isn't theoretical. The Node.js ecosystem has seen it firsthand:

- **event-stream (2018)** — A popular npm package was handed to a new maintainer who injected code targeting cryptocurrency wallets. 8 million weekly downloads carried the payload.
- **ua-parser-js (2021)** — An attacker gained access to the maintainer's npm account and published versions containing cryptominers and credential stealers.
- **xz-utils (2024)** — A multi-year social engineering campaign embedded a backdoor into a critical Linux compression library, nearly compromising SSH authentication worldwide.

Why does this matter for Skillsmith? Our edge functions handle billing (Stripe webhooks, checkout), skill indexing, and API authentication. Every one of those functions imports code from external CDNs and registries. If any of those imports were compromised, it could affect your account, your payments, and your data.

---

## What We Found

We audited every external dependency across our infrastructure and identified four attack surfaces where we were relying on mutable references instead of pinned versions.

| Surface | Before | Risk |
|---------|--------|------|
| **esm.sh CDN imports** | `stripe@20` (resolved to latest 20.x) | CDN serves whatever version it wants |
| **GitHub Actions** | `actions/checkout@v4` (mutable tag) | Tag can be silently retargeted to a different commit |
| **MCP server** | `ruflo@latest` | Every start pulled an unreviewed version |
| **Edge function shared code** | Mixed `@supabase/supabase-js` versions | Inconsistent versions across 25 functions |

None of these were actively exploited. But each one represented a window where a compromise upstream could propagate into our production systems without any change on our side.

---

## What We Did

### Pinned esm.sh Imports

Every edge function that imports from esm.sh now specifies an exact version. `stripe@20` became `stripe@20.4.1`. Seven files importing `@supabase/supabase-js` were standardized to `@2.47.0`.

This means a CDN compromise can't silently serve different code. The URL itself is the version lock — if the version doesn't match, the import fails rather than loading something unexpected.

We deployed all 25 edge functions to our staging environment first, validated them against Stripe test mode and live API calls, then promoted to production.

### SHA-Pinned GitHub Actions

All 19 third-party GitHub Actions now reference immutable commit SHAs instead of mutable version tags. For example:

| Before | After |
|--------|-------|
| `actions/checkout@v4` | `actions/checkout@<sha> # v4` |
| `actions/setup-node@v4` | `actions/setup-node@<sha> # v6` |

A tag like `@v4` is a pointer that the action author can move at any time. A SHA is a specific commit that can never change. Tag retargeting attacks — where an attacker compromises an action author's account and points `@v4` at malicious code — are now blocked entirely.

We also configured Dependabot to monitor these SHAs monthly and batch updates into grouped PRs, so we stay current without manual tracking.

### Pinned MCP Server

Our `.mcp.json` configuration referenced `ruflo@latest`, which meant every time the MCP server started, it pulled whatever version was newest on npm. We pinned this to `ruflo@3.5.51` — a version we've tested and validated.

### Built a Staging Environment

Every edge function change now goes through an isolated staging project before touching production. Billing functions are tested against Stripe test mode. API functions are validated against staging data. Only after staging passes do we deploy to production.

This isn't just about supply chain security — it's about catching any regression, whether from our code or from an upstream dependency change, before it reaches your account.

---

## What's Next

This was Wave 1 of our supply chain hardening initiative. Here's what's coming:

- **Wave 2 (July 2026):** Evaluating automated supply chain monitoring tools for behavioral analysis of dependency updates — catching not just known vulnerabilities, but suspicious code changes.
- **Ongoing:** Monthly Dependabot SHA updates for GitHub Actions, quarterly risk reviews of all external dependencies.
- **Transparency:** We'll continue publishing when we make infrastructure changes that affect how your data is protected.

---

## What You Need to Do

**Nothing.** All changes are infrastructure-side. Your API keys, installed skills, and billing are protected by exact-pinned dependencies that were validated in staging before reaching production.

These protections complement the [multi-layered security scanning](/blog/security-quarantine-safe-installation) that already protects you when installing skills. Together, they cover both the code you choose to install and the infrastructure that serves it.

If you have questions, reach out at [security@skillsmith.app](mailto:security@skillsmith.app).

---

**References:**

- [Skillsmith Security Policy](/security) — Vulnerability reporting and disclosure process
- [Security, Quarantine, and Safe Skill Installation](/blog/security-quarantine-safe-installation) — How we protect skill installations
- [PR #437](https://github.com/smith-horn/skillsmith/pull/437) — The supply chain hardening changeset
