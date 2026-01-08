#!/usr/bin/env bash
#
# SMI-632: Performance Benchmark Runner
#
# Usage:
#   ./scripts/run-benchmarks.sh              # Run all benchmarks
#   ./scripts/run-benchmarks.sh search       # Run search benchmarks only
#   ./scripts/run-benchmarks.sh index        # Run index benchmarks only
#   ./scripts/run-benchmarks.sh --compare baseline.json  # Compare with baseline
#   ./scripts/run-benchmarks.sh --json       # Output as JSON
#   ./scripts/run-benchmarks.sh --ci         # CI mode (fails on regression)
#
# Performance Targets:
#   p50: < 100ms
#   p95: < 300ms
#   p99: < 500ms
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CORE_PKG="$PROJECT_ROOT/packages/core"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default options
SUITE=""
OUTPUT="text"
COMPARE=""
CI_MODE=false
ITERATIONS=""
SAVE_BASELINE=false
BASELINE_FILE="$PROJECT_ROOT/benchmarks/baseline.json"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    search|index)
      SUITE="$1"
      shift
      ;;
    --json)
      OUTPUT="json"
      shift
      ;;
    --compare)
      COMPARE="$2"
      shift 2
      ;;
    --ci)
      CI_MODE=true
      OUTPUT="json"
      shift
      ;;
    --save-baseline)
      SAVE_BASELINE=true
      shift
      ;;
    --iterations)
      ITERATIONS="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: $0 [suite] [options]"
      echo ""
      echo "Suites:"
      echo "  search          Run search benchmarks only"
      echo "  index           Run index benchmarks only"
      echo ""
      echo "Options:"
      echo "  --json          Output results as JSON"
      echo "  --compare FILE  Compare results with baseline JSON file"
      echo "  --ci            CI mode: JSON output, fail on regressions"
      echo "  --save-baseline Save results as new baseline"
      echo "  --iterations N  Override default iteration count"
      echo "  --help, -h      Show this help message"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

echo -e "${BLUE}╔═══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║         SMI-632: Skillsmith Performance Benchmarks            ║${NC}"
echo -e "${BLUE}╠═══════════════════════════════════════════════════════════════╣${NC}"
echo -e "${BLUE}║  Targets: p50 < 100ms | p95 < 300ms | p99 < 500ms             ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check if running in Docker
if [ -f /.dockerenv ] || grep -qE 'docker|containerd' /proc/1/cgroup 2>/dev/null; then
  DOCKER_MODE=true
  echo -e "${GREEN}✓ Running in Docker container${NC}"
else
  DOCKER_MODE=false
  echo -e "${YELLOW}⚠ Running outside Docker (consider using Docker for consistent results)${NC}"
fi

# Ensure dependencies are built
echo -e "\n${BLUE}Building project...${NC}"
cd "$PROJECT_ROOT"
docker exec skillsmith-dev-1 npm run build --workspace=@skillsmith/core 2>/dev/null || {
  echo -e "${YELLOW}Building core package...${NC}"
  docker exec skillsmith-dev-1 npm run build --workspace=@skillsmith/core
}

# Create benchmarks output directory
mkdir -p "$PROJECT_ROOT/benchmarks"

# Create a temporary runner file
RUNNER_FILE=$(mktemp /tmp/benchmark-runner-XXXXXX.mjs)
trap "rm -f $RUNNER_FILE" EXIT

cat > "$RUNNER_FILE" << 'EOF'
import { runAllBenchmarks } from './dist/benchmarks/index.js';

const args = process.argv.slice(2);
const options = {};

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--suite') options.suite = args[++i];
  if (args[i] === '--output') options.output = args[++i];
  if (args[i] === '--compare') options.compare = args[++i];
  if (args[i] === '--iterations') options.iterations = parseInt(args[++i], 10);
}

try {
  await runAllBenchmarks(options);
} catch (err) {
  console.error('Benchmark failed:', err.message);
  process.exit(1);
}
EOF

# Run benchmarks
echo -e "\n${BLUE}Running benchmarks...${NC}"
echo ""

cd "$CORE_PKG"

# Build args array
ARGS=""
[ -n "$SUITE" ] && ARGS="$ARGS --suite $SUITE"
[ -n "$OUTPUT" ] && ARGS="$ARGS --output $OUTPUT"
[ -n "$COMPARE" ] && ARGS="$ARGS --compare $COMPARE"
[ -n "$ITERATIONS" ] && ARGS="$ARGS --iterations $ITERATIONS"

# Use node with ES modules support and expose GC
node --expose-gc "$RUNNER_FILE" $ARGS || {
  echo -e "${RED}Benchmark execution failed${NC}"
  exit 1
}

# Summary
echo ""
echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}Benchmark run complete${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"

# Log to progress file
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Benchmark run completed" >> /tmp/smi632-progress.log
