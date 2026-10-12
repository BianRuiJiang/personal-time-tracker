import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!url || !publishableKey) {
  throw new Error('缺少 Supabase 环境变量，请检查部署配置')
}

function appUrl() {
  const base = import.meta.env.BASE_URL || '/'
  return new URL(base, window.location.origin).toString()
}

export const supabase = createClient(url, publishableKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})

export function redirectUrl() {
  return appUrl()
}
