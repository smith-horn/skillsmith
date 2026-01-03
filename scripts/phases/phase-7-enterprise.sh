#!/usr/bin/env bash
#
# Phase 7: Enterprise Implementation Execution Script
# ====================================================
# Creates a worktree and launches Claude Code for Phase 7 enterprise features.
#
# DEPENDENCY: Phase 5 npm publishing should be complete or in progress.
# This phase can start design/architecture while Phase 5 completes.
#
# Usage:
#   ./scripts/phases/phase-7-enterprise.sh [--dry-run] [--week N]
#
# Prerequisites (MANUAL):
#   1. LINEAR_API_KEY set in environment (via Varlock)
#   2. Docker container running
#   3. Phase 5 npm packages published (for integration testing)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKTREE_DIR="$PROJECT_ROOT/../worktrees"
WORKTREE_NAME="phase-7-enterprise"
WORKTREE_PATH="$WORKTREE_DIR/$WORKTREE_NAME"
BRANCH_NAME="phase-7/enterprise-implementation"

DRY_RUN=false
WEEK=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --week)
      WEEK="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

echo "=============================================="
echo "Phase 7: Enterprise Implementation Setup"
echo "=============================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check prerequisites
echo "Checking prerequisites..."

# 1. Docker container
if ! docker ps --filter name=skillsmith-dev-1 --format "{{.Status}}" | grep -q "Up"; then
  echo -e "${YELLOW}⚠ Docker container not running. Starting...${NC}"
  if [[ "$DRY_RUN" == "false" ]]; then
    cd "$PROJECT_ROOT"
    docker compose --profile dev up -d
    sleep 5
  fi
fi
echo -e "${GREEN}✓ Docker container running${NC}"

# 2. Check if Phase 5 packages are published
echo "Checking Phase 5 npm packages..."
CORE_PUBLISHED=$(npm view @skillsmith/core version 2>/dev/null || echo "not-published")
if [[ "$CORE_PUBLISHED" == "not-published" ]]; then
  echo -e "${YELLOW}⚠ @skillsmith/core not yet published on npm${NC}"
  echo "   Phase 7 can proceed with design work, but integration testing requires Phase 5."
else
  echo -e "${GREEN}✓ @skillsmith/core published (v$CORE_PUBLISHED)${NC}"
fi

# 3. LINEAR_API_KEY
if command -v varlock &>/dev/null; then
  if ! varlock load --quiet 2>/dev/null; then
    echo -e "${YELLOW}⚠ Varlock validation failed. Ensure LINEAR_API_KEY is set.${NC}"
  else
    echo -e "${GREEN}✓ Varlock environment validated${NC}"
  fi
fi

echo ""
echo "Creating worktree for Phase 7..."

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY-RUN] Would create: $WORKTREE_PATH"
  echo "[DRY-RUN] Branch: $BRANCH_NAME"
else
  # Ensure we're on latest main
  cd "$PROJECT_ROOT"
  git fetch origin main
  git checkout main
  git pull origin main

  # Create worktree directory
  mkdir -p "$WORKTREE_DIR"

  # Check if worktree already exists
  if git worktree list | grep -q "$WORKTREE_PATH"; then
    echo -e "${YELLOW}Worktree already exists. Using existing worktree.${NC}"
  else
    # Create the worktree
    git worktree add "$WORKTREE_PATH" -b "$BRANCH_NAME" 2>/dev/null || \
      git worktree add "$WORKTREE_PATH" "$BRANCH_NAME"
  fi

  cd "$WORKTREE_PATH"
  git fetch origin main
  git rebase origin/main || true
fi

echo ""
echo -e "${GREEN}Worktree created at: $WORKTREE_PATH${NC}"
echo ""

# Generate week-specific or full prompt
if [[ -n "$WEEK" ]]; then
  case "$WEEK" in
    1|2)
      cat << 'WEEK12_PROMPT'
================================================================================
PHASE 7: ENTERPRISE - WEEK 1-2: LICENSE VALIDATION
================================================================================
Session: phase-7-enterprise
Branch: phase-7/enterprise-implementation
Focus: License Key Validation System

## OBJECTIVE
Implement the core license validation system for enterprise features.

## ISSUES
- Part of SMI-942: Enterprise Package Implementation
- Related: License Key Generation and Validation (SMI-952)

## TASKS

### Week 1: Core Implementation
- [ ] Set up packages/enterprise package structure
- [ ] Implement JWT parsing and validation (jose library)
- [ ] Create LicenseValidator class
- [ ] Implement online validation against license API
- [ ] Add license caching mechanism
- [ ] Unit tests for validation logic

### Week 2: Offline & Advanced Features
- [ ] Implement offline validation with cached public keys
- [ ] Add key rotation support (KeyRotationManager)
- [ ] Create grace period handling (7 days)
- [ ] Add feature flag checking (hasFeature)
- [ ] Integration with @skillsmith/core
- [ ] E2E tests for license flows
- [ ] Documentation

## KEY FILES TO CREATE
packages/enterprise/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── types.ts
│   ├── license/
│   │   ├── index.ts
│   │   ├── LicenseValidator.ts
│   │   ├── LicenseKeyParser.ts
│   │   ├── OfflineValidator.ts
│   │   └── KeyRotation.ts
│   └── config/
│       └── EnterpriseConfig.ts
└── tests/
    └── license/

## REFERENCE DOCS
- docs/enterprise/ENTERPRISE_PACKAGE.md §2
- docs/adr/014-enterprise-package-architecture.md

## DOCKER COMMANDS
docker exec skillsmith-dev-1 npm run build
docker exec skillsmith-dev-1 npm test -- packages/enterprise

================================================================================
WEEK12_PROMPT
      ;;
    3|4)
      cat << 'WEEK34_PROMPT'
================================================================================
PHASE 7: ENTERPRISE - WEEK 3-4: AUDIT LOGGING
================================================================================
Session: phase-7-enterprise
Branch: phase-7/enterprise-implementation
Focus: Enterprise Audit Logging System

## OBJECTIVE
Implement the enterprise audit logging system with SIEM integration.

## ISSUES
- SMI-957: EnterpriseAuditLogger base class (P1)
- SMI-958: SIEM Exporter - Splunk (P2)
- SMI-959: SIEM Exporter - AWS CloudWatch (P2)
- SMI-960: SIEM Exporter - Datadog (P2)
- SMI-961: 90-Day Configurable Retention (P2)
- SMI-962: SOC 2 Compliant Formatting (P2)
- SMI-963: Real-Time Event Streaming (P2)
- SMI-964: SSO/RBAC Event Types (P1)
- SMI-965: Immutable Log Storage (P3)

## TASKS

### Week 3: Core Audit System
- [ ] Design audit event schema (AuditEventTypes.ts)
- [ ] Implement EnterpriseAuditLogger extending CoreAuditLogger
- [ ] Create event type definitions (SSO, RBAC, License events)
- [ ] Build JSON formatter
- [ ] Set up SQLite storage for audit logs
- [ ] Add retention policy framework
- [ ] Unit tests

### Week 4: SIEM & Export
- [ ] Implement Syslog formatter (RFC 5424)
- [ ] Add CEF formatter
- [ ] Create SplunkExporter (HEC integration)
- [ ] Build CloudWatchExporter (AWS SDK v3)
- [ ] Create DatadogExporter
- [ ] Implement real-time event streaming (WebSocket/SSE)
- [ ] Integration with license module
- [ ] E2E tests for audit flows

## KEY FILES TO CREATE
packages/enterprise/src/audit/
├── index.ts
├── AuditLogger.ts           # EnterpriseAuditLogger
├── AuditEventTypes.ts       # Event definitions
├── formatters/
│   ├── JSONFormatter.ts
│   ├── SyslogFormatter.ts
│   └── CEFFormatter.ts
├── exporters/
│   ├── SplunkExporter.ts
│   ├── CloudWatchExporter.ts
│   └── DatadogExporter.ts
├── retention/
│   ├── RetentionPolicy.ts
│   └── RetentionEnforcer.ts
└── streaming/
    └── EventStream.ts

## REFERENCE DOCS
- docs/architecture/audit-logging-architecture.md
- docs/enterprise/ENTERPRISE_PACKAGE.md §4
- ADR-008: Security Hardening Phase

================================================================================
WEEK34_PROMPT
      ;;
    5|6)
      cat << 'WEEK56_PROMPT'
================================================================================
PHASE 7: ENTERPRISE - WEEK 5-6: SSO/SAML
================================================================================
Session: phase-7-enterprise
Branch: phase-7/enterprise-implementation
Focus: SSO/SAML Integration

## OBJECTIVE
Implement SSO/SAML integration for enterprise identity providers.

## ISSUES
- Part of SMI-942: Enterprise Package Implementation
- Related: SSO/RBAC Event Types (SMI-964)

## TASKS

### Week 5: SAML Implementation
- [ ] Implement SAML parser (saml2-js)
- [ ] Create SP metadata generator
- [ ] Build assertion consumer service
- [ ] Add signature validation
- [ ] Implement attribute mapping
- [ ] Create session management
- [ ] Unit tests for SAML flows

### Week 6: OIDC & Provider Integration
- [ ] Implement OIDC client (openid-client)
- [ ] Add token management (TokenManager)
- [ ] Create OktaProvider
- [ ] Create AzureADProvider
- [ ] Create GoogleWorkspaceProvider
- [ ] Build SSOManager orchestration
- [ ] Integration with audit logging (SSO events)
- [ ] E2E tests with mock IdP

## KEY FILES TO CREATE
packages/enterprise/src/sso/
├── index.ts
├── SSOManager.ts
├── providers/
│   ├── OktaProvider.ts
│   ├── AzureADProvider.ts
│   └── GoogleWorkspaceProvider.ts
├── saml/
│   ├── SAMLParser.ts
│   ├── SAMLValidator.ts
│   └── SAMLConfig.ts
└── oidc/
    ├── OIDCClient.ts
    ├── TokenManager.ts
    └── JWKSFetcher.ts

## REFERENCE DOCS
- docs/enterprise/ENTERPRISE_PACKAGE.md §3
- Okta SAML Setup Guide
- Azure AD SAML Configuration

================================================================================
WEEK56_PROMPT
      ;;
    7|8)
      cat << 'WEEK78_PROMPT'
================================================================================
PHASE 7: ENTERPRISE - WEEK 7-8: RBAC
================================================================================
Session: phase-7-enterprise
Branch: phase-7/enterprise-implementation
Focus: Role-Based Access Control

## OBJECTIVE
Implement RBAC system with policy engine.

## ISSUES
- Part of SMI-942: Enterprise Package Implementation
- Related: SSO/RBAC Event Types (SMI-964)

## TASKS

### Week 7: Core RBAC
- [ ] Design role schema
- [ ] Implement role hierarchy (admin > manager > user > viewer)
- [ ] Create PermissionChecker
- [ ] Build RBACManager API
- [ ] Add user-role assignment
- [ ] Implement permission inheritance
- [ ] Unit tests

### Week 8: Policy Engine & Integration
- [ ] Implement PolicyEngine
- [ ] Create PolicyLoader
- [ ] Add default policies
- [ ] Build condition evaluator (ABAC)
- [ ] Integrate with SSO for role mapping
- [ ] Add audit logging for authz events
- [ ] Create middleware for route protection
- [ ] E2E tests

## PERMISSION MATRIX
| Permission | Admin | Manager | Publisher | User | Viewer |
|------------|:-----:|:-------:|:---------:|:----:|:------:|
| skill:publish | Y | Y | Y | N | N |
| user:create | Y | N | N | N | N |
| settings:update | Y | N | N | N | N |
| audit:export | Y | N | N | N | N |

## KEY FILES TO CREATE
packages/enterprise/src/rbac/
├── index.ts
├── RBACManager.ts
├── PermissionChecker.ts
├── RoleHierarchy.ts
└── policies/
    ├── PolicyEngine.ts
    ├── PolicyLoader.ts
    └── DefaultPolicies.ts

## REFERENCE DOCS
- docs/enterprise/ENTERPRISE_PACKAGE.md §5
- ADR-014: Enterprise Package Architecture

================================================================================
WEEK78_PROMPT
      ;;
    9|10)
      cat << 'WEEK910_PROMPT'
================================================================================
PHASE 7: ENTERPRISE - WEEK 9-10: PRIVATE REGISTRY
================================================================================
Session: phase-7-enterprise
Branch: phase-7/enterprise-implementation
Focus: Private Registry Support

## OBJECTIVE
Implement private skill registry with publishing workflow.

## ISSUES
- Part of SMI-942: Enterprise Package Implementation
- Related: ADR-015: Private Registry Architecture

## TASKS

### Week 9: Registry Client
- [ ] Design registry API spec
- [ ] Implement PrivateRegistry client
- [ ] Add authentication handlers (OAuth2, mTLS)
- [ ] Build SkillPublisher
- [ ] Create validation pipeline
- [ ] Implement version management
- [ ] Unit tests

### Week 10: Sync & Integration
- [ ] Add RegistrySync for public registry mirroring
- [ ] Implement caching layer
- [ ] Create review workflow (approval states)
- [ ] Build deprecation handling
- [ ] Integrate with RBAC for publish permissions
- [ ] Add audit logging for publish events
- [ ] E2E tests with mock registry
- [ ] Final integration testing
- [ ] Documentation
- [ ] Release preparation

## KEY FILES TO CREATE
packages/enterprise/src/registry/
├── index.ts
├── PrivateRegistry.ts
├── RegistryAuth.ts
├── SkillPublisher.ts
├── RegistrySync.ts
└── types.ts

## REFERENCE DOCS
- docs/enterprise/ENTERPRISE_PACKAGE.md §6
- ADR-015: Private Registry Architecture

================================================================================
WEEK910_PROMPT
      ;;
    *)
      echo "Invalid week: $WEEK. Use 1-10."
      exit 1
      ;;
  esac
else
  # Full Phase 7 prompt
  cat << 'PHASE7_PROMPT'
================================================================================
PHASE 7: ENTERPRISE IMPLEMENTATION
================================================================================
Session: phase-7-enterprise
Branch: phase-7/enterprise-implementation
Target: February 28, 2026
Estimated Effort: 10 weeks (40+ hours)

## OBJECTIVE
Implement the @skillsmith/enterprise package with SSO, RBAC, audit logging,
license validation, and private registry support.

## PHASE 5 DEPENDENCY
Phase 5 (npm publishing) should complete before integration testing.
Design and architecture work can proceed in parallel.

## IMPLEMENTATION ROADMAP (10 Weeks)

### Week 1-2: License Validation
- [ ] Set up packages/enterprise structure
- [ ] Implement LicenseValidator (JWT-based)
- [ ] Add offline validation with cached keys
- [ ] Create key rotation support
- [ ] 7-day grace period handling

### Week 3-4: Audit Logging
- [ ] EnterpriseAuditLogger extending CoreAuditLogger
- [ ] SIEM exporters (Splunk, CloudWatch, Datadog)
- [ ] 90-day configurable retention
- [ ] SOC 2 compliant formatting
- [ ] Real-time event streaming

### Week 5-6: SSO/SAML
- [ ] SAML 2.0 implementation
- [ ] OIDC support
- [ ] Provider integrations (Okta, Azure AD, Google)
- [ ] Session management

### Week 7-8: RBAC
- [ ] Role hierarchy (admin > manager > user > viewer)
- [ ] Permission checker
- [ ] Policy engine with ABAC
- [ ] SSO role mapping

### Week 9-10: Private Registry
- [ ] Registry client with OAuth2/mTLS
- [ ] Skill publishing workflow
- [ ] Review/approval states
- [ ] Public registry sync

## LINEAR ISSUES

### P1 - High Priority
- SMI-942: Enterprise Package Implementation (Epic)
- SMI-957: EnterpriseAuditLogger base class
- SMI-964: SSO/RBAC Event Types
- SMI-951: Payment Integration (Stripe)
- SMI-952: License Key Generation

### P2 - Medium Priority
- SMI-958: SIEM Exporter - Splunk
- SMI-959: SIEM Exporter - AWS CloudWatch
- SMI-960: SIEM Exporter - Datadog
- SMI-961: 90-Day Configurable Retention
- SMI-962: SOC 2 Compliant Formatting
- SMI-963: Real-Time Event Streaming
- SMI-953: Marketing Website
- SMI-954: Support Infrastructure
- SMI-955: Status Page and SLA Monitoring

### P3 - Lower Priority
- SMI-965: Immutable Log Storage
- SMI-956: SOC 2 Type I Preparation

## REFERENCE DOCUMENTATION
- docs/enterprise/ENTERPRISE_PACKAGE.md
- docs/architecture/audit-logging-architecture.md
- docs/adr/013-open-core-licensing.md
- docs/adr/014-enterprise-package-architecture.md
- docs/strategy/ROADMAP.md

## DOCKER COMMANDS
docker exec skillsmith-dev-1 npm run build
docker exec skillsmith-dev-1 npm test -- packages/enterprise
docker exec skillsmith-dev-1 npm run typecheck

## WEEKLY FOCUS
Run with --week N to get focused prompt for that week:
  ./scripts/phases/phase-7-enterprise.sh --week 3

================================================================================
PHASE7_PROMPT
fi

if [[ "$DRY_RUN" == "false" ]]; then
  echo ""
  echo "To start working on Phase 7:"
  echo ""
  echo "  cd $WORKTREE_PATH"
  echo "  claude"
  echo ""
  echo "For week-specific focus:"
  echo "  ./scripts/phases/phase-7-enterprise.sh --week 3"
  echo ""
fi
