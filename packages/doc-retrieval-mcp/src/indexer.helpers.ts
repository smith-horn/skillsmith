import { createHash } from 'node:crypto'
import type { ChunkConfig, CorpusConfig } from './config.js'
import type { ChunkMetadata } from './types.js'

const TOKEN_CHAR_RATIO = 4

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_CHAR_RATIO)
}

interface HeadingLine {
  level: number
  text: string
  lineNumber: number
}

export interface ParsedMarkdownBlock {
  headingChain: string[]
  startLine: number
  endLine: number
  content: string
}

export function parseMarkdown(raw: string): ParsedMarkdownBlock[] {
  const lines = raw.split('\n')
  const blocks: ParsedMarkdownBlock[] = []
  const stack: HeadingLine[] = []
  let bufferStart = 1
  let bufferLines: string[] = []
  let inFence = false
  let fenceMarker = ''

  const flush = (endLine: number): void => {
    const content = bufferLines.join('\n').trim()
    if (content.length === 0) return
    blocks.push({
      headingChain: stack.map((h) => h.text),
      startLine: bufferStart,
      endLine,
      content,
    })
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNo = i + 1

    const fence = line.match(/^(`{3,}|~{3,})/)
    if (fence) {
      if (!inFence) {
        inFence = true
        fenceMarker = fence[1]
      } else if (line.startsWith(fenceMarker)) {
        inFence = false
      }
    }

    const headingMatch = !inFence && line.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      if (bufferLines.length > 0) {
        flush(lineNo - 1)
      }
      const level = headingMatch[1].length
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop()
      }
      stack.push({ level, text: headingMatch[2].trim(), lineNumber: lineNo })
      bufferStart = lineNo
      bufferLines = [line]
      continue
    }

    bufferLines.push(line)
  }

  if (bufferLines.length > 0) {
    flush(lines.length)
  }

  return blocks
}

export function chunkBlocks(
  blocks: ParsedMarkdownBlock[],
  filePath: string,
  chunkCfg: ChunkConfig
): ChunkMetadata[] {
  const chunks: ChunkMetadata[] = []
  for (const block of blocks) {
    const blockChunks = splitBlock(block, chunkCfg)
    for (const c of blockChunks) {
      if (c.tokens < chunkCfg.minTokens) continue
      chunks.push(finalize(c, filePath))
    }
  }
  return chunks
}

interface RawChunk {
  text: string
  startLine: number
  endLine: number
  tokens: number
  headingChain: string[]
}

function splitBlock(block: ParsedMarkdownBlock, cfg: ChunkConfig): RawChunk[] {
  const lines = block.content.split('\n')
  const tokensPerLine = lines.map((l) => estimateTokens(l))
  const total = tokensPerLine.reduce((a, b) => a + b, 0)

  if (total <= cfg.targetTokens) {
    return [
      {
        text: block.content,
        startLine: block.startLine,
        endLine: block.endLine,
        tokens: total,
        headingChain: block.headingChain,
      },
    ]
  }

  const out: RawChunk[] = []
  let cursor = 0
  while (cursor < lines.length) {
    let tokens = 0
    let end = cursor
    while (end < lines.length && tokens + tokensPerLine[end] <= cfg.targetTokens) {
      tokens += tokensPerLine[end]
      end++
    }
    if (end === cursor) {
      tokens = tokensPerLine[end]
      end = cursor + 1
    }
    out.push({
      text: lines.slice(cursor, end).join('\n'),
      startLine: block.startLine + cursor,
      endLine: block.startLine + end - 1,
      tokens,
      headingChain: block.headingChain,
    })
    if (end >= lines.length) break
    cursor = findOverlapStart(cursor, end, tokensPerLine, cfg.overlapTokens)
  }
  return out
}

function findOverlapStart(
  currentStart: number,
  currentEnd: number,
  tokensPerLine: number[],
  overlap: number
): number {
  let tokens = 0
  let idx = currentEnd
  while (idx > currentStart && tokens < overlap) {
    idx--
    tokens += tokensPerLine[idx]
  }
  const next = idx
  return next === currentStart ? currentEnd : next
}

function finalize(raw: RawChunk, filePath: string): ChunkMetadata {
  const id = chunkId(filePath, raw.startLine, raw.endLine, raw.text)
  return {
    id,
    filePath,
    lineStart: raw.startLine,
    lineEnd: raw.endLine,
    headingChain: raw.headingChain,
    text: raw.text,
    tokens: raw.tokens,
  }
}

function chunkId(filePath: string, startLine: number, endLine: number, text: string): string {
  const hash = createHash('sha1')
    .update(`${filePath}:${startLine}:${endLine}:${text}`)
    .digest('hex')
    .slice(0, 16)
  return `${filePath}#L${startLine}-L${endLine}@${hash}`
}

export function chunkDocument(raw: string, filePath: string, cfg: CorpusConfig): ChunkMetadata[] {
  const blocks = parseMarkdown(raw)
  return chunkBlocks(blocks, filePath, cfg.chunk)
}
