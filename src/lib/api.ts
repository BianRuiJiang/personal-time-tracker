import { redirectUrl, supabase } from './supabase'
import type { Activity, RecordCycle, Shortcut } from '../types'

// crypto.randomUUID 在旧浏览器下可能缺失，做一层兜底
function messageId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export async function signIn(email: string, password: string) {
  return supabase.auth.signInWithPassword({
    email,
    password,
  })
}

export async function signUp(email: string, password: string) {
  return supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: redirectUrl() },
  })
}

export async function switchActivity(name: string, source: 'manual' | 'shortcut') {
  const { data, error } = await supabase.rpc('switch_activity', {
    p_name: name,
    p_source: source,
    p_client_event_id: messageId(),
  }).select().single<Activity>()
  if (error) throw new Error(error.message)
  return data
}

export async function touchInteraction() {
  const { error } = await supabase.rpc('touch_interaction')
  if (error) throw new Error(error.message)
}

export async function fetchShortcuts() {
  const { data, error } = await supabase
    .from('shortcuts')
    .select('*')
    .order('sort_order')
    .returns<Shortcut[]>()
  if (error) throw new Error(error.message)
  return data
}

export async function addShortcut(name: string) {
  const { data: sessionData } = await supabase.auth.getUser()
  if (!sessionData.user) throw new Error('未登录')
  const { data, error } = await supabase
    .from('shortcuts')
    .insert({ user_id: sessionData.user.id, name, sort_order: 999 })
    .select()
    .single<Shortcut>()
  if (error) throw new Error(error.message)
  return data
}

export async function renameShortcut(id: string, name: string) {
  const { error } = await supabase.from('shortcuts').update({ name }).eq('id', id)
  if (error) throw new Error(error.message)
}

export async function deleteShortcut(id: string) {
  const { error } = await supabase.from('shortcuts').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

export async function reorderShortcuts(items: Shortcut[]) {
  const results = await Promise.all(items.map((item, index) =>
    supabase.from('shortcuts').update({ sort_order: index + 1 }).eq('id', item.id),
  ))
  const failure = results.find((result) => result.error)
  if (failure?.error) throw new Error(failure.error.message)
}

export async function fetchCurrentCycle() {
  const { data, error } = await supabase
    .from('record_cycles')
    .select('*')
    .is('ended_at', null)
    .maybeSingle<RecordCycle>()
  if (error) throw new Error(error.message)
  if (!data) throw new Error('当前记录周期不存在，请刷新后重试')
  return data
}

export async function fetchActivitiesByOverlap(startIso: string, endIso: string, cycleStartIso: string) {
  const { data, error } = await supabase
    .from('activities')
    .select('*')
    .gte('started_at', cycleStartIso)
    .lt('started_at', endIso)
    .or(`ended_at.is.null,ended_at.gte.${startIso}`)
    .order('started_at')
    .returns<Activity[]>()
  if (error) throw new Error(error.message)
  return data
}

export async function fetchCycleActivities(cycleStartIso: string) {
  const pageSize = 1000
  const rows: Activity[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('activities')
      .select('*')
      .gte('started_at', cycleStartIso)
      .order('started_at')
      .range(from, from + pageSize - 1)
      .returns<Activity[]>()
    if (error) throw new Error(error.message)
    rows.push(...data)
    if (data.length < pageSize) break
  }
  return rows
}

export async function resetRecordCycle() {
  const { data, error } = await supabase
    .rpc('reset_record_cycle')
    .single<RecordCycle>()
  if (error) throw new Error(error.message)
  return data
}

export async function updateActivity(
  id: string,
  values: Pick<Activity, 'name' | 'started_at' | 'ended_at'>,
) {
  const { data, error } = await supabase
    .from('activities')
    .update(values)
    .eq('id', id)
    .select()
    .single<Activity>()
  if (error) throw new Error(error.message)
  return data
}

export async function deleteActivity(id: string) {
  const { error } = await supabase.from('activities').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

