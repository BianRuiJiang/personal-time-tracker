-- 每次重置都会新开一个周期；活动记录永久保留，界面只展示当前周期。
create table if not exists public.record_cycles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default clock_timestamp(),
  ended_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint record_cycle_valid check (ended_at is null or ended_at >= started_at)
);

create unique index if not exists one_open_cycle_per_user
  on public.record_cycles (user_id)
  where ended_at is null;
create index if not exists record_cycles_user_started_idx
  on public.record_cycles (user_id, started_at desc);

alter table public.record_cycles enable row level security;

drop policy if exists record_cycles_select_own on public.record_cycles;
create policy record_cycles_select_own on public.record_cycles
  for select to authenticated using (user_id = auth.uid());

revoke all on public.record_cycles from anon, authenticated;
grant select on public.record_cycles to authenticated;

-- 现有用户在升级时补一个周期，起始时间取最早记录，避免旧数据被排除。
insert into public.record_cycles (user_id, started_at)
select users.id,
       coalesce(
         (select min(activities.started_at)
          from public.activities
          where activities.user_id = users.id),
         clock_timestamp()
       )
from auth.users as users
where not exists (
  select 1
  from public.record_cycles
  where record_cycles.user_id = users.id and record_cycles.ended_at is null
);

create or replace function public.reset_record_cycle()
returns public.record_cycles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_boundary timestamptz;
  v_created public.record_cycles;
begin
  if v_user_id is null then
    raise exception '未登录';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));
  v_boundary := clock_timestamp();

  -- 当前进行中的活动在周期边界结束；旧记录不删除。
  update public.activities
  set ended_at = v_boundary
  where user_id = v_user_id
    and ended_at is null
    and started_at < v_boundary;

  update public.record_cycles
  set ended_at = v_boundary
  where user_id = v_user_id
    and ended_at is null
    and started_at < v_boundary;

  insert into public.record_cycles (user_id, started_at)
  values (v_user_id, v_boundary)
  returning * into v_created;

  insert into public.session_state (user_id, last_interaction_at, updated_at)
  values (v_user_id, v_boundary, v_boundary)
  on conflict (user_id) do update
    set last_interaction_at = excluded.last_interaction_at,
        updated_at = excluded.updated_at;

  return v_created;
end;
$$;

revoke all on function public.reset_record_cycle() from public, anon, authenticated;
grant execute on function public.reset_record_cycle() to authenticated;

-- 新用户首次注册时同时创建初始周期。
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.session_state (user_id) values (new.id)
  on conflict (user_id) do nothing;

  insert into public.record_cycles (user_id) values (new.id);

  insert into public.shortcuts (user_id, name, sort_order, is_default) values
    (new.id, '学习', 1, true),
    (new.id, '休息', 2, true),
    (new.id, '工作', 3, true)
  on conflict (user_id, name) do nothing;

  return new;
end;
$$;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'record_cycles'
    ) then
      alter publication supabase_realtime add table public.record_cycles;
    end if;
  end if;
end;
$$;
