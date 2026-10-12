import { redirectUrl, supabase } from './supabase'
import type { Activity, Shortcut } from '../types'

function messageId() {
  return crypto.randomUUID()
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
  await Promise.all(items.map((item, index) =>
    supabase.from('shortcuts').update({ sort_order: index + 1 }).eq('id', item.id),
  ))
}

export async function fetchActivitiesByOverlap(startIso: string, endIso: string) {
  const { data, error } = await supabase
    .from('activities')
    .select('*')
    .lt('started_at', endIso)
    .or(`ended_at.is.null,ended_at.gte.${startIso}`)
    .order('started_at')
    .returns<Activity[]>()
  if (error) throw new Error(error.message)
  return data
}

export async function fetchAllActivities() {
  const { data, error } = await supabase
    .from('activities')
    .select('*')
    .order('started_at')
    .returns<Activity[]>()
  if (error) throw new Error(error.message)
  return data
}

export async function deleteActivity(id: string) {
  const { error } = await supabase.from('activities').delete().eq('id', id)
  if (error) throw new Error(error.message)
}
