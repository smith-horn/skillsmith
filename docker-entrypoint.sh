#!/bin/bash
#
# Docker Entrypoint Script
#
# Validates native modules before starting the application.
# This prevents confusing runtime errors from NODE_MODULE_VERSION mismatches.
#
# Usage: Set as ENTRYPOINT in Dockerfile or docker-compose.yml
#
# Reference: ADR-012 (Native Module Version Management)
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}[entrypoint] Validating native modules...${NC}"

# List of native modules to validate
NATIVE_MODULES=("better-sqlite3")

# Track validation status
VALIDATION_FAILED=0

for module in "${NATIVE_MODULES[@]}"; do
    if node -e "require('${module}')" 2>/dev/null; then
        echo -e "${GREEN}  ✓ ${module}${NC}"
    else
        echo -e "${RED}  ✗ ${module} - validation failed${NC}"
        VALIDATION_FAILED=1
    fi
done

# If validation failed, attempt rebuild
if [ $VALIDATION_FAILED -eq 1 ]; then
    echo -e "${YELLOW}[entrypoint] Native module mismatch detected. Attempting rebuild...${NC}"

    for module in "${NATIVE_MODULES[@]}"; do
        echo -e "${YELLOW}  Rebuilding ${module}...${NC}"
        npm rebuild "${module}" 2>/dev/null || true
    done

    # Re-validate after rebuild
    REBUILD_FAILED=0
    for module in "${NATIVE_MODULES[@]}"; do
        if ! node -e "require('${module}')" 2>/dev/null; then
            echo -e "${RED}  ✗ ${module} - still failing after rebuild${NC}"
            REBUILD_FAILED=1
        fi
    done

    if [ $REBUILD_FAILED -eq 1 ]; then
        echo -e "${RED}[entrypoint] Native module validation failed after rebuild.${NC}"
        echo -e "${YELLOW}Try: docker compose down && docker compose build --no-cache${NC}"
        exit 1
    fi

    echo -e "${GREEN}[entrypoint] Native modules rebuilt successfully.${NC}"
fi

echo -e "${GREEN}[entrypoint] All native modules validated.${NC}"

# Execute the main command
exec "$@"
