#!/usr/bin/env bash
# regenerate-digest.sh (SMI-6744, ADR-170 § 7, finding M-8) — the committed
# derivation for scripts/ruflo-seed/SEED-MANIFEST.sha256.
#
# § 7 requires the EXPECTED digest to be "derived from the accepted build and
# published outside the image, as a committed ... acceptance input" — before
# this script, SEED-MANIFEST.sha256 had no committed derivation of its own
# (it was hand-written once). This script IS that derivation, runnable both
# by a human regenerating the file locally and by CI in --check mode
# (.github/workflows/ruflo-seed-digest.yml).
#
# Procedure (§ 7, round-4 finding 2: never trust a digest read back from
# inside the image):
#   1. build the `ruflo` Dockerfile stage into a throwaway tag (or reuse one
#      already built, via --no-build <tag>)
#   2. `docker create` a container from that image with node as the
#      entrypoint, pointed at /tmp/manifest.mjs (not yet copied in — docker
#      create does not need the entrypoint target to exist yet, only
#      docker start does)
#   3. `docker cp` THIS CHECKOUT's own scripts/ruflo-seed/manifest.mjs into
#      the container at /tmp/manifest.mjs -- the in-image copy at
#      /opt/ruflo-manifest/generate-manifest.mjs is never used here, exactly
#      because acceptance must never trust a generator that shipped inside
#      the artifact it is authenticating (§ 7)
#   4. `docker start -a` the container, capturing its stdout (the
#      `--digest`-mode output: ONLY the lowercase-hex sha256 digest,
#      newline-terminated) as the CANDIDATE digest
#   5. remove the throwaway container
#   6. print OLD (the current committed file) and NEW (the candidate) side
#      by side, then either write NEW to SEED-MANIFEST.sha256 (default:
#      "regenerate" mode), or, under --check, exit 1 on any mismatch without
#      writing anything (CI mode -- a PR that changed the image or the
#      generator but forgot to regenerate the committed digest must fail)
#
# Usage:
#   scripts/ruflo-seed/regenerate-digest.sh [--no-build <image-tag>] [--check]
#
#   --no-build <image-tag>   Skip `docker build`; run the digest derivation
#                            against an image tag that already exists (e.g.
#                            one built earlier in the same CI job, or a
#                            locally-built dev image for a dry run).
#   --check                  CI mode: never write SEED-MANIFEST.sha256.
#                            Print OLD and NEW, and exit 1 if they differ.
#                            Without this flag the script writes NEW to
#                            SEED-MANIFEST.sha256 unconditionally (this is
#                            the "regenerate the committed file" mode a
#                            human runs locally after an intentional
#                            manifest.mjs or seed-tree change).
#
# Exit codes: 0 success (digest matched in --check mode, or written
# otherwise); 1 mismatch in --check mode; 2 usage error; any other non-zero
# status is an unexpected failure of one of the docker/node steps invoked
# along the way (the offending command's own stderr is left un-redirected,
# so it is visible above whichever line this script's own diagnostic names).
#
# Requires: docker, node (only for local sanity-checking the digest format;
# the actual digest computation always happens INSIDE the container, never
# on the host -- the host's own node may differ in version from the image's).
#
# bash 3.2-safe (macOS ships bash 3.2 as /bin/bash) and
# `shellcheck -S warning` clean -- no associative arrays, no `${var,,}`/
# `${var^^}` case expansion, no `mapfile`/`readarray`.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MANIFEST_SCRIPT="$REPO_ROOT/scripts/ruflo-seed/manifest.mjs"
DIGEST_FILE="$REPO_ROOT/scripts/ruflo-seed/SEED-MANIFEST.sha256"
DEFAULT_IMAGE_TAG="skillsmith-ruflo-seed:regen"

usage() {
  printf 'usage: %s [--no-build <image-tag>] [--check]\n' "$(basename "${BASH_SOURCE[0]}")" >&2
}

NO_BUILD=0
IMAGE_TAG="$DEFAULT_IMAGE_TAG"
CHECK_MODE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --no-build)
      NO_BUILD=1
      shift
      if [ $# -eq 0 ]; then
        printf '%s: --no-build requires an <image-tag> argument\n' "$(basename "${BASH_SOURCE[0]}")" >&2
        usage
        exit 2
      fi
      IMAGE_TAG="$1"
      shift
      ;;
    --check)
      CHECK_MODE=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf '%s: unrecognized argument: %s\n' "$(basename "${BASH_SOURCE[0]}")" "$1" >&2
      usage
      exit 2
      ;;
  esac
done

if [ ! -f "$MANIFEST_SCRIPT" ]; then
  printf 'regenerate-digest.sh: manifest generator not found at %s\n' "$MANIFEST_SCRIPT" >&2
  exit 1
fi

if [ "$NO_BUILD" -eq 0 ]; then
  printf 'regenerate-digest.sh: building image (target=ruflo) as %s ...\n' "$IMAGE_TAG" >&2
  if ! ( cd "$REPO_ROOT" && docker build --target ruflo -t "$IMAGE_TAG" . ); then
    printf 'regenerate-digest.sh: docker build failed for target ruflo\n' >&2
    exit 1
  fi
else
  printf 'regenerate-digest.sh: --no-build: reusing existing image %s\n' "$IMAGE_TAG" >&2
fi

# Step 2-3: create (not start) a container with node as the entrypoint,
# pointed at a path that does not need to exist until step 4 (docker start).
CONTAINER_ID="$(docker create --entrypoint node "$IMAGE_TAG" /tmp/manifest.mjs /opt/ruflo-seed --digest)"
if [ -z "$CONTAINER_ID" ]; then
  printf 'regenerate-digest.sh: docker create produced no container id\n' >&2
  exit 1
fi

cleanup() {
  docker rm -f "$CONTAINER_ID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! docker cp "$MANIFEST_SCRIPT" "$CONTAINER_ID:/tmp/manifest.mjs"; then
  printf 'regenerate-digest.sh: docker cp of %s into the container failed\n' "$MANIFEST_SCRIPT" >&2
  exit 1
fi

# Step 4: run it. `docker start -a` attaches stdout/stderr and blocks until
# the container exits; capture its stdout and status SEPARATELY (CLAUDE.md's
# "never conclude from truncated output" rule) -- this is a direct command
# substitution, not a pipe, so `$?` immediately below is docker start's own
# exit status, not some other command's.
NEW_DIGEST="$(docker start -a "$CONTAINER_ID")"
START_STATUS=$?
if [ "$START_STATUS" -ne 0 ]; then
  printf 'regenerate-digest.sh: container run failed (exit %s) -- manifest generator refused or crashed against /opt/ruflo-seed inside %s\n' "$START_STATUS" "$IMAGE_TAG" >&2
  exit 1
fi

case "$NEW_DIGEST" in
  *[!0-9a-f]* | "")
    printf 'regenerate-digest.sh: candidate output is not a lowercase sha256 hex digest (got %s)\n' "$NEW_DIGEST" >&2
    exit 1
    ;;
esac
if [ "${#NEW_DIGEST}" -ne 64 ]; then
  printf 'regenerate-digest.sh: candidate digest has length %s, expected 64 hex characters (got %s)\n' "${#NEW_DIGEST}" "$NEW_DIGEST" >&2
  exit 1
fi

# Step 5 (container removal) happens via the EXIT trap above.

OLD_DIGEST=""
if [ -f "$DIGEST_FILE" ]; then
  OLD_DIGEST="$(cat "$DIGEST_FILE")"
else
  printf 'regenerate-digest.sh: note: %s does not exist yet\n' "$DIGEST_FILE" >&2
fi

printf 'OLD: %s\n' "${OLD_DIGEST:-<none>}"
printf 'NEW: %s\n' "$NEW_DIGEST"

if [ "$CHECK_MODE" -eq 1 ]; then
  if [ "$OLD_DIGEST" != "$NEW_DIGEST" ]; then
    printf 'regenerate-digest.sh: MISMATCH -- committed %s does not match the digest derived from %s (OLD=%s NEW=%s)\n' \
      "$DIGEST_FILE" "$IMAGE_TAG" "$OLD_DIGEST" "$NEW_DIGEST" >&2
    exit 1
  fi
  printf 'regenerate-digest.sh: OK -- %s matches the digest derived from %s\n' "$DIGEST_FILE" "$IMAGE_TAG"
  exit 0
fi

printf '%s\n' "$NEW_DIGEST" >"$DIGEST_FILE"
printf 'regenerate-digest.sh: wrote %s\n' "$DIGEST_FILE"
