#!/bin/bash
# SMI-6676 feasibility checks 1+2 (macOS host, APFS, no root, no dtruss): /bin/rm -r against
# symlinks, a disk-image mount (with and without -x), and E44-style swaps timed by a slow tree.
# Scratch-only: refuses any base outside this session's scratchpad.
set -u
SP=/private/tmp/claude-501/-Users-williamsmith-Documents-GitHub-Smith-Horn-skillsmith/00e8585a-398c-4ef3-b023-3f54a2f9c5bd/scratchpad/smi6676
W=$SP/mac-work; case "$W" in "$SP"/*) ;; *) echo "unsafe base"; exit 99;; esac
REPS=${REPS:-3}; NBIG=${NBIG:-60000}
rm -rf "$W"; mkdir -p "$W"
echo "rm: $(what /bin/rm | sed -n 2p | tr -s ' \t' ' ') macOS $(sw_vers -productVersion) stdin_tty=$([ -t 0 ] && echo yes || echo no) uid=$(id -u)"
mkbig() { mkdir -p "$1"; (cd "$1" && seq -f 'f%06g' 1 "$NBIG" | xargs touch); }

echo "== M1 symlinks inside the tree"
for i in $(seq 1 $REPS); do B=$W/m1-$i; mkdir -p $B/outside $B/t/sub; echo OUT > $B/outside/o.txt; echo a > $B/t/sub/a; ln -s $B/outside $B/t/dlink; ln -s $B/outside/o.txt $B/t/flink
  /bin/rm -r $B/t; rc=$?; echo "M1 rep=$i rc=$rc outsideIntact=$([ "$(cat $B/outside/o.txt)" = OUT ] && echo yes || echo no) tGone=$([ -e $B/t ] && echo no || echo yes)"; done

echo "== M2 disk image mounted inside the tree (no root), rm -r vs rm -rx"
IMG=$W/img.dmg; hdiutil create -size 2m -fs HFS+ -volname s6676 -layout NONE -o $IMG >/dev/null || { echo "hdiutil create failed"; }
for flag in "-r" "-rx"; do for i in $(seq 1 $REPS); do B=$W/m2$flag-$i; mkdir -p $B/t/m; echo a > $B/t/a.txt; echo z > $B/t/z.txt
  hdiutil attach -nobrowse -mountpoint $B/t/m $IMG >/dev/null || { echo "attach failed"; continue; }; echo USER > $B/t/m/u.txt
  /bin/rm $flag $B/t 2>$B.err; rc=$?; surv=$([ -f $B/t/m/u.txt ] && echo yes || echo no)
  echo "M2 flag=$flag rep=$i rc=$rc userFileSurvives=$surv left=[$(ls -A $B/t 2>/dev/null | tr '\n' ' ')] stderr=$(tr '\n' ' ' < $B.err)"
  hdiutil detach $B/t/m >/dev/null 2>&1 || hdiutil detach -force $B/t/m >/dev/null 2>&1; done; done

# Find two sibling names where 'big' is listed before the victim (fts has no comparator in rm: readdir order).
pick_names() { local d=$W/order; rm -rf $d; mkdir -p $d; for n in big bigdir aaa-big zzz-big; do for v in victim v zz-victim aa-victim; do rm -rf $d/*; mkdir $d/$n $d/$v; first=$(ls -f $d | grep -v '^\.' | head -1); if [ "$first" = "$n" ]; then echo "$n $v"; return; fi; done; done; echo "none"; }
read BIGN VICN < <(pick_names); echo "names: big=$BIGN victim=$VICN (readdir order: big first)"

swap_run() { # $1 label $2 kind(dir|symlink|mount) $3 where(before-descent|inside-victim)
  local label=$1 kind=$2 where=$3 i
  for i in $(seq 1 $REPS); do
    local B=$W/s-$label-$i; mkdir -p $B/s $B/outside; echo OUT > $B/outside/o.txt; echo PARENT-USER > $B/zz-after.txt
    if [ $where = before-descent ]; then mkbig $B/s/$BIGN; mkdir $B/s/$VICN; echo b1 > $B/s/$VICN/f1; echo b2 > $B/s/$VICN/f2
    else mkbig $B/s/$VICN; echo b1 > $B/s/$VICN/f1; fi
    echo built > $B/s/zz-after.txt
    local mnt=""
    /bin/rm -r $B/s 2>$B.err & pid=$!
    sleep 0.4
    local before=$(ls -f $B/s/$([ $where = before-descent ] && echo $BIGN || echo $VICN) 2>/dev/null | wc -l | tr -d ' ')
    case $kind in
      dir) mv $B/s/$VICN $B/aside-victim; mkdir $B/s/$VICN; echo USER-REPL > $B/s/$VICN/f1; echo USER-ONLY > $B/s/$VICN/user-only;;
      symlink) mv $B/s/$VICN $B/aside-victim; ln -s $B/outside $B/s/$VICN;;
      mount) hdiutil attach -nobrowse -mountpoint $B/s/$VICN $IMG >/dev/null && { mnt=$B/s/$VICN; echo USER > $B/s/$VICN/u.txt; };;
    esac
    wait $pid; rc=$?
    local v
    case $kind in
      dir) v="replacement=$([ "$(cat $B/s/$VICN/f1 2>/dev/null)" = USER-REPL ] && [ -f $B/s/$VICN/user-only ] && echo intact || echo DAMAGED)";;
      symlink) v="outside=$([ "$(cat $B/outside/o.txt 2>/dev/null)" = OUT ] && echo intact || echo DELETED)";;
      mount) v="mountedFile=$([ -f $mnt/u.txt ] && echo survives || echo DELETED)"; [ -n "$mnt" ] && { hdiutil detach $mnt >/dev/null 2>&1 || hdiutil detach -force $mnt >/dev/null 2>&1; };;
    esac
    echo "$label rep=$i entriesInWalkedDirAtSwap=$before rc=$rc $v parentSiblingUserFile=$([ "$(cat $B/zz-after.txt 2>/dev/null)" = PARENT-USER ] && echo intact || echo DELETED) asideOriginal=$([ -e $B/aside-victim ] && (ls -A $B/aside-victim | wc -l | tr -d ' ') || echo n/a) stderr=$(tr '\n' ' ' < $B.err | cut -c1-200)"
  done; }
[ "$BIGN" != none ] && {
  swap_run A-dir-swapped-before-descent dir before-descent
  swap_run B-symlink-swapped-before-descent symlink before-descent
  swap_run C-dir-swapped-while-inside dir inside-victim
  swap_run D-mount-before-descent mount before-descent
}
rm -rf "$W"
