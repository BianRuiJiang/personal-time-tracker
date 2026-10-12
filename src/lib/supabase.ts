import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

// 缺少配置时不抛异常（否则整个页面白屏），改为暴露错误信息，由界面友好提示
export const configError = !url || !publishableKey
  ? '缺少 Supabase 环境变量（VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY），请检查部署配置。'
  : null

export const supabase = createClient(
  url ?? 'https://placeholder.supabase.co',
  publishableKey ?? 'placeholder-publishable-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  },
)

function appUrl() {
  const base = import.meta.env.BASE_URL || '/'
  return new URL(base, window.location.origin).toString()
}

export function redirectUrl() {
  return appUrl()
}
