#!/bin/bash
# Docker Health Check Hook
# Prevents docker commands from hanging indefinitely
# Usage: Called by Claude Code hooks before docker exec commands

TIMEOUT_SECONDS=${DOCKER_TIMEOUT:-5}
MAX_STUCK_PROCESSES=${MAX_DOCKER_STUCK:-10}

# Check if Docker daemon is responsive
check_docker_health() {
    if ! timeout "$TIMEOUT_SECONDS" docker info >/dev/null 2>&1; then
        echo "ERROR: Docker daemon is unresponsive (timeout: ${TIMEOUT_SECONDS}s)" >&2
        echo "SUGGESTION: Restart Docker Desktop or run: killall Docker && open -a Docker" >&2
        return 1
    fi
    return 0
}

# Count stuck docker processes
count_stuck_docker_processes() {
    local count=$(ps aux | grep -E "docker (exec|compose|build|ps)" | grep -v grep | wc -l)
    echo "$count"
}

# Kill stuck docker processes older than threshold
cleanup_stuck_processes() {
    local threshold_minutes=${1:-5}
    echo "Cleaning up docker processes older than ${threshold_minutes} minutes..."

    # Find and kill stuck docker exec processes
    ps aux | grep "docker exec" | grep -v grep | awk '{print $2}' | while read pid; do
        local elapsed=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')
        if [[ -n "$elapsed" ]]; then
            # Check if process is older than threshold
            if [[ "$elapsed" =~ ^[0-9]+: ]]; then
                echo "Killing stuck docker process: $pid (elapsed: $elapsed)"
                kill -9 "$pid" 2>/dev/null
            fi
        fi
    done
}

# Main check
main() {
    local action="${1:-check}"

    case "$action" in
        check)
            # Check docker health
            if ! check_docker_health; then
                exit 1
            fi

            # Check for too many stuck processes
            local stuck_count=$(count_stuck_docker_processes)
            if [ "$stuck_count" -gt "$MAX_STUCK_PROCESSES" ]; then
                echo "WARNING: $stuck_count stuck docker processes detected" >&2
                echo "Run: $0 cleanup to clean them up" >&2
                exit 2
            fi

            echo "Docker health check passed"
            ;;
        cleanup)
            cleanup_stuck_processes "${2:-5}"
            ;;
        status)
            echo "Docker Daemon: $(timeout 2 docker info >/dev/null 2>&1 && echo 'responsive' || echo 'unresponsive')"
            echo "Stuck Processes: $(count_stuck_docker_processes)"
            ;;
        *)
            echo "Usage: $0 {check|cleanup|status}" >&2
            exit 1
            ;;
    esac
}

main "$@"
