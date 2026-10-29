-- 每天 05:00 自动开启新周期；导出状态保存在周期上，历史记录永久保留。
alter table public.record_cycles
  add column if not exists exported_at timestamptz;
alter table public.record_cycles
  add column if not exists export_file_name text;

comment on column public.record_cycles.exported_at is '该周期 Markdown 首次导出成功的时间；空值表示尚未导出';
comment on column public.record_cycles.export_file_name is '该周期最近一次导出的文件名';

-- 当前登录用户：只允许在最新统计日边界后切一次周期。
create or replace function public.ensure_daily_record_cycle()
returns public.record_cycles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_now timestamptz := clock_timestamp();
  v_stat_day date;
  v_boundary timestamptz;
  v_current public.record_cycles;
  v_created public.record_cycles;
begin
  if v_user_id is null then
    raise exception '未登录';
  end if;

  v_stat_day := (v_now at time zone 'Asia/Shanghai')::date;
  if (v_now at time zone 'Asia/Shanghai')::time < time '05:00' then
    v_stat_day := v_stat_day - 1;
  end if;
  v_boundary := (v_stat_day + time '05:00') at time zone 'Asia/Shanghai';

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));

  select * into v_current
  from public.record_cycles
  where user_id = v_user_id and ended_at is null
  order by started_at desc
  limit 1;

  if not found then
    insert into public.record_cycles (user_id, started_at)
    values (v_user_id, v_boundary)
    returning * into v_created;
    return v_created;
  end if;

  if v_current.started_at >= v_boundary then
    return v_current;
  end if;

  -- 自动重置和手动重置语义一致：结束跨界活动，但不删除任何记录。
  update public.activities
  set ended_at = v_boundary
  where user_id = v_user_id
    and ended_at is null
    and started_at < v_boundary;

  update public.record_cycles
  set ended_at = v_boundary
  where id = v_current.id
    and ended_at is null;

  insert into public.record_cycles (user_id, started_at)
  values (v_user_id, v_boundary)
  returning * into v_created;

  update public.session_state
  set updated_at = v_boundary
  where user_id = v_user_id;

  return v_created;
end;
$$;

-- Cron 逐个处理所有用户，避免依赖某个浏览器在线。
create or replace function public.ensure_all_daily_record_cycles()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_stat_day date;
  v_boundary timestamptz;
  v_user_id uuid;
  v_current public.record_cycles;
  v_count integer := 0;
begin
  v_stat_day := (v_now at time zone 'Asia/Shanghai')::date;
  if (v_now at time zone 'Asia/Shanghai')::time < time '05:00' then
    v_stat_day := v_stat_day - 1;
  end if;
  v_boundary := (v_stat_day + time '05:00') at time zone 'Asia/Shanghai';

  for v_user_id in
    select user_id
    from public.record_cycles
    where ended_at is null
      and started_at < v_boundary
    order by user_id
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));

    select * into v_current
    from public.record_cycles
    where user_id = v_user_id and ended_at is null
      and started_at < v_boundary
    limit 1;
    continue when not found;

    update public.activities
    set ended_at = v_boundary
    where user_id = v_user_id
      and ended_at is null
      and started_at < v_boundary;

    update public.record_cycles
    set ended_at = v_boundary
    where id = v_current.id
      and ended_at is null;

    insert into public.record_cycles (user_id, started_at)
    values (v_user_id, v_boundary);

    update public.session_state
    set updated_at = v_boundary
    where user_id = v_user_id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- 手动重置可携带导出文件名；只有导出成功后浏览器才会调用它。
create or replace function public.reset_record_cycle(p_export_file_name text default null)
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

  update public.activities
  set ended_at = v_boundary
  where user_id = v_user_id
    and ended_at is null
    and started_at < v_boundary;

  update public.record_cycles
  set ended_at = v_boundary,
      exported_at = case
        when p_export_file_name is not null then coalesce(exported_at, v_boundary)
        else exported_at
      end,
      export_file_name = case
        when p_export_file_name is not null then p_export_file_name
        else export_file_name
      end
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

-- 数据库面板补导出旧周期后，把该周期标记为已导出。
create or replace function public.mark_cycle_exported(
  p_cycle_id uuid,
  p_export_file_name text
)
returns public.record_cycles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_updated public.record_cycles;
begin
  if v_user_id is null then
    raise exception '未登录';
  end if;
  if btrim(p_export_file_name) = '' then
    raise exception '导出文件名不能为空';
  end if;

  update public.record_cycles
  set exported_at = coalesce(exported_at, clock_timestamp()),
      export_file_name = btrim(p_export_file_name)
  where id = p_cycle_id
    and user_id = v_user_id
  returning * into v_updated;

  if not found then
    raise exception '记录周期不存在';
  end if;

  return v_updated;
end;
$$;

-- 删除旧的零参版本，让 p_export_file_name 的默认值成为唯一无参调用入口。
drop function if exists public.reset_record_cycle();

revoke all on function public.ensure_daily_record_cycle() from public, anon, authenticated;
grant execute on function public.ensure_daily_record_cycle() to authenticated;

revoke all on function public.ensure_all_daily_record_cycles() from public, anon, authenticated, service_role;
grant execute on function public.ensure_all_daily_record_cycles() to service_role;

revoke all on function public.reset_record_cycle(text) from public, anon, authenticated;
grant execute on function public.reset_record_cycle(text) to authenticated;

revoke all on function public.mark_cycle_exported(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_cycle_exported(uuid, text) to authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'daily-record-cycle-reset';
select cron.schedule(
  'daily-record-cycle-reset',
  '0 21 * * *',
  $cron$ select public.ensure_all_daily_record_cycles(); $cron$
);
