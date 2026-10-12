export type ActivitySource = 'manual' | 'shortcut' | 'auto_sleep' | 'auto_pause'

export interface Activity {
  id: string
  user_id: string
  name: string
  started_at: string
  ended_at: string | null
  source: ActivitySource
  metadata: Record<string, unknown>
  created_at: string
}

export interface Shortcut {
  id: string
  user_id: string
  name: string
  sort_order: number
  is_default: boolean
  created_at: string
}
