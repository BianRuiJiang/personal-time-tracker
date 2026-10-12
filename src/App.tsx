import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { AuthForm } from './components/AuthForm'
import { supabase } from './lib/supabase'
import {
  addShortcut,
  deleteActivity,
  deleteShortcut,
  fetchActivitiesByOverlap,
  fetchAllActivities,
  fetchShortcuts,
  renameShortcut,
  reorderShortcuts,
  switchActivity,
  touchInteraction,
} from './lib/api'
import {
  beijingMinute,
  durationText,
  dayRange,
  shiftDate,
  splitForStatDay,
  statisticalDay,
} from './lib/time'
import { exportCsv, exportJson } from './lib/export'
import type { Activity, Shortcut } from './types'

const sourceLabels: Record<Activity['source'], string> = {
  manual: '手动',
  shortcut: '快捷',
  auto_sleep: '自动睡眠',
  auto_pause: '自动暂停',
}

function sourceLabel(source: string) {
  return sourceLabels[source as Activity['source']] ?? source
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [shortcuts, setShortcuts] = useState<Shortcut[]>([])
  const [records, setRecords] = useState<Activity[]>([])
  const [selectedDay, setSelectedDay] = useState(() => statisticalDay())
  const [activityName, setActivityName] = useState('')
  const [actionError, setActionError] = useState('')
  const [interactionError, setInteractionError] = useState('')
  const [busy, setBusy] = useState(false)
  const [managing, setManaging] = useState(false)
  const [newShortcut, setNewShortcut] = useState('')
  const [now, setNow] = useState(() => new Date())
  const lastTouchRef = useRef(0)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setAuthReady(true)
    })

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setAuthReady(true)
    })

    return () => authListener?.subscription.unsubscribe()
  }, [])

  const loadRecords = useCallback(async (day: string) => {
    if (!session) return
    const { start, end } = dayRange(day)
    const rows = await fetchActivitiesByOverlap(start.toISOString(), end.toISOString())
    setRecords(rows)
  }, [session])

  const loadShortcuts = useCallback(async () => {
    if (!session) return
    setShortcuts(await fetchShortcuts())
  }, [session])

  useEffect(() => {
    if (!session) {
      setShortcuts([])
      setRecords([])
      return
    }
    loadShortcuts().catch((error) => setActionError(error.message))
    loadRecords(selectedDay).catch((error) => setActionError(error.message))
  }, [session, selectedDay, loadShortcuts, loadRecords])

  useEffect(() => {
    if (!session) return
    const userId = session.user.id
    const channel = supabase.channel(`time-tracker-${userId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'activities',
        filter: `user_id=eq.${userId}`,
      }, () => {
        loadRecords(selectedDay).catch(() => undefined)
      })
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'shortcuts',
        filter: `user_id=eq.${userId}`,
      }, () => {
        loadShortcuts().catch(() => undefined)
      })
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [session, selectedDay, loadRecords, loadShortcuts])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!session) return
    let touching = false

    async function recordTouch() {
      const currentTime = Date.now()
      const current = records.find((record) => record.ended_at === null)
      if (!current || current.source === 'auto_sleep' || touching) return
      if (currentTime - lastTouchRef.current < 60_000) return
      lastTouchRef.current = currentTime
      touching = true
      try {
        await touchInteraction()
        setInteractionError('')
      } catch (error) {
        setInteractionError('交互时间同步失败，网络恢复后请再操作页面。')
        console.error(error)
      } finally {
        touching = false
      }
    }

    const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'focus']
    events.forEach((eventName) => window.addEventListener(eventName, recordTouch))
    return () => events.forEach((eventName) => window.removeEventListener(eventName, recordTouch))
  }, [session, records])

  const current = useMemo(
    () => records.find((record) => record.ended_at === null) ?? null,
    [records],
  )
  const todaySegments = useMemo(
    () => splitForStatDay(records, selectedDay, now),
    [records, selectedDay, now],
  )

  function runAction(action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setActionError('')
    action().catch((error) => setActionError(error.message)).finally(() => setBusy(false))
  }

  async function startRecord(source: 'manual' | 'shortcut') {
    const name = activityName.trim()
    if (!name) {
      setActionError('请先输入活动名称')
      return
    }
    await switchActivity(name, source)
    await loadRecords(selectedDay)
    setActivityName('')
  }

  async function startShortcut(shortcut: Shortcut) {
    if (shortcut.is_default) {
      setActivityName(shortcut.name)
      return
    }
    await switchActivity(shortcut.name, 'shortcut')
    await loadRecords(selectedDay)
  }

  if (!authReady) {
    return <main className="shell"><p>加载中...</p></main>
  }
  if (!session) return <AuthForm />

  return (
    <main className="shell">
      <header className="app-header">
        <h1>个人时间记录</h1>
        <div className="account">
          <span>{session.user.email}</span>
          <button className="ghost" onClick={() => runAction(async () => {
            const { error } = await supabase.auth.signOut()
            if (error) throw error
          })}>退出</button>
        </div>
      </header>

      <section className="current-panel" aria-labelledby="current-title">
        <h2 id="current-title">当前活动</h2>
        {current ? (
          <>
            <p className="current-name">{current.name}</p>
            <p className="current-meta">
              {beijingMinute(current.started_at)} 开始 · 已持续 {durationText(current.started_at, null)}
            </p>
            {current.source === 'auto_sleep' && <p className="muted">系统睡眠中，07:00 自动结束</p>}
          </>
        ) : <p className="muted">无进行中活动</p>}

        <form className="start-form" onSubmit={(event) => {
          event.preventDefault()
          runAction(() => startRecord('manual'))
        }}>
          <input
            aria-label="活动名称"
            placeholder="正在做什么？"
            value={activityName}
            onChange={(event) => setActivityName(event.target.value)}
            maxLength={80}
          />
          <button className="primary" type="submit" disabled={busy}>开始记录</button>
        </form>

        <div className="shortcut-block">
          <div className="section-title">
            <h3>常用按钮</h3>
            <button className="link" onClick={() => setManaging(!managing)}>
              {managing ? '完成' : '管理'}
            </button>
          </div>
          <div className="shortcut-grid">
            {shortcuts.map((shortcut) => (
              <div key={shortcut.id} className="shortcut-item">
                {managing ? (
                  <>
                    <input
                      aria-label="快捷按钮名称"
                      defaultValue={shortcut.name}
                      onBlur={(event) => {
                        const name = event.target.value.trim()
                        if (name && name !== shortcut.name) {
                          runAction(async () => {
                            await renameShortcut(shortcut.id, name)
                            await loadShortcuts()
                          })
                        }
                      }}
                    />
                    <button className="icon" aria-label="上移" onClick={() => {
                      const index = shortcuts.findIndex((item) => item.id === shortcut.id)
                      if (index <= 0) return
                      const next = [...shortcuts]
                      ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
                      runAction(async () => {
                        await reorderShortcuts(next)
                        await loadShortcuts()
                      })
                    }}>↑</button>
                    <button className="icon" aria-label="下移" onClick={() => {
                      const index = shortcuts.findIndex((item) => item.id === shortcut.id)
                      if (index < 0 || index === shortcuts.length - 1) return
                      const next = [...shortcuts]
                      ;[next[index + 1], next[index]] = [next[index], next[index + 1]]
                      runAction(async () => {
                        await reorderShortcuts(next)
                        await loadShortcuts()
                      })
                    }}>↓</button>
                    <button className="danger icon" aria-label={`删除 ${shortcut.name}`} onClick={() => {
                      if (!window.confirm(`确认删除「${shortcut.name}」按钮？`)) return
                      runAction(async () => {
                        await deleteShortcut(shortcut.id)
                        await loadShortcuts()
                      })
                    }}>×</button>
                  </>
                ) : (
                  <button
                    className={shortcut.is_default ? 'shortcut' : 'shortcut custom'}
                    disabled={busy || current?.source === 'auto_sleep'}
                    onClick={() => runAction(() => startShortcut(shortcut))}
                  >
                    {shortcut.name}
                  </button>
                )}
              </div>
            ))}
          </div>

          {managing && (
            <form className="shortcut-add" onSubmit={(event) => {
              event.preventDefault()
              const name = newShortcut.trim()
              if (!name) return
              runAction(async () => {
                await addShortcut(name)
                setNewShortcut('')
                await loadShortcuts()
              })
            }}>
              <input
                aria-label="新增快捷按钮"
                placeholder="新增自定义按钮"
                value={newShortcut}
                onChange={(event) => setNewShortcut(event.target.value)}
                maxLength={80}
              />
              <button type="submit" disabled={busy}>新增</button>
            </form>
          )}
        </div>
      </section>

      <section aria-labelledby="today-title">
        <div className="section-title">
          <h2 id="today-title">{selectedDay} 明细</h2>
          <label className="date-label">
            日期
            <input
              type="date"
              value={selectedDay}
              onChange={(event) => event.target.value && setSelectedDay(event.target.value)}
            />
          </label>
          <button className="ghost" onClick={() => setSelectedDay(shiftDate(selectedDay, -1))}>前一天</button>
          <button className="ghost" onClick={() => setSelectedDay(statisticalDay())}>今天</button>
        </div>

        {actionError && <p className="error" role="alert">{actionError}</p>}
        {interactionError && <p className="notice" role="status">{interactionError}</p>}

        <ol className="record-list">
          {todaySegments.map((segment) => (
              <li key={`${segment.record.id}-${segment.segment_start}`}>
                <div>
                  <strong>{segment.record.name}</strong>
                  <span>{sourceLabel(segment.record.source)}</span>
                </div>
                <div className="record-meta">
                  {beijingMinute(segment.segment_start)} – {segment.segment_end ? beijingMinute(segment.segment_end) : '进行中'}
                  <span>{durationText(segment.segment_start, segment.segment_end)}</span>
                </div>
                <button
                  className="danger link"
                  onClick={() => {
                    if (!window.confirm('确认删除这条记录？删除后不可恢复。')) return
                    runAction(async () => {
                      await deleteActivity(segment.record.id)
                      await loadRecords(selectedDay)
                    })
                  }}
                >
                  删除
                </button>
              </li>
          ))}
        </ol>
        {todaySegments.length === 0 && <p className="muted">这一天暂无记录</p>}
      </section>

      <section aria-labelledby="export-title">
        <h2 id="export-title">导出</h2>
        <div className="export-actions">
          <button disabled={busy} onClick={() => exportCsv(records, selectedDay)}>导出当日 CSV</button>
          <button disabled={busy} onClick={() => exportJson(records, selectedDay)}>导出当日 JSON</button>
          <button disabled={busy} onClick={() => {
            if (!window.confirm('确认导出全部历史记录？')) return
            runAction(async () => exportCsv(await fetchAllActivities(), 'all'))
          }}>导出全部 CSV</button>
          <button disabled={busy} onClick={() => {
            if (!window.confirm('确认导出全部历史记录？')) return
            runAction(async () => exportJson(await fetchAllActivities(), 'all'))
          }}>导出全部 JSON</button>
        </div>
      </section>
    </main>
  )
}
