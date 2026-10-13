-- Daily staff access hours; does not change stored records or enable a schedule.
begin;
set local lock_timeout='5s';
do $$declare r record; actual text; begin
 for r in select * from (values ('freshy_actor','21be04ed42cf4ecf7b722896e7a1adc0','6ad1b5a8b1e75ca28444647a8eaa00c7'),('freshy_read','73ea7d3b139552b9bf2ae008128aef55','a7306009b4a30ea7f6f3e12f22ce797f'),('freshy_apply','7d9e03cf34c3a987a81ddf2d8ac8705e','7d9e03cf34c3a987a81ddf2d8ac8705e'),('freshy_payment','eac3d350f9e35ac7df1bb9c19a14d374','eac3d350f9e35ac7df1bb9c19a14d374')) as expected(name,previous,current) loop
  select md5(prosrc) into actual from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=r.name limit 1;
  if actual is null or actual not in (r.previous,r.current) then raise exception 'UNEXPECTED_FUNCTION_VERSION:%',r.name; end if;
 end loop;
end $$;
lock table public.freshy_store in share mode;
create temp table freshy_hours_before on commit drop as select md5(string_agg(key||value::text,'|' order by key)) as fingerprint from public.freshy_store;
create or replace function public.freshy_member() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare actor jsonb; email_address text;
begin
 if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 select email into email_address from auth.users where id=auth.uid() and email_confirmed_at is not null;
 select x into actor from public.freshy_store s, jsonb_array_elements(s.value) x
 where s.key='employees' and lower(x->>'email')=lower(email_address)
 and coalesce(x->>'status','active') not in ('pending','inactive','disabled') limit 1;
 if actor is null then raise exception 'MEMBER_NOT_FOUND' using errcode='42501'; end if;
 return actor;
end $$;

create or replace function public.freshy_validate_access_hours(policy jsonb) returns void
language plpgsql immutable set search_path=pg_catalog,public as $$
begin
 if policy is null then return; end if;
 if jsonb_typeof(policy)<>'object' or (policy-array['enabled','start','end','timeZone'])<>'{}'::jsonb or jsonb_typeof(policy->'enabled') is distinct from 'boolean'
  or coalesce(policy->>'start','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  or coalesce(policy->>'end','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  or policy->>'start'=policy->>'end' or policy->>'timeZone' is distinct from 'Asia/Bangkok'
 then raise exception 'INVALID_ACCESS_HOURS' using errcode='22023'; end if;
end $$;

create or replace function public.freshy_access_allowed(policy jsonb,at_time timestamptz default statement_timestamp()) returns boolean
language plpgsql stable set search_path=pg_catalog,public as $$
declare current_minute text:=to_char(at_time at time zone 'Asia/Bangkok','HH24:MI'); first_time text; last_time text;
begin
 perform public.freshy_validate_access_hours(policy);
 if policy is null or policy->>'enabled'='false' then return true; end if;
 first_time:=policy->>'start';last_time:=policy->>'end';
 if first_time<last_time then return current_minute>=first_time and current_minute<last_time; end if;
 return current_minute>=first_time or current_minute<last_time;
end $$;

create or replace function public.freshy_actor() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare actor jsonb:=public.freshy_member(); policy jsonb;
begin
 if coalesce(actor->>'role','staff')<>'admin' then
  select value->'accessHours' into policy from public.freshy_store where key='settings';
  if not public.freshy_access_allowed(policy) then
   raise exception 'ACCESS_HOURS_CLOSED' using errcode='PT403',detail=jsonb_build_object('accessHours',policy,'serverTime',statement_timestamp())::text;
  end if;
 end if;
 return actor;
end $$;

create or replace function public.freshy_access_status() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare actor jsonb:=public.freshy_member(); policy jsonb;
begin
 select value->'accessHours' into policy from public.freshy_store where key='settings';
 return jsonb_build_object('version',1,'allowed',actor->>'role'='admin' or public.freshy_access_allowed(policy),'accessHours',policy,'serverTime',statement_timestamp());
end $$;

create or replace function public.freshy_access_hours_guard() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if new.key='settings' then perform public.freshy_validate_access_hours(new.value->'accessHours'); end if;
 return new;
end $$;
drop trigger if exists freshy_access_hours_guard on public.freshy_store;
create trigger freshy_access_hours_guard before insert or update of value on public.freshy_store for each row execute function public.freshy_access_hours_guard();
revoke all on function public.freshy_member() from public,anon,authenticated;
revoke all on function public.freshy_validate_access_hours(jsonb) from public,anon,authenticated;
revoke all on function public.freshy_access_allowed(jsonb,timestamptz) from public,anon,authenticated;
revoke all on function public.freshy_access_hours_guard() from public,anon,authenticated;
revoke all on function public.freshy_access_status() from public,anon;
grant execute on function public.freshy_access_status() to authenticated;

create or replace function public.freshy_read() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare actor jsonb:=public.freshy_actor(); result jsonb:='{}'; r record; v jsonb; aid text:=actor->>'id'; recorders jsonb;
begin
 for r in select key,value from public.freshy_store where key in ('settings','employees','products','villages','customers','debtors','cashsales','audit','approvals','sentEmails') loop
  if actor->>'role'='admin' then v:=r.value;
  elsif r.key='settings' then
   v:=r.value-'db';
   v:=jsonb_set(v,'{email}',coalesce(v->'email','{}')-'apiKey'-'smtpPass'-'serviceKey');
  elsif r.key='employees' then v:=jsonb_build_array(actor);
  elsif r.key in ('products','villages','customers','debtors','cashsales') then v:=r.value;
  elsif r.key='approvals' then
   select coalesce(jsonb_agg(x),'[]') into v from jsonb_array_elements(r.value) x where x->>'type'='payment' or x->>'employeeId'=aid;
  else
   select coalesce(jsonb_agg(x),'[]') into v from jsonb_array_elements(r.value) x where public.freshy_owns(x,aid);
  end if;
  result:=result||jsonb_build_object(r.key,v);
 end loop;
 select coalesce(jsonb_agg(jsonb_build_object('id',x->>'id','name',x->>'name')),'[]') into recorders from public.freshy_store s,jsonb_array_elements(s.value) x where s.key='employees';
 return jsonb_build_object('actor',actor,'data',result,'recorders',recorders,'serverTime',statement_timestamp());
end $$;

do $$begin
 if (select fingerprint from freshy_hours_before) is distinct from (select md5(string_agg(key||value::text,'|' order by key)) from public.freshy_store) then raise exception 'DATA_FINGERPRINT_CHANGED'; end if;
end $$;
notify pgrst,'reload schema';
commit;
select 'ACCESS_HOURS_INSTALLED_DATA_UNCHANGED' as result;
