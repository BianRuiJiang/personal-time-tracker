-- 个人时间记录：表结构、RLS、安全 RPC 和 PostgreSQL Cron 自动化。
create extension if not exists pg_cron;

create table public.activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  started_at timestamptz not null,
  ended_at timestamptz,
  source text not null check (source in ('manual', 'shortcut', 'auto_sleep', 'auto_pause')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  constraint activity_period_valid check (ended_at is null or ended_at >= started_at)
);

create table public.shortcuts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  sort_order integer not null default 0,
  is_default boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  constraint shortcut_name_unique unique (user_id, name)
);

create table public.session_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_interaction_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create index activities_user_started_idx on public.activities (user_id, started_at desc, ended_at);
create index activities_open_idx on public.activities (user_id) where ended_at is null;
create index shortcuts_user_sort_idx on public.shortcuts (user_id, sort_order);

alter table public.activities enable row level security;
alter table public.shortcuts enable row level security;
alter table public.session_state enable row level security;

-- 历史记录只能被所有者查看和删除；没有 UPDATE/INSERT 策略，用户无法补录或改时间。
create policy activities_select_own on public.activities
  for select to authenticated using (user_id = auth.uid());
create policy activities_delete_own on public.activities
  for delete to authenticated using (user_id = auth.uid());

create policy shortcuts_select_own on public.shortcuts
  for select to authenticated using (user_id = auth.uid());
create policy shortcuts_insert_own on public.shortcuts
  for insert to authenticated with check (user_id = auth.uid());
create policy shortcuts_update_own on public.shortcuts
  for update to authenticated using (user_id = auth.uid())
  with check (user_id = auth.uid());
create policy shortcuts_delete_own on public.shortcuts
  for delete to authenticated using (user_id = auth.uid());

-- 自动暂停状态只能通过 RPC 更新，避免浏览器伪造无限在线时间。
create policy session_state_select_own on public.session_state
  for select to authenticated using (user_id = auth.uid());

revoke all on public.activities from anon, authenticated;
revoke all on public.shortcuts from anon, authenticated;
revoke all on public.session_state from anon, authenticated;
grant select, delete on public.activities to authenticated;
grant select, insert, update, delete on public.shortcuts to authenticated;
grant select on public.session_state to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.session_state (user_id) values (new.id)
  on conflict (user_id) do nothing;

  insert into public.shortcuts (user_id, name, sort_order, is_default) values
    (new.id, '学习', 1, true),
    (new.id, '休息', 2, true),
    (new.id, '工作', 3, true)
  on conflict (user_id, name) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 同一用户所有未结束记录（含睡觉）最多一条；数据库层阻断两设备并发重复。
create unique index one_open_record_per_user
  on public.activities (user_id)
  where ended_at is null;

create or replace function public.switch_activity(
  p_name text,
  p_source text default 'manual',
  p_client_event_id uuid default null
)
returns setof public.activities
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_name text := btrim(p_name);
  v_now timestamptz;
  v_current public.activities;
  v_has_current boolean;
  v_created public.activities;
begin
  if v_user_id is null then
    raise exception '未登录';
  end if;
  if v_name = '' or length(v_name) > 80 then
    raise exception '活动名称必须为 1 到 80 个字符';
  end if;
  if p_source not in ('manual', 'shortcut') then
    raise exception '活动来源无效';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));
  insert into public.session_state (user_id) values (v_user_id)
  on conflict (user_id) do nothing;

  select * into v_current
  from public.activities
  where user_id = v_user_id and ended_at is null
  limit 1;
  v_has_current := found;

  -- 同名活动已开启时直接确认现状，避免双击或双设备重复创建。
  if v_has_current and v_current.name = v_name then
    update public.session_state
    set last_interaction_at = clock_timestamp(), updated_at = clock_timestamp()
    where user_id = v_user_id;
    return query select * from public.activities where id = v_current.id;
    return;
  end if;

  v_now := clock_timestamp();
  if v_has_current then
    update public.activities
    set ended_at = v_now
    where id = v_current.id and ended_at is null;
    if not found then
      raise exception '活动状态已变化，请刷新后重试';
    end if;
  end if;

  insert into public.activities (user_id, name, started_at, source, metadata)
  values (
    v_user_id,
    v_name,
    v_now,
    p_source,
    jsonb_build_object('client_event_id', p_client_event_id)
  )
  returning * into v_created;

  update public.session_state
  set last_interaction_at = v_now, updated_at = v_now
  where user_id = v_user_id;

  return query select * from public.activities where id = v_created.id;
end;
$$;

create or replace function public.touch_interaction()
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_now timestamptz;
begin
  if v_user_id is null then
    raise exception '未登录';
  end if;

  v_now := clock_timestamp();
  insert into public.session_state (user_id, last_interaction_at, updated_at)
  values (v_user_id, v_now, v_now)
  on conflict (user_id) do update
    set last_interaction_at = excluded.last_interaction_at,
        updated_at = excluded.updated_at;

  return v_now;
end;
$$;

create or replace function public.pause_inactive_activities()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row record;
  v_count integer := 0;
  v_ended_at timestamptz;
begin
  for v_row in
    select a.id, a.user_id, a.started_at, s.last_interaction_at
    from public.activities a
    join public.session_state s on s.user_id = a.user_id
    where a.ended_at is null
      and a.source <> 'auto_sleep'
      and s.last_interaction_at + interval '120 minutes' <= clock_timestamp()
    order by a.user_id
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_row.user_id::text, 0));
    v_ended_at := v_row.last_interaction_at + interval '120 minutes';

    update public.activities
    set ended_at = v_ended_at
    where id = v_row.id
      and ended_at is null
      and started_at < v_ended_at;

    if found then
      insert into public.activities (
        user_id, name, started_at, ended_at, source, metadata
      ) values (
        v_row.user_id,
        '自动暂停',
        v_ended_at,
        v_ended_at,
        'auto_pause',
        jsonb_build_object('previous_activity_id', v_row.id, 'reason', 'inactivity_120_minutes')
      );
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

create or replace function public.start_scheduled_sleep(p_boundary timestamptz default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
  v_current public.activities;
  v_boundary timestamptz;
  v_created public.activities;
  v_count integer := 0;
begin
  for v_user_id in
    select distinct user_id
    from public.activities
    where ended_at is null
    order by 1
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));
    v_boundary := coalesce(
      p_boundary,
      ((now() at time zone 'Asia/Shanghai')::date + time '23:00')
        at time zone 'Asia/Shanghai'
    );

    select * into v_current
    from public.activities
    where user_id = v_user_id and ended_at is null;

    continue when not found or v_current.source = 'auto_sleep';

    update public.activities
    set ended_at = v_boundary
    where id = v_current.id and ended_at is null and started_at < v_boundary;

    if found then
      insert into public.activities (
        user_id, name, started_at, source, metadata
      ) values (
        v_user_id,
        '睡觉',
        v_boundary,
        'auto_sleep',
        jsonb_build_object('previous_activity_id', v_current.id, 'rule', 'shanghai_23_00')
      )
      returning * into v_created;
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

create or replace function public.end_scheduled_sleep(p_boundary timestamptz default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
  v_boundary timestamptz;
  v_count integer := 0;
begin
  for v_user_id in
    select distinct user_id
    from public.activities
    where ended_at is null and source = 'auto_sleep'
    order by 1
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));
    v_boundary := coalesce(
      p_boundary,
      ((now() at time zone 'Asia/Shanghai')::date + time '07:00')
        at time zone 'Asia/Shanghai'
    );

    update public.activities
    set ended_at = v_boundary
    where user_id = v_user_id
      and source = 'auto_sleep'
      and ended_at is null
      and started_at < v_boundary;

    v_count := v_count + found::integer;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.switch_activity(text, text, uuid) from public, anon, authenticated;
grant execute on function public.switch_activity(text, text, uuid) to authenticated;

revoke all on function public.touch_interaction() from public, anon, authenticated;
grant execute on function public.touch_interaction() to authenticated;

revoke all on function public.pause_inactive_activities() from public, anon, authenticated;
revoke all on function public.start_scheduled_sleep(timestamptz) from public, anon, authenticated;
revoke all on function public.end_scheduled_sleep(timestamptz) from public, anon, authenticated;
grant execute on function public.pause_inactive_activities() to service_role;
grant execute on function public.start_scheduled_sleep(timestamptz) to service_role;
grant execute on function public.end_scheduled_sleep(timestamptz) to service_role;

select cron.unschedule(jobid) from cron.job where jobname in (
  'pause-inactive-activities', 'start-scheduled-sleep', 'end-scheduled-sleep'
);
select cron.schedule(
  'pause-inactive-activities',
  '*/10 * * * *',
  $cron$ select public.pause_inactive_activities(); $cron$
);
-- Supabase PostgreSQL Cron 使用 UTC；15:00 UTC 是北京 23:00，23:00 UTC 是北京 07:00。
select cron.schedule(
  'start-scheduled-sleep',
  '0 15 * * *',
  $cron$ select public.start_scheduled_sleep(); $cron$
);
select cron.schedule(
  'end-scheduled-sleep',
  '0 23 * * *',
  $cron$ select public.end_scheduled_sleep(); $cron$
);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'activities'
    ) then
      alter publication supabase_realtime add table public.activities;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'shortcuts'
    ) then
      alter publication supabase_realtime add table public.shortcuts;
    end if;
  end if;
end;
$$;
