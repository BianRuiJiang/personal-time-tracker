import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const db = new PGlite()
const user1 = '11111111-1111-4111-8111-111111111111'
const user2 = '22222222-2222-4222-8222-222222222222'

async function become(userId: string | null, role = 'authenticated') {
  await db.exec('reset role')
  await db.exec(`select set_config('request.jwt.claim.sub', '${userId ?? ''}', false)`)
  await db.exec(`set role ${role}`)
}

async function query<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  const result = await db.query<T>(text, values)
  return result.rows
}

beforeAll(async () => {
  const source = readFileSync(resolve(process.cwd(), 'supabase/migrations/001_init.sql'), 'utf8')
  const productionSql = source.slice(0, source.indexOf('\nselect cron.unschedule'))
    .replace('create extension if not exists pg_cron;', '')

  await db.exec(`
    create role authenticated nologin;
    create role anon nologin;
    create role service_role nologin;
    create schema auth authorization postgres;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid
    language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public to authenticated, anon, service_role;
  `)
  await db.exec(productionSql)
  await db.exec(`
    insert into auth.users (id, email) values ('${user1}', 'one@example.com'), ('${user2}', 'two@example.com');
  `)
})

describe('数据库核心规则', () => {
  it('注册用户获得自己的状态和三个默认按钮', async () => {
    const states = await query<{ user_id: string }>('select * from public.session_state order by user_id')
    const shortcuts = await query<{ user_id: string; name: string }>(
      'select user_id, name from public.shortcuts order by user_id, sort_order',
    )
    expect(states).toHaveLength(2)
    expect(shortcuts.map((row) => row.name).sort((left, right) =>
      ['学习', '休息', '工作'].indexOf(left) - ['学习', '休息', '工作'].indexOf(right),
    )).toEqual(['学习', '学习', '休息', '休息', '工作', '工作'])
  })

  it('开始并切换活动，同一时刻只保留一条未结束记录', async () => {
    await become(user1)
    const started = await query<{ id: string; name: string; ended_at: null }>(
      "select * from public.switch_activity('学习', 'manual')",
    )
    expect(started).toHaveLength(1)
    expect(started[0].ended_at).toBeNull()

    const switched = await query<{ id: string; name: string }>(
      "select * from public.switch_activity('工作', 'shortcut')",
    )
    expect(switched[0].name).toBe('工作')

    const open = await query<{ name: string }>(
      `select name from public.activities where user_id = $1 and ended_at is null`, [user1],
    )
    expect(open).toEqual([{ name: '工作' }])
  })

  it('同名活动分别保存，不会合并', async () => {
    await become(user1)
    await query("select public.switch_activity('学习', 'manual')")
    const rows = await query<{ count: string }>(
      "select count(*)::text as count from public.activities where user_id = $1 and name = '学习' and ended_at is not null",
      [user1],
    )
    expect(Number(rows[0].count)).toBeGreaterThanOrEqual(1)
  })

  it('两个设备同时切换时只保留最后一条未结束记录', async () => {
    await become(user1)
    const races = await Promise.all([
      query("select public.switch_activity('并发学习', 'manual')"),
      query("select public.switch_activity('并发锻炼', 'shortcut')"),
    ])
    expect(races).toHaveLength(2)

    const open = await query<{ name: string }>(`
      select name from public.activities
      where user_id = $1 and ended_at is null
    `, [user1])
    expect(open).toHaveLength(1)
    expect(['并发学习', '并发锻炼']).toContain(open[0].name)
  })

  it('数据库唯一索引阻止同一用户出现第二条未结束记录', async () => {
    await become(user1, 'postgres')
    await expect(query(`
      insert into public.activities (user_id, name, started_at, source)
      values ('${user1}', '并发活动', clock_timestamp(), 'manual')
    `)).rejects.toThrow(/one_open_record_per_user/i)
  })

  it('120 分钟无交互后按最后一次交互加 120 分钟暂停，重复执行幂等', async () => {
    await become(user2)
    await query("select public.switch_activity('阅读', 'manual')")
    await become(null, 'postgres')
    await db.exec(`
      update public.activities
      set started_at = '2026-10-12T00:00:00Z'
      where user_id = '${user2}' and ended_at is null;
      update public.session_state
      set last_interaction_at = '2026-10-12T00:00:00Z'
      where user_id = '${user2}';
    `)
    await become(null, 'service_role')
    const first = await query<{ count: number }>('select public.pause_inactive_activities() as count')
    const second = await query<{ count: number }>('select public.pause_inactive_activities() as count')
    await become(null, 'postgres')
    const markers = await query<{ started_at: string; ended_at: string; source: string }>(`
      select started_at, ended_at, source
      from public.activities
      where user_id = $1 and source = 'auto_pause'
    `, [user2])
    expect(first[0].count).toBe(1)
    expect(second[0].count).toBe(0)
    expect(markers).toHaveLength(1)
    expect(new Date(markers[0].started_at).toISOString()).toBe('2026-10-12T02:00:00.000Z')
    expect(new Date(markers[0].ended_at).toISOString()).toBe('2026-10-12T02:00:00.000Z')
  })

  it('23:00 开始睡眠，07:00 结束睡眠，跨统计日保留一条原始记录且重复执行幂等', async () => {
    await become(user1)
    await query("select public.switch_activity('晚上学习', 'manual')")
    await become(null, 'postgres')
    await db.exec(`
      update public.activities
      set started_at = '2026-10-11T10:00:00Z'
      where user_id = '${user1}' and ended_at is null;
    `)
    await become(null, 'service_role')
    const startedOnce = await query<{ count: number }>(
      "select public.start_scheduled_sleep('2026-10-11T15:00:00Z') as count",
    )
    const startedTwice = await query<{ count: number }>(
      "select public.start_scheduled_sleep('2026-10-11T15:00:00Z') as count",
    )
    const endedOnce = await query<{ count: number }>(
      "select public.end_scheduled_sleep('2026-10-11T23:00:00Z') as count",
    )
    const endedTwice = await query<{ count: number }>(
      "select public.end_scheduled_sleep('2026-10-11T23:00:00Z') as count",
    )
    await become(null, 'postgres')
    const sleeps = await query<{ started_at: string; ended_at: string; source: string }>(`
      select started_at, ended_at, source
      from public.activities
      where user_id = $1 and source = 'auto_sleep'
    `, [user1])
    expect(startedOnce[0].count).toBe(1)
    expect(startedTwice[0].count).toBe(0)
    expect(endedOnce[0].count).toBe(1)
    expect(endedTwice[0].count).toBe(0)
    expect(sleeps).toHaveLength(1)
    expect(new Date(sleeps[0].started_at).toISOString()).toBe('2026-10-11T15:00:00.000Z')
    expect(new Date(sleeps[0].ended_at).toISOString()).toBe('2026-10-11T23:00:00.000Z')
  })

  it('用户只能看到和删除自己的数据', async () => {
    await become(user2)
    const visible = await query<{ user_id: string }>('select user_id from public.activities')
    expect(visible.every((row) => row.user_id === user2)).toBe(true)

    const foreignRows = await query<{ id: string }>(
      'select id from public.activities where user_id = $1', [user1],
    )
    expect(foreignRows).toEqual([])
    const deleted = await query<{ id: string }>(`
      with deleted as (
        delete from public.activities where user_id = $1 returning id
      )
      select id from deleted
    `, [user1])
    expect(deleted).toEqual([])

    await become(user1)
    const before = await query<{ id: string }>(
      'select id from public.activities where user_id = $1 and source = $2', [user1, 'manual'],
    )
    await query('delete from public.activities where id = $1', [before[0].id])
    const after = await query<{ count: string }>(
      'select count(*)::text as count from public.activities where id = $1', [before[0].id],
    )
    expect(Number(after[0].count)).toBe(0)
  })
})
