import { describe, it, expect } from 'vitest'
import { loadCSVDataset, loadJSONDataset, loadDataset } from '../../src/benchmarks/evoskill/dataset-loader.js'

describe('loadCSVDataset', () => {
  const csv = [
    'question,answer',
    'What is 2+2?,4',
    'Capital of France?,Paris',
    'Color of sky?,Blue',
    'Largest planet?,Jupiter',
    'Speed of light?,299792458',
    'Boiling point of water?,100',
    'Chemical symbol for gold?,Au',
    'Year of moon landing?,1969',
    'Pi to 2 decimals?,3.14',
    'Continent of Brazil?,South America',
  ].join('\n')

  it('parses all rows', () => {
    const result = loadCSVDataset(csv, 'officeqa', { seed: 42 })
    expect(result.tasks).toHaveLength(10)
  })

  it('splits into train/val/test', () => {
    const result = loadCSVDataset(csv, 'officeqa', { seed: 42 })
    expect(result.train.length).toBeGreaterThan(0)
    expect(result.val.length).toBeGreaterThan(0)
    expect(result.test.length).toBeGreaterThan(0)
    expect(result.train.length + result.val.length + result.test.length).toBe(10)
  })

  it('assigns correct split labels', () => {
    const result = loadCSVDataset(csv, 'officeqa', { seed: 42 })
    for (const t of result.train) expect(t.split).toBe('train')
    for (const t of result.val) expect(t.split).toBe('val')
    for (const t of result.test) expect(t.split).toBe('test')
  })

  it('uses default split ratios (18/12/70)', () => {
    // With 10 items: train=2, val=1, test=7
    const result = loadCSVDataset(csv, 'officeqa', { seed: 42 })
    expect(result.train).toHaveLength(2)
    expect(result.val).toHaveLength(1)
    expect(result.test).toHaveLength(7)
  })

  it('is deterministic with same seed', () => {
    const a = loadCSVDataset(csv, 'officeqa', { seed: 42 })
    const b = loadCSVDataset(csv, 'officeqa', { seed: 42 })
    expect(a.train.map((t) => t.id)).toEqual(b.train.map((t) => t.id))
    expect(a.test.map((t) => t.id)).toEqual(b.test.map((t) => t.id))
  })

  it('produces different shuffle with different seed', () => {
    const a = loadCSVDataset(csv, 'officeqa', { seed: 42 })
    const b = loadCSVDataset(csv, 'officeqa', { seed: 99 })
    // With different seeds, order should differ (overwhelmingly likely with 10 items)
    const aIds = a.tasks.map((t) => t.id)
    const bIds = b.tasks.map((t) => t.id)
    expect(aIds).not.toEqual(bIds)
  })

  it('handles quoted CSV fields with commas', () => {
    const csvWithCommas = [
      'question,answer',
      '"What is 1,000 + 2,000?","3,000"',
      'Simple question?,Yes',
    ].join('\n')
    const result = loadCSVDataset(csvWithCommas, 'officeqa', { seed: 42 })
    const task = result.tasks.find((t) => t.question.includes('1,000'))
    expect(task).toBeDefined()
    expect(task!.groundTruth).toBe('3,000')
  })

  it('supports ground_truth column name', () => {
    const altCsv = 'question,ground_truth\nQ1?,A1\nQ2?,A2\n'
    const result = loadCSVDataset(altCsv, 'sealqa', { seed: 42 })
    expect(result.tasks).toHaveLength(2)
    expect(result.tasks[0].groundTruth).toBeTruthy()
  })

  it('throws for empty dataset', () => {
    expect(() => loadCSVDataset('question,answer\n', 'officeqa')).toThrow('fewer than 2 lines')
  })

  it('throws for missing columns', () => {
    expect(() => loadCSVDataset('foo,bar\n1,2\n', 'officeqa')).toThrow('missing required columns')
  })
})

describe('loadJSONDataset', () => {
  const jsonData = JSON.stringify(
    Array.from({ length: 20 }, (_, i) => ({
      question: `Question ${i + 1}`,
      answer: `Answer ${i + 1}`,
    }))
  )

  it('parses all items', () => {
    const result = loadJSONDataset(jsonData, 'browsecomp', { seed: 42 })
    expect(result.tasks).toHaveLength(20)
  })

  it('splits correctly', () => {
    const result = loadJSONDataset(jsonData, 'browsecomp', { seed: 42 })
    // 20 items: train=4 (18%), val=2 (12%), test=14 (70%)
    expect(result.train).toHaveLength(4)
    expect(result.val).toHaveLength(2)
    expect(result.test).toHaveLength(14)
  })

  it('assigns browsecomp benchmark', () => {
    const result = loadJSONDataset(jsonData, 'browsecomp', { seed: 42 })
    for (const t of result.tasks) expect(t.benchmark).toBe('browsecomp')
  })

  it('throws for empty array', () => {
    expect(() => loadJSONDataset('[]', 'browsecomp')).toThrow('empty')
  })
})

describe('loadDataset', () => {
  it('routes CSV for officeqa', () => {
    const csv = 'question,answer\nQ?,A\nQ2?,A2\nQ3?,A3\nQ4?,A4\nQ5?,A5\n'
    const result = loadDataset(csv, 'officeqa', { seed: 42 })
    expect(result.tasks[0].benchmark).toBe('officeqa')
  })

  it('routes JSON for browsecomp', () => {
    const json = JSON.stringify([
      { question: 'Q1', answer: 'A1' },
      { question: 'Q2', answer: 'A2' },
      { question: 'Q3', answer: 'A3' },
      { question: 'Q4', answer: 'A4' },
      { question: 'Q5', answer: 'A5' },
    ])
    const result = loadDataset(json, 'browsecomp', { seed: 42 })
    expect(result.tasks[0].benchmark).toBe('browsecomp')
  })
})
