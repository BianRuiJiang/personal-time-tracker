export const TIME_ZONE = 'Asia/Shanghai'

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const minuteFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const fullFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

export function statisticalDay(date = new Date()) {
  const calendarDate = dateFormatter.format(date)
  const hour = Number(minuteFormatter.format(date).slice(0, 2))
  if (hour < 5) return shiftDate(calendarDate, -1)
  return calendarDate
}

export function shiftDate(dateText: string, days: number) {
  const date = new Date(`${dateText}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function dayRange(dayText: string) {
  return {
    start: new Date(`${dayText}T05:00:00+08:00`),
    end: new Date(`${shiftDate(dayText, 1)}T05:00:00+08:00`),
  }
}

export function beijingDateTime(value: string | Date | null) {
  if (!value) return ''
  return fullFormatter.format(new Date(value)).replace('T', ' ')
}

export function beijingDateTimeInput(value: string | Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(value))
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`
}

export function beijingDateTimeInputToIso(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null
  const date = new Date(`${value}:00+08:00`)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function beijingMinute(value: string | Date) {
  return minuteFormatter.format(new Date(value))
}

export function durationText(start: string | Date, end: string | Date | null) {
  const ms = Math.max(0, (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime())
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':')
}

export function beijingClockLabel(value: string | Date) {
  const [hour, minute] = beijingMinute(value).split(':')
  return `${hour}时${minute}分`
}

// 时长统一为 xxhxxmin，不足 1 分钟按 1 分钟计；不足 1 小时不显示前导 0
export function durationLabel(start: string | Date, end: string | Date | null) {
  const totalMinutes = Math.max(1, Math.floor(durationSeconds(start, end) / 60))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return hours > 0 ? `${hours}h${minutes}min` : `${minutes}min`
}

export function durationSeconds(start: string | Date, end: string | Date | null) {
  return Math.max(0, Math.floor(
    ((end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime()) / 1000,
  ))
}

export interface DisplaySegment {
  record: {
    id: string
    name: string
    source: string
    started_at: string
    ended_at: string | null
  }
  segment_start: string
  segment_end: string | null
}

export function splitForStatDay<T extends { id: string; name: string; source: string; started_at: string; ended_at: string | null }>(
  records: T[],
  dayText: string,
  now = new Date(),
) {
  const { start, end } = dayRange(dayText)
  const result: DisplaySegment[] = []

  for (const record of records) {
    const rawStart = new Date(record.started_at)
    const rawEnd = record.ended_at ? new Date(record.ended_at) : now
    if (rawEnd <= start || rawStart >= end) continue

    const segmentStart = rawStart < start ? start : rawStart
    const segmentEnd = rawEnd > end ? end : rawEnd
    result.push({
      record,
      segment_start: segmentStart.toISOString(),
      segment_end: segmentEnd.toISOString(),
    })
  }

  return result.sort((left, right) => left.segment_start.localeCompare(right.segment_start))
}
