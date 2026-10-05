import { describe, expect, test } from 'claude-code/testing'

import { barCells, markerIndex, renderBar } from './bar'
import type { Segment } from './bar'

const joined = (segments: Segment[]): string => segments.map(segment => segment.text).join('')

describe('barCells', () => {
  test('0% is all empty and 100% is all full', () => {
    expect(barCells(10, 0).join('')).toBe('░░░░░░░░░░')
    expect(barCells(10, 100).join('')).toBe('██████████')
  })

  test('fills to the eighth of a cell', () => {
    expect(barCells(10, 45).join('')).toBe('████▌░░░░░')
    expect(barCells(10, 12.5).join('')).toBe('█▎░░░░░░░░')
  })

  test('clamps out-of-range usage', () => {
    expect(barCells(10, 130).join('')).toBe('██████████')
    expect(barCells(10, -5).join('')).toBe('░░░░░░░░░░')
  })
})

describe('markerIndex', () => {
  test('stays inside the bar', () => {
    expect(markerIndex(10, 0)).toBe(0)
    expect(markerIndex(10, 50)).toBe(5)
    expect(markerIndex(10, 100)).toBe(9)
  })
})

describe('renderBar', () => {
  test('draws the marker in the empty part', () => {
    expect(renderBar(10, 20, 60, 'under')).toEqual([
      { text: '██', color: 'green' },
      { text: '░░░░', dimColor: true },
      { text: '│', color: 'cyan' },
      { text: '░░░', dimColor: true },
    ])
  })

  test('draws the marker inside the fill', () => {
    expect(renderBar(10, 80, 30, 'over')).toEqual([
      { text: '███', color: 'red' },
      { text: '│', color: 'cyan' },
      { text: '████', color: 'red' },
      { text: '░░', dimColor: true },
    ])
  })

  test('draws no marker without an ideal', () => {
    expect(renderBar(10, 50, undefined, 'near')).toEqual([
      { text: '█████', color: 'yellow' },
      { text: '░░░░░', dimColor: true },
    ])
  })

  test('always spans exactly the width', () => {
    for (const width of [10, 23, 40]) {
      for (const real of [0, 33.3, 99.9, 100]) {
        expect(joined(renderBar(width, real, 50, 'under'))).toHaveLength(width)
      }
    }
  })
})
