#!/bin/bash
#
# Phase 4 Orchestrator Runner
#
# Handles environment setup and launches the orchestrator with proper
# secret management via varlock.
#
# Usage:
#   ./run.sh                    # Run all epics
#   ./run.sh --dry-run          # Preview without changes
#   ./run.sh --start-from 2     # Resume from epic 2
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLSMITH_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║          PHASE 4 ORCHESTRATOR - STARTUP                      ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Check prerequisites
echo -e "${YELLOW}[Setup] Checking prerequisites...${NC}"

# Check Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is required but not installed.${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Node.js $(node --version)${NC}"

# Check npx
if ! command -v npx &> /dev/null; then
    echo -e "${RED}Error: npx is required but not installed.${NC}"
    exit 1
fi
echo -e "${GREEN}✓ npx available${NC}"

# Check claude-flow (uses local node_modules version)
CLAUDE_FLOW_VERSION=$(npx claude-flow --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
if [ -z "$CLAUDE_FLOW_VERSION" ]; then
    echo -e "${RED}Error: claude-flow not found. Run 'npm install' in skillsmith root.${NC}"
    exit 1
fi
echo -e "${GREEN}✓ claude-flow v${CLAUDE_FLOW_VERSION}${NC}"

# Version compatibility check (require v2.x)
MAJOR_VERSION=$(echo "$CLAUDE_FLOW_VERSION" | cut -d. -f1)
if [ "$MAJOR_VERSION" != "2" ]; then
    echo -e "${YELLOW}Warning: claude-flow v${CLAUDE_FLOW_VERSION} detected. This orchestrator was tested with v2.x${NC}"
    echo -e "${YELLOW}Some features may not work as expected.${NC}"
fi

# Pre-flight health check - verify claude-flow actually works
echo -e "${YELLOW}[Setup] Running pre-flight health check...${NC}"
if ! npx claude-flow memory store __health_check__ "$(date +%s)" --namespace health 2>/dev/null; then
    echo -e "${RED}Error: claude-flow health check failed${NC}"
    echo -e "${YELLOW}Try running: npm rebuild better-sqlite3${NC}"
    exit 1
fi
echo -e "${GREEN}✓ claude-flow health check passed${NC}"

# Check Linear API key
if [ -z "$LINEAR_API_KEY" ]; then
    echo -e "${YELLOW}[Setup] LINEAR_API_KEY not set, attempting varlock...${NC}"

    if command -v varlock &> /dev/null; then
        # Use varlock to load secrets
        echo -e "${BLUE}[Setup] Loading secrets via varlock...${NC}"
        eval "$(varlock load --export 2>/dev/null)" || true
    fi

    if [ -z "$LINEAR_API_KEY" ]; then
        echo -e "${YELLOW}Warning: LINEAR_API_KEY not available. Linear updates will be skipped.${NC}"
    else
        echo -e "${GREEN}✓ LINEAR_API_KEY loaded via varlock${NC}"
    fi
else
    echo -e "${GREEN}✓ LINEAR_API_KEY present${NC}"
fi

# Check for .env file as fallback
if [ -z "$LINEAR_API_KEY" ] && [ -f "$SKILLSMITH_DIR/.env" ]; then
    echo -e "${YELLOW}[Setup] Loading from .env file...${NC}"
    export $(grep -v '^#' "$SKILLSMITH_DIR/.env" | xargs)
    if [ -n "$LINEAR_API_KEY" ]; then
        echo -e "${GREEN}✓ LINEAR_API_KEY loaded from .env${NC}"
    fi
fi

# Create output directory
mkdir -p "$SKILLSMITH_DIR/output"
echo -e "${GREEN}✓ Output directory ready${NC}"

# Install dependencies if needed
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
    echo -e "${YELLOW}[Setup] Installing orchestrator dependencies...${NC}"
    cd "$SCRIPT_DIR"
    npm install @linear/sdk 2>/dev/null || true
fi

# Build TypeScript if needed
echo -e "${YELLOW}[Setup] Compiling orchestrator...${NC}"
cd "$SKILLSMITH_DIR"

# Run the orchestrator
echo ""
echo -e "${BLUE}[Setup] Starting orchestrator...${NC}"
echo ""

# Pass through all arguments
if command -v varlock &> /dev/null && [ -n "$LINEAR_API_KEY" ]; then
    # Run with varlock for secure secret handling
    exec varlock run -- npx tsx "$SCRIPT_DIR/orchestrator.ts" "$@"
else
    # Run directly
    exec npx tsx "$SCRIPT_DIR/orchestrator.ts" "$@"
fi
