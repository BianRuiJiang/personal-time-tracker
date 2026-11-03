import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchAllActivities,
  fetchRecordCycles,
  markCycleExported,
} from '../lib/api'
import { exportMarkdown } from '../lib/export'
import {
  beijingClockLabel,
  durationLabel,
  shiftDate,
  statisticalDay,
} from '../lib/time'
import type { Activity, RecordCycle } from '../types'

const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日']
const SOURCE_LABELS: Record<Activity['source'], string> = {
  manual: '手动',
  shortcut: '快捷',
  auto_sleep: '睡眠',
  auto_pause: '暂停',
}

function pad(value: number) {
  return String(value).padStart(2, '0')
}

function dayNumber(dayText: string) {
  return Number(dayText.slice(8, 10))
}

function cycleStartDay(cycle: RecordCycle) {
  return statisticalDay(new Date(cycle.started_at))
}

function cycleEndDay(cycle: RecordCycle) {
  if (!cycle.ended_at) return statisticalDay()
  const endedAt = new Date(cycle.ended_at)
  endedAt.setMilliseconds(endedAt.getMilliseconds() - 1)
  return statisticalDay(endedAt)
}

function cycleRangeLabel(cycle: RecordCycle) {
  const start = cycleStartDay(cycle)
  const end = cycleEndDay(cycle)
  return start === end ? start : `${start} 至 ${end}`
}

function cycleFileName(cycle: RecordCycle) {
  const start = cycleStartDay(cycle)
  const end = cycleEndDay(cycle)
  const label = start === end ? start : `${start}_to_${end}`
  return `time-records-${label}.md`
}

function monthLabel(cursor: { year: number; month: number }) {
  return `${cursor.year}年${pad(cursor.month)}月`
}

function shiftMonth(cursor: { year: number; month: number }, delta: number) {
  const next = new Date(Date.UTC(cursor.year, cursor.month - 1 + delta, 1))
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1 }
}

function calendarDays(cursor: { year: number; month: number }) {
  const firstDay = `${cursor.year}-${pad(cursor.month)}-01`
  const weekday = (new Date(`${firstDay}T00:00:00Z`).getUTCDay() + 6) % 7
  const start = shiftDate(firstDay, -weekday)
  return Array.from({ length: 42 }, (_, index) => shiftDate(start, index))
}

interface ArchiveOverlayProps {
  onClose: () => void
  onError: (message: string) => void
}

export function ArchiveOverlay({ onClose, onError }: ArchiveOverlayProps) {
  const [cycles, setCycles] = useState<RecordCycle[]>([])
  const [records, setRecords] = useState<Activity[]>([])
  const [loading, setLoading] = useState(true)
  const [exportingId, setExportingId] = useState<string | null>(null)
  const [selectedDay, setSelectedDay] = useState(statisticalDay())
  const [monthCursor, setMonthCursor] = useState(() => {
    const today = statisticalDay()
    return { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) }
  })

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [cycleRows, activityRows] = await Promise.all([
        fetchRecordCycles(),
        fetchAllActivities(),
      ])
      setCycles(cycleRows)
      setRecords(activityRows)
    } catch (error) {
      onError(error instanceof Error ? error.message : '数据库记录读取失败')
    } finally {
      setLoading(false)
    }
  }, [onError])

  useEffect(() => {
    void loadData()
  }, [loadData])

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  function goToday() {
    const today = statisticalDay()
    setSelectedDay(today)
    setMonthCursor({
      year: Number(today.slice(0, 4)),
      month: Number(today.slice(5, 7)),
    })
  }

  const sortedRecords = useMemo(
    () => [...records].sort((left, right) => left.started_at.localeCompare(right.started_at)),
    [records],
  )

  const recordsByDay = useMemo(() => {
    const grouped = new Map<string, Activity[]>()
    for (const record of sortedRecords) {
      const day = statisticalDay(new Date(record.started_at))
      const rows = grouped.get(day) ?? []
      rows.push(record)
      grouped.set(day, rows)
    }
    return grouped
  }, [sortedRecords])

  const recordsByCycle = useMemo(() => {
    const grouped = new Map<string, Activity[]>()
    const orderedCycles = [...cycles].sort((left, right) => left.started_at.localeCompare(right.started_at))

    for (const record of sortedRecords) {
      const startedAt = new Date(record.started_at)
      const owner = orderedCycles.find((cycle) => {
        const cycleStart = new Date(cycle.started_at)
        const cycleEnd = cycle.ended_at ? new Date(cycle.ended_at) : null
        return startedAt >= cycleStart && (!cycleEnd || startedAt < cycleEnd)
      })
      const key = owner?.id ?? 'unassigned'
      const rows = grouped.get(key) ?? []
      rows.push(record)
      grouped.set(key, rows)
    }
    return grouped
  }, [cycles, sortedRecords])

  const days = useMemo(() => calendarDays(monthCursor), [monthCursor])
  const today = statisticalDay()
  const selectedRecords = recordsByDay.get(selectedDay) ?? []

  const selectedGroups = useMemo(() => {
    const grouped = new Map<string, Activity[]>()
    for (const record of selectedRecords) {
      const cycle = cycles.find((item) => {
        const startedAt = new Date(record.started_at)
        const cycleStart = new Date(item.started_at)
        const cycleEnd = item.ended_at ? new Date(item.ended_at) : null
        return startedAt >= cycleStart && (!cycleEnd || startedAt < cycleEnd)
      })
      const key = cycle?.id ?? 'unassigned'
      const rows = grouped.get(key) ?? []
      rows.push(record)
      grouped.set(key, rows)
    }
    return [...grouped.entries()]
      .map(([cycleId, rows]) => ({
        cycle: cycles.find((item) => item.id === cycleId),
        records: rows,
      }))
      .sort((left, right) => {
        const leftTime = left.cycle ? new Date(left.cycle.started_at).getTime() : 0
        const rightTime = right.cycle ? new Date(right.cycle.started_at).getTime() : 0
        return leftTime - rightTime
      })
  }, [cycles, selectedRecords])

  const unexportedCount = cycles.filter((cycle) => !cycle.exported_at).length

  function cycleForDay(day: string) {
    const rows = recordsByDay.get(day)
    if (!rows?.length) return undefined
    const startedAt = new Date(rows[0].started_at)
    return cycles.find((cycle) => {
      const cycleStart = new Date(cycle.started_at)
      const cycleEnd = cycle.ended_at ? new Date(cycle.ended_at) : null
      return startedAt >= cycleStart && (!cycleEnd || startedAt < cycleEnd)
    })
  }

  function dayTone(day: string) {
    if (day > today) return 'future'
    const rows = recordsByDay.get(day)
    if (!rows?.length) return 'empty'
    return cycleForDay(day)?.exported_at ? 'exported' : 'unexported'
  }

  async function downloadCycle(cycle: RecordCycle) {
    if (exportingId) return
    const rows = recordsByCycle.get(cycle.id) ?? []
    if (rows.length === 0) return

    setExportingId(cycle.id)
    try {
      const fileName = cycleFileName(cycle)
      exportMarkdown(rows, fileName.replace(/^time-records-/, '').replace(/\.md$/, ''))
      const updated = await markCycleExported(cycle.id, fileName)
      setCycles((items) => items.map((item) => item.id === updated.id ? updated : item))
    } catch (error) {
      onError(error instanceof Error ? error.message : '导出失败，请重试')
    } finally {
      setExportingId(null)
    }
  }

  return (
    <div className="archive-overlay" role="dialog" aria-label="数据库记录" aria-modal="true">
      <section className="archive-panel">
        <header className="archive-header">
          <div>
            <p>数据库</p>
            <h2>全部记录</h2>
          </div>
          <div className="archive-summary">
            <span>{cycles.length} 个周期</span>
            <span>{records.length} 条记录</span>
            {unexportedCount > 0 && <strong>{unexportedCount} 个未导出</strong>}
          </div>
          <button type="button" className="archive-close" onClick={onClose} aria-label="关闭数据库">
            ×
          </button>
        </header>

        {loading ? (
          <p className="empty">加载中…</p>
        ) : (
          <div className="archive-layout">
            <aside className="archive-calendar">
              <div className="month-nav">
                <div className="month-arrows">
                  <button type="button" onClick={() => setMonthCursor(shiftMonth(monthCursor, -1))} aria-label="上一月">‹</button>
                  <strong>{monthLabel(monthCursor)}</strong>
                  <button type="button" onClick={() => setMonthCursor(shiftMonth(monthCursor, 1))} aria-label="下一月">›</button>
                </div>
                <button type="button" className="today-btn" onClick={goToday}>今天</button>
              </div>
              <div className="calendar-week">
                {WEEK_LABELS.map((label) => <span key={label}>{label}</span>)}
              </div>
              <div className="calendar-grid">
                {days.map((day) => {
                  const count = recordsByDay.get(day)?.length ?? 0
                  const tone = dayTone(day)
                  const cycle = cycleForDay(day)
                  return (
                    <div key={day} className="calendar-cell">
                      <button
                        type="button"
                        className={[
                          'calendar-day',
                          day.startsWith(`${monthCursor.year}-${pad(monthCursor.month)}`) ? '' : 'outside',
                          day === selectedDay ? 'selected' : '',
                          tone,
                        ].filter(Boolean).join(' ')}
                        onClick={() => setSelectedDay(day)}
                        disabled={tone === 'future'}
                        aria-label={`${day}${tone === 'future' ? '，未来日期' : ''}`}
                      >
                        <span>{dayNumber(day)}</span>
                        {count > 0 && <small>{count}</small>}
                        {tone === 'exported' && <span className="calendar-state-mark" aria-hidden="true">✓</span>}
                        {tone === 'unexported' && <span className="calendar-fog" aria-hidden="true" />}
                      </button>
                      {tone === 'unexported' && cycle && (
                        <button
                          type="button"
                          className="calendar-download"
                          disabled={exportingId !== null}
                          aria-label={`下载 ${day}`}
                          title={`下载 ${day}`}
                          onClick={() => void downloadCycle(cycle)}
                        >
                          {exportingId === cycle.id ? (
                            <span className="download-progress" aria-hidden="true" />
                          ) : (
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M12 3v12" />
                              <path d="m7 10 5 5 5-5" />
                              <path d="M5 21h14" />
                            </svg>
                          )}
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
              <div className="calendar-legend">
                <span className="legend-exported">已下载</span>
                <span className="legend-unexported">待下载</span>
                <span className="legend-future">未来</span>
              </div>
            </aside>

            <section className="archive-detail">
              <header className="archive-detail-head">
                <h3>{selectedDay}</h3>
                <span>{selectedRecords.length} 条记录</span>
              </header>

              {selectedGroups.length === 0 ? (
                <p className="empty">这一天没有记录。</p>
              ) : (
                selectedGroups.map(({ cycle, records: rows }) => (
                  <article
                    key={cycle?.id ?? 'unassigned'}
                    className={cycle?.exported_at ? 'archive-cycle exported' : 'archive-cycle unexported'}
                  >
                    <div className="archive-cycle-head">
                      <div>
                        <strong>{cycle ? cycleRangeLabel(cycle) : '未归入周期'}</strong>
                        <span className={cycle?.exported_at ? 'cycle-badge exported' : 'cycle-badge unexported'}>
                          {cycle?.exported_at ? '已导出' : '未导出'}
                        </span>
                      </div>
                    </div>
                    <div className="archive-cycle-records">
                      <ol>
                        {rows.map((record) => (
                          <li key={record.id}>
                            <div className="archive-record-top">
                              <strong>{record.name}</strong>
                              <span>{SOURCE_LABELS[record.source]}</span>
                            </div>
                            <div className="archive-record-meta">
                              <span>
                                {beijingClockLabel(record.started_at)}
                                {record.ended_at ? `-${beijingClockLabel(record.ended_at)}` : '-进行中'}
                              </span>
                              <span>{durationLabel(record.started_at, record.ended_at)}</span>
                            </div>
                          </li>
                        ))}
                      </ol>
                    </div>
                  </article>
                ))
              )}
            </section>
          </div>
        )}
      </section>
    </div>
  )
}
