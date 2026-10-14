// SMI-7123 Wave 5 (design §3.4): the one job a prune parent passes its walker
// child on stdin. bigints travel as decimal strings and sidecar bytes as base64.

const ID_KEYS = ['dev', 'ino', 'birthtimeNs']
const READ_KEYS = ['ino', 'size', 'mtimeNs', 'ctimeNs']

export function encodeJob(job) {
  const out = { ...job }
  out.rootIdentity = Object.fromEntries(ID_KEYS.map((k) => [k, String(job.rootIdentity[k])]))
  out.sidecarRead =
    job.sidecarRead === null || job.sidecarRead === undefined
      ? null
      : {
          bytes: Buffer.from(job.sidecarRead.bytes).toString('base64'),
          ...Object.fromEntries(READ_KEYS.map((k) => [k, String(job.sidecarRead[k])])),
        }
  return out
}

export function decodeJob(raw) {
  const job = { ...raw }
  job.rootIdentity = Object.fromEntries(ID_KEYS.map((k) => [k, BigInt(raw.rootIdentity[k])]))
  job.sidecarRead =
    raw.sidecarRead === null
      ? null
      : {
          bytes: Buffer.from(raw.sidecarRead.bytes, 'base64'),
          ...Object.fromEntries(READ_KEYS.map((k) => [k, BigInt(raw.sidecarRead[k])])),
        }
  for (const k of ['copyPath', 'leaf', 'approvedHash', 'trashRoot', 'opDir']) {
    if (typeof job[k] !== 'string') throw new TypeError(`prune job: ${k} must be a string`)
  }
  return job
}
