# Basic Usage

Essential release commands and simple deployment workflows.

---

## Create Release Draft

```bash
# Get last release tag
LAST_TAG=$(gh release list --limit 1 --json tagName -q '.[0].tagName')

# Generate changelog from commits
CHANGELOG=$(gh api repos/:owner/:repo/compare/${LAST_TAG}...HEAD \
  --jq '.commits[].commit.message')

# Create draft release
gh release create v2.0.0 \
  --draft \
  --title "Release v2.0.0" \
  --notes "$CHANGELOG" \
  --target main
```

---

## Version Bump

### NPM Version Commands

```bash
# Update package.json version
npm version patch  # 1.0.0 -> 1.0.1
npm version minor  # 1.0.0 -> 1.1.0
npm version major  # 1.0.0 -> 2.0.0

# Push version tag
git push --follow-tags
```

### Manual Version Update

```bash
# Edit package.json
# Update version field

# Create and push tag
git tag v2.0.0
git push origin v2.0.0
```

---

## Simple Deployment

### NPM Package

```bash
# Build and publish
npm run build
npm publish

# Create GitHub release
gh release create $(npm pkg get version) \
  --generate-notes
```

### Docker Image

```bash
# Build image
docker build -t myapp:v2.0.0 .

# Push to registry
docker push myapp:v2.0.0
```

---

## Quick Integration Example

```javascript
// Simple release preparation in Claude Code
[Single Message]:
  // Update version files
  Edit("package.json", { old: '"version": "1.0.0"', new: '"version": "2.0.0"' })

  // Generate changelog
  Bash("gh api repos/:owner/:repo/compare/v1.0.0...HEAD --jq '.commits[].commit.message' > CHANGELOG.md")

  // Create release branch
  Bash("git checkout -b release/v2.0.0")
  Bash("git add -A && git commit -m 'release: Prepare v2.0.0'")

  // Create PR
  Bash("gh pr create --title 'Release v2.0.0' --body 'Automated release preparation'")
```

---

## Release Branch Workflow

### Create Release Branch

```bash
# Create branch from main
git checkout -b release/v2.0.0 main

# Update version
npm version 2.0.0 --no-git-tag-version

# Commit changes
git add -A
git commit -m "chore: Bump version to 2.0.0"

# Push branch
git push -u origin release/v2.0.0
```

### Create Pull Request

```bash
gh pr create \
  --title "Release v2.0.0" \
  --body "Release preparation for v2.0.0" \
  --head release/v2.0.0 \
  --base main
```

### Finalize Release

```bash
# After PR is merged
git checkout main
git pull

# Create release
gh release create v2.0.0 \
  --generate-notes \
  --title "Release v2.0.0"
```

---

## Changelog Generation

### From Commits

```bash
# Get commits since last release
gh api repos/:owner/:repo/compare/v1.0.0...HEAD \
  --jq '.commits[].commit.message'
```

### From PRs

```bash
# Get merged PRs since last release
gh pr list --state merged --base main \
  --json number,title,labels,author \
  --jq '.[] | "- \(.title) (#\(.number)) by @\(.author.login)"'
```

### Automatic Generation

```bash
# Use GitHub's auto-generated notes
gh release create v2.0.0 --generate-notes
```

---

## Pre-Release Validation

```bash
# Run tests
npm test

# Run linting
npm run lint

# Build to verify
npm run build

# Check for security issues
npm audit
```
