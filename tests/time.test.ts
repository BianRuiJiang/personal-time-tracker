import { describe, expect, it } from 'vitest'
import { dayRange, durationLabel, durationText, shiftDate, splitForStatDay, statisticalDay } from '../src/lib/time'
import { buildCsv, buildJson } from '../src/lib/export'
import type { Activity } from '../src/types'

function record(partial: Partial<Activity>): Activity {
  return {
    id: 'record-id',
    user_id: 'user-id',
    name: '学习',
    started_at: '2026-10-12T00:00:00Z',
    ended_at: null,
    source: 'manual',
    metadata: {},
    created_at: '2026-10-12T00:00:00Z',
    ...partial,
  }
}

describe('北京时间统计日', () => {
  it('04:59 属于前一天，05:00 开始新统计日', () => {
    expect(statisticalDay(new Date('2026-10-12T20:59:59Z'))).toBe('2026-10-12')
    expect(statisticalDay(new Date('2026-10-12T21:00:00Z'))).toBe('2026-10-13')
  })

  it('统计日范围是当天 05:00 到次日 05:00', () => {
    const range = dayRange('2026-10-12')
    expect(range.start.toISOString()).toBe('2026-10-11T21:00:00.000Z')
    expect(range.end.toISOString()).toBe('2026-10-12T21:00:00.000Z')
    expect(shiftDate('2026-10-12', 1)).toBe('2026-10-13')
  })

  it('跨 05:00 的睡眠被拆成两段，原始记录仍保留', () => {
    const sleep = record({
      id: 'sleep',
      name: '睡觉',
      source: 'auto_sleep',
      started_at: '2026-10-11T17:00:00Z',
      ended_at: '2026-10-12T01:00:00Z',
    })
    const segments = splitForStatDay([sleep], '2026-10-12', new Date('2026-10-12T02:00:00Z'))
    expect(segments).toHaveLength(1)
    expect(segments[0].segment_start).toBe('2026-10-11T21:00:00.000Z')
    expect(segments[0].segment_end).toBe('2026-10-12T01:00:00.000Z')
  })

  it('耗时输出为时分秒', () => {
    expect(durationText('2026-10-12T00:00:00Z', '2026-10-12T01:02:03Z')).toBe('01:02:03')
  })

  it('界面时长统一为 xxhxxmin，不足 1 分钟按 1 分钟，不足 1 小时无前导 0', () => {
    expect(durationLabel('2026-10-12T00:00:00Z', '2026-10-12T01:20:00Z')).toBe('1h20min')
    expect(durationLabel('2026-10-12T00:00:00Z', '2026-10-12T00:15:00Z')).toBe('15min')
    expect(durationLabel('2026-10-12T00:00:00Z', '2026-10-12T00:00:30Z')).toBe('1min')
  })
})

describe('原始数据导出', () => {
  it('CSV 和 JSON 逐条导出，不合并同名活动', () => {
    const rows = [
      record({ id: 'one', started_at: '2026-10-12T00:00:00Z', ended_at: '2026-10-12T01:00:00Z' }),
      record({ id: 'two', started_at: '2026-10-12T02:00:00Z', ended_at: '2026-10-12T03:00:00Z' }),
    ]
    const csv = buildCsv(rows)
    const json = buildJson(rows, '2026-10-12')
    expect(csv.split('\n')).toHaveLength(3)
    expect(csv).toContain('学习')
    expect(csv).toContain('2026-10-12 08:00:00')
    expect(json.records).toHaveLength(2)
    expect(json.timezone).toBe('Asia/Shanghai')
    expect(json.records[0].duration_seconds).toBe(3600)
  })
})
