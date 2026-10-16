import { describe, expect, it } from 'vitest'
import {
  beijingDateTimeInputToIso,
  dayRange,
  durationLabel,
  durationText,
  shiftDate,
  splitForStatDay,
  statisticalDay,
} from '../src/lib/time'
import { buildJson, buildMarkdown } from '../src/lib/export'
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

  it('修改记录拒绝浏览器不会产生的非法日期', () => {
    expect(beijingDateTimeInputToIso('2026-02-31T10:00')).toBeNull()
    expect(beijingDateTimeInputToIso('2026-13-01T10:00')).toBeNull()
    expect(beijingDateTimeInputToIso('2026-10-12T10:00')).toBe('2026-10-12T02:00:00.000Z')
  })

  it('兼容部分浏览器返回的秒级 datetime-local 值', () => {
    expect(beijingDateTimeInputToIso('2026-10-12T10:00:30')).toBe('2026-10-12T02:00:30.000Z')
  })

  it('界面时长满 1 小时显示时分，不足 1 小时只显示分', () => {
    expect(durationLabel('2026-10-12T00:00:00Z', '2026-10-12T01:20:00Z')).toBe('01时20分')
    expect(durationLabel('2026-10-12T00:00:00Z', '2026-10-12T00:15:00Z')).toBe('15分')
    expect(durationLabel('2026-10-12T00:00:00Z', '2026-10-12T00:00:30Z')).toBe('01分')
  })
})

describe('原始数据导出', () => {
  it('Markdown 和 JSON 逐条导出，不合并同名活动', () => {
    const rows = [
      record({ id: 'one', started_at: '2026-10-12T00:00:00Z', ended_at: '2026-10-12T01:00:00Z' }),
      record({ id: 'two', started_at: '2026-10-12T02:00:00Z', ended_at: '2026-10-12T03:00:00Z' }),
    ]
    const markdown = buildMarkdown(rows, '2026-10-12')
    const json = buildJson(rows, '2026-10-12')
    expect(markdown).toContain('| 活动名称 | 开始时间 | 结束时间 | 耗时秒 | 记录来源 | 记录来源标签 | 记录ID |')
    expect(markdown).toContain('| 学习 | 2026-10-12 08:00:00 | 2026-10-12 09:00:00 | 3600 | manual | 手动 | one |')
    expect(markdown).toContain('- 时区：Asia/Shanghai')
    expect(json.records).toHaveLength(2)
    expect(json.timezone).toBe('Asia/Shanghai')
    expect(json.records[0].duration_seconds).toBe(3600)
  })
})
