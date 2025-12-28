#!/bin/bash
# SMI-690: Docker Health Check Script
# Ensures the development container is running and healthy before tests

set -e

CONTAINER_NAME="${CONTAINER_NAME:-skillsmith-dev-1}"
COMPOSE_PROFILE="${COMPOSE_PROFILE:-dev}"
MAX_WAIT_SECONDS=60
CHECK_INTERVAL=2

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if Docker is available
check_docker() {
    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed or not in PATH"
        exit 1
    fi

    if ! docker info &> /dev/null; then
        log_error "Docker daemon is not running"
        exit 1
    fi
}

# Check if container is running
is_container_running() {
    docker ps --filter "name=$CONTAINER_NAME" --format "{{.Names}}" 2>/dev/null | grep -q "$CONTAINER_NAME"
}

# Check if container is healthy
is_container_healthy() {
    local status
    status=$(docker inspect --format='{{.State.Health.Status}}' "$CONTAINER_NAME" 2>/dev/null || echo "none")
    [ "$status" = "healthy" ]
}

# Start the container
start_container() {
    log_info "Starting Docker container with profile '$COMPOSE_PROFILE'..."
    docker compose --profile "$COMPOSE_PROFILE" up -d
}

# Wait for container to be healthy
wait_for_healthy() {
    local elapsed=0

    log_info "Waiting for container to be healthy..."

    while [ $elapsed -lt $MAX_WAIT_SECONDS ]; do
        if is_container_healthy; then
            log_info "Container is healthy!"
            return 0
        fi

        # Check if container is at least running
        if ! is_container_running; then
            log_error "Container stopped unexpectedly"
            docker logs "$CONTAINER_NAME" --tail 20 2>/dev/null || true
            return 1
        fi

        sleep $CHECK_INTERVAL
        elapsed=$((elapsed + CHECK_INTERVAL))
        echo -n "."
    done

    echo ""
    log_warn "Container did not become healthy within ${MAX_WAIT_SECONDS}s"
    log_info "Checking if container is responsive..."

    # Fallback: check if we can execute a command
    if docker exec "$CONTAINER_NAME" node -e "console.log('ready')" &>/dev/null; then
        log_info "Container is responsive (health check may not be configured)"
        return 0
    fi

    log_error "Container is not responsive"
    docker logs "$CONTAINER_NAME" --tail 30 2>/dev/null || true
    return 1
}

# Main execution
main() {
    log_info "Checking Docker environment..."
    check_docker

    if is_container_running; then
        log_info "Container '$CONTAINER_NAME' is already running"

        # Verify it's healthy or responsive
        if is_container_healthy; then
            log_info "Container is healthy"
        elif docker exec "$CONTAINER_NAME" node -e "console.log('ready')" &>/dev/null; then
            log_info "Container is responsive"
        else
            log_warn "Container is running but not responsive, restarting..."
            docker compose --profile "$COMPOSE_PROFILE" restart
            wait_for_healthy
        fi
    else
        log_info "Container '$CONTAINER_NAME' is not running"
        start_container
        wait_for_healthy
    fi

    log_info "Docker environment ready!"
}

main "$@"
