#!/bin/bash
# SMI-1661: Orphan Process Cleanup Script
# Finds and kills orphaned agent processes that didn't terminate properly

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
DRY_RUN=false
FORCE=false
MAX_AGE_SECONDS=3600  # 1 hour
PROCESS_PATTERNS=("claude-flow" "agent-spawn" "Task")

# Counters
FOUND_COUNT=0
KILLED_COUNT=0

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_debug() {
    echo -e "${BLUE}[DEBUG]${NC} $1"
}

usage() {
    cat << EOF
Usage: $(basename "$0") [OPTIONS]

Find and kill orphaned agent processes (claude-flow, agent-spawn, Task).

OPTIONS:
    --dry-run    Preview orphaned processes without killing them
    --force      Skip confirmation prompt before killing
    -h, --help   Show this help message

ORPHAN CRITERIA:
    - Parent PID is 1 (init-adopted process)
    - OR no TTY and running for more than 1 hour

EXAMPLES:
    $(basename "$0") --dry-run    # Preview what would be killed
    $(basename "$0")              # Interactive cleanup (asks for confirmation)
    $(basename "$0") --force      # Kill orphans without confirmation

EOF
    exit 0
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --force)
            FORCE=true
            shift
            ;;
        -h|--help)
            usage
            ;;
        *)
            log_error "Unknown option: $1"
            usage
            ;;
    esac
done

# Get process age in seconds
get_process_age() {
    local pid=$1
    local elapsed

    if [[ "$(uname)" == "Darwin" ]]; then
        # macOS: ps -o etime gives elapsed time
        elapsed=$(ps -p "$pid" -o etime= 2>/dev/null | tr -d ' ')
    else
        # Linux: ps -o etimes gives elapsed seconds directly
        elapsed=$(ps -p "$pid" -o etimes= 2>/dev/null | tr -d ' ')
        if [[ -n "$elapsed" ]]; then
            echo "$elapsed"
            return
        fi
        elapsed=$(ps -p "$pid" -o etime= 2>/dev/null | tr -d ' ')
    fi

    if [[ -z "$elapsed" ]]; then
        echo "0"
        return
    fi

    # Parse elapsed time format: [[DD-]HH:]MM:SS
    local days=0 hours=0 minutes=0 seconds=0

    if [[ "$elapsed" =~ ^([0-9]+)-(.+)$ ]]; then
        days="${BASH_REMATCH[1]}"
        elapsed="${BASH_REMATCH[2]}"
    fi

    IFS=':' read -ra parts <<< "$elapsed"
    local num_parts=${#parts[@]}

    if [[ $num_parts -eq 3 ]]; then
        hours="${parts[0]}"
        minutes="${parts[1]}"
        seconds="${parts[2]}"
    elif [[ $num_parts -eq 2 ]]; then
        minutes="${parts[0]}"
        seconds="${parts[1]}"
    elif [[ $num_parts -eq 1 ]]; then
        seconds="${parts[0]}"
    fi

    # Remove leading zeros to avoid octal interpretation
    days=$((10#$days))
    hours=$((10#$hours))
    minutes=$((10#$minutes))
    seconds=$((10#$seconds))

    echo $((days * 86400 + hours * 3600 + minutes * 60 + seconds))
}

# Check if process is an orphan
is_orphan() {
    local pid=$1
    local ppid tty age

    # Get parent PID and TTY
    if [[ "$(uname)" == "Darwin" ]]; then
        ppid=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ')
        tty=$(ps -p "$pid" -o tty= 2>/dev/null | tr -d ' ')
    else
        ppid=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ')
        tty=$(ps -p "$pid" -o tty= 2>/dev/null | tr -d ' ')
    fi

    # Parent PID 1 = adopted by init (definitely orphan)
    if [[ "$ppid" == "1" ]]; then
        return 0
    fi

    # No TTY and running > 1 hour = likely orphan
    if [[ "$tty" == "?" || "$tty" == "??" || -z "$tty" ]]; then
        age=$(get_process_age "$pid")
        if [[ "$age" -gt "$MAX_AGE_SECONDS" ]]; then
            return 0
        fi
    fi

    return 1
}

# Find orphan processes matching patterns
find_orphans() {
    local orphans=()

    for pattern in "${PROCESS_PATTERNS[@]}"; do
        # Use pgrep to find matching processes, exclude this script
        while IFS= read -r pid; do
            [[ -z "$pid" ]] && continue

            # Skip self and parent processes
            [[ "$pid" == "$$" ]] && continue
            [[ "$pid" == "$PPID" ]] && continue

            # Check if it's an orphan
            if is_orphan "$pid"; then
                orphans+=("$pid")
            fi
        done < <(pgrep -f "$pattern" 2>/dev/null || true)
    done

    # Remove duplicates and print
    printf '%s\n' "${orphans[@]}" | sort -u
}

# Display process info
display_process() {
    local pid=$1
    local cmd ppid age tty user

    if [[ "$(uname)" == "Darwin" ]]; then
        read -r user ppid tty cmd <<< "$(ps -p "$pid" -o user=,ppid=,tty=,command= 2>/dev/null)"
    else
        read -r user ppid tty cmd <<< "$(ps -p "$pid" -o user=,ppid=,tty=,cmd= 2>/dev/null)"
    fi

    age=$(get_process_age "$pid")
    local age_human
    if [[ $age -ge 86400 ]]; then
        age_human="$((age / 86400))d $((age % 86400 / 3600))h"
    elif [[ $age -ge 3600 ]]; then
        age_human="$((age / 3600))h $((age % 3600 / 60))m"
    else
        age_human="$((age / 60))m $((age % 60))s"
    fi

    # Truncate command if too long
    if [[ ${#cmd} -gt 60 ]]; then
        cmd="${cmd:0:57}..."
    fi

    printf "  PID: %-8s PPID: %-6s TTY: %-8s Age: %-10s\n" "$pid" "$ppid" "${tty:-?}" "$age_human"
    printf "  User: %-8s Cmd: %s\n" "$user" "$cmd"
    echo ""
}

# Kill a process with logging
kill_process() {
    local pid=$1

    if $DRY_RUN; then
        log_debug "[DRY-RUN] Would kill PID $pid"
        return 0
    fi

    # Try graceful termination first
    if kill -TERM "$pid" 2>/dev/null; then
        sleep 1
        # Check if still running, force kill if needed
        if kill -0 "$pid" 2>/dev/null; then
            log_warn "Process $pid didn't terminate gracefully, force killing..."
            kill -KILL "$pid" 2>/dev/null || true
        fi
        log_info "Killed PID $pid"
        ((KILLED_COUNT++))
        return 0
    else
        log_warn "Failed to kill PID $pid (may have already exited)"
        return 1
    fi
}

# Main execution
main() {
    log_info "Scanning for orphaned agent processes..."
    log_info "Patterns: ${PROCESS_PATTERNS[*]}"
    log_info "Max age threshold: $((MAX_AGE_SECONDS / 60)) minutes"
    echo ""

    # Find orphans
    local orphan_pids
    orphan_pids=$(find_orphans)

    if [[ -z "$orphan_pids" ]]; then
        log_info "No orphaned processes found."
        echo ""
        echo "Summary: 0 orphans found, 0 killed"
        exit 0
    fi

    # Count and display orphans
    echo -e "${YELLOW}Found orphaned processes:${NC}"
    echo ""

    while IFS= read -r pid; do
        [[ -z "$pid" ]] && continue
        ((FOUND_COUNT++))
        display_process "$pid"
    done <<< "$orphan_pids"

    echo "---"
    log_info "Found $FOUND_COUNT orphaned process(es)"
    echo ""

    # Dry run mode - just display and exit
    if $DRY_RUN; then
        log_info "[DRY-RUN] No processes killed. Run without --dry-run to clean up."
        echo ""
        echo "Summary: $FOUND_COUNT orphans found, 0 killed (dry-run mode)"
        exit 0
    fi

    # Confirm unless --force
    if ! $FORCE; then
        echo -n "Kill these $FOUND_COUNT process(es)? [y/N] "
        read -r response
        if [[ ! "$response" =~ ^[Yy]$ ]]; then
            log_info "Aborted by user."
            echo ""
            echo "Summary: $FOUND_COUNT orphans found, 0 killed (aborted)"
            exit 0
        fi
    fi

    # Kill orphans
    echo ""
    log_info "Killing orphaned processes..."

    while IFS= read -r pid; do
        [[ -z "$pid" ]] && continue
        kill_process "$pid"
    done <<< "$orphan_pids"

    echo ""
    echo "---"
    echo -e "${GREEN}Summary: $FOUND_COUNT orphans found, $KILLED_COUNT killed${NC}"
}

main "$@"
