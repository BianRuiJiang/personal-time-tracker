import { useState, type FormEvent } from 'react'
import { signIn, signUp } from '../lib/api'

// 记住账号密码：只存在当前浏览器的 localStorage，不上传、不写入仓库
const STORE_KEY = 'ptt.credentials'

type Saved = { email: string; password: string }

function loadSaved(): Saved | null {
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Saved>
    if (typeof parsed.email !== 'string' || !parsed.email) return null
    return { email: parsed.email, password: typeof parsed.password === 'string' ? parsed.password : '' }
  } catch {
    return null
  }
}

function saveSaved(value: Saved) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(value))
  } catch {
    // 隐私模式等场景下写入会失败，忽略即可
  }
}

function clearSaved() {
  try {
    window.localStorage.removeItem(STORE_KEY)
  } catch {
    // 同上
  }
}

export function AuthForm() {
  const [initial] = useState(loadSaved)
  const [email, setEmail] = useState(initial?.email ?? '')
  const [password, setPassword] = useState(initial?.password ?? '')
  // 默认勾选：用户明确要求少登录；取消勾选会立即清除本地保存的账号密码
  const [remember, setRemember] = useState(true)
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    const account = email.trim()
    try {
      if (mode === 'signin') {
        const { error } = await signIn(account, password)
        if (error) throw error
        if (remember) saveSaved({ email: account, password })
        else clearSaved()
      } else {
        const { data, error } = await signUp(account, password)
        if (error) throw error
        if (!data.session) setMessage('注册成功，请先打开邮箱确认链接，再登录。')
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="shell">
      <section className="auth-panel" aria-labelledby="auth-title">
        <h1 id="auth-title">个人时间记录</h1>
        <form onSubmit={submit}>
          <label>
            邮箱
            <input
              type="email"
              name="email"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
            密码
            <input
              type="password"
              name="password"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              minLength={6}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>

          <label className="remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => {
                setRemember(event.target.checked)
                if (!event.target.checked) clearSaved()
              }}
            />
            记住账号和密码
          </label>

          <button className="primary" type="submit" disabled={busy}>
            {mode === 'signin' ? '登录' : '注册'}
          </button>
          <button
            className="ghost"
            type="button"
            disabled={busy}
            onClick={() => {
              setMode(mode === 'signin' ? 'signup' : 'signin')
              setMessage('')
            }}
          >
            {mode === 'signin' ? '没有账号？注册' : '已有账号？登录'}
          </button>
        </form>
        {message && <p className="notice" role="status">{message}</p>}
      </section>
    </main>
  )
}
