import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../src/App'
import type { Activity, RecordCycle, Shortcut } from '../src/types'
import { beijingMinute, dayRange, shiftDate, statisticalDay } from '../src/lib/time'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const apiMocks = vi.hoisted(() => ({
  signIn: vi.fn(),
  signUp: vi.fn(),
  switchActivity: vi.fn(),
  touchInteraction: vi.fn(),
  fetchShortcuts: vi.fn(),
  addShortcut: vi.fn(),
  renameShortcut: vi.fn(),
  deleteShortcut: vi.fn(),
  reorderShortcuts: vi.fn(),
  fetchActivitiesByOverlap: vi.fn(),
  fetchCurrentCycle: vi.fn(),
  fetchCycleActivities: vi.fn(),
  resetRecordCycle: vi.fn(),
  deleteActivity: vi.fn(),
  updateActivity: vi.fn(),
}))

const supabaseMocks = vi.hoisted(() => {
  const listener = { subscription: { unsubscribe: vi.fn() } }
  const channel = {
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn().mockReturnThis(),
  }
  return {
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(() => listener),
    signOut: vi.fn(),
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
  }
})

const exportMocks = vi.hoisted(() => ({
  exportMarkdown: vi.fn(),
}))

vi.mock('../src/lib/api', () => apiMocks)
vi.mock('../src/lib/supabase', () => ({
  supabase: { ...supabaseMocks, auth: supabaseMocks },
  configError: null,
  redirectUrl: () => 'https://example.github.io/personal-time-tracker/',
}))

vi.mock('../src/lib/export', () => exportMocks)

const userId = '2d59cd70-04f3-4a92-a13b-6b3f2c9f24f1'
const session = {
  user: { id: userId, email: 'test@example.com' },
} as never

function activity(partial: Partial<Activity>): Activity {
  return {
    id: 'activity-id',
    user_id: userId,
    name: '学习',
    started_at: '2026-10-11T21:00:00Z',
    ended_at: null,
    source: 'manual',
    metadata: {},
    created_at: '2026-10-11T21:00:00Z',
    ...partial,
  }
}

function shortcut(partial: Partial<Shortcut>): Shortcut {
  return {
    id: 'shortcut-id',
    user_id: userId,
    name: '学习',
    sort_order: 1,
    is_default: true,
    created_at: '2026-10-11T21:00:00Z',
    ...partial,
  }
}

function cycle(partial: Partial<RecordCycle> = {}): RecordCycle {
  const startedAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  return {
    id: 'cycle-id',
    user_id: userId,
    started_at: startedAt,
    ended_at: null,
    created_at: startedAt,
    ...partial,
  }
}

function historicalActivity(dayOffset: number, partial: Partial<Activity>): Activity {
  const day = dayRange(shiftDate(statisticalDay(), dayOffset))
  const started = new Date(day.start.getTime() + 60_000).toISOString()
  const ended = new Date(day.start.getTime() + 120_000).toISOString()
  return activity({ id: `history-${dayOffset}`, started_at: started, ended_at: ended, created_at: started, ...partial })
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:mock'), writable: true })
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), writable: true })
  supabaseMocks.getSession.mockResolvedValue({ data: { session } })
  apiMocks.fetchShortcuts.mockResolvedValue([
    shortcut({ id: 'default-id', name: '学习', is_default: true }),
    shortcut({ id: 'custom-id', name: '阅读', is_default: false }),
  ])
  // 测试数据跟随当前统计日，避免真实日期跨过 05:00 后夹具失效。
  const dayStart = dayRange(statisticalDay()).start
  const oldStart = new Date(dayStart.getTime() + 60_000).toISOString()
  const oldEnd = new Date(dayStart.getTime() + 120_000).toISOString()
  apiMocks.fetchActivitiesByOverlap.mockResolvedValue([
    activity({ id: 'old-id', started_at: oldStart, ended_at: oldEnd, created_at: oldStart }),
    activity({ id: 'current-id', name: '写作', source: 'shortcut', started_at: new Date().toISOString() }),
  ])
  apiMocks.fetchCurrentCycle.mockResolvedValue(cycle())
  apiMocks.fetchCycleActivities.mockResolvedValue([])
  apiMocks.resetRecordCycle.mockResolvedValue(cycle({ id: 'next-cycle-id', started_at: new Date().toISOString() }))
  apiMocks.switchActivity.mockResolvedValue(activity({ id: 'new-id', name: '阅读', source: 'shortcut' }))
  apiMocks.updateActivity.mockImplementation((_id: string, values: Partial<Activity>) =>
    Promise.resolve(activity(values)),
  )
  apiMocks.deleteActivity.mockResolvedValue(undefined)
  apiMocks.reorderShortcuts.mockResolvedValue(undefined)
  apiMocks.renameShortcut.mockResolvedValue(undefined)
  apiMocks.deleteShortcut.mockResolvedValue(undefined)
  apiMocks.addShortcut.mockResolvedValue(undefined)
  exportMocks.exportMarkdown.mockClear()
})

describe('时间记录界面', () => {
  it('旧周期记录不再单独提醒，统一交给重置入口', async () => {
    apiMocks.fetchActivitiesByOverlap.mockResolvedValue([
      activity({ id: 'current-id', name: '写作', source: 'shortcut', started_at: new Date().toISOString() }),
    ])
    apiMocks.fetchCycleActivities.mockResolvedValue([
      historicalActivity(-3, { name: '整理' }),
      historicalActivity(-2, { name: '复盘' }),
      activity({ id: 'current-id', name: '写作', source: 'shortcut', started_at: new Date().toISOString() }),
    ])

    render(<App />)
    await screen.findAllByText('写作')

    expect(apiMocks.fetchActivitiesByOverlap).toHaveBeenCalledWith(
      dayRange(shiftDate(statisticalDay(), -1)).start.toISOString(),
      dayRange(statisticalDay()).end.toISOString(),
      expect.any(String),
    )
    expect(screen.queryByLabelText('未导出记录提醒')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '导出并清空' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重置' })).toBeEnabled()
  })

  it('开始记录不再弹出导出确认，也不自动清空旧周期', async () => {
    apiMocks.fetchActivitiesByOverlap.mockResolvedValue([
      activity({ id: 'current-id', name: '写作', source: 'shortcut', started_at: new Date().toISOString() }),
    ])
    apiMocks.fetchCycleActivities.mockResolvedValue([
      historicalActivity(-3, { name: '整理' }),
      historicalActivity(-2, { name: '复盘' }),
      activity({ id: 'current-id', name: '写作', source: 'shortcut', started_at: new Date().toISOString() }),
    ])
    apiMocks.switchActivity.mockResolvedValue(activity({ id: 'new-id', name: '阅读', source: 'manual' }))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const user = userEvent.setup()

    render(<App />)
    await screen.findAllByText('写作')

    await user.type(screen.getByLabelText('活动名称'), '阅读')
    await user.click(screen.getByRole('button', { name: '记录' }))

    await waitFor(() => expect(apiMocks.switchActivity).toHaveBeenCalledWith('阅读', 'manual'))
    expect(apiMocks.resetRecordCycle).not.toHaveBeenCalled()
    expect(exportMocks.exportMarkdown).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()

    await user.type(screen.getByLabelText('活动名称'), '运动')
    await user.click(screen.getByRole('button', { name: '记录' }))
    await waitFor(() => expect(apiMocks.switchActivity).toHaveBeenCalledWith('运动', 'manual'))

    expect(exportMocks.exportMarkdown).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })

  it('只显示服务器确认的当前活动，不再显示秒或持续时长', async () => {
    render(<App />)
    expect((await screen.findAllByText('写作')).length).toBeGreaterThan(0)
    expect(screen.queryByText(/已持续/)).not.toBeInTheDocument()
    expect(screen.queryByText(/正在进行/)).not.toBeInTheDocument()
    expect(apiMocks.fetchActivitiesByOverlap).toHaveBeenCalled()
  })

  it('每条记录同时显示开始时刻与总时长，精确到分且不出现秒与区间', async () => {
    render(<App />)
    await screen.findAllByText('写作')
    expect(screen.queryByText(/\d{2}:\d{2}:\d{2}/)).not.toBeInTheDocument()
    expect(screen.queryByText(/～/)).not.toBeInTheDocument()
    expect(screen.getAllByText(/^\d{2}时\d{2}分$/).length).toBeGreaterThan(0)
  })

  it('默认按钮只填入输入框，自定义按钮立即切换', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: '学习' }))
    expect(screen.getByLabelText('活动名称')).toHaveValue('学习')
    expect(apiMocks.switchActivity).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '阅读' }))
    await waitFor(() => expect(apiMocks.switchActivity).toHaveBeenCalledWith('阅读', 'shortcut'))
  })

  it('删除历史记录前要求确认，且只在服务器成功后刷新', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = userEvent.setup()
    render(<App />)
    await screen.findAllByText('写作')
    await user.click(screen.getAllByRole('button', { name: '删除' })[0])
    expect(confirm).toHaveBeenCalled()
    await waitFor(() => expect(apiMocks.deleteActivity).toHaveBeenCalledWith('old-id'))
    expect(apiMocks.fetchActivitiesByOverlap).toHaveBeenCalledTimes(2)
  })

  it('睡眠记录进行中时，记录与快捷按钮仍然可用', async () => {
    apiMocks.fetchActivitiesByOverlap.mockResolvedValue([
      activity({ id: 'sleep-id', name: '睡觉', ended_at: null, source: 'auto_sleep' }),
    ])
    const user = userEvent.setup()
    render(<App />)
    await screen.findAllByText('睡觉')

    expect(screen.getByRole('button', { name: '记录' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '学习' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '阅读' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: '阅读' }))
    await waitFor(() => expect(apiMocks.switchActivity).toHaveBeenCalledWith('阅读', 'shortcut'))
  })

  it('点记录时不再弹遮罩，新记录先本地可见，再同步到云端', async () => {
    let release: () => void = () => undefined
    apiMocks.switchActivity.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve(activity({ id: 'server-id', name: '写周报' }))
    }))
    const user = userEvent.setup()
    render(<App />)
    await screen.findAllByText('写作')

    await user.type(screen.getByLabelText('活动名称'), '写周报')
    await user.click(screen.getByRole('button', { name: '记录' }))

    // 云端还没返回，本地已经能看到，且没有遮罩
    expect(screen.getAllByText('写周报').length).toBeGreaterThan(0)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(apiMocks.fetchActivitiesByOverlap).toHaveBeenCalledTimes(1)

    release()
    await waitFor(() => expect(apiMocks.fetchActivitiesByOverlap).toHaveBeenCalledTimes(2))
  })

  it('快速连点不会丢操作：请求排队按顺序全部执行', async () => {
    apiMocks.fetchShortcuts.mockResolvedValue([
      shortcut({ id: 'read-id', name: '阅读', is_default: false }),
      shortcut({ id: 'write-id', name: '写作', is_default: false }),
    ])
    apiMocks.fetchActivitiesByOverlap.mockResolvedValue([
      activity({ id: 'open-id', name: '整理', ended_at: null }),
    ])

    const calls: string[] = []
    // 用数组存放，避免 TS 把闭包里的赋值收窄成 never
    const releaseFirst: Array<() => void> = []
    apiMocks.switchActivity.mockImplementation((name: string) => {
      calls.push(name)
      if (calls.length === 1) {
        return new Promise((resolve) => {
          releaseFirst[0] = () => resolve(activity({ id: 's1', name }))
        })
      }
      return Promise.resolve(activity({ id: 's2', name }))
    })

    const recordNames = () =>
      Array.from(document.querySelectorAll('.row-name')).map((element) => element.textContent)

    const user = userEvent.setup()
    render(<App />)
    await screen.findAllByText('整理')

    await user.click(screen.getByRole('button', { name: '阅读' }))
    await user.click(screen.getByRole('button', { name: '写作' }))

    // 第一个请求还没回来，但两条都已经在本地可见，且第二个已排队未发出
    expect(recordNames()).toContain('阅读')
    expect(recordNames()).toContain('写作')
    expect(calls).toEqual(['阅读'])

    releaseFirst[0]?.()
    await waitFor(() => expect(calls).toEqual(['阅读', '写作']))
  })

  it('当前已在记录同名活动时，重复提交被忽略，不产生重复记录', async () => {
    apiMocks.fetchShortcuts.mockResolvedValue([
      shortcut({ id: 'default-id', name: '学习', is_default: true }),
      shortcut({ id: 'write-id', name: '写作', is_default: false }),
    ])

    const user = userEvent.setup()
    render(<App />)
    await screen.findAllByText('写作')

    // 当前进行中的就是“写作”，点同名快捷按钮应直接忽略
    await user.click(screen.getByRole('button', { name: '写作' }))
    expect(apiMocks.switchActivity).not.toHaveBeenCalled()

    // 手动输入同一个名字再点“记录”也一样
    await user.type(screen.getByLabelText('活动名称'), '写作')
    await user.click(screen.getByRole('button', { name: '记录' }))
    expect(apiMocks.switchActivity).not.toHaveBeenCalled()
  })

  it('删除记录不会触发自动滚动', async () => {
    const scrollTo = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollTo', {
      value: scrollTo, writable: true, configurable: true,
    })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    try {
      const user = userEvent.setup()
      render(<App />)
      await screen.findAllByText('写作')
      scrollTo.mockClear()

      await user.click(screen.getAllByRole('button', { name: '删除' })[0])
      await waitFor(() => expect(apiMocks.deleteActivity).toHaveBeenCalledWith('old-id'))

      expect(scrollTo).not.toHaveBeenCalled()
    } finally {
      delete (Element.prototype as unknown as Record<string, unknown>).scrollTo
    }
  })

  it('斜向快速滑动不会被误判为左滑，避免闪出红色', async () => {
    render(<App />)
    await screen.findAllByText('写作')
    const first = document.querySelector<HTMLElement>('.row-surface')!

    // dx=-20 dy=+40：纵向占优，必须交还给页面滚动
    fireEvent.pointerDown(first, { pointerId: 1, clientX: 300, clientY: 100 })
    fireEvent.pointerMove(first, { pointerId: 1, clientX: 280, clientY: 140 })
    fireEvent.pointerUp(first, { pointerId: 1, clientX: 280, clientY: 140 })

    expect(first.style.transform).toBe('')
    expect(first.classList.contains('dragging')).toBe(false)
  })

  it('手势被系统打断时只回弹，不展开删除', async () => {
    render(<App />)
    await screen.findAllByText('写作')
    const first = document.querySelector<HTMLElement>('.row-surface')!

    fireEvent.pointerDown(first, { pointerId: 1, clientX: 300, clientY: 100 })
    fireEvent.pointerMove(first, { pointerId: 1, clientX: 160, clientY: 100 })
    expect(first.style.transform).toBe('translateX(-140px)')

    fireEvent.pointerCancel(first, { pointerId: 1, clientX: 200, clientY: 100 })
    expect(first.style.transform).toBe('translateX(0px)')
    expect(first.classList.contains('dragging')).toBe(false)
  })

  it('记录后自动把列表滚到底部，让新记录可见', async () => {
    const scrollTo = vi.fn()
    Object.defineProperty(Element.prototype, 'scrollTo', {
      value: scrollTo, writable: true, configurable: true,
    })
    try {
      const user = userEvent.setup()
      render(<App />)
      await screen.findAllByText('写作')
      scrollTo.mockClear()

      await user.type(screen.getByLabelText('活动名称'), '写周报')
      await user.click(screen.getByRole('button', { name: '记录' }))

      await waitFor(() => expect(scrollTo).toHaveBeenCalled())
      const [options] = scrollTo.mock.calls[scrollTo.mock.calls.length - 1]
      expect(options.behavior).toBe('smooth')
      expect(typeof options.top).toBe('number')
    } finally {
      delete (Element.prototype as unknown as Record<string, unknown>).scrollTo
    }
  })

  it('左滑展开删除，且同时只保留一条展开', async () => {
    render(<App />)
    await screen.findAllByText('写作')
    const surfaces = Array.from(document.querySelectorAll<HTMLElement>('.row-surface'))
    expect(surfaces.length).toBeGreaterThan(1)

    const [first, second] = surfaces
    fireEvent.pointerDown(first, { pointerId: 1, clientX: 300, clientY: 100 })
    fireEvent.pointerMove(first, { pointerId: 1, clientX: 160, clientY: 100 })

    // 拖动期间只改样式，并带上 dragging 类（去掉过渡，避免与手势打架）
    expect(first.classList.contains('dragging')).toBe(true)
    expect(first.style.transform).toBe('translateX(-140px)')

    fireEvent.pointerUp(first, { pointerId: 1, clientX: 200, clientY: 100 })
    expect(first.classList.contains('dragging')).toBe(false)
    expect(first.style.transform).toBe('translateX(-140px)')

    // 展开第二条时，第一条自动收起
    fireEvent.pointerDown(second, { pointerId: 2, clientX: 300, clientY: 100 })
    fireEvent.pointerMove(second, { pointerId: 2, clientX: 160, clientY: 100 })
    fireEvent.pointerUp(second, { pointerId: 2, clientX: 160, clientY: 100 })

    await waitFor(() => expect(first.style.transform).toBe('translateX(0px)'))
    expect(second.style.transform).toBe('translateX(-140px)')
  })

  it('左滑松手后补发的 click 不会让记录自动回弹', async () => {
    render(<App />)
    await screen.findAllByText('写作')
    const first = document.querySelector<HTMLElement>('.row-surface')!

    fireEvent.pointerDown(first, { pointerId: 1, clientX: 300, clientY: 100 })
    fireEvent.pointerMove(first, { pointerId: 1, clientX: 160, clientY: 100 })
    fireEvent.pointerUp(first, { pointerId: 1, clientX: 160, clientY: 100 })

    // iOS/桌面浏览器会在 pointerup 后补发 click，必须被这次手势吞掉。
    fireEvent.click(first)
    expect(first.style.transform).toBe('translateX(-140px)')
  })

  it('左滑修改记录，保存后同步活动名称和起止时间', async () => {
    const user = userEvent.setup()
    render(<App />)
    await screen.findAllByText('写作')
    const first = document.querySelector<HTMLElement>('.row-surface')!

    fireEvent.pointerDown(first, { pointerId: 1, clientX: 300, clientY: 100 })
    fireEvent.pointerMove(first, { pointerId: 1, clientX: 150, clientY: 100 })
    fireEvent.pointerUp(first, { pointerId: 1, clientX: 150, clientY: 100 })

    await user.click(screen.getAllByLabelText('修改')[0])
    await screen.findByRole('dialog', { name: '修改记录' })
    const nameInput = screen.getByLabelText('修改活动名称')
    const startInput = screen.getByLabelText('开始时间')
    const endInput = screen.getByLabelText('结束时间')
    await user.clear(nameInput)
    await user.type(nameInput, '改后的学习')
    await user.clear(startInput)
    await user.type(startInput, '2026-01-01T08:00')
    await user.clear(endInput)
    await user.type(endInput, '2026-01-01T09:30')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(apiMocks.updateActivity).toHaveBeenCalledWith('old-id', {
      name: '改后的学习',
      started_at: '2026-01-01T00:00:00.000Z',
      ended_at: '2026-01-01T01:30:00.000Z',
    }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('修改失败时保留编辑弹窗并提示错误', async () => {
    apiMocks.updateActivity.mockRejectedValue(new Error('修改失败'))
    const user = userEvent.setup()
    render(<App />)
    await screen.findAllByText('写作')

    await user.click(screen.getAllByLabelText('修改')[0])
    await screen.findByRole('dialog', { name: '修改记录' })
    await user.clear(screen.getByLabelText('修改活动名称'))
    await user.type(screen.getByLabelText('修改活动名称'), '失败记录')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('修改失败'))
    expect(screen.getByLabelText('修改活动名称')).toHaveValue('失败记录')
  })

  it('编辑弹窗支持 Escape 和点击遮罩关闭', async () => {
    const user = userEvent.setup()
    render(<App />)
    await screen.findAllByText('写作')

    await user.click(screen.getAllByLabelText('修改')[0])
    await screen.findByRole('dialog', { name: '修改记录' })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await user.click(screen.getAllByLabelText('修改')[0])
    await screen.findByRole('dialog', { name: '修改记录' })
    fireEvent.click(document.querySelector('.editor-overlay')!)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('纵向滑动不触发左滑展开', async () => {
    render(<App />)
    await screen.findAllByText('写作')
    const first = document.querySelector<HTMLElement>('.row-surface')!

    fireEvent.pointerDown(first, { pointerId: 1, clientX: 300, clientY: 100 })
    fireEvent.pointerMove(first, { pointerId: 1, clientX: 296, clientY: 160 })
    fireEvent.pointerUp(first, { pointerId: 1, clientX: 296, clientY: 160 })

    // 纵向手势不碰 transform
    expect(first.style.transform).toBe('')
    expect(first.classList.contains('dragging')).toBe(false)
  })

  it('云端写入失败时回滚本地记录并提示错误', async () => {
    apiMocks.switchActivity.mockRejectedValue(new Error('网络中断'))
    const user = userEvent.setup()
    render(<App />)
    await screen.findAllByText('写作')

    await user.type(screen.getByLabelText('活动名称'), '写周报')
    await user.click(screen.getByRole('button', { name: '记录' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('网络中断'))
    expect(screen.queryByText('写周报')).not.toBeInTheDocument()
    expect(screen.getByLabelText('活动名称')).toHaveValue('写周报')
  })

  it('记录时间显示 HH:MM，时长显示 HH时MM分', async () => {
    const startedAt = new Date(dayRange(statisticalDay()).start.getTime() + 60_000)
    render(<App />)
    await screen.findByText(beijingMinute(startedAt))
    expect(screen.getAllByText(beijingMinute(startedAt)).length).toBeGreaterThan(0)
    expect(screen.getAllByText('00时01分').length).toBeGreaterThan(0)
  })

  it('重置先下载当前周期 Markdown，再开启新周期且不删除云端记录', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    apiMocks.fetchCycleActivities.mockResolvedValue([
      historicalActivity(-3, { name: '整理' }),
      historicalActivity(-2, { name: '复盘' }),
    ])
    const user = userEvent.setup()
    render(<App />)
    await screen.findAllByText('写作')

    await waitFor(() => expect(screen.getByRole('button', { name: '重置' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '重置' }))

    expect(confirm).not.toHaveBeenCalled()
    await waitFor(() => expect(apiMocks.resetRecordCycle).toHaveBeenCalledTimes(1))
    expect(apiMocks.deleteActivity).not.toHaveBeenCalled()
    expect(exportMocks.exportMarkdown).toHaveBeenCalledTimes(1)
    const [exportedRows] = exportMocks.exportMarkdown.mock.calls[0]
    expect(exportedRows.map((row: Activity) => row.name)).toEqual(
      expect.arrayContaining(['整理', '复盘', '学习', '写作']),
    )
  })

  it('滚动区只包含记录条目，不含标题和今日记录抬头', async () => {
    render(<App />)
    await screen.findAllByText('写作')
    const scroll = document.querySelector('.display')
    expect(scroll).not.toBeNull()
    expect(scroll!.textContent ?? '').not.toContain('今日记录')
    expect(scroll!.textContent ?? '').not.toContain('时间记录')
    expect(scroll!.querySelectorAll('.record-row').length).toBeGreaterThan(0)
  })

  it('记录卡片不留 min-height，底部内边距足以容纳时间带', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    const surface = css.match(/\.row-surface\s*\{([^}]*)\}/)
    expect(surface).not.toBeNull()
    const block = surface![1]
    expect(block).not.toMatch(/min-height/)
    // padding: 20px 22px —— 下边距要装得下时间（12px 行高 1.2 + 距底 3px）
    const padding = block.match(/padding:\s*(\d+)px\s+(\d+)px/)
    expect(padding).not.toBeNull()
    expect(Number(padding![1])).toBeGreaterThanOrEqual(17)
    expect(Number(padding![2])).toBe(22)
  })

  it('当前进行中的那条记录有独立的强调样式', async () => {
    render(<App />)
    await screen.findAllByText('写作')

    const ongoing = document.querySelector('.record-row.ongoing')
    expect(ongoing).not.toBeNull()
    expect(ongoing!.querySelector('.row-name')?.textContent).toBe('写作')

    const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    // 左侧色条 + 描边 + 浅绿底
    expect(css).toMatch(/\.record-row\.ongoing \.row-surface \{[^}]*inset 3px 0 0 0 var\(--accent\)/)
    expect(css).toMatch(/\.record-row\.ongoing \.row-surface \{[^}]*var\(--accent-soft\)/)
    expect(css).toMatch(/\.record-row\.ongoing \.row-name \{[^}]*var\(--accent-deep\)/)
  })

  it('全站配色采用指定的冷静自然色板', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    const tokens: Record<string, string> = {
      '--canvas': '#f5f5f0',
      '--surface': '#ffffff',
      '--ink': '#303630',
      '--ink-2': '#737a74',
      '--accent': '#64856b',
      '--accent-soft': '#e6eee5',
      '--info': '#6486a3',
      '--warn': '#c18b4f',
      '--danger': '#b85c56',
      '--hairline': '#e3e6df',
    }
    for (const [name, value] of Object.entries(tokens)) {
      expect(css).toContain(`${name}: ${value};`)
    }
    // 时间信息用辅助蓝，危险操作才用红色
    expect(css).toMatch(/\.row-time \{[^}]*var\(--info-text\)/)
    expect(css).toMatch(/\.row-delete \{[^}]*color:\s*var\(--danger\)/)
  })

  it('时间两列固定宽度，保证每条记录时刻纵向对齐', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    expect(css).toMatch(/\.row-time\s*\{[^}]*min-width/)
    expect(css).toMatch(/\.row-duration\s*\{[^}]*min-width/)
    expect(css).toMatch(/\.row-time\s*\{[^}]*text-align:\s*right/)
    expect(css).toMatch(/\.row-duration\s*\{[^}]*text-align:\s*right/)
  })

  it('长按自定义按钮可拖动换位并保存排序', async () => {
    apiMocks.fetchShortcuts.mockResolvedValue([
      shortcut({ id: 'default-id', name: '学习', is_default: true }),
      shortcut({ id: 'read-id', name: '阅读', is_default: false }),
      shortcut({ id: 'write-id', name: '写作', is_default: false }),
    ])
    const rect = (left: number, right: number): DOMRect => ({
      left, right, top: 0, bottom: 34, width: right - left, height: 34,
      x: left, y: 0, toJSON: () => ({}),
    }) as DOMRect
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const text = this.textContent ?? ''
      if (text.includes('阅读')) return rect(0, 60)
      if (text.includes('写作')) return rect(60, 120)
      return rect(0, 0)
    })

    render(<App />)
    await screen.findAllByText('写作')

    const writeChip = screen.getByRole('button', { name: '写作' })
    fireEvent.pointerDown(writeChip, { pointerId: 1, clientX: 90, clientY: 10 })
    await new Promise((resolve) => setTimeout(resolve, 450))
    fireEvent.pointerMove(writeChip, { pointerId: 1, clientX: 20, clientY: 10 })
    fireEvent.pointerUp(writeChip, { pointerId: 1, clientX: 20, clientY: 10 })

    await waitFor(() => expect(apiMocks.reorderShortcuts).toHaveBeenCalled())
    const saved = apiMocks.reorderShortcuts.mock.calls[0][0] as Array<{ name: string }>
    expect(saved.map((item) => item.name)).toEqual(['学习', '写作', '阅读'])
  })

  it('手机布局规则存在且首屏控件保留', async () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    render(<App />)
    expect(await screen.findAllByLabelText('活动名称')).not.toHaveLength(0)
    expect(screen.getByRole('button', { name: '记录' })).toBeInTheDocument()
    expect(css).toContain('@media (max-width: 560px)')
    expect(css).toContain('flex-direction: column')
    // 底部按钮可用性依赖滚动区能收缩
    expect(css).toContain('min-height: 0')
  })
})
