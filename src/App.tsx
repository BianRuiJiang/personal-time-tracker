import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { AuthForm } from './components/AuthForm'
import { configError, supabase } from './lib/supabase'
import {
  addShortcut,
  deleteActivity,
  deleteAllActivities,
  deleteShortcut,
  fetchAllActivities,
  fetchActivitiesByOverlap,
  fetchShortcuts,
  renameShortcut,
  reorderShortcuts,
  switchActivity,
  touchInteraction,
} from './lib/api'
import {
  beijingClockLabel,
  dayRange,
  durationLabel,
  splitForStatDay,
  statisticalDay,
  shiftDate,
} from './lib/time'
import { exportCsv } from './lib/export'
import type { Activity, Shortcut } from './types'

const REVEAL = 84

// crypto.randomUUID 在旧浏览器或非安全上下文下可能不存在，做一层兜底
function newId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

interface RowProps {
  name: string
  timeText: string
  durationText: string
  ongoing: boolean
  open: boolean
  onOpen: () => void
  onClose: () => void
  onDelete: () => void
}

// 左滑露出删除。
// 拖动过程直接改 DOM 的 transform，不触发 React 渲染 —— 这是之前卡顿的根因。
function SwipeRow({
  name, timeText, durationText, ongoing, open, onOpen, onClose, onDelete,
}: RowProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const offset = useRef(0)
  const startX = useRef(0)
  const startY = useRef(0)
  const base = useRef(0)
  const axis = useRef<'none' | 'x' | 'y'>('none')
  const active = useRef(false)
  const lastX = useRef(0)
  const lastT = useRef(0)
  const speed = useRef(0)

  function paint(value: number, animate: boolean) {
    const element = surfaceRef.current
    if (!element) return
    offset.current = value
    element.style.transition = animate ? '' : 'none'
    element.style.transform = `translateX(${value}px)`
  }

  // 由父级统一控制“同时只开一条”，其它行收到 open=false 时自动归位
  useEffect(() => {
    const target = open ? -REVEAL : 0
    if (offset.current === target) return
    paint(target, true)
  }, [open])

  function handleDown(event: ReactPointerEvent<HTMLDivElement>) {
    active.current = true
    axis.current = 'none'
    startX.current = event.clientX
    startY.current = event.clientY
    lastX.current = event.clientX
    lastT.current = event.timeStamp
    speed.current = 0
    base.current = offset.current
  }

  function handleMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!active.current) return
    const dx = event.clientX - startX.current
    const dy = event.clientY - startY.current

    if (axis.current === 'none') {
      // 横向位移要够大、且明显压过纵向，才认定是左滑；
      // 否则快速纵向滚动会被误判成左滑，闪出红色删除层
      const absX = Math.abs(dx)
      const absY = Math.abs(dy)
      if (absX > 10 && absX > absY * 1.2) {
        axis.current = 'x'
        event.currentTarget.setPointerCapture?.(event.pointerId)
        surfaceRef.current?.classList.add('dragging')
      } else if (absY > 8) {
        axis.current = 'y'
      }
    }
    if (axis.current !== 'x') return

    const elapsed = Math.max(1, event.timeStamp - lastT.current)
    speed.current = (event.clientX - lastX.current) / elapsed
    lastX.current = event.clientX
    lastT.current = event.timeStamp

    paint(Math.min(0, Math.max(-REVEAL, base.current + dx)), false)
  }

  // 手势被浏览器接管（通常是转为纵向滚动）时，只回弹，不展开
  function cancel() {
    if (!active.current) return
    active.current = false
    surfaceRef.current?.classList.remove('dragging')
    if (axis.current === 'x') {
      paint(0, true)
      onClose()
    }
    axis.current = 'none'
  }

  function finish() {
    if (!active.current) return
    active.current = false
    surfaceRef.current?.classList.remove('dragging')

    if (axis.current !== 'x') {
      // 单击：收起已展开的行
      onClose()
      return
    }

    // 滑过一半或快速轻扫都算展开
    const shouldOpen = offset.current <= -REVEAL / 2 || speed.current < -0.5
    if (shouldOpen) {
      paint(-REVEAL, true)
      onOpen()
    } else {
      paint(0, true)
      onClose()
    }
  }

  return (
    <li className={ongoing ? 'record-row ongoing' : 'record-row'}>
      <button type="button" className="row-delete" aria-label="删除" onClick={onDelete}>
        删除
      </button>
      <div
        ref={surfaceRef}
        className="row-surface"
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={finish}
        onPointerCancel={cancel}
        onClick={() => {
          if (offset.current !== 0) onClose()
        }}
      >
        <span className="row-name">{name}</span>
        <span className="row-meta">
          <span className="row-time">{timeText}</span>
          <span className="row-duration">{durationText}</span>
        </span>
      </div>
    </li>
  )
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [shortcuts, setShortcuts] = useState<Shortcut[]>([])
  const [records, setRecords] = useState<Activity[]>([])
  const [historyRecords, setHistoryRecords] = useState<Activity[]>([])
  const [statDay, setStatDay] = useState(() => statisticalDay())
  const [activityName, setActivityName] = useState('')
  const [actionError, setActionError] = useState('')
  const [interactionError, setInteractionError] = useState('')
  const [managing, setManaging] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [newShortcut, setNewShortcut] = useState('')
  const [now, setNow] = useState(() => new Date())
  const [exportedDay, setExportedDay] = useState<string | null>(null)
  const lastTouchRef = useRef(0)
  const displayRef = useRef<HTMLElement | null>(null)
  const declinedExportDay = useRef<string | null>(null)
  // 新增记录后需要把列表滚到底，让刚记的那条可见
  const scrollPending = useRef(false)
  // 写操作串行排队：快速连点不会丢操作，也不会和刷新互相覆盖。
  // pending > 0 期间不应用服务器快照，避免冲掉仍在排队的乐观记录。
  const writeQueue = useRef<Promise<unknown>>(Promise.resolve())
  const writePending = useRef(0)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [draftOrder, setDraftOrder] = useState<Shortcut[] | null>(null)
  const [dragDelta, setDragDelta] = useState({ x: 0, y: 0 })
  const chipRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const pressTimer = useRef<number | null>(null)
  const pressStart = useRef<{ x: number; y: number; id: string } | null>(null)
  const dragState = useRef<{ id: string; order: Shortcut[] } | null>(null)
  const suppressTap = useRef(false)

  useEffect(() => {
    if (configError) return

    supabase.auth.getSession()
      .then(({ data }) => {
        setSession(data.session)
        setAuthReady(true)
      })
      .catch((error) => {
        setActionError(error instanceof Error ? error.message : '登录状态读取失败')
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
    // 多查一个统计日：跨过 05:00 后进行中的记录仍能正常展示。
    const { start } = dayRange(shiftDate(day, -1))
    const { end } = dayRange(day)
    const rows = await fetchActivitiesByOverlap(start.toISOString(), end.toISOString())
    setRecords(rows)
  }, [session])

  const loadShortcuts = useCallback(async () => {
    if (!session) return
    setShortcuts(await fetchShortcuts())
  }, [session])

  const loadHistoryRecords = useCallback(async () => {
    if (!session) return
    setHistoryRecords(await fetchAllActivities())
  }, [session])

  // 统一的刷新入口：永远不产生未捕获的 Promise 拒绝
  const reloadRecords = useCallback((day: string) => {
    loadRecords(day).catch((error) => {
      setActionError(error instanceof Error ? error.message : '刷新记录失败，请稍后重试')
    })
  }, [loadRecords])

  const reloadShortcuts = useCallback(() => {
    loadShortcuts().catch((error) => {
      setActionError(error instanceof Error ? error.message : '刷新快捷按钮失败，请稍后重试')
    })
  }, [loadShortcuts])

  const reloadHistoryRecords = useCallback(() => {
    loadHistoryRecords().catch((error) => {
      setActionError(error instanceof Error ? error.message : '刷新导出数据失败，请稍后重试')
    })
  }, [loadHistoryRecords])

  const exportStorageKey = useCallback((userId: string) => `time-tracker-exported-day-${userId}`, [])

  useEffect(() => {
    if (!session) {
      setExportedDay(null)
      return
    }
    setExportedDay(window.localStorage.getItem(exportStorageKey(session.user.id)))
  }, [session, exportStorageKey])

  useEffect(() => {
    if (!session) {
      setShortcuts([])
      setRecords([])
      return
    }
    reloadShortcuts()
    reloadRecords(statDay)
    reloadHistoryRecords()
  }, [session, statDay, reloadShortcuts, reloadRecords, reloadHistoryRecords])

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
        // 本地写入排队中时跳过，避免实时事件把乐观记录冲掉
        if (writePending.current > 0) return
        reloadRecords(statDay)
        reloadHistoryRecords()
      })
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'shortcuts',
        filter: `user_id=eq.${userId}`,
      }, () => {
        if (writePending.current > 0) return
        reloadShortcuts()
      })
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [session, statDay, reloadRecords, reloadHistoryRecords, reloadShortcuts])

  // 30 秒刷新一次即可，界面只展示到分钟，不出现秒数跳动。
  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = new Date()
      setNow(next)
      setStatDay(statisticalDay(next))
    }, 30_000)
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
    () => splitForStatDay(records, statDay, now),
    [records, statDay, now],
  )
  const pendingExportCount = useMemo(() => {
    const cutoff = exportedDay ? dayRange(exportedDay).end.getTime() : 0
    return historyRecords.filter((record) => {
      const end = record.ended_at ? new Date(record.ended_at).getTime() : now.getTime()
      return new Date(record.started_at).getTime() < now.getTime() && end > cutoff
    }).length
  }, [exportedDay, historyRecords, now])
  const pendingExportVisible = pendingExportCount > 0 && exportedDay !== statDay

  // 记录成功后把列表滚到底部，保证刚新增的那条在可视范围内
  useEffect(() => {
    if (!scrollPending.current) return
    scrollPending.current = false
    const element = displayRef.current
    if (!element) return
    const smooth = !(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
    if (smooth && typeof element.scrollTo === 'function') {
      element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
    } else {
      element.scrollTop = element.scrollHeight
    }
  }, [todaySegments])

  // 写入策略：先在本地渲染，再同步云端。成功后用服务器数据替换本地临时数据；
  // 失败则回滚到服务器状态并提示，不做离线队列。
  function runWrite<T>(
    applyLocal: () => void,
    action: () => Promise<T>,
    refresh: () => void,
    onFail?: () => void,
    onResult?: (result: T) => void,
  ) {
    setActionError('')
    // 先同步反映到界面，用户点了就立刻能看到
    applyLocal()
    writePending.current += 1
    let failed = false
    let result: T | undefined

    // 排队执行：所有请求按点击顺序串行落到服务器，不会互相插队
    const task = () => Promise.resolve()
      .then(action)
      .then((value) => {
        result = value
      })
      .catch((error) => {
        failed = true
        setActionError(error instanceof Error ? error.message : '同步失败，请重试')
      })
      .finally(() => {
        writePending.current -= 1
        if (failed) onFail?.()
        if (!failed) onResult?.(result as T)
        // 队列排空后才以服务器状态为准
        if (writePending.current === 0) refresh()
      })

    writeQueue.current = writeQueue.current.then(task, task)
  }

  function syncRecords<T>(
    applyLocal: () => void,
    action: () => Promise<T>,
    onFail?: () => void,
    onResult?: (result: T) => void,
  ) {
    runWrite(applyLocal, action, () => {
      reloadRecords(statDay)
      reloadHistoryRecords()
    }, onFail, onResult)
  }

  function syncShortcuts(applyLocal: () => void, action: () => Promise<unknown>, onFail?: () => void) {
    runWrite(applyLocal, action, reloadShortcuts, onFail)
  }

  // 本地临时记录：id 带 local- 前缀，云端返回后会被真实记录替换
  function optimisticRecord(name: string, source: 'manual' | 'shortcut'): Activity {
    const nowIso = new Date().toISOString()
    return {
      id: `local-${newId()}`,
      user_id: session?.user.id ?? '',
      name,
      started_at: nowIso,
      ended_at: null,
      source,
      metadata: {},
      created_at: nowIso,
    }
  }

  function localSwitch(name: string, source: 'manual' | 'shortcut') {
    const optimistic = optimisticRecord(name, source)
    scrollPending.current = true
    const closeOpenAndAppend = (rows: Activity[]) => [
      ...rows.map((row) => (row.ended_at === null ? { ...row, ended_at: optimistic.started_at } : row)),
      optimistic,
    ]
    setRecords(closeOpenAndAppend)
    setHistoryRecords(closeOpenAndAppend)
  }

  // 与服务器一致：同名活动已经在进行中时，重复提交直接忽略，不生成新记录
  function isAlreadyRunning(name: string) {
    const open = records.find((row) => row.ended_at === null)
    return open?.name === name
  }

  function pendingExportRows(endOverride?: string) {
    const cutoff = exportedDay ? dayRange(exportedDay).end.getTime() : 0
    const boundary = endOverride ?? now.toISOString()
    return historyRecords.filter((record) => {
      const rawEnd = record.ended_at ?? boundary
      return new Date(record.started_at) < new Date(boundary) &&
        new Date(rawEnd).getTime() > cutoff
    })
  }

  function markExported(day: string) {
    if (!session) return
    window.localStorage.setItem(exportStorageKey(session.user.id), day)
    setExportedDay(day)
    declinedExportDay.current = null
  }

  function exportPendingRecords(endOverride?: string) {
    const rows = pendingExportRows(endOverride)
    if (rows.length === 0) return
    const days = rows.map((record) => statisticalDay(new Date(record.started_at))).sort()
    const firstDay = days[0]
    const lastDay = days[days.length - 1]
    const label = firstDay === lastDay ? firstDay : `${firstDay}_to_${lastDay}`
    exportCsv(rows, label)
    markExported(statDay)
  }

  // 跨统计日后第一次记录才弹窗；取消后靠顶部提醒兜底，避免每记一条都打断。
  function confirmPendingExport() {
    if (exportedDay === statDay || declinedExportDay.current === statDay) return false
    if (writePending.current > 0 || pendingExportRows().length === 0) return false
    const confirmed = window.confirm(`距上次导出已有 ${pendingExportRows().length} 条记录。是否先导出？`)
    if (!confirmed) declinedExportDay.current = statDay
    return confirmed
  }

  function startRecord() {
    const name = activityName.trim()
    if (!name) {
      setActionError('请先输入活动名称')
      return
    }
    if (isAlreadyRunning(name)) {
      setActivityName('')
      setActionError('')
      return
    }
    const shouldExportPending = confirmPendingExport()
    const previous = records
    setActivityName('')
    syncRecords(
      () => localSwitch(name, 'manual'),
      () => switchActivity(name, 'manual'),
      () => {
        setActivityName(name)
        // 只有没有其它排队写入时才整体回滚，避免覆盖别人的乐观记录
        if (writePending.current === 0) setRecords(previous)
      },
      shouldExportPending
        ? (result) => exportPendingRecords(result.started_at)
        : undefined,
    )
  }

  function startShortcut(shortcut: Shortcut) {
    if (shortcut.is_default) {
      setActivityName(shortcut.name)
      return
    }
    if (isAlreadyRunning(shortcut.name)) return
    const shouldExportPending = confirmPendingExport()
    const previous = records
    syncRecords(
      () => localSwitch(shortcut.name, 'shortcut'),
      () => switchActivity(shortcut.name, 'shortcut'),
      () => {
        if (writePending.current === 0) setRecords(previous)
      },
      shouldExportPending
        ? (result) => exportPendingRecords(result.started_at)
        : undefined,
    )
  }

  function removeRecord(id: string) {
    const previous = records
    // 删除不改变列表末尾，不触发自动滚动
    syncRecords(
      () => setRecords((rows) => rows.filter((row) => row.id !== id)),
      () => deleteActivity(id),
      () => setRecords(previous),
    )
  }

  // 重置：先把当日 CSV 下载到本地再清空；本地立即清空，云端失败会回滚
  function resetAll() {
    if (!session) return
    const previous = records
    if (records.length > 0) exportCsv(records, statDay)
    syncRecords(
      () => setRecords([]),
      () => deleteAllActivities(session.user.id),
      () => setRecords(previous),
    )
  }

  const orderedShortcuts = draftOrder ?? shortcuts

  function clearPressTimer() {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
  }

  function chipUnderPointer(x: number, y: number) {
    for (const [id, element] of Object.entries(chipRefs.current)) {
      if (!element) continue
      const shortcut = shortcuts.find((item) => item.id === id)
      // 默认三个按钮固定在前，不参与拖动
      if (!shortcut || shortcut.is_default) continue
      const rect = element.getBoundingClientRect()
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return id
    }
    return null
  }

  // 长按 400ms 进入移动状态，移动过程中实时交换位置
  function handleChipPointerDown(shortcut: Shortcut, event: ReactPointerEvent<HTMLButtonElement>) {
    if (managing || shortcut.is_default || writePending.current > 0) return
    const element = event.currentTarget
    pressStart.current = { x: event.clientX, y: event.clientY, id: shortcut.id }
    clearPressTimer()
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null
      element.setPointerCapture?.(event.pointerId)
      const order = [...shortcuts]
      dragState.current = { id: shortcut.id, order }
      suppressTap.current = true
      setDraftOrder(order)
      setDraggingId(shortcut.id)
    }, 400)
  }

  function handleChipPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const start = pressStart.current
    if (!start) return
    const state = dragState.current
    if (!state) {
      if (Math.abs(event.clientX - start.x) > 8 || Math.abs(event.clientY - start.y) > 8) {
        clearPressTimer()
      }
      return
    }
    if (state.id !== start.id) return
    setDragDelta({ x: event.clientX - start.x, y: event.clientY - start.y })
    const hovered = chipUnderPointer(event.clientX, event.clientY)
    if (!hovered || hovered === state.id) return
    const from = state.order.findIndex((item) => item.id === state.id)
    const to = state.order.findIndex((item) => item.id === hovered)
    if (from < 0 || to < 0 || from === to) return
    const next = [...state.order]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    state.order = next
    animateReorder(next, state.id)
  }

  // 交换顺序前后记录位置差，用 FLIP 让其它按钮平滑让位
  function animateReorder(next: Shortcut[], draggedId: string) {
    const before = new Map<string, DOMRect>()
    for (const [id, element] of Object.entries(chipRefs.current)) {
      if (element) before.set(id, element.getBoundingClientRect())
    }
    setDraftOrder(next)
    window.requestAnimationFrame(() => {
      for (const [id, element] of Object.entries(chipRefs.current)) {
        if (!element || id === draggedId) continue
        const previous = before.get(id)
        if (!previous) continue
        const current = element.getBoundingClientRect()
        const dx = previous.left - current.left
        const dy = previous.top - current.top
        if (dx === 0 && dy === 0) continue
        element.style.transition = 'none'
        element.style.transform = `translate(${dx}px, ${dy}px)`
        window.requestAnimationFrame(() => {
          element.style.transition = 'transform .24s cubic-bezier(.2,.8,.2,1)'
          element.style.transform = ''
          window.setTimeout(() => { element.style.transition = '' }, 260)
        })
      }
    })
  }

  function handleChipPointerUp() {
    clearPressTimer()
    pressStart.current = null
    const state = dragState.current
    if (!state) return
    dragState.current = null
    setDraggingId(null)
    setDraftOrder(null)
    setDragDelta({ x: 0, y: 0 })
    window.setTimeout(() => { suppressTap.current = false }, 300)
    const previous = shortcuts
    syncShortcuts(
      () => setShortcuts(state.order),
      () => reorderShortcuts(state.order),
      () => setShortcuts(previous),
    )
  }

  if (configError) {
    return (
      <main className="shell">
        <div className="auth-panel">
          <h1>配置缺失</h1>
          <p className="empty">{configError}</p>
        </div>
      </main>
    )
  }
  if (!authReady) {
    return <main className="shell"><p className="empty">加载中…</p></main>
  }
  if (!session) return <AuthForm />

  return (
    <div className="app">
      <header className="app-header">
        <h1>时间记录</h1>
        <button
          type="button"
          className="reset-btn"
          onClick={resetAll}
          disabled={records.length === 0}
          title="下载当日 CSV 并清空全部记录"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
            <path d="M3 3v5h5" />
          </svg>
          重置
        </button>
      </header>

      <section className="current" aria-live="polite">
        {current ? (
          <h2 className="current-name">
            <span className="live-dot" aria-hidden="true" />
            <span className="current-text">{current.name}</span>
          </h2>
        ) : (
          <h2 className="current-name idle">没有进行中的活动</h2>
        )}
      </section>

      {pendingExportVisible && (
        <section className="export-reminder" aria-label="未导出记录提醒">
          <p>
            {exportedDay ? '上次导出后' : '目前'}有 {pendingExportCount} 条记录，数据仍保留在云端。
          </p>
          <button type="button" onClick={() => exportPendingRecords()}>
            导出 CSV
          </button>
        </section>
      )}

      <div className="history-head">
        <h3>今日记录</h3>
        <span className="history-day">{statDay}</span>
      </div>

      <main className="display" ref={displayRef} aria-label="今日记录列表">
        {todaySegments.length === 0 ? (
          <p className="empty">还没有记录，从下面开始。</p>
        ) : (
          <ol className="record-list">
            {todaySegments.map((segment) => (
              <SwipeRow
                key={`${segment.record.id}-${segment.segment_start}`}
                name={segment.record.name}
                timeText={beijingClockLabel(segment.record.started_at)}
                durationText={durationLabel(segment.segment_start, segment.segment_end)}
                ongoing={segment.record.ended_at === null}
                open={openId === segment.record.id}
                onOpen={() => setOpenId(segment.record.id)}
                onClose={() => setOpenId(null)}
                onDelete={() => {
                  if (window.confirm('确认删除这条记录？删除后不可恢复。')) {
                    setOpenId(null)
                    removeRecord(segment.record.id)
                  }
                }}
              />
            ))}
          </ol>
        )}
      </main>

      {(actionError || interactionError) && (
        <div className="alerts">
          {actionError && <p className="error" role="alert">{actionError}</p>}
          {interactionError && <p className="notice" role="status">{interactionError}</p>}
        </div>
      )}

      <footer className="composer">
        <form
          className="composer-form"
          onSubmit={(event) => {
            event.preventDefault()
            startRecord()
          }}
        >
          <input
            aria-label="活动名称"
            placeholder="正在做什么？"
            value={activityName}
            onChange={(event) => setActivityName(event.target.value)}
            maxLength={80}
          />
          <button className="primary" type="submit">
            记录
          </button>
        </form>

        <div className="shortcut-row">
          {orderedShortcuts.map((shortcut) => (
            <div key={shortcut.id} className="shortcut-item">
              {managing ? (
                <>
                  <input
                    aria-label="快捷按钮名称"
                    defaultValue={shortcut.name}
                    onBlur={(event) => {
                      const name = event.target.value.trim()
                      if (name && name !== shortcut.name) {
                        const previous = shortcuts
                        syncShortcuts(
                          () => setShortcuts((items) => items.map((item) => (
                            item.id === shortcut.id ? { ...item, name } : item
                          ))),
                          () => renameShortcut(shortcut.id, name),
                          () => setShortcuts(previous),
                        )
                      }
                    }}
                  />
                  <button className="icon danger" aria-label={`删除 ${shortcut.name}`} onClick={() => {
                    if (!window.confirm(`确认删除「${shortcut.name}」按钮？`)) return
                    const previous = shortcuts
                    syncShortcuts(
                      () => setShortcuts((items) => items.filter((item) => item.id !== shortcut.id)),
                      () => deleteShortcut(shortcut.id),
                      () => setShortcuts(previous),
                    )
                  }}>×</button>
                </>
              ) : (
                <button
                  ref={(element) => { chipRefs.current[shortcut.id] = element }}
                  type="button"
                  className={[
                    'shortcut',
                    shortcut.is_default ? '' : 'custom',
                    draggingId === shortcut.id ? 'dragging' : '',
                  ].filter(Boolean).join(' ')}
                  onContextMenu={(event) => event.preventDefault()}
                  onPointerDown={(event) => handleChipPointerDown(shortcut, event)}
                  onPointerMove={handleChipPointerMove}
                  onPointerUp={handleChipPointerUp}
                  onPointerCancel={handleChipPointerUp}
                  style={draggingId === shortcut.id
                    ? { transform: `translate(${dragDelta.x}px, ${dragDelta.y}px) scale(1.08)`, zIndex: 5 }
                    : undefined}
                  onClick={() => {
                    if (suppressTap.current) return
                    startShortcut(shortcut)
                  }}
                >
                  {shortcut.name}
                </button>
              )}
            </div>
          ))}
          <button type="button" className="manage-btn" onClick={() => setManaging(!managing)}>
            {managing ? '完成' : '编辑'}
          </button>
        </div>

        {managing && (
          <form className="shortcut-add" onSubmit={(event) => {
            event.preventDefault()
            const name = newShortcut.trim()
            if (!name) return
            const optimistic: Shortcut = {
              id: `local-${newId()}`,
              user_id: session?.user.id ?? '',
              name,
              sort_order: shortcuts.length + 1,
              is_default: false,
              created_at: new Date().toISOString(),
            }
            setNewShortcut('')
            syncShortcuts(
              () => setShortcuts((items) => [...items, optimistic]),
              () => addShortcut(name),
              () => setNewShortcut(name),
            )
          }}>
            <input
              aria-label="新增快捷按钮"
              placeholder="新增快捷按钮"
              value={newShortcut}
              onChange={(event) => setNewShortcut(event.target.value)}
              maxLength={80}
            />
            <button type="submit">新增</button>
          </form>
        )}
      </footer>
    </div>
  )
}
