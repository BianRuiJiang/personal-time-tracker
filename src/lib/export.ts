import { beijingDateTime, durationSeconds } from './time'
import type { Activity } from '../types'

const sourceLabels: Record<Activity['source'], string> = {
  manual: '手动',
  shortcut: '快捷按钮',
  auto_sleep: '自动睡眠',
  auto_pause: '自动暂停',
}

function markdownCell(value: string | number) {
  return String(value)
    .replace(/\r\n|\r|\n/g, '<br>')
    .replace(/\|/g, '\\|')
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

export function exportMarkdown(records: Activity[], dayLabel: string) {
  const markdown = buildMarkdown(records, dayLabel)
  download(markdown, `time-records-${dayLabel}.md`, 'text/markdown;charset=utf-8')
}

export function buildMarkdown(records: Activity[], dayLabel: string) {
  const headers = ['活动名称', '开始时间', '结束时间', '耗时秒', '记录来源', '记录来源标签', '记录ID']
  const lines = [
    '# 时间记录导出',
    '',
    `- 导出时间：${beijingDateTime(new Date())}`,
    '- 时区：Asia/Shanghai',
    `- 范围：${dayLabel}`,
    `- 记录数：${records.length}`,
    '',
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ]
  for (const record of records) {
    const cells = [
      markdownCell(record.name),
      beijingDateTime(record.started_at),
      record.ended_at ? beijingDateTime(record.ended_at) : '',
      record.ended_at ? durationSeconds(record.started_at, record.ended_at) : '',
      record.source,
      sourceLabels[record.source],
      markdownCell(record.id),
    ]
    lines.push(`| ${cells.join(' | ')} |`)
  }
  return lines.join('\n')
}
