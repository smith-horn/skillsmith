#!/usr/bin/env bash
# shellcheck disable=SC2154  # run_capture assigns its rc variable by name through
# eval, which shellcheck cannot follow; every such variable IS assigned before use.
# ADR-170 § 6 egress arms 1, 2 and 4, run against the Compose service itself.
# Arm 3 is the § 2 seed acceptance and lives in lib/seed.sh.
#
# Each arm is paired with a known-positive control on a throwaway NETWORKED
# container, because an instrument that returns the same answer for a
# network-none container and a bridged one is measuring nothing. The controls
# run first, so a failure to distinguish the two states is reported before any
# verdict about the service is printed.

# S-4/F-12 (SMI-6744 A1.8 retro round 2): fall back to a no-op-safe note()
# when this file is sourced before lib/common.sh has defined it -- see
# lib/quad.sh's identical fallback (immediately above the same guard there)
# for the full rationale; same `declare -F` mechanism (S-4). Sourced-only.
declare -F note >/dev/null 2>&1 || note() { printf '  note: %s\n' "$1"; }

egress_arms() {
  h1 "ADR-170 § 6 -- egress, against the running Compose service $SERVICE"

  # ---- instrument controls -------------------------------------------------
  arm "E0-control" "the probe distinguishes a network-none container from a bridged one"
  applied "docker run --rm --network bridge <image> net-probe.mjs (known positive) and --network none (known negative)"
  run_capture ctl_pos_rc "$EVD/e0-positive.json" \
    docker run --rm --network bridge -v "$HARNESS":/harness:ro --entrypoint node "$IMAGE" /harness/net-probe.mjs
  run_capture ctl_neg_rc "$EVD/e0-negative.json" \
    docker run --rm --network none -v "$HARNESS":/harness:ro --entrypoint node "$IMAGE" /harness/net-probe.mjs
  pos_up_nonlo="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/e0-positive.json" upNonLoopback || echo ERR)"
  neg_up_nonlo="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/e0-negative.json" upNonLoopback || echo ERR)"
  pos_dns="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/e0-positive.json" dnsFailed || echo ERR)"
  neg_dns="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/e0-negative.json" dnsFailed || echo ERR)"
  pos_ip_code="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/e0-positive.json" rawIpCode || echo ERR)"
  # Positive equality on every half (M-4): a negated comparison like
  # `!= "0"` accepts "undefined"/"ERR"/anything-but-zero as a pass, which is
  # exactly the shape that let this instrument-control silently measure
  # nothing. Both docker runs must have actually exited 0, and pos_up_nonlo
  # must match a real positive integer, not merely fail to equal "0".
  if [ "$ctl_pos_rc" -eq 0 ] && [ "$ctl_neg_rc" -eq 0 ] &&
    printf '%s' "$pos_up_nonlo" | grep -qE '^[1-9][0-9]*$' &&
    [ "$neg_up_nonlo" = "0" ]; then ok=0; else ok=1; fi
  predicate "E0a instrument separates the two states (interfaces)" "$ok" \
    "both control containers exit 0; bridged container's upNonLoopback matches ^[1-9][0-9]*\$ (a real positive interface count); network-none's upNonLoopback == 0" \
    "ctl_pos_rc=$ctl_pos_rc ctl_neg_rc=$ctl_neg_rc bridged=$pos_up_nonlo none=$neg_up_nonlo"
  if [ "$pos_dns" = "false" ] && [ "$neg_dns" = "true" ]; then ok=0; else ok=1; fi
  predicate "E0b instrument separates the two states (egress)" "$ok" \
    "bridged container resolves DNS (failed=false); network-none fails (failed=true)" \
    "bridged.dnsFailed=$pos_dns none.dnsFailed=$neg_dns"
  # E0c (M-6): the bridged control's own raw-IP connect must NOT already read
  # as the service's expected failure signature -- otherwise E4b's assertion
  # of ENETUNREACH against the isolated service would be meaningless (an
  # instrument that says ENETUNREACH for an attached, working network too is
  # not distinguishing anything).
  if [ "$pos_ip_code" != "ENETUNREACH" ] && [ "$pos_ip_code" != "ERR" ]; then ok=0; else ok=1; fi
  predicate "E0c instrument's raw-IP connect succeeds on the bridged control" "$ok" \
    "the bridged known-positive control's raw-IP connect code is neither ENETUNREACH nor ERR -- E4b asserts ENETUNREACH against the isolated service using the same instrument" \
    "bridged.rawIpCode=$pos_ip_code"

  # ---- arm 1 ---------------------------------------------------------------
  # e1_eval <container> <evidence-basename> -- sets E1_VERDICT (0 unattached,
  # 1 attached) and E1_DETAIL. Used for BOTH the service and the bridged
  # known-positive control, so the arm is not trusted until the same code has
  # been shown to return the other answer for an attached container.
  e1_eval() {
    docker inspect "$1" --format '{{json .NetworkSettings}}' >"$EVD/$2-netsettings.json" 2>&1
    E1_MODE="$(docker inspect "$1" --format '{{.HostConfig.NetworkMode}}' 2>&1)"
    E1_NETS="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/$2-netsettings.json" netNames || echo ERR)"
    E1_ADDRESSED="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/$2-netsettings.json" netWithAddress || echo ERR)"
    E1_DETAILS="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/$2-netsettings.json" netDetail || echo ERR)"
    E1_DRIVERS=""
    for n in $(echo "$E1_NETS" | tr ',' ' '); do
      E1_DRIVERS="$E1_DRIVERS $n=$(docker network inspect "$n" --format '{{.Driver}}' 2>/dev/null || echo '?')"
    done
    # "no attached network" is read as: NetworkMode none; the only listed entry
    # is `none`, whose driver is null; and NO network carries an address. The
    # daemon always lists `none` for a --network none container, so requiring an
    # EMPTY map would be a predicate no correct configuration can satisfy.
    if [ "$E1_MODE" = "none" ] && [ "$E1_NETS" = "none" ] && [ "$E1_ADDRESSED" = "0" ] &&
      [ "$(echo "$E1_DRIVERS" | tr -d ' ')" = "none=null" ]; then E1_VERDICT=0; else E1_VERDICT=1; fi
    E1_DETAIL="NetworkMode=$E1_MODE networks='$E1_NETS' drivers='$E1_DRIVERS' addressedNetworks=$E1_ADDRESSED detail: $E1_DETAILS"
  }

  arm "E1" "docker inspect reports no attached Docker network for the service"
  applied "docker inspect $SERVICE -- HostConfig.NetworkMode, NetworkSettings.Networks (raw JSON), and the driver of each listed network; the same evaluator is then run against a bridged control"
  _ctl="a14-e1-ctl-$$"
  docker run -d --name "$_ctl" --network bridge --entrypoint sleep "$IMAGE" 30 >/dev/null 2>&1 || true
  e1_eval "$_ctl" e1-control
  _ctl_verdict="$E1_VERDICT"
  _ctl_detail="$E1_DETAIL"
  docker rm -f "$_ctl" >/dev/null 2>&1 || true
  e1_eval "$SERVICE" e1-service
  if [ "$_ctl_verdict" -ne 0 ]; then ok=1; else ok=0; fi
  predicate "E1-control the same evaluator calls a BRIDGED container attached" "$([ "$_ctl_verdict" -ne 0 ] && echo 0 || echo 1)" \
    "the bridged control is judged ATTACHED (verdict 1), proving the evaluator is not a constant" \
    "control verdict=$_ctl_verdict; $_ctl_detail"
  predicate "E1 no attached Docker network" "$E1_VERDICT" \
    "HostConfig.NetworkMode=none, NetworkSettings.Networks == {none} whose driver is null, and 0 networks carrying an address" \
    "$E1_DETAIL"

  # ---- arm 2 ---------------------------------------------------------------
  arm "E2" "no UP non-loopback interface and no non-loopback address inside the service container"
  applied "docker exec $SERVICE node /harness/net-probe.mjs (reads /sys/class/net/*/flags, /proc/net/fib_trie, /proc/net/if_inet6, /proc/net/route)"
  run_capture e2_rc "$EVD/e2-service.json" \
    docker exec -i "$SERVICE" node - < "$HARNESS/net-probe.mjs"
  up_nonlo="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/e2-service.json" upNonLoopback || echo ERR)"
  nonlo_v4="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/e2-service.json" nonLoopbackV4 || echo ERR)"
  nonlo_v6="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/e2-service.json" nonLoopbackV6 || echo ERR)"
  routes="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/e2-service.json" routeCount || echo ERR)"
  iflist="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/e2-service.json" ifaceSummary || echo ERR)"
  if [ "$up_nonlo" = "0" ] && [ "$nonlo_v4" = "0" ] && [ "$nonlo_v6" = "0" ] && [ "$routes" = "0" ]; then ok=0; else ok=1; fi
  predicate "E2 no non-loopback network presence" "$ok" \
    "0 UP non-loopback interfaces, 0 non-loopback IPv4 addresses, 0 non-loopback IPv6 addresses, 0 routes" \
    "upNonLoopback=$up_nonlo nonLoopbackV4=$nonlo_v4 nonLoopbackV6=$nonlo_v6 routes=$routes probeRc=$e2_rc; interfaces: $iflist"
  note "the literal 'no non-loopback interface' is not the predicate: this kernel creates tunl0/gre0/gretap0/erspan0/ip_vti0/ip6_vti0/sit0/ip6tnl0/ip6gre0 in EVERY new netns; none is UP and none carries an address."

  # ---- arm 4 ---------------------------------------------------------------
  arm "E4" "a known outbound request from inside fails with A0.7's measured signature"
  applied "the same net-probe run above: dns.lookup(registry.npmjs.org) and net.connect(93.184.216.34:443)"
  dns_code="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/e2-service.json" dnsCode || echo ERR)"
  dns_errno="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/e2-service.json" dnsErrno || echo ERR)"
  dns_syscall="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/e2-service.json" dnsSyscall || echo ERR)"
  ip_code="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/e2-service.json" rawIpCode || echo ERR)"
  ip_errno="$(node "$HARNESS/lib/jqlite.mjs" "$EVD/e2-service.json" rawIpErrno || echo ERR)"
  if [ "$dns_code" = "EAI_AGAIN" ] && [ "$dns_errno" = "-3001" ] && [ "$dns_syscall" = "getaddrinfo" ]; then ok=0; else ok=1; fi
  predicate "E4a DNS errno matches A0.7" "$ok" \
    "code=EAI_AGAIN errno=-3001 syscall=getaddrinfo" \
    "code=$dns_code errno=$dns_errno syscall=$dns_syscall"
  if [ "$ip_code" = "ENETUNREACH" ]; then ok=0; else ok=1; fi
  predicate "E4b raw-IP connect errno matches A0.7" "$ok" \
    "code=ENETUNREACH on connect to a raw IP (no DNS involved)" \
    "code=$ip_code errno=$ip_errno"
}

# The § 6 required failing mutation is NOT run by this harness: it edits the
# live service's own compose entry and recreates it, which is the queen's to do.
egress_mutation_doc() {
  h1 "ADR-170 § 6 required failing mutation -- NOT RUN HERE"
  cat <<'DOC'
  applied=nothing. This mode prints the procedure and stops.

  ADR-170 § 6: "Required failing mutation: delete `network_mode: none`,
  recreate, and arms 1, 2 and 4 must fail."

  Steps (the queen owns the service lifecycle, so the queen runs these):
    1. In docker-compose.yml, comment out the ruflo service's `network_mode: none`.
    2. docker compose --profile ruflo up -d --force-recreate ruflo
    3. ./scripts/ruflo-acceptance/run.sh --egress
    4. Restore the line and recreate again; re-run --egress and require green.

  Expected failing arms after step 2, each with the value that changes:
    E1  NetworkMode becomes the project's bridge network (e.g. <project>_default),
        NetworkSettings.Networks gains that entry with a non-empty IPAddress.
    E2  eth0 appears UP (flags bit 0x1) and non-loopback, nonLoopbackV4 becomes 1,
        routeCount becomes >= 1.
    E4a dns.failed becomes false (an address is returned) -- or, if the upstream
        resolver is unreachable for another reason, the code is NOT EAI_AGAIN/-3001.
    E4b the raw-IP connect no longer returns ENETUNREACH (it connects, times out,
        or is refused).
    E0  the two controls collapse: the bridged control and the service report the
        same values, which is itself the signal that the service is no longer
        isolated.

  Not measured here: whether arms 1, 2 and 4 fail INDEPENDENTLY of one another
  under that mutation. They share one cause (an attached network), so this
  mutation is one mutation, not three.
DOC
}
