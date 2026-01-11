# Protective Licensing Options for Public Repository

> **Status:** Proposed
> **Last Updated:** 2026-01-11
> **Context:** Choosing IP-protective license for public Skillsmith repository
> **Related:**
> - [Free Tier Pricing Strategy](./free-tier-pricing-strategy.md)
> - [Repository Visibility Strategy](./repository-visibility-strategy.md)

## Executive Summary

**Question:** What license protects our IP while allowing a public repository?

**Answer:** Use a **source-available protective license** instead of traditional open source licenses. You haven't launched, have zero users, and can choose any license.

**Recommendation:** **Elastic License 2.0** for immediate launch, or **Fair Source License (FSL)** for eventual open source transition.

**Key Insight:** Modern SaaS companies (Sentry, HashiCorp, Elastic, CockroachDB) abandoned permissive open source (Apache-2.0, MIT) in favor of protective licenses that prevent competitors from offering their software as a service while keeping code public.

---

## The Problem with Apache-2.0

**Apache-2.0 License (your current choice) allows:**
- ✅ Anyone can view, fork, modify, and redistribute
- ✅ Anyone can use commercially
- ✅ **Anyone can offer as a competing SaaS** ⚠️
- ✅ No requirement to contribute back
- ✅ No protection against cloud providers (AWS, Azure, Google) wrapping your product

**Real-world example:**
- **Elastic** was Apache-2.0 → AWS offered "Amazon Elasticsearch Service" → Elastic lost revenue → Switched to Elastic License 2.0 in 2021

**Why this matters for Skillsmith:**
- With Apache-2.0, a competitor could fork Skillsmith, deploy the API, and compete directly
- Your $9.99/mo pricing has no license protection
- You'd compete on execution alone (which may be fine, but you have options)

---

## Four Protective License Options

### Option 1: Elastic License 2.0 (ELv2) ⭐ RECOMMENDED FOR IMMEDIATE LAUNCH

**What it does:**
- ✅ Code is **fully public** (can view, fork, clone on GitHub)
- ✅ Anyone can **use, modify, and redistribute** freely
- ❌ **Cannot** provide as a managed/hosted service to third parties
- ❌ **Cannot** disable license key functionality (paid features)
- ✅ No time limit - permanent restrictions

**Who uses it:**
- **Elastic** (Elasticsearch, Kibana) - since 2021
- **Elastic** added AGPLv3 as alternative option in 2024

**Best for:**
- Protecting against cloud providers (AWS, Azure, Google)
- Preventing competitors from offering your API as a service
- No future open source commitment required

**Pricing compatibility:**
- ✅ Perfect for SaaS model ($9.99/mo)
- ✅ Users can self-host for internal use (not competing with you)
- ✅ Cannot resell your API as a service

**Restrictions:**
You **may not** provide the software to third parties as a hosted or managed service where the service provides users with access to any substantial set of the features or functionality of the software.

**Example allowed use:**
- Company installs Skillsmith MCP server internally for their developers ✅
- Individual uses Skillsmith CLI locally ✅
- Company forks and modifies for internal use ✅

**Example prohibited use:**
- Startup offers "Skillsmith-as-a-Service" API ❌
- Cloud provider offers "Managed Skillsmith" ❌
- Competitor wraps Skillsmith API and charges for it ❌

**Sources:**
- [Elastic License 2.0 Official](https://www.elastic.co/licensing/elastic-license)
- [Elastic License v2 Announcement](https://www.elastic.co/blog/elastic-license-v2)

---

### Option 2: Fair Source License (FSL) - BEST FOR EVENTUAL OPEN SOURCE

**What it does:**
- ✅ Code is **fully public** (can view, fork, clone on GitHub)
- ✅ Anyone can **use, modify, and redistribute**
- ❌ **Cannot** offer as a competing commercial service
- ⏰ **Converts to Apache-2.0** after 2 years (automatic)
- ✅ Clear path to true open source

**Who uses it:**
- **Sentry** - adopted FSL in 2023, now 100k+ customers, $100M+ ARR
- **GitLab** (some components)
- **Cal.com** (scheduling platform)

**Best for:**
- Protecting IP short-term while committing to open source long-term
- Building trust with developer community
- Avoiding SSPL controversy (FSL is more permissive)

**Pricing compatibility:**
- ✅ Perfect for SaaS model ($9.99/mo)
- ✅ Users can self-host for internal use
- ✅ Cannot compete with your paid service
- ⏰ After 2 years, becomes Apache-2.0 (anyone can do anything)

**Restrictions (temporary - 2 years):**
You **may not** use the software to provide commercial services to third parties that compete directly with Skillsmith.

**Sentry's FSL implementation:**
- Anyone can use, deploy, modify Sentry
- **Cannot** sell self-hosted Sentry as a SaaS offering
- **Cannot** be a direct competitor of Sentry
- After 2 years → Apache-2.0 (fully open source)

**Success story:**
- Sentry switched to FSL in 2023
- Compliance departments at 10,000+ organizations approved internal use
- 100,000+ cloud customers
- $100M+ annual revenue
- Developers still contribute (it's "practically open source")

**Sources:**
- [Sentry Fair Source Announcement](https://blog.sentry.io/sentry-is-now-fair-source/)
- [Fair Source License](https://fair.io/)
- [TechCrunch: Fair Source Movement](https://techcrunch.com/2024/09/22/some-startups-are-going-fair-source-to-avoid-the-pitfalls-of-open-source-licensing/)

---

### Option 3: Business Source License (BSL) 1.1

**What it does:**
- ✅ Code is **fully public** (can view, fork, clone on GitHub)
- ✅ Anyone can use for non-production or non-commercial purposes
- ❌ **Cannot** use for production commercial purposes (without license)
- ⏰ **Converts to GPL-compatible license** after max 4 years (you choose date)
- ✅ You define "Additional Use Grant" (production use exceptions)

**Who uses it:**
- **HashiCorp** (Terraform, Vault, Consul) - since 2023
- **CockroachDB** - used BSL before switching to CCL
- **MariaDB** - created BSL in 2013
- **Redpanda**, **Akka**, **Couchbase**

**Best for:**
- Controlling production use cases
- Longer protection period (up to 4 years vs FSL's 2 years)
- Flexibility in "Additional Use Grant"

**Pricing compatibility:**
- ✅ Good for SaaS model
- ⚠️ Requires clear "Additional Use Grant" definition
- ⏰ After 4 years max, converts to GPL (copyleft)

**Additional Use Grant (you define):**
Example from HashiCorp:
> "You may use the software for production purposes except in products that are competitive with HashiCorp's products."

**Time-delayed open source:**
- You specify conversion date (max 4 years from release)
- Automatically converts to GPL v2+ or GPL-compatible license
- Example: Code released Jan 2026 → becomes GPL Jan 2030

**Controversy:**
- HashiCorp's BSL adoption sparked **OpenTofu fork** (community backlash)
- Converts to **GPL** (copyleft), not permissive like Apache-2.0
- More complex than Elastic License 2.0 or FSL

**Sources:**
- [HashiCorp BSL Adoption](https://www.hashicorp.com/en/blog/hashicorp-adopts-business-source-license)
- [Business Source License 1.1](https://mariadb.com/bsl11/)
- [FOSSA: BSL Guide](https://fossa.com/blog/business-source-license-requirements-provisions-history/)

---

### Option 4: Server Side Public License (SSPL) - NOT RECOMMENDED

**What it does:**
- ✅ Code is **fully public**
- ✅ Anyone can use, modify, and redistribute
- ❌ If you offer as SaaS, **must open source entire infrastructure** (monitoring, auth, deployment, UI, etc.)
- ❌ Very restrictive copyleft (extends to entire stack)
- ❌ **Not OSI-approved** (rejected as "not open source")

**Who uses it:**
- **MongoDB** - since 2018
- **Graylog**

**Why NOT recommended:**
- ⚠️ Controversial - Debian, Red Hat, Fedora **dropped MongoDB** due to SSPL
- ⚠️ OSI rejected SSPL as "not open source" (discriminates against SaaS)
- ⚠️ Very restrictive - scares away enterprise users
- ⚠️ Requires open sourcing **entire service stack** (not just your code)
- ⚠️ MongoDB is the only major successful example

**SSPL Requirement:**
If you offer software as a service, you must open source:
- Your application code
- Management software
- User interfaces
- APIs
- Automation software
- Monitoring, backup, storage, hosting software
- **Everything required to run the service**

This is extremely broad and has been criticized as "weaponized copyleft."

**Sources:**
- [MongoDB SSPL FAQ](https://www.mongodb.com/legal/licensing/server-side-public-license/faq)
- [Why SSPL is Not Open Source - New Stack](https://thenewstack.io/the-case-against-the-server-side-public-license-sspl/)
- [Wikipedia: Server Side Public License](https://en.wikipedia.org/wiki/Server_Side_Public_License)

---

## Comparison Matrix

| License | Public Code | Prevents SaaS Competition | Time-Bound | Eventual License | Controversy | Best For |
|---------|-------------|---------------------------|------------|------------------|-------------|----------|
| **Apache-2.0** | ✅ | ❌ | No | N/A (permanent) | None | Open source everything |
| **Elastic License 2.0** | ✅ | ✅ | No | N/A (permanent) | Low | Protecting SaaS revenue |
| **Fair Source (FSL)** | ✅ | ✅ | 2 years | Apache-2.0 | Very low | Short-term protection + trust |
| **Business Source (BSL)** | ✅ | ✅ | 4 years max | GPL-compatible | Medium | Longer protection period |
| **SSPL** | ✅ | ✅✅ (extreme) | No | N/A (permanent) | **Very high** | Not recommended |

---

## Recommendation for Skillsmith

### Primary Recommendation: **Elastic License 2.0**

**Why:**
1. ✅ **Permanent SaaS protection** - no competitor can offer "Skillsmith-as-a-Service"
2. ✅ **Simple and clear** - one restriction: "don't offer as managed service"
3. ✅ **Public repository** - full transparency, community can audit, fork, contribute
4. ✅ **Proven success** - Elastic (multi-billion dollar company) uses it
5. ✅ **Compatible with $9.99/mo model** - protects your pricing without complexity
6. ✅ **Low controversy** - more permissive than SSPL, doesn't scare enterprise
7. ✅ **No future commitment** - no obligation to open source later

**Implementation:**
```
LICENSE (Elastic License 2.0)
Copyright 2026 Smith Horn Group Ltd

Elastic License 2.0

URL: https://www.elastic.co/licensing/elastic-license

Limitation: You may not provide the software to third parties as a
hosted or managed service, where the service provides users with
access to any substantial set of the features or functionality
of the software.
```

**What this means for users:**
- ✅ Install Skillsmith MCP server locally
- ✅ Fork and modify for internal company use
- ✅ Contribute bug fixes and features back
- ✅ Self-host for team/organization
- ❌ Cannot offer "Skillsmith API as a Service" to external customers
- ❌ Cannot build competing SaaS on top of Skillsmith

---

### Alternative Recommendation: **Fair Source License (FSL)**

**Why:**
1. ✅ **2-year SaaS protection** - prevents competition during critical growth phase
2. ✅ **Converts to Apache-2.0** - builds trust with community
3. ✅ **Proven with Sentry** - $100M+ ARR, 100k+ customers
4. ✅ **Developer-friendly** - "practically open source" before conversion
5. ✅ **Lower barrier to adoption** - compliance departments approve it
6. ⏰ **Time-bound** - after 2 years, becomes fully open source

**When to choose FSL over ELv2:**
- You want eventual true open source (Apache-2.0)
- You want to build maximum trust with developer community
- You're confident in 2-year head start (network effects)
- You value "eventual open source" as marketing message

**Implementation:**
```
LICENSE (Fair Source License)
Copyright 2026 Smith Horn Group Ltd

Fair Source License, version 0.9

Usage Restriction: You may not use the software to provide
commercial services to third parties that compete directly
with Skillsmith's skill discovery and recommendation services.

Change Date: 2028-01-11 (2 years from first public release)

Change License: Apache License 2.0
```

---

## Detailed Feature Comparison

### What Each License Allows

| Use Case | Apache-2.0 | Elastic License 2.0 | Fair Source (FSL) | BSL 1.1 |
|----------|------------|---------------------|-------------------|---------|
| View source code | ✅ | ✅ | ✅ | ✅ |
| Fork repository | ✅ | ✅ | ✅ | ✅ |
| Modify code | ✅ | ✅ | ✅ | ✅ |
| Use internally (company) | ✅ | ✅ | ✅ | ✅ (with grant) |
| Self-host for team | ✅ | ✅ | ✅ | ✅ (with grant) |
| Offer as SaaS to customers | ✅ ⚠️ | ❌ | ❌ (if competing) | ❌ |
| Commercial use | ✅ | ✅ | ✅ (non-competing) | ⚠️ (needs grant) |
| Embed in proprietary product | ✅ | ✅ | ✅ (non-competing) | ⚠️ (needs grant) |
| Resell API access | ✅ ⚠️ | ❌ | ❌ (if competing) | ❌ |
| Contribute back (PRs) | ✅ | ✅ | ✅ | ✅ |
| Convert to open source later | N/A | No | Yes (2 years) | Yes (4 years max) |

---

## Migration Path: Changing License Post-Launch

**Important:** You CAN change license later, but it's complex:

**If you launch with Apache-2.0:**
- ❌ **Cannot retroactively restrict** code already released
- ❌ Users who forked under Apache-2.0 can keep using that version
- ✅ Can change future releases to protective license
- ⚠️ Creates fragmentation (old Apache-2.0 fork vs new restrictive)

**If you launch with Elastic License 2.0 or FSL:**
- ✅ Can relax to Apache-2.0 later (permissive → more permissive)
- ❌ Hard to make more restrictive (users already have rights)
- ✅ Easier to add open source option (dual licensing)

**Recommendation:** Start restrictive, loosen later if needed. **Going from permissive → restrictive is nearly impossible.**

**Historical examples:**
- **Elastic:** Apache-2.0 → Elastic License 2.0 (caused AWS fork)
- **MongoDB:** AGPL → SSPL (caused Debian/RedHat to drop it)
- **HashiCorp:** MPL → BSL (caused OpenTofu community fork)
- **Redis:** BSD → SSPL → **added back AGPLv3** in 2025 (backlash)

---

## Licensing Strategy for Skillsmith Monorepo

### Recommended Structure

**Option A: Unified Protective License (Simpler)**

```
skillsmith/ (Public Repository)
├── packages/
│   ├── core/          # Elastic License 2.0
│   ├── mcp-server/    # Elastic License 2.0
│   ├── cli/           # Elastic License 2.0
│   └── enterprise/    # Proprietary (separate private repo)
├── LICENSE            # Elastic License 2.0
└── README.md
```

**Pros:**
- Simple - one license for all public code
- Clear boundary: public (ELv2) vs enterprise (proprietary)
- No confusion about which package has which license

---

**Option B: Mixed Licensing (More Complex, More Flexible)**

```
skillsmith/ (Public Repository)
├── packages/
│   ├── core/          # Apache-2.0 (foundational library)
│   ├── mcp-server/    # Elastic License 2.0 (SaaS protection)
│   ├── cli/           # Apache-2.0 (encourage CLI adoption)
│   └── enterprise/    # Proprietary (separate private repo)
├── LICENSE            # Refers to individual package licenses
├── packages/core/LICENSE      # Apache-2.0
├── packages/mcp-server/LICENSE # Elastic License 2.0
└── packages/cli/LICENSE       # Apache-2.0
```

**Pros:**
- Core library is permissive (can be embedded in other projects)
- CLI is permissive (encourages local adoption)
- MCP server is protected (prevents SaaS competition)

**Cons:**
- More complex to communicate
- Users need to understand different licenses per package

---

**Recommendation:** **Option A (Unified ELv2)** for simplicity.

---

## Implementation Checklist

### Before Making Repository Public

- [ ] **Choose license:** Elastic License 2.0 or Fair Source License
- [ ] **Add LICENSE file** to repository root
- [ ] **Add license headers** to all source files (optional but recommended)
- [ ] **Update README.md** with clear license statement
- [ ] **Update package.json** `"license": "Elastic-2.0"` or `"license": "UNLICENSED"`
- [ ] **Create NOTICE file** (for attribution, if using ELv2)
- [ ] **Add FAQ** to docs/legal/ explaining what users can/cannot do
- [ ] **Legal review** (if enterprise/VC-backed, have lawyer review)

### License File Template (Elastic License 2.0)

```markdown
# Elastic License 2.0

Copyright 2026 Smith Horn Group Ltd

## Acceptance

By using the software, you agree to all of the terms and conditions below.

## Limitation

You may not provide the software to third parties as a hosted or managed
service, where the service provides users with access to any substantial
set of the features or functionality of the software.

## Notices

You must ensure that anyone who gets a copy of any part of the software
from you also gets a copy of these terms.

## No Other Rights

These terms do not imply any licenses other than those expressly granted.

---

Full license text: https://www.elastic.co/licensing/elastic-license
```

### License File Template (Fair Source License)

```markdown
# Fair Source License, version 0.9

Copyright 2026 Smith Horn Group Ltd

## Licensor

Smith Horn Group Ltd

## Software

Skillsmith skill discovery and recommendation system

## Use Limitation

You may not use the software to provide commercial services to third
parties that compete directly with Skillsmith's skill discovery,
recommendation, and installation services.

## License Grant

Subject to the Use Limitation, Licensor grants you a non-exclusive,
worldwide, royalty-free license to:
- Use, copy, modify, and create derivative works of the software
- Redistribute the software and derivative works

## Change Date

January 11, 2028 (two years from first public release)

## Change License

Apache License, Version 2.0

On the Change Date, this license automatically converts to the Change
License for all purposes.

---

Full license text: https://fair.io/
```

---

## FAQ

### Q: Can users still contribute to a protective license?

**A:** Yes! Both Elastic License 2.0 and Fair Source License allow:
- Viewing source code ✅
- Forking the repository ✅
- Submitting pull requests ✅
- Reporting bugs ✅
- Using internally ✅

The only restriction is **providing as a managed service to third parties**.

**Example:** Sentry (FSL) has 100+ external contributors despite protective license.

---

### Q: Will npm/PyPI/package registries accept non-OSI licenses?

**A:** Yes, but with caveats:

**npm:**
- ✅ Accepts any license string in `package.json`
- ⚠️ Use `"license": "SEE LICENSE IN LICENSE"` for non-standard licenses
- ✅ Elastic License 2.0: use `"license": "Elastic-2.0"`
- ✅ Fair Source: use `"license": "UNLICENSED"` (then specify in LICENSE file)

**GitHub Packages:**
- ✅ No restrictions on license type

**Example from Elastic's package.json:**
```json
{
  "name": "@elastic/elasticsearch",
  "license": "Apache-2.0 OR Elastic-2.0",
  "description": "Dual licensed under Apache-2.0 and Elastic License 2.0"
}
```

---

### Q: What about CLA (Contributor License Agreement)?

**A:** Optional but recommended:

**Without CLA:**
- Contributors retain copyright to their contributions
- Their contributions are licensed under your license (ELv2 or FSL)
- You **cannot** relicense their code without permission

**With CLA:**
- Contributors grant you rights to relicense their code
- Enables future license changes (e.g., ELv2 → Apache-2.0)
- Protects you from IP disputes

**Recommendation:**
- **Small project:** No CLA needed (simpler)
- **VC-backed/Enterprise:** CLA recommended (flexibility)

**CLA Tools:**
- [CLA Assistant](https://cla-assistant.io/) (free, GitHub bot)
- [EasyCLA](https://lfx.linuxfoundation.org/tools/easycla/) (Linux Foundation)

---

### Q: Can we dual-license (e.g., Elastic License 2.0 OR Apache-2.0)?

**A:** Yes! This is what Elastic does:

```json
{
  "license": "Apache-2.0 OR Elastic-2.0"
}
```

**Benefits:**
- Users choose which license to use
- Apache-2.0 option encourages adoption
- Elastic License 2.0 protects your SaaS business

**Downside:**
- More complex to communicate
- Users can choose permissive option (Apache-2.0) and ignore ELv2

**Recommendation:** Start with single license (ELv2), add dual licensing later if needed.

---

### Q: What if we get acquired? Does license change?

**A:** Depends on license:

**Elastic License 2.0:**
- Acquirer inherits rights as new licensor
- Can continue under ELv2 or change license for future releases
- Existing releases remain under ELv2 (cannot retroactively change)

**Fair Source License:**
- Converts to Apache-2.0 after 2 years (automatic, cannot be stopped)
- Acquirer cannot prevent conversion
- Good for M&A: buyers know code becomes open source

---

## Conclusion

### For Skillsmith: Choose **Elastic License 2.0**

**Why:**
1. ✅ You haven't launched - **now is the time to choose protective license**
2. ✅ **Public repository + IP protection** - best of both worlds
3. ✅ **Prevents SaaS competition** - no one can offer "Skillsmith-as-a-Service"
4. ✅ **Compatible with $9.99/mo pricing** - protects your revenue model
5. ✅ **Simple to communicate** - "public code, can't resell as service"
6. ✅ **No future commitment** - permanent protection, no time limit
7. ✅ **Proven success** - Elastic (multi-billion dollar company) uses it

### Don't use Apache-2.0 because:
- ❌ Competitors can fork and compete directly with your SaaS
- ❌ Cloud providers can offer "Managed Skillsmith" without paying you
- ❌ No protection for your $9.99/mo pricing model
- ❌ Hard to add restrictions later (existing forks retain permissive license)

### Alternative: Fair Source License if:
- You want eventual open source (converts to Apache-2.0 after 2 years)
- You want to maximize developer trust
- You're confident in network effects (2-year head start sufficient)

---

## Next Steps

1. **Decision:** Choose Elastic License 2.0 or Fair Source License
2. **Legal review:** Have lawyer review license choice (if VC-backed)
3. **Update repository:**
   - Add LICENSE file
   - Update package.json
   - Update README.md
4. **Make repository public** (see [Repository Visibility Strategy](./repository-visibility-strategy.md))
5. **Announce:** "Skillsmith is now public - source-available under Elastic License 2.0"

---

## References

### License Texts
- [Elastic License 2.0](https://www.elastic.co/licensing/elastic-license)
- [Fair Source License](https://fair.io/)
- [Business Source License 1.1](https://mariadb.com/bsl11/)

### Industry Examples
- [Elastic License v2 Announcement](https://www.elastic.co/blog/elastic-license-v2)
- [Sentry Fair Source Announcement](https://blog.sentry.io/sentry-is-now-fair-source/)
- [HashiCorp BSL Adoption](https://www.hashicorp.com/en/blog/hashicorp-adopts-business-source-license)

### Analysis
- [TechCrunch: Fair Source Movement](https://techcrunch.com/2024/09/22/some-startups-are-going-fair-source-to-avoid-the-pitfalls-of-open-source-licensing/)
- [FOSSA: Source-Available Licenses Guide](https://fossa.com/blog/comprehensive-guide-source-available-software-licenses/)
- [FSL vs AGPL Analysis](https://lucumr.pocoo.org/2024/9/23/fsl-agpl-open-source-businesses/)

### Related Skillsmith Docs
- [Free Tier Pricing Strategy](./free-tier-pricing-strategy.md)
- [Repository Visibility Strategy](./repository-visibility-strategy.md)
- [ADR-013: Open Core Licensing](../adr/013-open-core-licensing.md)
