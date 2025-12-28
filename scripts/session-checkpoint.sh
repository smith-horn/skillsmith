#!/bin/bash
# SMI-638: Session Checkpoint Hook Script
#
# Called by claude-flow hooks to store session checkpoint data.
# Usage: session-checkpoint.sh <action> [options]
#
# Actions:
#   store   - Store checkpoint to memory
#   restore - Restore checkpoint from memory
#   list    - List available checkpoints
#   cleanup - Clean old checkpoints

set -e

# Configuration
MEMORY_PREFIX="session"
MAX_CHECKPOINTS=20
CHECKPOINT_TTL=86400  # 24 hours

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[checkpoint]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[checkpoint]${NC} $1"
}

log_error() {
    echo -e "${RED}[checkpoint]${NC} $1" >&2
}

# Store checkpoint to claude-flow memory
store_checkpoint() {
    local session_id="${1:-$(date +%s)}"
    local checkpoint_id="${2:-ckpt_$(date +%s)_$$}"
    local data="${3:-}"

    if [[ -z "$data" ]]; then
        # Read from stdin if no data provided
        data=$(cat)
    fi

    local memory_key="${MEMORY_PREFIX}/${session_id}/checkpoint/${checkpoint_id}"

    log_info "Storing checkpoint: $memory_key"

    # Store using claude-flow memory
    if command -v npx &> /dev/null; then
        echo "$data" | npx claude-flow@alpha memory store "$memory_key" --ttl "$CHECKPOINT_TTL" - 2>/dev/null || {
            # Fallback: store as file in temp directory
            local fallback_dir="/tmp/skillsmith-checkpoints/${session_id}"
            mkdir -p "$fallback_dir"
            echo "$data" > "${fallback_dir}/${checkpoint_id}.json"
            log_warn "Stored to fallback: ${fallback_dir}/${checkpoint_id}.json"
        }
    else
        log_error "npx not found, cannot store to claude-flow memory"
        return 1
    fi

    log_info "Checkpoint stored successfully"
}

# Restore checkpoint from claude-flow memory
restore_checkpoint() {
    local memory_key="$1"

    if [[ -z "$memory_key" ]]; then
        log_error "Memory key required for restore"
        return 1
    fi

    log_info "Restoring checkpoint: $memory_key"

    if command -v npx &> /dev/null; then
        npx claude-flow@alpha memory get "$memory_key" 2>/dev/null || {
            # Fallback: try to read from temp directory
            local fallback_file="/tmp/skillsmith-checkpoints/${memory_key#$MEMORY_PREFIX/}.json"
            fallback_file="${fallback_file//\/checkpoint\//\/}"
            if [[ -f "$fallback_file" ]]; then
                cat "$fallback_file"
            else
                log_error "Checkpoint not found"
                return 1
            fi
        }
    else
        log_error "npx not found"
        return 1
    fi
}

# List available checkpoints
list_checkpoints() {
    local session_id="$1"
    local pattern="${MEMORY_PREFIX}/${session_id:-*}/checkpoint/*"

    log_info "Listing checkpoints: $pattern"

    if command -v npx &> /dev/null; then
        npx claude-flow@alpha memory list --pattern "$pattern" 2>/dev/null || {
            # Fallback: list from temp directory
            local fallback_dir="/tmp/skillsmith-checkpoints"
            if [[ -d "$fallback_dir" ]]; then
                find "$fallback_dir" -name "*.json" -type f 2>/dev/null | while read -r file; do
                    echo "${MEMORY_PREFIX}/$(dirname ${file#$fallback_dir/})/checkpoint/$(basename $file .json)"
                done
            fi
        }
    else
        log_error "npx not found"
        return 1
    fi
}

# Cleanup old checkpoints
cleanup_checkpoints() {
    local session_id="$1"
    local keep="${2:-$MAX_CHECKPOINTS}"

    log_info "Cleaning up checkpoints (keeping last $keep)"

    # Get list of checkpoints sorted by timestamp
    local checkpoints
    checkpoints=$(list_checkpoints "$session_id" 2>/dev/null | sort -r)

    if [[ -z "$checkpoints" ]]; then
        log_info "No checkpoints to clean"
        return 0
    fi

    # Delete all except the most recent N
    local count=0
    echo "$checkpoints" | while read -r key; do
        count=$((count + 1))
        if [[ $count -gt $keep ]]; then
            log_info "Deleting old checkpoint: $key"
            if command -v npx &> /dev/null; then
                npx claude-flow@alpha memory delete "$key" 2>/dev/null || true
            fi
        fi
    done

    log_info "Cleanup complete"
}

# Create a checkpoint from current state
create_checkpoint() {
    local session_id="${1:-$(cat /tmp/skillsmith-session-id 2>/dev/null || echo "default")}"
    local working_dir="${2:-$(pwd)}"
    local branch="${3:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")}"

    local checkpoint_id="ckpt_$(date +%s)_$$"
    local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Create minimal checkpoint data
    local checkpoint_data=$(cat <<EOF
{
  "id": "$checkpoint_id",
  "timestamp": "$timestamp",
  "sessionId": "$session_id",
  "workingDirectory": "$working_dir",
  "branch": "$branch",
  "filesModified": [],
  "testsRun": [],
  "todos": []
}
EOF
)

    store_checkpoint "$session_id" "$checkpoint_id" "$checkpoint_data"
}

# Show usage
show_usage() {
    cat <<EOF
Usage: session-checkpoint.sh <action> [options]

Actions:
  store <session_id> <checkpoint_id> [data]
      Store checkpoint data to memory
      If data is not provided, reads from stdin

  restore <memory_key>
      Restore checkpoint from memory

  list [session_id]
      List available checkpoints
      If session_id not provided, lists all

  cleanup [session_id] [keep_count]
      Clean old checkpoints, keeping the most recent
      Default keep_count: $MAX_CHECKPOINTS

  create [session_id] [working_dir] [branch]
      Create a new checkpoint from current state

Examples:
  $0 store sess_abc ckpt_123 '{"id":"ckpt_123",...}'
  echo '{"data":"..."}' | $0 store sess_abc ckpt_123
  $0 restore session/sess_abc/checkpoint/ckpt_123
  $0 list sess_abc
  $0 cleanup sess_abc 10
  $0 create
EOF
}

# Main entry point
main() {
    local action="$1"
    shift || true

    case "$action" in
        store)
            store_checkpoint "$@"
            ;;
        restore)
            restore_checkpoint "$@"
            ;;
        list)
            list_checkpoints "$@"
            ;;
        cleanup)
            cleanup_checkpoints "$@"
            ;;
        create)
            create_checkpoint "$@"
            ;;
        -h|--help|help)
            show_usage
            ;;
        *)
            log_error "Unknown action: $action"
            show_usage
            exit 1
            ;;
    esac
}

main "$@"
