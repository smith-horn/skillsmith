// SMI-7123 Wave 5: the row-only FUNCTION STUBS (controls for Q6-Q10), split out
// of w5-mutants.mjs for the file-length limit and re-exported from it. Each is
// self-contained: none imports the W5 module it stands in for.
import fs from 'node:fs'
import path from 'node:path'

/** C4-stateroot (Q6 control): park into a trash under the STATE root, not next to the tree. */
export function c4Stateroot(parentAbs, name, stateRoot) {
  const dest = path.join(stateRoot, '.skillsmith-trash', `op-stateroot-${process.pid}`)
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 })
  try {
    fs.renameSync(path.join(parentAbs, name), path.join(dest, name))
    return { status: 'quarantined', path: path.join(dest, name), errno: null }
  } catch (err) {
    return {
      status: 'stopped',
      reason: 'quarantine-failed',
      path: path.join(parentAbs, name),
      entry: name,
      errno: err.code ?? null,
    }
  }
}

/** C4-consolation (Q7 control): on a failed park, delete the tree anyway ("consolation" rm). */
export function c4Consolation(quarantine, rmRf) {
  return (parentAbs, name, options) => {
    const r = quarantine(parentAbs, name, options)
    if (r.status === 'stopped') rmRf(path.join(parentAbs, name))
    return r
  }
}

const readIndex = (indexPath) => {
  try {
    return fs
      .readFileSync(indexPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

/** list-index-only (Q8 control): the index is the listing; a copy without a line is invisible. */
export function listIndexOnly({ roots, indexPath }) {
  const entries = readIndex(indexPath).filter((e) =>
    roots.some((r) => e.path.startsWith(path.join(r, '.skillsmith-trash') + path.sep))
  )
  return {
    roots: roots.map((r) => ({
      root: r,
      copies: entries
        .filter((e) => e.path.startsWith(r))
        .map((e) => ({ copyPath: e.path, index: 'present' })),
    })),
    index: { errors: [], stale: [] },
  }
}

/** list-throwing (Q8 control): an index line whose copy is gone throws. */
export function listThrowing({ roots, indexPath }) {
  for (const e of readIndex(indexPath)) {
    if (!fs.existsSync(e.path)) throw new Error(`index names a missing copy: ${e.path}`)
  }
  return listIndexOnly({ roots, indexPath })
}

/** list-scan-path (Q8 control): every index entry is listed, including roots not scanned. */
export function listScanPath({ indexPath }) {
  return {
    roots: [
      {
        root: '(index)',
        copies: readIndex(indexPath)
          .filter((e) => fs.existsSync(e.path))
          .map((e) => ({ copyPath: e.path, index: 'present' })),
      },
    ],
    index: { errors: [], stale: [] },
  }
}

/** report-drop-origin (Q9 control): the report omits where each copy came from. */
export function reportDropOrigin(listing) {
  const lines = []
  for (const r of listing.roots) {
    if (r.absent || r.refused) continue
    lines.push(`Trash next to your skill folders: ${r.copies.length} copies`)
    lines.push(
      `Skillsmith parked these copies in ${r.trashRoot}, next to your own directory ${r.root}.`
    )
    for (const c of r.copies) lines.push(`  copy  0d  ${c.copyPath}`)
  }
  return lines.join('\n')
}

/** gitignore-editor (Q10 control): "helpfully" appends the trash to the user's .gitignore. */
export function gitignoreEditor(root, seenRoots) {
  if (seenRoots.has(root)) return null
  seenRoots.add(root)
  fs.appendFileSync(path.join(root, '.gitignore'), '\n.skillsmith-trash/\n')
  return 'added .skillsmith-trash/ to your .gitignore'
}
