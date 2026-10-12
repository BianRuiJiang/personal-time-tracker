import { beijingDateTime, durationSeconds } from './time'
import type { Activity } from '../types'

const sourceLabels: Record<Activity['source'], string> = {
  manual: '手动',
  shortcut: '快捷按钮',
  auto_sleep: '自动睡眠',
  auto_pause: '自动暂停',
}

function csvValue(value: string | number) {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function download(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = filename
  link.click()
  URL.revokeObjectURL(link.href)
}

export function exportJson(records: Activity[], dayLabel: string) {
  const payload = buildJson(records, dayLabel)
  download(JSON.stringify(payload, null, 2), `time-records-${dayLabel}.json`, 'application/json')
}

export function buildJson(records: Activity[], dayLabel: string) {
  return {
    exported_at_beijing: beijingDateTime(new Date()),
    timezone: 'Asia/Shanghai',
    range_label: dayLabel,
    records: records.map((record) => ({
      id: record.id,
      activity_name: record.name,
      started_at_beijing: beijingDateTime(record.started_at),
      ended_at_beijing: record.ended_at ? beijingDateTime(record.ended_at) : null,
      duration_seconds: record.ended_at ? durationSeconds(record.started_at, record.ended_at) : null,
      source: record.source,
      source_label: sourceLabels[record.source],
      metadata: record.metadata,
    })),
  }
}

export function exportCsv(records: Activity[], dayLabel: string) {
  const csv = buildCsv(records)
  download(`\uFEFF${csv}`, `time-records-${dayLabel}.csv`, 'text/csv;charset=utf-8')
}

export function buildCsv(records: Activity[]) {
  const headers = ['活动名称', '开始时间', '结束时间', '耗时秒', '记录来源', '记录来源标签', '记录ID']
  const lines = [headers.join(',')]
  for (const record of records) {
    lines.push([
      csvValue(record.name),
      beijingDateTime(record.started_at),
      record.ended_at ? beijingDateTime(record.ended_at) : '',
      record.ended_at ? durationSeconds(record.started_at, record.ended_at) : '',
      record.source,
      sourceLabels[record.source],
      record.id,
    ].join(','))
  }
  return lines.join('\n')
}
