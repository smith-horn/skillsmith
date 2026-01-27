#!/bin/bash
#
# Skill Update Conflict Resolution - Wave Execution Script
#
# This script orchestrates the execution of waves for the skill conflict
# resolution feature using git worktrees and claude-flow.
#
# Usage:
#   ./scripts/execute-conflict-waves.sh [command] [options]
#
# Commands:
#   setup       Create all worktrees
#   wave <n>    Execute wave n (1-5)
#   all         Execute all waves sequentially
#   parallel    Execute waves 4 & 5 in parallel (after wave 3)
#   cleanup     Remove worktrees and branches
#   status      Show current status of all waves
#
# Examples:
#   ./scripts/execute-conflict-waves.sh setup
#   ./scripts/execute-conflict-waves.sh wave 1
#   ./scripts/execute-conflict-waves.sh all
#   ./scripts/execute-conflict-waves.sh cleanup
#
# Linear Issues:
#   Parent: SMI-1863
#   Wave 1: SMI-1864, SMI-1865 (Foundation)
#   Wave 2: SMI-1866 (Merge Algorithm)
#   Wave 3: SMI-1867 (Install Flow)
#   Wave 4: SMI-1868, SMI-1869 (Testing)
#   Wave 5: SMI-1870, SMI-1871 (Documentation)

set -e

# Configuration
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKTREE_BASE="$PROJECT_ROOT/worktrees"
HIVE_MIND_DIR="$PROJECT_ROOT/.claude/hive-mind"

# Wave configuration
declare -A WAVE_NAMES=(
  [1]="Foundation"
  [2]="Core Algorithm"
  [3]="Integration"
  [4]="Testing"
  [5]="Documentation"
)

declare -A WAVE_STRATEGIES=(
  [1]="development"
  [2]="development"
  [3]="development"
  [4]="testing"
  [5]="development"
)

declare -A WAVE_ISSUES=(
  [1]="SMI-1864, SMI-1865"
  [2]="SMI-1866"
  [3]="SMI-1867"
  [4]="SMI-1868, SMI-1869"
  [5]="SMI-1870, SMI-1871"
)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Pre-flight checks
preflight_check() {
  log_info "Running pre-flight checks..."

  # Check Docker
  if ! docker ps | grep -q skillsmith; then
    log_error "Docker container 'skillsmith' not running"
    log_info "Start with: docker compose --profile dev up -d"
    exit 1
  fi
  log_success "Docker container running"

  # Check git-crypt (if docs are encrypted)
  if git-crypt status docs/ 2>/dev/null | head -1 | grep -q "encrypted:"; then
    log_warn "git-crypt is locked. Some docs may be encrypted."
    log_info "Unlock with: varlock run -- sh -c 'git-crypt unlock \"\${GIT_CRYPT_KEY_PATH/#\\~/\$HOME}\"'"
  else
    log_success "git-crypt unlocked (or not used)"
  fi

  # Check claude-flow MCP
  if grep -q "claude-flow" "$PROJECT_ROOT/.mcp.json" 2>/dev/null; then
    log_success "claude-flow MCP configured"
  else
    log_warn "claude-flow MCP not found in .mcp.json"
  fi

  # Check hive-mind configs exist
  local missing_configs=0
  for i in 1 2 3 4 5; do
    if [[ ! -f "$HIVE_MIND_DIR/skill-conflict-wave-$i.yaml" ]]; then
      log_error "Missing: skill-conflict-wave-$i.yaml"
      missing_configs=1
    fi
  done

  if [[ $missing_configs -eq 0 ]]; then
    log_success "All hive-mind configs present"
  else
    exit 1
  fi

  echo ""
}

# Setup worktrees
setup_worktrees() {
  log_info "Setting up worktrees for all waves..."

  mkdir -p "$WORKTREE_BASE"

  for i in 1 2 3 4 5; do
    local worktree="$WORKTREE_BASE/conflict-wave-$i"
    local branch="feature/conflict-wave-$i"

    if [[ -d "$worktree" ]]; then
      log_warn "Worktree already exists: $worktree"
      continue
    fi

    log_info "Creating worktree for Wave $i: ${WAVE_NAMES[$i]}..."

    # Use create-worktree.sh if available, otherwise manual creation
    if [[ -x "$PROJECT_ROOT/scripts/create-worktree.sh" ]]; then
      "$PROJECT_ROOT/scripts/create-worktree.sh" "$worktree" "$branch"
    else
      git worktree add "$worktree" -b "$branch" main
    fi

    log_success "Created: $worktree"
  done

  echo ""
  log_success "All worktrees created!"
}

# Execute a single wave
execute_wave() {
  local wave_num=$1

  if [[ -z "$wave_num" ]] || [[ $wave_num -lt 1 ]] || [[ $wave_num -gt 5 ]]; then
    log_error "Invalid wave number. Use 1-5."
    exit 1
  fi

  local worktree="$WORKTREE_BASE/conflict-wave-$wave_num"
  local config="$HIVE_MIND_DIR/skill-conflict-wave-$wave_num.yaml"
  local strategy="${WAVE_STRATEGIES[$wave_num]}"
  local name="${WAVE_NAMES[$wave_num]}"
  local issues="${WAVE_ISSUES[$wave_num]}"

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  log_info "Executing Wave $wave_num: $name"
  log_info "Issues: $issues"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  # Check worktree exists
  if [[ ! -d "$worktree" ]]; then
    log_error "Worktree not found: $worktree"
    log_info "Run: ./scripts/execute-conflict-waves.sh setup"
    exit 1
  fi

  # Rebase on previous wave if needed
  if [[ $wave_num -gt 1 ]]; then
    local prev_wave=$((wave_num - 1))
    # Waves 4 and 5 both depend on wave 3
    if [[ $wave_num -eq 5 ]]; then
      prev_wave=3
    fi

    local prev_branch="feature/conflict-wave-$prev_wave"

    log_info "Rebasing on $prev_branch..."
    cd "$worktree"
    git fetch origin "$prev_branch" 2>/dev/null || true

    if git rev-parse "origin/$prev_branch" >/dev/null 2>&1; then
      git rebase "origin/$prev_branch" || {
        log_error "Rebase failed. Resolve conflicts manually."
        exit 1
      }
      log_success "Rebased on $prev_branch"
    else
      log_warn "Branch $prev_branch not found on origin, skipping rebase"
    fi
  fi

  # Execute with claude-flow
  cd "$worktree"
  log_info "Starting claude-flow swarm..."

  npx claude-flow swarm "Execute Wave $wave_num: $name ($issues)" \
    --config "$config" \
    --strategy "$strategy" \
    --mode hierarchical

  # Run preflight after wave
  log_info "Running post-wave verification..."
  docker exec skillsmith-dev-1 npm run preflight || {
    log_warn "Preflight had issues. Review before proceeding."
  }

  echo ""
  log_success "Wave $wave_num complete!"
  echo ""
}

# Execute all waves sequentially
execute_all() {
  log_info "Executing all waves sequentially..."
  echo ""

  for i in 1 2 3; do
    execute_wave $i
  done

  log_info "Waves 1-3 complete. Waves 4 & 5 can run in parallel."
  log_info "Run: ./scripts/execute-conflict-waves.sh parallel"
  echo ""
}

# Execute waves 4 & 5 in parallel
execute_parallel() {
  log_info "Executing Waves 4 & 5 in parallel..."
  echo ""

  local worktree4="$WORKTREE_BASE/conflict-wave-4"
  local worktree5="$WORKTREE_BASE/conflict-wave-5"
  local config4="$HIVE_MIND_DIR/skill-conflict-wave-4.yaml"
  local config5="$HIVE_MIND_DIR/skill-conflict-wave-5.yaml"

  # Check worktrees exist
  for wt in "$worktree4" "$worktree5"; do
    if [[ ! -d "$wt" ]]; then
      log_error "Worktree not found: $wt"
      exit 1
    fi
  done

  # Rebase both on wave 3
  for wave_num in 4 5; do
    local worktree="$WORKTREE_BASE/conflict-wave-$wave_num"
    cd "$worktree"
    git fetch origin feature/conflict-wave-3 2>/dev/null || true
    if git rev-parse "origin/feature/conflict-wave-3" >/dev/null 2>&1; then
      git rebase "origin/feature/conflict-wave-3" || {
        log_error "Rebase failed for wave $wave_num"
        exit 1
      }
    fi
  done

  log_info "Starting parallel execution..."

  # Execute in parallel using background processes
  (
    cd "$worktree4"
    npx claude-flow swarm "Execute Wave 4: Testing (SMI-1868, SMI-1869)" \
      --config "$config4" \
      --strategy testing \
      --mode hierarchical
  ) &
  local pid4=$!

  (
    cd "$worktree5"
    npx claude-flow swarm "Execute Wave 5: Documentation (SMI-1870, SMI-1871)" \
      --config "$config5" \
      --strategy development \
      --mode hierarchical
  ) &
  local pid5=$!

  log_info "Wave 4 running (PID: $pid4)"
  log_info "Wave 5 running (PID: $pid5)"
  log_info "Waiting for both to complete..."

  wait $pid4
  local exit4=$?
  wait $pid5
  local exit5=$?

  if [[ $exit4 -eq 0 ]] && [[ $exit5 -eq 0 ]]; then
    log_success "Both waves completed successfully!"
  else
    [[ $exit4 -ne 0 ]] && log_error "Wave 4 failed (exit: $exit4)"
    [[ $exit5 -ne 0 ]] && log_error "Wave 5 failed (exit: $exit5)"
    exit 1
  fi
}

# Show status
show_status() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Skill Conflict Resolution - Wave Status"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  for i in 1 2 3 4 5; do
    local worktree="$WORKTREE_BASE/conflict-wave-$i"
    local branch="feature/conflict-wave-$i"
    local name="${WAVE_NAMES[$i]}"
    local issues="${WAVE_ISSUES[$i]}"

    printf "Wave %d: %-15s " "$i" "$name"

    if [[ -d "$worktree" ]]; then
      echo -e "${GREEN}[READY]${NC}"

      # Show branch status
      cd "$worktree"
      local commits=$(git log main..HEAD --oneline 2>/dev/null | wc -l | tr -d ' ')
      local status=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')

      echo "        Branch: $branch"
      echo "        Commits ahead of main: $commits"
      echo "        Uncommitted changes: $status"
      echo "        Issues: $issues"
    else
      echo -e "${YELLOW}[NOT SETUP]${NC}"
      echo "        Issues: $issues"
    fi
    echo ""
  done

  echo "Linear Project: https://linear.app/smith-horn-group/project/skill-update-conflict-resolution-5b3bec4f691b"
  echo "Parent Issue: https://linear.app/smith-horn-group/issue/SMI-1863"
  echo ""
}

# Cleanup worktrees
cleanup() {
  log_info "Cleaning up worktrees and branches..."
  echo ""

  read -p "This will remove all worktrees and local branches. Continue? (y/N) " confirm
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    log_info "Cancelled."
    exit 0
  fi

  cd "$PROJECT_ROOT"

  for i in 1 2 3 4 5; do
    local worktree="$WORKTREE_BASE/conflict-wave-$i"
    local branch="feature/conflict-wave-$i"

    if [[ -d "$worktree" ]]; then
      log_info "Removing worktree: $worktree"
      git worktree remove "$worktree" --force 2>/dev/null || true
    fi

    if git rev-parse --verify "$branch" >/dev/null 2>&1; then
      log_info "Deleting branch: $branch"
      git branch -D "$branch" 2>/dev/null || true
    fi
  done

  # Remove worktree base if empty
  rmdir "$WORKTREE_BASE" 2>/dev/null || true

  echo ""
  log_success "Cleanup complete!"
}

# Show help
show_help() {
  cat << 'EOF'
Skill Update Conflict Resolution - Wave Execution Script

Usage: ./scripts/execute-conflict-waves.sh [command] [options]

Commands:
  setup       Create all git worktrees (run first)
  wave <n>    Execute a specific wave (1-5)
  waves-1-3   Execute waves 1-3 sequentially
  parallel    Execute waves 4 & 5 in parallel
  all         Execute all waves (1-3 sequential, then 4-5 parallel)
  status      Show status of all waves
  cleanup     Remove worktrees and branches
  help        Show this help message

Wave Overview:
  Wave 1: Foundation (Types + Helpers)     - SMI-1864, SMI-1865
  Wave 2: Core Algorithm (Three-way Merge) - SMI-1866
  Wave 3: Integration (Install Flow)       - SMI-1867
  Wave 4: Testing (Unit + Integration)     - SMI-1868, SMI-1869
  Wave 5: Documentation                    - SMI-1870, SMI-1871

Execution Order:
  Wave 1 → Wave 2 → Wave 3 → (Wave 4 || Wave 5)

Examples:
  # Full setup and execution
  ./scripts/execute-conflict-waves.sh setup
  ./scripts/execute-conflict-waves.sh wave 1
  ./scripts/execute-conflict-waves.sh wave 2
  ./scripts/execute-conflict-waves.sh wave 3
  ./scripts/execute-conflict-waves.sh parallel

  # Or run all at once
  ./scripts/execute-conflict-waves.sh setup
  ./scripts/execute-conflict-waves.sh all

  # Check status anytime
  ./scripts/execute-conflict-waves.sh status

Linear Project:
  https://linear.app/smith-horn-group/project/skill-update-conflict-resolution-5b3bec4f691b

EOF
}

# Main
main() {
  cd "$PROJECT_ROOT"

  case "${1:-help}" in
    setup)
      preflight_check
      setup_worktrees
      ;;
    wave)
      preflight_check
      execute_wave "$2"
      ;;
    waves-1-3)
      preflight_check
      for i in 1 2 3; do
        execute_wave $i
      done
      ;;
    parallel)
      preflight_check
      execute_parallel
      ;;
    all)
      preflight_check
      setup_worktrees
      for i in 1 2 3; do
        execute_wave $i
      done
      execute_parallel
      log_success "All waves complete!"
      ;;
    status)
      show_status
      ;;
    cleanup)
      cleanup
      ;;
    help|--help|-h)
      show_help
      ;;
    *)
      log_error "Unknown command: $1"
      show_help
      exit 1
      ;;
  esac
}

main "$@"
