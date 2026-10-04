#!/usr/bin/env node
/**
 * Raw-text duplicate-key scanner for audit-dependency-registry-helpers.mjs
 * (SMI-6949 XF-M2). JSON.parse keeps the LAST duplicate and the loss is
 * invisible afterwards, so duplicates must be found in the raw text, before
 * ordinary parsing. The input must already have passed JSON.parse (the caller
 * guarantees well-formedness); this is a minimal scanner, not a validator.
 */

/**
 * @param {string} text well-formed JSON text
 * @returns {Array<{key: string, path: string}>} one entry per repeated key
 */
export function scanDuplicateJsonKeys(text) {
  const dups = []
  let i = 0
  const ws = () => {
    while (i < text.length && ' \t\r\n'.includes(text[i])) i++
  }
  const str = () => {
    const start = i
    i++ // opening quote
    while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1
    i++
    return JSON.parse(text.slice(start, i))
  }
  const value = (path) => {
    ws()
    const c = text[i]
    if (c === '{') return obj(path)
    if (c === '[') return arr(path)
    if (c === '"') return void str()
    while (i < text.length && !',}] \t\r\n'.includes(text[i])) i++
  }
  const arr = (path) => {
    i++
    ws()
    let n = 0
    while (text[i] !== ']') {
      value(`${path}[${n++}]`)
      ws()
      if (text[i] === ',') i++
      ws()
    }
    i++
  }
  const obj = (path) => {
    i++
    ws()
    const seen = new Set()
    while (text[i] !== '}') {
      ws()
      const key = str()
      if (seen.has(key)) dups.push({ key, path })
      seen.add(key)
      ws()
      i++ // colon
      value(path ? `${path}.${key}` : key)
      ws()
      if (text[i] === ',') i++
      ws()
    }
    i++
  }
  value('')
  return dups
}
