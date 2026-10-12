import { useState, type FormEvent } from 'react'
import { signIn, signUp } from '../lib/api'

export function AuthForm() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    try {
      if (mode === 'signin') {
        const { error } = await signIn(email.trim(), password)
        if (error) throw error
      } else {
        const { data, error } = await signUp(email.trim(), password)
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
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
            密码
            <input
              type="password"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              minLength={6}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
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
