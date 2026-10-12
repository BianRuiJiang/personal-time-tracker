import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AuthForm } from '../src/components/AuthForm'

const apiMocks = vi.hoisted(() => ({
  signIn: vi.fn(),
  signUp: vi.fn(),
}))

vi.mock('../src/lib/api', () => apiMocks)

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  apiMocks.signIn.mockResolvedValue({ error: null })
  apiMocks.signUp.mockResolvedValue({ data: { session: null }, error: null })
})

describe('登录页记住账号密码', () => {
  it('勾选后登录成功会把账号密码存在本地', async () => {
    const user = userEvent.setup()
    render(<AuthForm />)

    await user.type(screen.getByLabelText('邮箱'), 'someone@example.com')
    await user.type(screen.getByLabelText('密码'), 'secret123')
    expect(screen.getByRole('checkbox', { name: '记住账号和密码' })).toBeChecked()
    await user.click(screen.getByRole('button', { name: '登录' }))

    await waitFor(() => expect(apiMocks.signIn).toHaveBeenCalledWith('someone@example.com', 'secret123'))
    expect(JSON.parse(window.localStorage.getItem('ptt.credentials')!)).toEqual({
      email: 'someone@example.com',
      password: 'secret123',
    })
  })

  it('再次打开会自动填好账号密码', async () => {
    window.localStorage.setItem(
      'ptt.credentials',
      JSON.stringify({ email: 'saved@example.com', password: 'saved-pass' }),
    )
    render(<AuthForm />)

    expect(screen.getByLabelText('邮箱')).toHaveValue('saved@example.com')
    expect(screen.getByLabelText('密码')).toHaveValue('saved-pass')
    expect(screen.getByRole('checkbox', { name: '记住账号和密码' })).toBeChecked()
  })

  it('取消勾选会立即清除本地保存的密码', async () => {
    window.localStorage.setItem(
      'ptt.credentials',
      JSON.stringify({ email: 'saved@example.com', password: 'saved-pass' }),
    )
    const user = userEvent.setup()
    render(<AuthForm />)

    await user.click(screen.getByRole('checkbox', { name: '记住账号和密码' }))
    expect(window.localStorage.getItem('ptt.credentials')).toBeNull()
  })

  it('本地存的内容损坏时不会崩，按未记住处理', () => {
    window.localStorage.setItem('ptt.credentials', '{坏掉的 JSON')
    render(<AuthForm />)

    expect(screen.getByLabelText('邮箱')).toHaveValue('')
    expect(screen.getByLabelText('密码')).toHaveValue('')
  })
})
