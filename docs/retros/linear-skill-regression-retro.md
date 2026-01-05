# Retrospective: Linear Skill Regressions

**Date**: January 4, 2026
**Severity**: High - Recurring issues across multiple phases
**Status**: Root causes identified, fixes proposed

---

## Problems Encountered

### Problem 1: Projects Not Linked to Initiatives
**Frequency**: Every phase creation
**Impact**: Projects invisible in roadmap views, broken initiative tracking

| Script | Links to Initiative? |
|--------|---------------------|
| `create-phase5-issues.ts` | ❌ No |
| `create-phase6-issues.ts` | ❌ No |
| `create-next-steps.ts` | ❌ No |
| `fix-skillsmith-structure.ts` | ⚠️ Attempted, failed |

**Root Cause**: Scripts create projects but never call `initiativeToProjectCreate`. The SKILL.md documents this mutation (line 773-797) but no script implements it correctly.

**Failed Fix Attempt**:
```typescript
// fix-skillsmith-structure.ts line 249
await client.client.rawRequest(`
  mutation {
    projectUpdate(id: "${proj.id}", input: { initiativeIds: ["${SKILLSMITH_INITIATIVE_ID}"] }) {
      success
    }
  }
`)
```
This fails because `initiativeIds` is not a valid field on `projectUpdate`. The correct mutation is `initiativeToProjectCreate`.

---

### Problem 2: Missing Detailed Descriptions/Resources
**Frequency**: Every project creation
**Impact**: Projects appear empty in Linear UI

| Field | Limit | Scripts Use? |
|-------|-------|--------------|
| `description` | 255 chars | ✅ Yes (but gets truncated) |
| `content` | Unlimited | ❌ No |
| Resource links | N/A | ❌ No |
| Milestones (DOD) | N/A | ❌ No |

**Root Cause**: Scripts only set `description`, ignoring the `content` field which displays in the main panel. The SKILL.md documents this (line 650-669) but scripts don't implement it.

**Evidence**:
```typescript
// create-phase6-issues.ts line 657-662
const projectResult = await client.createProject({
  teamIds: [team.id],
  name: 'Phase 6: Website & Subscription Portal',
  description: 'Marketing website + Stripe-powered subscription portal...',
  state: 'planned'
  // Missing: content, resourceLinks, milestones
})
```

---

### Problem 3: Missing Labels on Issues
**Frequency**: ~50% of issues
**Impact**: Issues not filterable, hard to track by category

| Issue | Labels Defined | Labels Applied? |
|-------|----------------|-----------------|
| SMI-1048 | npm, ci, security | Initially only Security |
| SMI-1053 | enterprise, security | Initially only Security |
| SMI-1062 | billing, backend | Initially none |

**Root Causes**:

1. **Case sensitivity**: Label lookup is lowercase but Linear labels may have mixed case
   ```typescript
   // create-phase6-issues.ts line 683
   const labelMap = new Map(labelsResult.nodes.map(l => [l.name.toLowerCase(), l.id]))
   // But issue.labels has 'website' not 'Website'
   ```

2. **Missing labels in requiredLabels**: Not all labels defined in issues are in the creation list
   ```typescript
   // Missing from requiredLabels: npm, ci, security, build, automation, legal, enterprise, mcp, etc.
   const requiredLabels = ['website', 'frontend', 'backend', 'billing', 'stripe', 'auth', 'documentation', 'dashboard', 'phase-6']
   ```

3. **No verification**: Scripts don't verify labels were actually applied

---

### Problem 4: Wrong Issue Count (17 vs 19)
**Expected**: 19 issues (6 + 7 + 4 + 2 auth issues)
**Actual**: 17 issues (SMI-1072 to SMI-1088)

**Root Cause**: Duplicate issue detection. When script re-ran, it found existing project and continued, but some issues may have been skipped as duplicates or failed silently.

**Evidence**:
```typescript
// create-phase6-issues.ts line 744-748
const created = await result.issue
if (created) {
  console.log(`  Created: ${created.identifier} - ${issue.title}`)
  issueCount++
}
// No else clause - silent failure!
```

**Missing**:
- No final count validation
- No comparison of expected vs actual
- No retry logic for failed creates
- No duplicate detection

---

## Root Cause Analysis

### Pattern: Copy-Paste Without Validation
Scripts are created by copying previous scripts without:
1. Checking if mandatory steps are included
2. Running validation after execution
3. Documenting what steps are required

### Pattern: No Standard Template
Each script is slightly different with no shared base:
- Different label handling
- Different project creation
- Different error handling
- No shared utilities

### Pattern: No Post-Execution Verification
Scripts complete without verifying:
- Project linked to initiative
- All labels applied
- All issues created
- Project has content/resources

---

## Proposed Fixes

### Fix 1: Create Standard Project Template

```typescript
// scripts/lib/project-template.ts
export interface ProjectConfig {
  name: string
  initiative: string  // Required - must link
  shortDescription: string  // 255 chars
  content: string  // Full markdown
  resources: { label: string; url: string }[]
  milestones: { name: string; description: string }[]
  labels: string[]  // All labels to create
  issues: IssueConfig[]
}

export async function createProject(config: ProjectConfig): Promise<CreateResult> {
  // 1. Validate config
  // 2. Create/find project
  // 3. Link to initiative (MANDATORY)
  // 4. Set content (full markdown)
  // 5. Create resource links
  // 6. Create milestones
  // 7. Create/verify labels
  // 8. Create issues with labels
  // 9. Verify all steps completed
  // 10. Return summary with any failures
}
```

### Fix 2: Add Initiative Linking

```typescript
// scripts/lib/initiative.ts
export async function linkProjectToInitiative(
  projectId: string,
  initiativeId: string
): Promise<boolean> {
  const mutation = `
    mutation {
      initiativeToProjectCreate(input: {
        initiativeId: "${initiativeId}",
        projectId: "${projectId}"
      }) {
        success
      }
    }
  `
  const result = await graphqlRequest(mutation)
  return result.data?.initiativeToProjectCreate?.success === true
}
```

### Fix 3: Add Project Content Setting

```typescript
// scripts/lib/project-content.ts
export async function setProjectContent(
  projectId: string,
  content: string,  // Full markdown
  description: string  // 255 char summary
): Promise<boolean> {
  const mutation = `
    mutation {
      projectUpdate(id: "${projectId}", input: {
        content: ${JSON.stringify(content)},
        description: ${JSON.stringify(description.substring(0, 255))}
      }) {
        success
      }
    }
  `
  // ...
}
```

### Fix 4: Add Label Verification

```typescript
// scripts/lib/labels.ts
export async function ensureLabelsExist(
  teamId: string,
  labelNames: string[]
): Promise<Map<string, string>> {
  const labelMap = new Map<string, string>()

  // 1. Get all existing labels
  const existing = await client.issueLabels({
    filter: { team: { id: { eq: teamId } } }
  })

  // 2. Build case-insensitive map
  for (const label of existing.nodes) {
    labelMap.set(label.name.toLowerCase(), label.id)
  }

  // 3. Create missing labels
  for (const name of labelNames) {
    const key = name.toLowerCase()
    if (!labelMap.has(key)) {
      const created = await createLabel(teamId, name)
      if (created) {
        labelMap.set(key, created.id)
      }
    }
  }

  return labelMap
}

export async function verifyLabelsApplied(
  issueId: string,
  expectedLabels: string[]
): Promise<{ applied: string[]; missing: string[] }> {
  const issue = await client.issue(issueId)
  const labels = await issue.labels()
  const applied = labels.nodes.map(l => l.name.toLowerCase())
  const missing = expectedLabels.filter(l => !applied.includes(l.toLowerCase()))
  return { applied, missing }
}
```

### Fix 5: Add Post-Execution Verification

```typescript
// scripts/lib/verify.ts
export interface VerificationResult {
  project: {
    exists: boolean
    linkedToInitiative: boolean
    hasContent: boolean
    hasResources: boolean
    hasMilestones: boolean
  }
  issues: {
    expected: number
    created: number
    withLabels: number
    failures: string[]
  }
}

export async function verifyProjectCreation(
  projectId: string,
  initiativeId: string,
  expectedIssueCount: number
): Promise<VerificationResult> {
  // Run all checks and return comprehensive report
}
```

### Fix 6: Update SKILL.md with Mandatory Checklist

Add to SKILL.md:

```markdown
## MANDATORY: Project Creation Checklist

Every script that creates a project MUST:

1. [ ] Link project to initiative via `initiativeToProjectCreate`
2. [ ] Set `content` field with full markdown
3. [ ] Set `description` field with 255-char summary
4. [ ] Create resource links to docs/repos
5. [ ] Create milestones for Definition of Done
6. [ ] Create/verify all required labels exist
7. [ ] Create issues with labels
8. [ ] Verify issue count matches expected
9. [ ] Run post-execution verification
10. [ ] Output summary with any failures
```

---

## Action Items

| Priority | Action | Effort |
|----------|--------|--------|
| P0 | Create `scripts/lib/` shared utilities | 2 hours |
| P0 | Add initiative linking to all scripts | 1 hour |
| P0 | Add post-execution verification | 1 hour |
| P1 | Update SKILL.md with mandatory checklist | 30 min |
| P1 | Fix missing 2 Phase 6 issues | 15 min |
| P1 | Create project template function | 1 hour |
| P2 | Add tests for Linear scripts | 2 hours |

---

## Immediate Fixes Needed

### Fix Skillsmith Initiative Links

```bash
# Run this mutation for each project
npx tsx scripts/query.ts 'mutation {
  initiativeToProjectCreate(input: {
    initiativeId: "5e1cebfe-f4bb-42c1-988d-af792fc4253b",
    projectId: "<project-uuid>"
  }) { success }
}'
```

### Create Missing Phase 6 Issues

Check which 2 issues are missing from the 19 defined:
1. Count issues in script array
2. Count issues in Linear (17)
3. Find the gap

---

## Prevention

1. **Pre-commit hook**: Validate scripts include initiative linking
2. **Template enforcement**: All new scripts must use `createProject()` template
3. **CI check**: Verify all Skillsmith projects linked to initiative
4. **Weekly audit**: Run verification script on all projects

---

## Resolution (January 4, 2026)

### Implemented Fixes

| Fix | Status | Location |
|-----|--------|----------|
| Shared lib/ utilities | ✅ Complete | `scripts/lib/` |
| Initiative linking utility | ✅ Complete | `lib/initiative.ts` |
| Label verification utility | ✅ Complete | `lib/labels.ts` |
| Post-execution verification | ✅ Complete | `lib/verify.ts` |
| Project creation template | ✅ Complete | `lib/project-template.ts` |
| SKILL.md mandatory checklist | ✅ Complete | SKILL.md lines 836-894 |

### Verification Results

After implementing fixes:
- **14 Skillsmith projects found**
- **13 projects pass verification** (all linked to initiative)
- **1 project fails** (Parking Lot - missing description, expected)
- **Phase 6 issue count confirmed**: 17 issues (SMI-1072 to SMI-1088)

### Bug Fixed

The `isProjectLinkedToInitiative` function was incorrectly checking `project.initiative` (singular field that doesn't exist). Fixed to query from initiative side using `initiative.projects.nodes`.

### Usage Going Forward

```typescript
// Use the shared lib/ utilities for ALL project operations
import {
  createSkillsmithProject,
  linkProjectToInitiative,
  ensureLabelsExist,
  verifyProjectCreation,
  INITIATIVES
} from './lib'

// Run verification after any project creation
npx tsx scripts/lib/verify.ts all
```
