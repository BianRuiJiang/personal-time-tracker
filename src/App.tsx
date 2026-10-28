import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent as ReactFormEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { AuthForm } from './components/AuthForm'
import { MeditationOverlay } from './components/MeditationOverlay'
import { configError, supabase } from './lib/supabase'
import {
  addShortcut,
  deleteActivity,
  deleteShortcut,
  fetchCurrentCycle,
  fetchCycleActivities,
  fetchShortcuts,
  renameShortcut,
  reorderShortcuts,
  resetRecordCycle,
  switchActivity,
  touchInteraction,
  updateActivity,
} from './lib/api'
import {
  beijingClockLabel,
  beijingDateTimeInput,
  beijingDateTimeInputToIso,
  durationLabel,
  statisticalDay,
} from './lib/time'
import { exportMarkdownToDirectory } from './lib/export-directory'
import type { Activity, Shortcut } from './types'

const REVEAL = 140

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
  onEdit: () => void
  onDelete: () => void
}

// 左滑露出删除。
// 拖动过程直接改 DOM 的 transform，不触发 React 渲染 —— 这是之前卡顿的根因。
function SwipeRow({
  name, timeText, durationText, ongoing, open, onOpen, onClose, onEdit, onDelete,
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
  const suppressClick = useRef(false)
  const suppressTimer = useRef<number | null>(null)

  // 左滑结束后浏览器可能补发一次 click；如果不拦截，刚展开的行会立即被收起。
  function suppressNextClick() {
    suppressClick.current = true
    if (suppressTimer.current !== null) window.clearTimeout(suppressTimer.current)
    suppressTimer.current = window.setTimeout(() => {
      suppressClick.current = false
      suppressTimer.current = null
    }, 500)
  }

  useEffect(() => () => {
    if (suppressTimer.current !== null) window.clearTimeout(suppressTimer.current)
  }, [])

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
      suppressNextClick()
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

    suppressNextClick()

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
      <div className="row-actions">
        <button type="button" aria-label="修改" onClick={onEdit}>
          修改
        </button>
        <button type="button" className="row-delete" aria-label="删除" onClick={onDelete}>
          删除
        </button>
      </div>
      <div
        ref={surfaceRef}
        className="row-surface"
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={finish}
        onPointerCancel={cancel}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false
            if (suppressTimer.current !== null) {
              window.clearTimeout(suppressTimer.current)
              suppressTimer.current = null
            }
            return
          }
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
  const [activityName, setActivityName] = useState('')
  const [actionError, setActionError] = useState('')
  const [interactionError, setInteractionError] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [managing, setManaging] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [newShortcut, setNewShortcut] = useState('')
  const [, setNow] = useState(() => new Date())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editStart, setEditStart] = useState('')
  const [editEnd, setEditEnd] = useState('')
  const [editingError, setEditingError] = useState('')
  const [meditationOpen, setMeditationOpen] = useState(false)
  const lastTouchRef = useRef(0)
  const displayRef = useRef<HTMLElement | null>(null)
  // 新增记录后需要把列表滚到底，让刚记的那条可见
  const scrollPending = useRef(false)
  // 写操作串行排队：快速连点不会丢操作，也不会和刷新互相覆盖。
  // pending > 0 期间不应用服务器快照，避免冲掉仍在排队的乐观记录。
  const writeQueue = useRef<Promise<unknown>>(Promise.resolve())
  const writePending = useRef(0)
  const cycleRequest = useRef(0)
  const shortcutsRequest = useRef(0)
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

  const loadCycleData = useCallback(async () => {
    if (!session) return
    const requestId = ++cycleRequest.current
    const cycle = await fetchCurrentCycle()
    if (requestId !== cycleRequest.current) return
    const cycleRows = await fetchCycleActivities(cycle.started_at)
    if (requestId !== cycleRequest.current) return
    setRecords(cycleRows)
    setHistoryRecords(cycleRows)
  }, [session])

  const loadShortcuts = useCallback(async () => {
    if (!session) return
    const requestId = ++shortcutsRequest.current
    const rows = await fetchShortcuts()
    if (requestId !== shortcutsRequest.current) return
    setShortcuts(rows)
  }, [session])

  // 统一的刷新入口：永远不产生未捕获的 Promise 拒绝
  const reloadCycleData = useCallback(() => {
    loadCycleData().catch((error) => {
      setActionError(error instanceof Error ? error.message : '刷新记录失败，请稍后重试')
    })
  }, [loadCycleData])

  const reloadShortcuts = useCallback(() => {
    loadShortcuts().catch((error) => {
      setActionError(error instanceof Error ? error.message : '刷新快捷按钮失败，请稍后重试')
    })
  }, [loadShortcuts])

  useEffect(() => {
    if (!session) {
      cycleRequest.current += 1
      shortcutsRequest.current += 1
      setShortcuts([])
      setRecords([])
      setHistoryRecords([])
      setEditingId(null)
      setOpenId(null)
      return
    }
    reloadShortcuts()
    reloadCycleData()
  }, [session, reloadShortcuts, reloadCycleData])

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
        reloadCycleData()
      })
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'record_cycles',
        filter: `user_id=eq.${userId}`,
      }, () => {
        if (writePending.current > 0) return
        reloadCycleData()
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
  }, [session, reloadCycleData, reloadShortcuts])

  // 30 秒刷新一次即可，界面只展示到分钟，不出现秒数跳动。
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(new Date())
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

  // 编辑弹窗打开时锁定页面滚动，并支持 Escape 关闭，避免移动端背景跟着弹窗滚动。
  useEffect(() => {
    if (!editingId) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') closeRecordEditor()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [editingId])

  const current = useMemo(
    () => records.find((record) => record.ended_at === null) ?? null,
    [records],
  )
  // 未重置前，页面显示当前周期的全部记录；云端历史始终保留。
  const cycleSegments = useMemo(
    () => [...records].sort((left, right) => left.started_at.localeCompare(right.started_at)),
    [records],
  )
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
  }, [cycleSegments])

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
    setSyncing(true)
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
        const queueIdle = writePending.current === 0
        if (queueIdle) setSyncing(false)
        // 队列中还有后续写入时先不回滚；排空后的服务器刷新会恢复真实状态。
        if (failed && queueIdle) onFail?.()
        if (!failed) onResult?.(result as T)
        // 队列排空后才以服务器状态为准
        if (queueIdle) refresh()
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
      reloadCycleData()
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

  function resetExportRows() {
    // 当前周期数据已经完整加载；再合并一次是为了兼容刷新间隙中的旧状态。
    const byId = new Map<string, Activity>()
    for (const row of [...historyRecords, ...records]) {
      if (!byId.has(row.id)) byId.set(row.id, row)
    }
    return [...byId.values()].sort((left, right) => left.started_at.localeCompare(right.started_at))
  }

  function resetExportLabel(rows: Activity[]) {
    const days = rows.map((record) => statisticalDay(new Date(record.started_at))).sort()
    const firstDay = days[0]
    const lastDay = days[days.length - 1]
    return firstDay === lastDay ? firstDay : `${firstDay}_to_${lastDay}`
  }

  async function exportResetRows(rows: Activity[]) {
    if (rows.length === 0) return false
    try {
      await exportMarkdownToDirectory(rows, resetExportLabel(rows))
      return true
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setActionError('已取消目录选择，记录未重置')
      } else {
        setActionError(error instanceof Error ? error.message : '导出失败，记录未重置')
      }
      return false
    }
  }

  function cycleResetRows() {
    const currentDay = statisticalDay(new Date())
    const rows = resetExportRows()
    const previousRows = rows.filter((row) => statisticalDay(new Date(row.started_at)) !== currentDay)
    // 当天已经继续记录过，说明用户已跳过这次周期切换；不再打断当前使用。
    return rows.some((row) => statisticalDay(new Date(row.started_at)) === currentDay)
      ? []
      : previousRows
  }

  function shouldPromptCycleReset() {
    return cycleResetRows().length > 0
  }

  function promptCycleReset() {
    const count = cycleResetRows().length
    return window.confirm(
      `上个使用周期有 ${count} 条记录未导出。是否先导出并重置？重置后将开始新记录。`,
    )
  }

  async function submitRecord(name: string, source: 'manual' | 'shortcut') {
    if (shouldPromptCycleReset()) {
      if (!promptCycleReset()) return

      const rows = resetExportRows()
      const previousRecords = records
      const previousHistory = historyRecords
      // 必须先导出旧周期；数据库重置成功后再写入的新记录才属于新周期。
      const exported = await exportResetRows(rows)
      if (!exported) return

      setActivityName('')
      syncRecords(
        () => {
          const optimistic = optimisticRecord(name, source)
          setRecords([optimistic])
          setHistoryRecords([optimistic])
        },
        async () => {
          await resetRecordCycle()
          return switchActivity(name, source)
        },
        () => {
          setRecords(previousRecords)
          setHistoryRecords(previousHistory)
        },
      )
      return
    }

    const previous = records
    setActivityName('')
    scrollPending.current = source === 'manual'
    syncRecords(
      () => localSwitch(name, source),
      () => switchActivity(name, source),
      () => {
        if (source === 'manual') setActivityName(name)
        setRecords(previous)
      },
    )
  }

  function openRecordEditor(record: Pick<Activity, 'id' | 'name' | 'started_at' | 'ended_at'>) {
    setOpenId(null)
    setEditingError('')
    setEditingId(record.id)
    setEditName(record.name)
    setEditStart(beijingDateTimeInput(record.started_at))
    setEditEnd(record.ended_at ? beijingDateTimeInput(record.ended_at) : '')
  }

  function closeRecordEditor() {
    setEditingId(null)
    setEditName('')
    setEditStart('')
    setEditEnd('')
    setEditingError('')
  }

  function saveRecordEdit(event: ReactFormEvent<HTMLFormElement>) {
    event.preventDefault()
    const record = historyRecords.find((item) => item.id === editingId) ??
      records.find((item) => item.id === editingId)
    if (!record) {
      closeRecordEditor()
      return
    }
    const name = editName.trim()
    const startedIso = beijingDateTimeInputToIso(editStart)
    const endedIso = editEnd ? beijingDateTimeInputToIso(editEnd) : null
    if (!name || !startedIso || (record.ended_at && !endedIso)) {
      setEditingError('请填写活动名称和有效时间')
      return
    }
    if (endedIso && endedIso < startedIso) {
      setEditingError('结束时间不能早于开始时间')
      return
    }
    const updated = { ...record, name, started_at: startedIso, ended_at: endedIso }
    const previousRecords = records
    const previousHistory = historyRecords
    syncRecords(
      () => {
        setRecords((items) => items.map((item) => item.id === record.id ? updated : item))
        setHistoryRecords((items) => items.map((item) => item.id === record.id ? updated : item))
      },
      () => updateActivity(record.id, {
        name,
        started_at: startedIso,
        ended_at: endedIso,
      }),
      () => {
        setRecords(previousRecords)
        setHistoryRecords(previousHistory)
      },
      () => closeRecordEditor(),
    )
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
    submitRecord(name, 'manual')
  }

  function startShortcut(shortcut: Shortcut) {
    if (shortcut.is_default) {
      setActivityName(shortcut.name)
      return
    }
    if (isAlreadyRunning(shortcut.name)) return
    submitRecord(shortcut.name, 'shortcut')
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

  // 重置：先下载当前周期 Markdown，再在数据库开启新周期；旧记录永久保留。
  async function resetAll() {
    if (!session) return
    if (writePending.current > 0) {
      setActionError('记录正在同步，请稍后再重置')
      return
    }
    const rows = resetExportRows()
    if (rows.length === 0) {
      setActionError('当前周期没有可导出的记录')
      return
    }
    const previousRecords = records
    const previousHistory = historyRecords
    setSyncing(true)
    const exported = await exportResetRows(rows)
    if (!exported) {
      setSyncing(false)
      return
    }
    syncRecords(
      () => {
        setRecords([])
        setHistoryRecords([])
      },
      () => resetRecordCycle(),
      () => {
        setRecords(previousRecords)
        setHistoryRecords(previousHistory)
      },
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
        <div className="header-actions">
          <button
            type="button"
            className="meditation-btn"
            onClick={() => setMeditationOpen(true)}
            title="打开冥想"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <circle cx="12" cy="12" r="3.5" />
            </svg>
            冥想
          </button>
          <button
            type="button"
            className="reset-btn"
            onClick={resetAll}
            disabled={syncing || (records.length === 0 && historyRecords.length === 0)}
            title="先导出当前周期 Markdown，再开始新周期"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
              <path d="M3 3v5h5" />
            </svg>
            重置
          </button>
        </div>
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

      <div className="history-head">
        <h3>未导出记录</h3>
        <span className="history-day">当前周期</span>
      </div>

      <main className="display" ref={displayRef} aria-label="今日记录列表">
        {cycleSegments.length === 0 ? (
          <p className="empty">还没有记录，从下面开始。</p>
        ) : (
          <ol className="record-list">
            {cycleSegments.map((segment) => (
              <SwipeRow
                key={segment.id}
                name={segment.name}
                timeText={beijingClockLabel(segment.started_at)}
                durationText={durationLabel(segment.started_at, segment.ended_at)}
                ongoing={segment.ended_at === null}
                open={openId === segment.id}
                onOpen={() => setOpenId(segment.id)}
                onClose={() => setOpenId(null)}
                onEdit={() => openRecordEditor(segment)}
                onDelete={() => {
                  if (window.confirm('确认删除这条记录？删除后不可恢复。')) {
                    setOpenId(null)
                    removeRecord(segment.id)
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

      {editingId && (
        <div
          className="editor-overlay"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeRecordEditor()
          }}
        >
          <form
            className="editor-panel"
            role="dialog"
            aria-label="修改记录"
            aria-modal="true"
            onSubmit={saveRecordEdit}
          >
            <h2>修改记录</h2>
            <label>
              活动名称
              <input
                aria-label="修改活动名称"
                value={editName}
                onChange={(event) => setEditName(event.target.value)}
                maxLength={80}
              />
            </label>
            <div className="editor-grid">
              <label>
                开始时间
                <input
                  aria-label="开始时间"
                  type="datetime-local"
                  step={60}
                  value={editStart}
                  onChange={(event) => setEditStart(event.target.value)}
                />
              </label>
              <label>
                结束时间
                <input
                  aria-label="结束时间"
                  type="datetime-local"
                  step={60}
                  value={editEnd}
                  placeholder="进行中可留空"
                  onChange={(event) => setEditEnd(event.target.value)}
                />
              </label>
            </div>
            {editingError && <p className="error" role="alert">{editingError}</p>}
            <div className="editor-actions">
              <button type="button" onClick={closeRecordEditor}>取消</button>
              <button className="primary" type="submit">保存</button>
            </div>
          </form>
        </div>
      )}

      {meditationOpen && (
        <MeditationOverlay onClose={() => setMeditationOpen(false)} />
      )}
    </div>
  )
}
