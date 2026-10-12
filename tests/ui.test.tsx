import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../src/App'
import type { Activity, Shortcut } from '../src/types'
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
  fetchAllActivities: vi.fn(),
  deleteActivity: vi.fn(),
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

vi.mock('../src/lib/api', () => apiMocks)
vi.mock('../src/lib/supabase', () => ({
  supabase: { ...supabaseMocks, auth: supabaseMocks },
  redirectUrl: () => 'https://example.github.io/personal-time-tracker/',
}))

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

beforeEach(() => {
  vi.clearAllMocks()
  supabaseMocks.getSession.mockResolvedValue({ data: { session } })
  apiMocks.fetchShortcuts.mockResolvedValue([
    shortcut({ id: 'default-id', name: '学习', is_default: true }),
    shortcut({ id: 'custom-id', name: '阅读', is_default: false }),
  ])
  apiMocks.fetchActivitiesByOverlap.mockResolvedValue([
    activity({ id: 'old-id', ended_at: '2026-10-11T22:00:00Z' }),
    activity({ id: 'current-id', name: '写作', source: 'shortcut' }),
  ])
  apiMocks.switchActivity.mockResolvedValue(activity({ id: 'new-id', name: '阅读', source: 'shortcut' }))
  apiMocks.deleteActivity.mockResolvedValue(undefined)
})

describe('时间记录界面', () => {
  it('显示服务器确认的当前活动和已持续状态', async () => {
    render(<App />)
    expect((await screen.findAllByText('写作')).length).toBeGreaterThan(0)
    expect(screen.getByText(/已持续/)).toBeInTheDocument()
    expect(apiMocks.fetchActivitiesByOverlap).toHaveBeenCalled()
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

  it('导出调用使用服务器查询到的原始记录', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = userEvent.setup()
    apiMocks.fetchAllActivities.mockResolvedValue([activity({ id: 'all-id' })])
    render(<App />)
    await screen.findAllByText('写作')
    await user.click(screen.getByRole('button', { name: '导出全部 JSON' }))
    await waitFor(() => expect(apiMocks.fetchAllActivities).toHaveBeenCalled())
    expect(confirm).toHaveBeenCalled()
  })

  it('手机布局规则存在且首屏控件保留', async () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    render(<App />)
    expect(await screen.findAllByLabelText('活动名称')).not.toHaveLength(0)
    expect(screen.getByRole('button', { name: '开始记录' })).toBeInTheDocument()
    expect(css).toContain('@media (max-width: 520px)')
    expect(css).toContain('grid-template-columns: repeat(3, 1fr)')
  })
})
