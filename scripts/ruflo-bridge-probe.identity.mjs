/**
 * ruflo-bridge-probe.identity.mjs — SMI-6744 A5.5.2 delta, D4.
 *
 * Split out of ruflo-bridge-probe.mjs, which crossed the 500-line gate when
 * the three-way identity outcome landed. Behaviour is unchanged by the split;
 * the constants this needs are passed in rather than duplicated, so there is
 * one definition of each and no second copy to drift.
 *
 * Returns one of three statuses and never two:
 *   confirmed    — identity matched the authority and freshness was checked
 *   contradicted — an active disagreement, which reads as degraded
 *   inconclusive — nothing was established, which must NOT read as healthy
 *
 * That third status is the point. An earlier revision returned null for both
 * "verified clean" and "could not verify", so a cached answer was written
 * healthy and the banner rendered nothing — the defect a cross-family code
 * gate found as its first blocker.
 */

// `memory_bridge_status` is a self-report from the layer that was lying
// (ADR-170), so a cached or latched `healthy` is a plausible answer no enum
// value alone can express. This check adds identity evidence the serving
// layer cannot fabricate (the fd-resolved store's own generation, read
// independently of the server's self-report) plus a write-free freshness
// signal (a monotonic counter checked across two calls in one probe).
//
// The nonce-challenge design the spec names as primary (write a random value
// into the store and require it echoed back) needs a write to the served
// store, which is gated on the owner's ingestion consent (Checkpoint 7, not
// taken here) — this implements ONLY the write-free fallback the spec names
// for that case, and states its weakness rather than papering over it: a
// counter that merely stays the same across two close-together calls is not
// proof of freshness, only an absence of the one failure mode (a visible
// decrease) this check can actually rule out.
//
// Fails OPEN: any error in this check (docker unavailable, no authority
// file, parsing failure) is logged and otherwise ignored — a check that
// cannot run is not the same as a check that found a problem, and promoting
// "inconclusive" to "wrong" would make this a second point of failure for
// the thing it exists to make more trustworthy.
export function checkIndependentIdentity(firstPayload, secondTotalEntries, log, deps) {
  const { execFileSync, readFileSync, CONTAINER_NAME, AGENTDB_DB_PATH, AUTHORITY_FILE } = deps
  try {
    const authorityRaw = readFileSync(AUTHORITY_FILE, 'utf8')
    const authority = JSON.parse(authorityRaw)
    const expectedGeneration = authority.generationUuid
    if (!expectedGeneration) {
      log('D4: authority file has no generationUuid')
      return {
        status: 'inconclusive',
        detail: 'the authority file carries no store generation to compare against',
      }
    }
    // Select the serving process by the descriptor it HOLDS, not by the order
    // its command line happens to appear in.
    //
    // Measured 2026-10-03, and the reason this check previously protected
    // nothing: six pids in this container satisfy a naive
    // cli.js+mcp+start cmdline predicate, and pid 1 is one of them, because
    // docker-init's own command line embeds the server's. /proc/[0-9]* globs
    // lexicographically, so pid 1 sorts first and a .find() selected the
    // wrapper — which holds no database descriptor at all. The check then
    // reported "no fd to inspect" and failed open on every single run.
    //
    // That artifact also invited a wrong explanation: that sql.js loads the
    // database into memory and keeps no descriptor. It does keep one. Of
    // those six pids, exactly one held agentdb-memory.db together with its
    // -wal and -shm. Scanning for the descriptor first is what makes this
    // check able to find its subject at all.
    //
    // Ambiguity is reported rather than guessed past: the container
    // accumulates orphaned server processes, so "more than one holder" is a
    // state that really occurs, and picking one arbitrarily is how a wrong
    // instrument returns a plausible answer instead of failing.
    const holderScan = execFileSync(
      'docker',
      [
        'exec',
        CONTAINER_NAME,
        'sh',
        '-c',
        'for p in /proc/[0-9]*; do pid=${p#/proc/}; ' +
          'c=$(tr "\\0" " " < "$p/cmdline" 2>/dev/null); ' +
          'case "$c" in *cli.js*mcp*start*) ' +
          'for f in "$p"/fd/*; do tgt=$(readlink "$f" 2>/dev/null); ' +
          'case "$tgt" in *agentdb-memory.db) echo "$pid $tgt";; esac; done;; esac; done',
      ],
      { encoding: 'utf8', timeout: 5000 }
    )
    const holders = holderScan
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    if (holders.length === 0) {
      log('D4: no server process holds an open fd to agentdb-memory.db')
      return {
        status: 'inconclusive',
        detail:
          'no server process holds the store open, so the served store could not be identified (genuinely no evidence, not a wrong subject)',
      }
    }
    // Several holders is the NORMAL state, not an anomaly, and an earlier
    // revision of this check treated it as a finding — which rendered a loud
    // false alarm on a healthy machine, measured 2026-10-03 (pids 2809 and
    // 502). Two reasons it is normal: this probe spawns its own server, which
    // opens the store, and the container accumulates orphaned servers that
    // keep their descriptors. A check that fires every session is one the
    // reader learns to ignore, which costs more than the check is worth.
    //
    // So the question is not WHICH process is the serving one — that is
    // unanswerable from a descriptor scan and, more importantly, not the
    // question D4 asks. D4 asks whether the store being served is the
    // authoritative one. That is answerable without identifying a unique
    // holder: require every holder to resolve to the same device:inode as
    // the authoritative path, and every holder's store generation to match
    // the authority file. Agreement across all holders confirms identity;
    // disagreement names the divergent process and is a real finding.
    const holderPids = holders.map((h) => h.split(' ')[0])
    const openAgentDb = holders[0].split(' ')[1]
    log(
      `D4: ${holders.length} process(es) hold the store open (pid(s) ${holderPids.join(', ')}); requiring all to agree with the authority`
    )
    const statOpen = execFileSync(
      'docker',
      ['exec', CONTAINER_NAME, 'stat', '-c', '%d:%i', openAgentDb],
      { encoding: 'utf8', timeout: 5000 }
    ).trim()
    const statExpected = execFileSync(
      'docker',
      ['exec', CONTAINER_NAME, 'stat', '-c', '%d:%i', AGENTDB_DB_PATH],
      { encoding: 'utf8', timeout: 5000 }
    ).trim()
    if (statOpen !== statExpected) {
      return {
        status: 'contradicted',
        detail: `the server's open agentdb-memory.db fd resolves to device:inode ${statOpen}, which differs from ${AGENTDB_DB_PATH}'s own ${statExpected} — a copied or substituted store`,
      }
    }
    // Every holder must resolve to that same inode. One holder agreeing is
    // not evidence about the others, and a divergent holder is exactly the
    // substituted-store case this check exists to catch.
    for (const hp of holderPids) {
      const hTargets = execFileSync(
        'docker',
        [
          'exec',
          CONTAINER_NAME,
          'sh',
          '-c',
          `for f in /proc/${hp}/fd/*; do tgt=$(readlink "$f" 2>/dev/null); case "$tgt" in *agentdb-memory.db) echo "$tgt";; esac; done`,
        ],
        { encoding: 'utf8', timeout: 5000 }
      )
      for (const tgt of hTargets
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean)) {
        const s = execFileSync('docker', ['exec', CONTAINER_NAME, 'stat', '-c', '%d:%i', tgt], {
          encoding: 'utf8',
          timeout: 5000,
        }).trim()
        if (s !== statExpected) {
          return {
            status: 'contradicted',
            detail: `pid ${hp} holds a store at device:inode ${s}, which differs from ${AGENTDB_DB_PATH}'s own ${statExpected} — two processes are serving different stores, so a healthy verdict is not attributable`,
          }
        }
      }
    }
    const genRaw = execFileSync(
      'docker',
      [
        'exec',
        CONTAINER_NAME,
        'node',
        '-e',
        `const D=require('/opt/ruflo-seed/node_modules/better-sqlite3/lib/index.js');const db=new D(${JSON.stringify(openAgentDb)},{readonly:true});const r=db.prepare('SELECT id FROM store_generation').get();process.stdout.write(r?r.id:'')`,
      ],
      { encoding: 'utf8', timeout: 5000 }
    ).trim()
    if (genRaw && genRaw !== expectedGeneration) {
      return {
        status: 'contradicted',
        detail: `the fd-resolved store's generation (${genRaw.slice(0, 12)}...) does not match the authority file's (${expectedGeneration.slice(0, 12)}...) — a copied generation marker pointing at the wrong store`,
      }
    }
    // Write-free freshness fallback: a counter that visibly DECREASED between
    // the two calls this probe made is impossible for a legitimate append-
    // mostly store and is the one thing this weaker check can rule out.
    const firstTotal = firstPayload?.agentdb?.totalEntries
    if (
      typeof firstTotal === 'number' &&
      typeof secondTotalEntries === 'number' &&
      secondTotalEntries < firstTotal
    ) {
      return {
        status: 'contradicted',
        detail: `agentdb.totalEntries decreased from ${firstTotal} to ${secondTotalEntries} across two calls in one probe — a cached or inconsistent answer`,
      }
    }
    // Freshness could only be checked at all if the second call produced a
    // number. Absent one, nothing was established — and this check must not
    // report "confirmed" for an absence, which is the whole defect the code
    // gate found as its first blocker.
    if (typeof secondTotalEntries !== 'number') {
      return {
        status: 'inconclusive',
        detail:
          'the second status call produced no entry count, so freshness was never established for this probe',
      }
    }
    return { status: 'confirmed' }
  } catch (e) {
    log(`D4: identity check inconclusive (${e.message})`)
    return {
      status: 'inconclusive',
      detail: `the identity check could not complete (${e.message})`,
    }
  }
}
