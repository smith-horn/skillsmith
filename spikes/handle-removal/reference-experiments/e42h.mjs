// E42h: what rmdir returns on a mount point before anything inside it is touched.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
const base = process.argv[2]
const kind = process.argv[3]
const res = []
const probe = (label, p) => {
  try {
    fs.rmdirSync(p)
    res.push({ label, result: 'removed' })
  } catch (e) {
    res.push({ label, result: e.code })
  }
}
fs.mkdirSync(path.join(base, 'plain-nonempty'), { recursive: true })
fs.writeFileSync(path.join(base, 'plain-nonempty', 'f'), 'f')
probe('ordinary non-empty directory', path.join(base, 'plain-nonempty'))
if (kind === 'linux') {
  for (const [label, fill] of [
    ['bind mount point, mounted dir non-empty', true],
    ['bind mount point, mounted dir empty', false],
  ]) {
    const u = path.join(base, `user-${fill}`)
    fs.mkdirSync(u, { recursive: true })
    if (fill) fs.writeFileSync(path.join(u, 'u.txt'), 'u')
    const m = path.join(base, 'tree', `m-${fill}`)
    fs.mkdirSync(m, { recursive: true })
    execFileSync('mount', ['--bind', u, m])
    probe(label, m)
    res.at(-1).userFileSurvives = fill ? fs.existsSync(path.join(u, 'u.txt')) : null
    execFileSync('umount', [m])
  }
}
console.log(JSON.stringify({ kind, node: process.version, res }))
