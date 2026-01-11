# Repository Visibility Strategy

> **Status:** Proposed
> **Last Updated:** 2026-01-11
> **Context:** Evaluating public repository strategy for Skillsmith
> **Related:** [ADR-013: Open Core Licensing](../adr/013-open-core-licensing.md)

## Executive Summary

This document analyzes repository visibility strategies used by industry leaders (Supabase, Docker, PostHog, Vercel) and recommends a visibility approach for Skillsmith aligned with our Open Core licensing model.

**Key Finding:** GitHub does **not** support "public but no fork/clone" - all public repositories can be forked and cloned. This is by design in GitHub's collaboration model.

**Recommendation:** Make core packages public (Apache-2.0), keep enterprise package private, leverage open core model for competitive advantage.

---

## Industry Analysis: What Do They Do?

### 1. Supabase: Fully Open Source

**Repository Status:**
- **Main repo:** [github.com/supabase/supabase](https://github.com/supabase/supabase) - **Public**
- **License:** Apache-2.0
- **Stars:** 95,885 stars (as of Jan 2026)
- **Forks:** 11,213 forks
- **Repositories:** 138 public repositories

**Strategy:**
- ✅ **Fully open source** - all code is public
- ✅ **Community-driven** - accepts contributions
- ✅ **Self-hostable** - users can deploy without Supabase Cloud
- ✅ **Revenue model:** Managed hosting, support, enterprise features

**Key Insight:** Supabase's openness drives adoption. They monetize through convenience (managed hosting) rather than code restrictions.

**Sources:**
- [GitHub - supabase/supabase](https://github.com/supabase/supabase)
- [Supabase Open Source Community](https://supabase.com/open-source)

---

### 2. PostHog: Open Core (with Controversy)

**Repository Status:**
- **Main repo:** [github.com/PostHog/posthog](https://github.com/PostHog/posthog) - **Public**
- **License:** MIT (core) + Proprietary (enterprise directory `ee/`)
- **Pure FOSS option:** [github.com/PostHog/posthog-foss](https://github.com/PostHog/posthog-foss) (read-only mirror, proprietary code removed)

**Strategy:**
- ⚠️ **Open core model** - majority MIT, some enterprise features proprietary
- ✅ **Transparent separation** - `ee/` directory clearly marked as enterprise
- ⚠️ **Controversy** - some users claim "not truly open source" ([Issue #38417](https://github.com/PostHog/posthog/issues/38417))
- ✅ **Self-hostable** - free Docker deployment (up to ~100k events/month)
- ✅ **Revenue model:** Managed cloud, enterprise features, scale pricing

**Key Insight:** PostHog's open core transparency builds trust while protecting revenue. The `posthog-foss` mirror demonstrates commitment to pure open source users.

**Controversy Note:** Users debate whether mixing MIT and proprietary code in one repo is "truly open source." PostHog addresses this with a separate FOSS mirror.

**Sources:**
- [GitHub - PostHog/posthog](https://github.com/PostHog/posthog)
- [GitHub - PostHog/posthog-foss](https://github.com/PostHog/posthog-foss)
- [Posthog is not open source · Issue #38417](https://github.com/PostHog/posthog/issues/38417)

---

### 3. Vercel/Next.js: Fully Open Source Framework

**Repository Status:**
- **Main repo:** [github.com/vercel/next.js](https://github.com/vercel/next.js/) - **Public**
- **License:** MIT
- **Framework:** Fully open source

**Strategy:**
- ✅ **Fully open source** - Next.js framework is MIT licensed
- ✅ **Community-driven** - massive community contribution
- ✅ **Self-hostable** - deploy Next.js anywhere
- ✅ **Revenue model:** Vercel platform (hosting, edge, analytics, not the code)

**Additional Open Source Projects:**
- [Vercel AI SDK](https://github.com/vercel/ai) - "Free open-source library for building AI-powered applications"
- [Next.js Commerce](https://github.com/vercel/commerce) - E-commerce template

**Key Insight:** Vercel monetizes the **platform** (deployment, performance, DX tools), not the code. Next.js being open drives Vercel adoption.

**Sources:**
- [GitHub - vercel/next.js](https://github.com/vercel/next.js/)
- [GitHub - vercel/ai](https://github.com/vercel/ai)

---

### 4. Docker: Open Source with Proprietary Add-Ons

**Repository Status:**
- **Main org:** [github.com/docker](https://github.com/docker) - **Multiple public repos**
- **License:** Apache-2.0 (core engine), mixed for other tools
- **Docker Engine:** Open source
- **Docker Desktop:** Proprietary (requires license for large companies)

**Strategy:**
- ✅ **Core engine open source** - Docker container runtime is Apache-2.0
- ✅ **Docker-Sponsored Open Source (DSOS) Program** - supports community projects
- ✅ **Proprietary GUI** - Docker Desktop requires paid license for enterprise
- ✅ **Revenue model:** Docker Desktop licenses, Docker Hub Pro/Teams, enterprise support

**Key Insight:** Docker open sources the core runtime (community adoption) while monetizing the developer experience (Docker Desktop, Docker Hub features).

**Sources:**
- [Docker · GitHub](https://github.com/docker)
- [Docker and Open Source](https://www.docker.com/community/open-source/)
- [GitHub - docker/opensource](https://github.com/docker/opensource)

---

## Comparison Matrix

| Company | Repository | License | Self-Hostable | Revenue Model | Strategy |
|---------|-----------|---------|---------------|---------------|----------|
| **Supabase** | Fully public | Apache-2.0 | Yes | Managed hosting, support | Open source everything |
| **PostHog** | Public (open core) | MIT + Proprietary `ee/` | Yes (limited) | Cloud, enterprise features | Open core (controversial) |
| **Vercel** | Fully public | MIT | Yes | Platform (hosting, edge) | Open framework, monetize platform |
| **Docker** | Public core | Apache-2.0 | Yes | Desktop licenses, Hub Pro | Open engine, monetize tooling |

### Common Patterns

1. **All make core functionality public**
2. **Self-hosting is allowed** (drives adoption, not direct revenue)
3. **Revenue comes from:**
   - Managed hosting (Supabase, Vercel, PostHog Cloud)
   - Enterprise features (PostHog, Docker Desktop)
   - Support/SLAs (all)
   - Platform value-adds (Vercel Edge, Docker Hub)
4. **Openness drives adoption** → Adoption drives revenue

---

## GitHub Repository Visibility Options

### Available Visibility Types

GitHub offers **three visibility options**:

| Visibility | Who Can See | Who Can Fork/Clone | Who Can Contribute |
|------------|-------------|-------------------|-------------------|
| **Public** | Everyone on the internet | Everyone | Anyone (via PRs, requires approval) |
| **Internal** | All enterprise members | Enterprise members only | Enterprise members |
| **Private** | Explicit collaborators only | Explicit collaborators only | Explicit collaborators only |

**Source:** [GitHub Docs - Setting repository visibility](https://docs.github.com/articles/setting-repository-visibility)

### Critical Limitation: No "Public Read-Only"

**GitHub does NOT support:**
- ❌ Public repository with disabled forking
- ❌ Public repository with disabled cloning
- ❌ Public repository with read-only web viewing

**Why?** Cloning and forking are **fundamental to GitHub's collaboration model**. As stated in [GitHub Community Discussion #23248](https://github.com/orgs/community/discussions/23248):

> "There is no way to prevent people from cloning or downloading your repository if they have access to it. Cloning a repository is a central operation in the collaboration model that GitHub provides."

**What You CAN Do:**
- ✅ Disable forking for **organization-owned** repositories
- ✅ Make forks **always public** (even if original is private)
- ❌ Prevent cloning (not possible - users can always `git clone` a public repo)

**Sources:**
- [Is there a way to stop cloning or downloading from my public repositories?](https://github.com/orgs/community/discussions/23248)
- [Managing the forking policy for your repository - GitHub Docs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/managing-the-forking-policy-for-your-repository)

---

## Skillsmith's Current Position

### Existing Open Core Model (ADR-013)

Skillsmith already has an **Open Core licensing model** defined in [ADR-013](../adr/013-open-core-licensing.md):

| Package | License | Status | Repository Status |
|---------|---------|--------|-------------------|
| `@skillsmith/core` | Apache-2.0 | Open source | **Currently private** |
| `@skillsmith/mcp-server` | Apache-2.0 | Open source | **Currently private** |
| `@skillsmith/cli` | Apache-2.0 | Open source | **Currently private** |
| `@skillsmith/enterprise` | Proprietary | Commercial | **Private (stay private)** |

**Current Gap:** Core packages are **licensed as open source** (Apache-2.0) but **repository is private**.

### What's Already Defined

**Revenue Model (ADR-013 + Free Tier Strategy):**
- Free tier: 100 API calls/month (open source core)
- Pro tier: $10/month - 10,000 calls (open source core + priority support)
- Enterprise tier: Custom pricing (proprietary `@skillsmith/enterprise` package)

**Feature Bifurcation:**
- Core packages provide full skill discovery functionality
- Enterprise package adds SSO, audit logging, RBAC, private registries
- No rate limiting on core features (just API call limits)

---

## Recommendation: Make Core Packages Public

### Proposed Repository Strategy

#### Phase 1: Public Core Packages (Immediate)

**Create public repository for core packages:**

```
wrsmith108/skillsmith (Public)
├── packages/
│   ├── core/          # @skillsmith/core (Apache-2.0)
│   ├── mcp-server/    # @skillsmith/mcp-server (Apache-2.0)
│   └── cli/           # @skillsmith/cli (Apache-2.0)
├── docs/              # Public documentation
├── examples/          # Example usage
└── README.md          # Public-facing README
```

**Key Files to Include:**
- `LICENSE` (Apache-2.0)
- `CONTRIBUTING.md` (contribution guidelines)
- `CODE_OF_CONDUCT.md`
- `SECURITY.md` (security policy, vulnerability reporting)
- `.github/ISSUE_TEMPLATE/` (bug reports, feature requests)
- `.github/PULL_REQUEST_TEMPLATE.md`

#### Phase 2: Private Enterprise Repository (Stays Private)

**Keep separate private repository for enterprise:**

```
wrsmith108/skillsmith-enterprise (Private)
├── packages/
│   └── enterprise/    # @skillsmith/enterprise (Proprietary)
├── docs/enterprise/   # Enterprise documentation (private)
└── LICENSE.md         # Proprietary license
```

**Access Control:**
- Only enterprise customers + internal team
- Deployed to **private npm registry**
- License key validation required

### Why This Approach?

#### Strategic Benefits

**1. Aligns with Open Core Model**
- Core packages already Apache-2.0 licensed (ADR-013)
- Making repo public matches the license intent
- Enterprise package stays private (revenue protection)

**2. Matches Industry Leaders**
- Supabase: Core public, monetize hosting
- PostHog: Core public (MIT), `ee/` proprietary
- Docker: Engine public, Desktop proprietary
- Vercel: Framework public, platform proprietary

**3. Drives Adoption**
- Open source → Trust → Community → Ecosystem → Revenue
- Contributors can audit security, fix bugs, add features
- "View source" lowers barrier to adoption
- SEO benefits (GitHub code search, Google indexing)

**4. Competitive Moat**
- **Transparency as differentiator:** "We're open, competitors aren't"
- **Community contributions:** Free R&D, feature requests, bug reports
- **Network effects:** More users → more skills → more value
- **Ecosystem lock-in:** Integrations, plugins, tooling all build on open core

**5. Marketing & Credibility**
- "Open source skill discovery" is a strong positioning
- GitHub stars/forks signal traction to investors
- Contributors become advocates
- Press coverage ("New open source tool for Claude Code")

**6. Recruiting**
- Developers want to work on open source
- Public portfolio of work attracts talent
- Community contributions = free interview process

#### Risk Mitigation

**Concern #1: "Competitors will fork our code"**

**Response:**
- They already can (Apache-2.0 license allows commercial use)
- Network effects protect you: community, ecosystem, integrations
- Brand matters: users want "official Skillsmith," not forks
- **Example:** Supabase has 11,213 forks, still dominates market

**Concern #2: "Losing competitive advantage"**

**Response:**
- Competitive advantage is **not the code**, it's:
  - **Network effects:** Skill index, community, ecosystem
  - **Brand:** Trust, reputation, verified skills
  - **Execution:** Speed, quality, support
  - **Data:** Skill quality scores, usage telemetry
  - **Enterprise features:** Proprietary `@skillsmith/enterprise` package

**Concern #3: "Free riders - people self-host and don't pay"**

**Response:**
- Self-hosting is **not** your customer segment
- Self-hosters lack: managed API, embeddings infrastructure, skill index updates, support
- **Example:** PostHog free tier supports ~100k events/month, then users upgrade for convenience
- Free tier (100 API calls/month) already assumes some free usage

**Concern #4: "Support burden from community"**

**Response:**
- Set expectations: "Community support for open source, paid support for Pro/Enterprise"
- Use GitHub Discussions for community Q&A (scales better than issues)
- Community often self-supports (power users help newbies)
- Tag contributors for "good first issue" (free triage)

#### What NOT to Make Public

**Keep Private:**
1. **`@skillsmith/enterprise` package** (proprietary features)
2. **Private skill registry** (enterprise customer data)
3. **Customer data** (telemetry, usage logs)
4. **API keys, secrets** (obviously)
5. **Revenue/financial data** (pricing experiments, conversion rates)
6. **Internal tools** (unless valuable to open source them)

---

## Alternative: Stay Private

### Arguments for Keeping Repository Private

**1. Competitive Secrecy**
- Competitors can't see roadmap, architecture, implementation details
- Harder to replicate features
- Trade secrets protected

**2. Control**
- No external contributors to manage
- No community support burden
- Full control over direction

**3. Enterprise Sales**
- "Exclusive access to codebase" as enterprise selling point (weak argument)
- Avoid transparency about bugs/issues

### Why This Is Suboptimal

**1. Conflicts with Existing License**
- Core packages already Apache-2.0 (ADR-013)
- Private repo with open license is unusual, signals distrust
- Limits the value of open source license

**2. Misses Adoption Opportunity**
- Open source drives community adoption
- Claude Code ecosystem is nascent - being "first open source skill discovery" is valuable positioning
- Private repo limits discoverability

**3. Against Industry Trends**
- All competitors (Supabase, PostHog, Docker, Vercel) made core functionality public
- Developer tools trend toward open source
- "Open core" is proven model for developer-facing products

**4. Limits Recruiting**
- Top developers want to work on open source
- No public portfolio of work to attract talent

---

## Recommended Implementation Plan

### Week 1: Preparation

**1. Audit for Secrets**
- Remove any hardcoded API keys, secrets, credentials
- Ensure `.env.example` is safe, `.env` is gitignored
- Audit commit history for accidentally committed secrets (use `git-secrets` or `truffleHog`)

**2. Documentation Cleanup**
- Update README.md for public audience
- Add CONTRIBUTING.md
- Add CODE_OF_CONDUCT.md
- Add SECURITY.md (vulnerability disclosure policy)
- Review all docs for sensitive internal info

**3. License Files**
- Ensure `LICENSE` (Apache-2.0) is in repo root
- Add license headers to core package files
- Create separate LICENSE.md for enterprise package

**4. Repository Structure**
- Ensure clear separation: `packages/core`, `packages/mcp-server`, `packages/cli` (public)
- If `packages/enterprise` exists, move to separate private repo

### Week 2: Public Launch

**1. Make Repository Public**
```bash
# GitHub repo settings → Visibility → Change to Public
```

**2. Configure Repository Settings**
- Enable Issues (for bug reports, feature requests)
- Enable Discussions (for community Q&A)
- Set up Issue Templates
- Set up PR Template
- Configure branch protection (require PR reviews, CI checks)
- Disable forking if preferred (organization setting)

**3. Publish Packages to npm**
```bash
npm publish @skillsmith/core --access public
npm publish @skillsmith/mcp-server --access public
npm publish @skillsmith/cli --access public
```

**4. Announce Launch**
- Post to Hacker News: "Show HN: Skillsmith – Open source skill discovery for Claude Code"
- Twitter/X announcement
- Reddit: r/ClaudeAI, r/opensource
- Claude Code community channels
- Update website with "Open Source" badge

### Week 3: Community Setup

**1. GitHub Community Files**
- Pin important issues
- Create first "good first issue" tags
- Set up GitHub Discussions categories:
  - 💡 Ideas
  - 🙋 Q&A
  - 📣 Announcements
  - 🐛 Bug Reports
  - 🎉 Show and Tell

**2. Contribution Guidelines**
- CLA setup (for enterprise integration points, per ADR-013)
- Contributor recognition (CONTRIBUTORS.md)
- First-time contributor guide

**3. Monitoring**
- GitHub stars/forks tracking
- Issue/PR velocity
- Community sentiment

### Week 4: Growth

**1. SEO & Discovery**
- Submit to GitHub trending
- Tag with relevant topics: `claude-code`, `mcp-server`, `skill-discovery`, `developer-tools`
- Add to awesome-lists (e.g., awesome-claude, awesome-mcp)

**2. Content Marketing**
- Blog post: "Why we open sourced Skillsmith"
- Architecture deep dive
- Contributor spotlight

---

## FAQ

### Q: Can we make the repo public but disable forking/cloning?

**A:** No. GitHub does not support this. Public repos can always be cloned and (usually) forked. This is by design in GitHub's collaboration model.

**Source:** [GitHub Community Discussion #23248](https://github.com/orgs/community/discussions/23248)

### Q: What if someone forks and competes with us?

**A:**
1. They can already do this (Apache-2.0 license allows it)
2. Network effects protect you (community, ecosystem, skill index)
3. Brand matters - users want "official Skillsmith"
4. Execution > code - you'll move faster
5. **Historical precedent:** Supabase has 11,213 forks, still dominates

### Q: Will we lose enterprise sales?

**A:**
1. Enterprise package stays private (SSO, audit logging, RBAC)
2. Enterprise customers buy support, SLAs, managed hosting - not code access
3. **Example:** Red Hat, Docker, PostHog all sell enterprise on top of open source

### Q: What about support burden?

**A:**
1. Set clear expectations: community vs. paid support
2. Use GitHub Discussions (scales better)
3. Community often self-supports
4. "Good first issue" tags reduce your triage burden

### Q: Should we require a CLA?

**A:** Per ADR-013, CLA is required for:
- Enterprise integration points
- Enterprise package contributions

No CLA needed for core packages (Apache-2.0).

### Q: What about security vulnerabilities?

**A:**
1. Add SECURITY.md with disclosure policy
2. Enable GitHub Security Advisories (private vulnerability reporting)
3. **Benefit:** More eyeballs = bugs are found faster
4. "Responsible disclosure" process protects you during patching

---

## Success Metrics

Track these metrics post-launch:

| Metric | Target (3 months) | Target (6 months) |
|--------|-------------------|-------------------|
| GitHub stars | 500 | 2,000 |
| Forks | 50 | 200 |
| Contributors | 5 | 20 |
| Issues/PRs | 20 | 100 |
| npm downloads/week | 500 | 2,500 |
| Community discussions | 10 | 50 |
| External integrations | 2 | 10 |

---

## Conclusion

**Recommendation:** Make core packages public, keep enterprise package private.

**Rationale:**
1. ✅ Aligns with existing Open Core model (ADR-013)
2. ✅ Matches industry leaders (Supabase, PostHog, Docker, Vercel)
3. ✅ Drives adoption through transparency and community
4. ✅ Protects revenue (enterprise package stays private)
5. ✅ Competitive moat through network effects, not code secrecy
6. ✅ Recruiting, marketing, SEO benefits

**Key Principle:** In developer tools, **openness drives adoption, adoption drives revenue.**

**Next Steps:**
1. Decision: Approve public repository strategy
2. Execute: 4-week implementation plan
3. Monitor: Track success metrics
4. Iterate: Adjust based on community feedback

---

## References

### Industry Examples
- [Supabase GitHub Organization](https://github.com/supabase)
- [PostHog Open Source](https://posthog.com/docs/self-host/open-source/support)
- [PostHog FOSS Mirror](https://github.com/PostHog/posthog-foss)
- [Vercel Next.js](https://github.com/vercel/next.js/)
- [Docker Open Source](https://www.docker.com/community/open-source/)

### GitHub Documentation
- [Setting Repository Visibility](https://docs.github.com/articles/setting-repository-visibility)
- [Managing Forking Policy](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/managing-the-forking-policy-for-your-repository)
- [Cannot Disable Cloning/Downloading](https://github.com/orgs/community/discussions/23248)

### Skillsmith Documentation
- [ADR-013: Open Core Licensing](../adr/013-open-core-licensing.md)
- [Free Tier Pricing Strategy](./free-tier-pricing-strategy.md)
- [README.md](../../README.md)
