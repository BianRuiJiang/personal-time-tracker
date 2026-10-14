-- 用户要求支持修改记录；RLS 仍然限制只能改自己的记录。
create policy activities_update_own on public.activities
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant update on public.activities to authenticated;
