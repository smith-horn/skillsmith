# Enterprise Package Split Guide

**Date:** January 15, 2026
**Related:** IP Sensitivity Review

---

## Overview

Split `packages/enterprise/` from the main Skillsmith monorepo into a separate private repository (`skillsmith-enterprise`).

---

## Step 1: Create the New Private Repository

```bash
# On GitHub, create new private repo: skillsmith-enterprise
# Or via CLI:
gh repo create Smith-Horn/skillsmith-enterprise --private --description "Skillsmith Enterprise Package (Proprietary)"
```

---

## Step 2: Extract Enterprise Package with History

```bash
# Clone a fresh copy for extraction
git clone git@github.com:wrsmith108/skillsmith.git skillsmith-extract
cd skillsmith-extract

# Use git-filter-repo to extract ONLY packages/enterprise/
git filter-repo --subdirectory-filter packages/enterprise/

# Add the new remote
git remote add origin git@github.com:Smith-Horn/skillsmith-enterprise.git

# Push to new repo
git push -u origin main
```

---

## Step 3: Set Up Enterprise Repo Structure

After extraction, restructure to be a standalone package:

```
skillsmith-enterprise/
├── src/
│   ├── audit/
│   ├── license/
│   └── quota/
├── tests/
├── package.json          # Update name to @skillsmith/enterprise
├── tsconfig.json
├── LICENSE.md            # Elastic License 2.0
└── README.md
```

Update `package.json`:
```json
{
  "name": "@skillsmith/enterprise",
  "version": "0.1.0",
  "private": true,
  "license": "SEE LICENSE IN LICENSE.md",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/Smith-Horn/skillsmith-enterprise.git"
  },
  "peerDependencies": {
    "@skillsmith/core": "^0.1.0"
  }
}
```

---

## Step 4: Remove from Main Repo

In the main skillsmith repo:

```bash
# Already added to .gitignore, but also remove from tracking
git rm -r --cached packages/enterprise/

# Commit the removal
git commit -m "chore: remove enterprise package (moved to private repo)

Enterprise package split to separate private repository
for IP protection. See skillsmith-enterprise repo.

Refs: IP sensitivity review 2026-01-15"
```

---

## Step 5: Update Main Repo References

### Update root package.json workspaces

```json
{
  "workspaces": [
    "packages/core",
    "packages/mcp-server",
    "packages/cli",
    "packages/vscode-extension",
    "packages/website"
    // Remove: "packages/enterprise"
  ]
}
```

### Update tsconfig.json references

Remove enterprise from any TypeScript project references.

### Update CI/CD

- Main repo CI: Remove enterprise build/test steps
- Create separate CI for enterprise repo
- Set up npm publishing from private repo to private registry

---

## Step 6: Set Up Cross-Repo Development

For local development where you need both:

```bash
# Clone both repos side by side
git clone git@github.com:wrsmith108/skillsmith.git
git clone git@github.com:Smith-Horn/skillsmith-enterprise.git

# In skillsmith-enterprise, link to local core
cd skillsmith-enterprise
npm link ../skillsmith/packages/core
```

Or use npm workspaces with a local override:

```bash
# In enterprise repo
npm install ../skillsmith/packages/core
```

---

## Step 7: Private npm Registry Setup

For distributing enterprise package to customers:

### Option A: GitHub Packages (Recommended)

```bash
# In skillsmith-enterprise
npm config set @skillsmith:registry https://npm.pkg.github.com

# Publish
npm publish
```

Customers authenticate with GitHub token to access.

### Option B: Private npm Registry

Use Verdaccio, Nexus, or Artifactory for self-hosted private registry.

---

## Verification Checklist

- [ ] Enterprise repo created and private
- [ ] Package history preserved in new repo
- [ ] packages/enterprise/ removed from main repo git tracking
- [ ] .gitignore updated (done)
- [ ] Main repo workspaces updated
- [ ] CI/CD updated for both repos
- [ ] Cross-repo development workflow documented
- [ ] Private npm publishing configured

---

## Rollback Plan

If issues arise:

```bash
# Enterprise package still exists locally (gitignored)
# Simply remove from .gitignore and re-add to tracking
git add packages/enterprise/
git commit -m "revert: restore enterprise package to monorepo"
```

---

## Timeline Estimate

| Task | Effort |
|------|--------|
| Create repo & extract | 30 min |
| Restructure package | 1 hour |
| Update main repo | 30 min |
| CI/CD setup | 2 hours |
| Testing | 1 hour |
| **Total** | **~5 hours** |
