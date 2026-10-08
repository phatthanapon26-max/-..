-- Read-only: staff can view admin-created customers/debts within enabled pages.
-- Own records remain visible. Other staff records and all write checks retain their existing scope.
begin;
create or replace function public.freshy_read() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare actor jsonb:=public.freshy_actor(); result jsonb:='{}'; r record; v jsonb; aid text:=actor->>'id'; admin_ids text[]; recorder_ids text[]; recorders jsonb;
begin
 select coalesce(array_agg(x->>'id'),array[]::text[]) into admin_ids from public.freshy_store s,jsonb_array_elements(s.value) x where s.key='employees' and x->>'role'='admin';
 for r in select key,value from public.freshy_store where key in ('settings','employees','products','villages','customers','debtors','cashsales','audit','approvals','sentEmails') loop
  if actor->>'role'='admin' then v:=r.value;
  elsif r.key='settings' then
   v := r.value - 'db';
   v := jsonb_set(v,'{email}',coalesce(v->'email','{}') - 'apiKey' - 'smtpPass' - 'serviceKey');
  elsif r.key='employees' then v:=jsonb_build_array(actor);
  elsif r.key in ('products','villages') then v:=r.value;
  else
   select coalesce(jsonb_agg(x),'[]') into v from jsonb_array_elements(r.value) x where (public.freshy_owns(x,aid) or (r.key in ('customers','debtors') and x->>'createdBy'=any(admin_ids))) and public.freshy_visible(r.key,x,actor);
  end if;
  result:=result || jsonb_build_object(r.key,v);
 end loop;
 select coalesce(array_agg(distinct id),array[]::text[]) into recorder_ids from (select x->>'createdBy' id from jsonb_array_elements(coalesce(result->'debtors','[]')) x union all select x->>'createdBy' from jsonb_array_elements(coalesce(result->'customers','[]')) x union all select x->>'managedBy' from jsonb_array_elements(coalesce(result->'customers','[]')) x union all select x->>'responsibleBy' from jsonb_array_elements(coalesce(result->'customers','[]')) x) names where id is not null;
 select coalesce(jsonb_agg(jsonb_build_object('id',x->>'id','name',x->>'name')),'[]') into recorders from public.freshy_store s,jsonb_array_elements(s.value) x where s.key='employees' and x->>'id'=any(recorder_ids);
 return jsonb_build_object('actor',actor,'data',result,'recorders',recorders);
end $$;

revoke all on function public.freshy_read() from public,anon;
grant execute on function public.freshy_read() to authenticated;
notify pgrst, 'reload schema';
commit;
