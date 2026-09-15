#!/bin/bash
# SMI-6676 feasibility check 1 (Linux): what GNU rm -r actually calls, symlink handling, --one-file-system vs mounts.
# Runs ONLY inside a throwaway `docker run --rm --privileged` container. Never on the host.
set -u
[ -f /.dockerenv ] || { echo "refusing: not in a container"; exit 99; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq strace >/dev/null 2>&1
echo "== versions"; rm --version | head -1; strace -V | head -1; uname -r; cat /etc/debian_version
W=/work; rm -rf "$W"; mkdir -p "$W" /logs
TR="strace -f -e trace=openat,unlinkat,rmdir,unlink,newfstatat,fstatat64,statx,fstat,getdents64,fchdir,chdir,close,fcntl,lseek"

echo "== T1 plain tree with dir symlink and file symlink to outside"
mkdir -p $W/outside && echo OUT > $W/outside/o.txt
mkdir -p $W/t/sub/deep && echo a > $W/t/a.txt && echo b > $W/t/sub/b.txt && echo c > $W/t/sub/deep/c.txt
ln -s $W/outside $W/t/dlink; ln -s $W/outside/o.txt $W/t/flink
$TR -o /logs/t1.trace rm -r $W/t; rc=$?
echo "T1 rc=$rc t_exists=$([ -e $W/t ] && echo yes || echo no) outside_intact=$([ "$(cat $W/outside/o.txt 2>/dev/null)" = OUT ] && echo yes || echo no)"
echo "-- T1 trace (after rm's own argv lstat; libs/locale filtered)"
awk '/newfstatat\(AT_FDCWD, "\/work\/t"/{on=1} on' /logs/t1.trace | grep -v -E '/lib/|/usr/|/etc/|locale' | sed 's/^[0-9]* *//'

for oneFs in no yes; do
for kind in bind-same-fs tmpfs-other-fs; do
  B=$W/m-$kind-$oneFs; mkdir -p $B/t/m $B/user; echo a > $B/t/a.txt; echo z > $B/t/z.txt
  if [ $kind = bind-same-fs ]; then echo USER > $B/user/u.txt; mount --bind $B/user $B/t/m; else mount -t tmpfs tmpfs $B/t/m; echo USER > $B/t/m/u.txt; fi
  flag=""; [ $oneFs = yes ] && flag="--one-file-system"
  $TR -o /logs/t2-$kind-$oneFs.trace rm -r $flag $B/t > /logs/t2-$kind-$oneFs.out 2>&1; rc=$?
  surv=$([ -f $B/t/m/u.txt ] && echo yes || echo no)
  echo "T2 kind=$kind one-file-system=$oneFs rc=$rc userFileSurvives=$surv left=[$(ls -A $B/t 2>/dev/null | tr '\n' ' ')] stderr=$(tr '\n' ' ' < /logs/t2-$kind-$oneFs.out)"
  umount $B/t/m 2>/dev/null
done; done
echo "-- T2 trace, bind-same-fs, one-file-system=yes (filtered)"
awk '/newfstatat\(AT_FDCWD, "\/work\/m-bind/{on=1} on' /logs/t2-bind-same-fs-yes.trace | grep -v -E '/lib/|/usr/|/etc/|locale' | sed 's/^[0-9]* *//'
echo "-- T2 trace, tmpfs-other-fs, one-file-system=yes (filtered)"
awk '/newfstatat\(AT_FDCWD, "\/work\/m-tmpfs/{on=1} on' /logs/t2-tmpfs-other-fs-yes.trace | grep -v -E '/lib/|/usr/|/etc/|locale' | sed 's/^[0-9]* *//'
