// E42e: T-K1 selection assertion against the §3.5 kind table and a control table marking failed-build default-prunable.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
function treeHash(dir) {
  const h = crypto.createHash('sha256')
  const walk = (rel) => {
    for (const n of fs.readdirSync(path.join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${n}` : n
      const a = path.join(dir, r)
      const s = fs.lstatSync(a)
      const mode = (s.mode & 0o7777).toString(8)
      if (s.isDirectory()) {
        h.update(`d\0${r}\0${mode}\n`)
        walk(r)
      } else if (s.isSymbolicLink()) h.update(`l\0${r}\0${mode}\0${fs.readlinkSync(a)}\n`)
      else h.update(`f\0${r}\0${mode}\0${s.size}\0${sha(fs.readFileSync(a))}\n`)
    }
  }
  walk('')
  return h.digest('hex')
}
const rmWalk = (p) => {
  for (const n of fs.readdirSync(p)) {
    const a = path.join(p, n)
    if (fs.lstatSync(a).isDirectory()) rmWalk(a)
    else fs.unlinkSync(a)
  }
  fs.rmdirSync(p)
}
const NEEDS_INCLUDE_KEPT = [
  'conflict',
  'edited-new',
  'unrecorded-new',
  'partial-copy:false',
  'abandoned-old',
  'abandoned-new',
  'abandoned-undone',
  'abort-remnant',
  'failed-build',
  'quarantined',
]
const DEFAULT_PRUNABLE = ['backup', 'undone', 'unused-new', 'partial-copy:true']
const tables = {
  'plan §3.5': { defaultPrunable: new Set(DEFAULT_PRUNABLE) },
  'control: failed-build default-prunable': {
    defaultPrunable: new Set([...DEFAULT_PRUNABLE, 'failed-build']),
  },
}
const kindKey = (s) => (s.kind === 'partial-copy' ? `partial-copy:${!!s.sourceUnchanged}` : s.kind)
for (const [tname, table] of Object.entries(tables))
  for (let rep = 1; rep <= 3; rep++) {
    const root = fs.mkdtempSync(path.join(process.env.SCRATCH, 'e42e-'))
    const area = path.join(root, 'backups', 'update', 'skill-a')
    fs.mkdirSync(area, { recursive: true })
    const all = [...DEFAULT_PRUNABLE, ...NEEDS_INCLUDE_KEPT]
    all.forEach((k, i) => {
      const [kind, su] = k.split(':')
      const name = `op${i}.${kind}`
      const t = path.join(area, name)
      fs.mkdirSync(t)
      fs.writeFileSync(path.join(t, 'SKILL.md'), `${k}\n`)
      fs.writeFileSync(
        `${t}.json`,
        JSON.stringify({ kind, sourceUnchanged: su === 'true', treeHash: treeHash(t) })
      )
    })
    // newest backup, protected by --keep 1
    {
      const t = path.join(area, 'op99')
      fs.mkdirSync(t)
      fs.writeFileSync(path.join(t, 'SKILL.md'), 'newest\n')
      fs.writeFileSync(
        `${t}.json`,
        JSON.stringify({ kind: 'backup', treeHash: treeHash(t), newest: true })
      )
    }
    // prune --apply, default flags (no --include-kept)
    const trash = path.join(root, 'backups', 'update', '.trash')
    fs.mkdirSync(trash)
    const deleted = []
    for (const n of fs.readdirSync(area).filter((n) => !n.endsWith('.json'))) {
      const side = JSON.parse(fs.readFileSync(path.join(area, `${n}.json`), 'utf8'))
      if (side.newest || !table.defaultPrunable.has(kindKey(side))) continue
      const parked = path.join(trash, n)
      fs.renameSync(path.join(area, n), parked)
      if (treeHash(parked) !== side.treeHash) {
        fs.renameSync(parked, path.join(area, n))
        continue
      }
      rmWalk(parked)
      fs.unlinkSync(path.join(area, `${n}.json`))
      deleted.push(kindKey(side))
    }
    const violations = deleted.filter((k) => NEEDS_INCLUDE_KEPT.includes(k))
    console.log(
      JSON.stringify({
        table: tname,
        rep,
        deleted,
        tK1SelectionAssertion: violations.length
          ? `FAILS (deleted without --include-kept: ${violations.join(', ')})`
          : 'passes',
        failedBuildSurvives: fs.existsSync(
          path.join(area, `op${all.indexOf('failed-build')}.failed-build`)
        ),
      })
    )
    fs.rmSync(root, { recursive: true, force: true })
  }
