#!/bin/bash
# SMI-6676 feasibility check 2 (Linux): E44-style swaps and mid-walk mounts against GNU rm -r,
# paused at exact syscalls with strace fault injection (delay), no FUSE.
# Runs ONLY inside a throwaway `docker run --rm --privileged` container.
set -u
[ -f /.dockerenv ] || { echo "refusing: not in a container"; exit 99; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq strace >/dev/null 2>&1
REPS=${REPS:-3}; DELAY_US=3000000; SWAP_AFTER=1.5
W=${W:-/work}; mkdir -p "$W"; FS=$(stat -f -c %T "$W"); echo "fs=$FS rm=$(rm --version | head -1) kernel=$(uname -r)"
mkfix() { rm -rf "$1"; mkdir -p "$1/s/sub" "$1/outside" "$1/user"; echo built1 > "$1/s/sub/f1"; echo built2 > "$1/s/sub/f2"; echo OUT > "$1/outside/o.txt"; echo USER > "$1/user/u.txt"; }
# ordinal of the Nth call of syscall $2 whose line matches $3, in a dry run
ordinal() { local B=$1 sc=$2 pat=$3 nth=$4; mkfix "$B"; strace -e trace=$sc -o "$B.dry" rm -r "$B/s" 2>/dev/null; grep -n '' "$B.dry" | grep -E "$pat" | sed -n "${nth}p" | cut -d: -f1; }
swapdo() { # $1 base, $2 kind
  case $2 in
    dir) mv "$1/s/sub" "$1/aside-sub"; mkdir "$1/s/sub"; echo USER-REPL > "$1/s/sub/f1"; echo USER-ONLY > "$1/s/sub/user-only";;
    symlink) mv "$1/s/sub" "$1/aside-sub"; ln -s "$1/outside" "$1/s/sub";;
    mount) mount --bind "$1/user" "$1/s/sub";;
  esac; }
judge() { # $1 base, $2 kind, $3 rc
  local B=$1 k=$2 rc=$3 verdict
  case $k in
    dir) [ "$(cat $B/s/sub/f1 2>/dev/null)" = USER-REPL ] && [ -f $B/s/sub/user-only ] && verdict=replacementIntact || verdict=REPLACEMENT_DAMAGED
         verdict="$verdict original=$( [ -e $B/aside-sub/f1 ] && echo intact || echo emptied)";;
    symlink) [ "$(cat $B/outside/o.txt 2>/dev/null)" = OUT ] && verdict=outsideIntact || verdict=OUTSIDE_DELETED
         verdict="$verdict original=$( [ -e $B/aside-sub/f1 ] && echo intact || echo emptied)";;
    mount) [ -f $B/user/u.txt ] && verdict=mountedFileSurvives || verdict=MOUNTED_FILE_DELETED; umount $B/s/sub 2>/dev/null;;
    none) verdict="(no swap)";;
  esac
  echo "rc=$rc $verdict"; }
run() { # $1 label, $2 inject spec ('' = swap before rm starts), $3 kind
  local label=$1 inj=$2 kind=$3 i
  for i in $(seq 1 $REPS); do
    local B=$W/r-$label-$kind-$i; mkfix "$B"
    if [ -z "$inj" ]; then swapdo "$B" "$kind"; rm -r "$B/s" 2>"$B.err"; rc=$?
    else strace -o "$B.trace" -e trace=openat,unlinkat,newfstatat,getdents64 -e inject=$inj rm -r "$B/s" 2>"$B.err" & pid=$!
         sleep $SWAP_AFTER; swapdo "$B" "$kind"; wait $pid; rc=$?; fi
    echo "$label kind=$kind rep=$i $(judge "$B" "$kind" $rc) stderr=$(tr '\n' ' ' < "$B.err" | cut -c1-160)"
  done; }
D=$W/dry
N_OPEN1=$(ordinal $D openat '"sub"' 1); N_OPEN2=$(ordinal $D openat '"sub"' 2)
N_RMSUB=$(ordinal $D unlinkat '"sub", AT_REMOVEDIR' 1); N_UNL1=$(ordinal $D unlinkat 'unlinkat\(' 1)
echo "ordinals: openat(sub)#1=$N_OPEN1 openat(sub)#2=$N_OPEN2 unlinkat first=$N_UNL1 unlinkat(sub,AT_REMOVEDIR)=$N_RMSUB"
for kind in dir symlink mount; do
  run S0-before-rm-starts "" $kind
  run S1-before-first-open-of-sub "openat:delay_enter=$DELAY_US:when=$N_OPEN1" $kind
  run S2-between-listing-open-and-reopen "openat:delay_enter=$DELAY_US:when=$N_OPEN2" $kind
  run S3-after-reopen-before-first-unlink "unlinkat:delay_enter=$DELAY_US:when=$N_UNL1" $kind
  run S4-before-rmdir-of-sub "unlinkat:delay_enter=$DELAY_US:when=$N_RMSUB" $kind
done
echo "-- sample trace S2 dir rep1"; grep -v -E '/lib/|/usr/|/etc/|locale' $W/r-S2-between-listing-open-and-reopen-dir-1.trace | tail -20
