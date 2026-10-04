-- Freshy Water v2: authenticated RPC access, row-scoped reads, conflict-safe writes.
-- Change this email to a confirmed user created in Supabase Authentication > Users.
begin;
create table if not exists public.freshy_store (
 key text primary key, value jsonb not null default '[]'::jsonb,
 updated_at timestamptz not null default now()
);
create table if not exists public.freshy_signal (
 id boolean primary key default true check (id),
 version bigint not null default 0,
 updated_at timestamptz not null default now()
);
insert into public.freshy_signal(id) values(true) on conflict do nothing;
alter table public.freshy_signal enable row level security;
drop policy if exists freshy_signal_authenticated_read on public.freshy_signal;
create policy freshy_signal_authenticated_read on public.freshy_signal for select to authenticated using (true);
revoke all on public.freshy_signal from public,anon;
grant select on public.freshy_signal to authenticated;
create or replace function public.freshy_emit_signal() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 insert into public.freshy_signal(id,version,updated_at) values(true,1,now())
 on conflict(id) do update set version=public.freshy_signal.version+1,updated_at=now();
 return new;
end $$;
drop trigger if exists freshy_store_emit_signal on public.freshy_store;
-- Cross-device refresh now uses lightweight Realtime Broadcast from the app.
-- Do not publish database rows: WAL decoding can saturate Nano compute.
do $$ begin
 if exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='freshy_signal') then
  alter publication supabase_realtime drop table public.freshy_signal;
 end if;
end $$;
-- Bound the append-only audit JSON so reads and writes stay fast on Nano plans.
create or replace function public.freshy_cap_audit() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
 if new.key='audit' and jsonb_typeof(new.value)='array' and jsonb_array_length(new.value)>2000 then
  select coalesce(jsonb_agg(x order by ord),'[]'::jsonb) into new.value
  from jsonb_array_elements(new.value) with ordinality as a(x,ord)
  where ord>jsonb_array_length(new.value)-1000;
 end if;
 return new;
end $$;
drop trigger if exists freshy_cap_audit_trigger on public.freshy_store;
create trigger freshy_cap_audit_trigger before insert or update on public.freshy_store
for each row execute function public.freshy_cap_audit();
alter table public.freshy_store enable row level security;
do $$ declare p record; begin
 for p in select policyname from pg_policies where schemaname='public' and tablename='freshy_store' loop
  execute format('drop policy %I on public.freshy_store',p.policyname);
 end loop;
end $$;
revoke all on public.freshy_store from public, anon, authenticated;
insert into public.freshy_store(key,value) values('employees','[]') on conflict do nothing;
-- Bootstrap an actual account. This does not copy demonstration customers or debts.
do $$
declare admin_email text := 'phatthanapon26@gmail.com'; existing jsonb; person jsonb;
begin
 if admin_email = 'CHANGE_ADMIN_EMAIL@example.com' then
  raise exception 'Replace CHANGE_ADMIN_EMAIL@example.com with the confirmed admin login email first';
 end if;
 if not exists(select 1 from auth.users where lower(email)=lower(admin_email) and email_confirmed_at is not null) then
  raise exception 'Create and confirm the admin account in Authentication > Users first';
 end if;
 select value into existing from public.freshy_store where key='employees' for update;
 select x into person from jsonb_array_elements(existing) x where lower(x->>'email')=lower(admin_email) limit 1;
 if person is null then
  person := jsonb_build_object('id','emp_'||gen_random_uuid()::text,'email',lower(admin_email),'name','ผู้ดูแลระบบ','code','7716','role','admin','permissions',jsonb_build_object('pages','{}'::jsonb,'canPrint',true,'canEmail',true));
  existing := existing || jsonb_build_array(person);
 else
  existing := (select jsonb_agg(case when x->>'id'=person->>'id' then x||'{"role":"admin","code":"7716"}'::jsonb else x end) from jsonb_array_elements(existing) x);
 end if;
 update public.freshy_store set value=existing where key='employees';
end $$;

do $$ declare r record; begin
 for r in select key,value from public.freshy_store where key<>'settings' and jsonb_typeof(value)='array' loop
  update public.freshy_store set value=(select coalesce(jsonb_agg(case when x->>'id' is null then x||jsonb_build_object('id',gen_random_uuid()::text) else x end),'[]') from jsonb_array_elements(r.value) x) where key=r.key;
 end loop;
end $$;

insert into public.freshy_store(key,value) values('settings','{"business": {"name": "โรงน้ำดื่ม เฟรชชี่ วอเตอร์", "address": "", "taxId": "", "commercialId": "", "phone": "", "email": "", "menuName": "ระบบจัดการลูกหนี้"}, "header": {"showLogo": true, "showName": true, "logoDataUrl": ""}, "email": {"enabled": false, "adminEmail": "", "provider": "resend", "fromEmail": "", "apiKey": "", "smtpHost": "", "smtpPort": "587", "smtpUser": "", "smtpPass": "", "alerts": {"login": true, "logout": true, "addDebtor": true, "undoRequest": true}}, "docPrefix": {"debtor": "FWD", "cash": "CSH", "customer": "CUS"}, "doccounters": {}}'::jsonb) on conflict do nothing;

create or replace function public.freshy_actor() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare actor jsonb; email_address text;
begin
 if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
 select email into email_address from auth.users where id=auth.uid() and email_confirmed_at is not null;
 select x into actor from public.freshy_store s, jsonb_array_elements(s.value) x
 where s.key='employees' and lower(x->>'email')=lower(email_address)
 and coalesce(x->>'status','active') not in ('inactive','disabled') limit 1;
 if actor is null then raise exception 'MEMBER_NOT_FOUND' using errcode='42501'; end if;
 return actor;
end $$;

create or replace function public.freshy_owns(v jsonb, actor_id text) returns boolean
language sql immutable set search_path=pg_catalog as $$
 select coalesce(v->>'createdBy'=actor_id,false) or coalesce(v->>'responsibleBy'=actor_id,false)
 or coalesce(v->>'paidBy'=actor_id,false) or coalesce(v->>'userId'=actor_id,false)
 or coalesce(v->>'employeeId'=actor_id,false)
$$;

create or replace function public.freshy_visible(k text,v jsonb,a jsonb) returns boolean
language sql immutable set search_path=pg_catalog as $$
 select case when k in ('customers','debtors','cashsales','audit') then coalesce((a#>>array['permissions','pages',
 case when k='customers' then case when v->>'area'='nai' then 'customersNai' else 'customersOther' end
 when k='debtors' then case when v->>'status'='paid' then case when v->>'area'='nai' then 'paymentsNai' else 'paymentsOther' end else case when v->>'area'='nai' then 'debtorsNai' else 'debtorsOther' end end
 else k end])::boolean,false) else true end
$$;

create or replace function public.freshy_read() returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare actor jsonb:=public.freshy_actor(); result jsonb:='{}'; r record; v jsonb; aid text:=actor->>'id';
begin
 for r in select key,value from public.freshy_store where key in ('settings','employees','products','villages','customers','debtors','cashsales','audit','approvals','sentEmails') loop
  if actor->>'role'='admin' then v:=r.value;
  elsif r.key='settings' then
   v := r.value - 'db';
   v := jsonb_set(v,'{email}',coalesce(v->'email','{}') - 'apiKey' - 'smtpPass' - 'serviceKey');
  elsif r.key='employees' then v:=jsonb_build_array(actor);
  elsif r.key in ('products','villages') then v:=r.value;
  else
   select coalesce(jsonb_agg(x),'[]') into v from jsonb_array_elements(r.value) x where public.freshy_owns(x,aid) and public.freshy_visible(r.key,x,actor);
  end if;
  result:=result || jsonb_build_object(r.key,v);
 end loop;
 return jsonb_build_object('actor',actor,'data',result);
end $$;

create or replace function public.freshy_apply(changes jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare actor jsonb; aid text; admin boolean;
 c jsonb; k text; rid text; vals jsonb; old jsonb; proposed jsonb; expected jsonb; inserted boolean;
 pages jsonb; page_name text; field_name text; count_admin integer;
begin
 if jsonb_typeof(changes)<>'array' or jsonb_array_length(changes)>2500 then raise exception 'INVALID_BATCH'; end if;
 -- Serialize batches for cross-collection transactions; compare expected rows to prevent stale updates.
 perform pg_advisory_xact_lock(7248219);
 actor:=public.freshy_actor();aid:=actor->>'id';admin:=actor->>'role'='admin';pages:=coalesce(actor#>'{permissions,pages}','{}');
 for c in select * from jsonb_array_elements(changes) loop
  k:=c->>'collection'; rid:=c->>'id'; proposed:=c->'value'; expected:=c->'expected';
  if k not in ('settings','employees','products','villages','customers','debtors','cashsales','audit','approvals','sentEmails') then raise exception 'INVALID_COLLECTION'; end if;
  insert into public.freshy_store(key,value) values(k,case when k='settings' then '{}'::jsonb else '[]'::jsonb end) on conflict do nothing;
  select value into vals from public.freshy_store where key=k for update;
  if k='settings' then old:=vals;
  else
   if rid is null or length(rid)>160 then raise exception 'INVALID_ID'; end if;
   select x into old from jsonb_array_elements(vals) x where x->>'id'=rid limit 1;
  end if;
  inserted := old is null;
  if coalesce(old,'null'::jsonb) is distinct from coalesce(expected,'null'::jsonb) then
   raise exception 'CONFLICT:%:%',k,coalesce(rid,'settings') using errcode='PT409';
  end if;
  if proposed='null'::jsonb then proposed:=null; end if;
  if proposed is not null and jsonb_typeof(proposed)<>'object' then raise exception 'INVALID_VALUE'; end if;
  if k<>'settings' and proposed is not null and proposed->>'id' is distinct from rid then raise exception 'ID_IMMUTABLE'; end if;
  if not admin then
   if proposed is null then raise exception 'ADMIN_ONLY_DELETE' using errcode='42501'; end if;
   if k in ('settings','products','villages') then raise exception 'ADMIN_ONLY' using errcode='42501'; end if;
   if k='employees' then
    if rid<>aid or (proposed - 'name' - 'avatarUrl' - 'code') is distinct from (old - 'name' - 'avatarUrl' - 'code') then raise exception 'PROFILE_ONLY' using errcode='42501'; end if;
   elsif k='audit' then
    if not inserted or proposed->>'userId' is distinct from aid then raise exception 'AUDIT_APPEND_ONLY'; end if;
   elsif k='sentEmails' then
    if proposed->>'createdBy' is distinct from aid or (not inserted and not public.freshy_owns(old,aid)) then raise exception 'MAIL_LOG_OWNER'; end if;
   elsif k='approvals' then
    if not inserted or proposed->>'employeeId' is distinct from aid or proposed->>'status' is distinct from 'pending' then raise exception 'APPROVAL_REQUEST_ONLY'; end if;
   else
    page_name := case k when 'cashsales' then 'cashsales'
     when 'customers' then case when proposed->>'area'='nai' then 'customersNai' else 'customersOther' end
     else case when proposed->>'area'='nai' then 'debtorsNai' else 'debtorsOther' end end;
    if not coalesce((pages->>page_name)::boolean,false) then raise exception 'PAGE_FORBIDDEN' using errcode='42501'; end if;
    if inserted then
     if proposed->>'createdBy' is distinct from aid then raise exception 'OWNER_REQUIRED'; end if;
     if k='debtors' and proposed->>'status' is distinct from 'unpaid' then raise exception 'NEW_DEBT_UNPAID'; end if;
     if k='cashsales' and proposed->>'responsibleBy' is distinct from aid then raise exception 'OWNER_REQUIRED'; end if;
    else
     if not public.freshy_owns(old,aid) then raise exception 'ROW_FORBIDDEN' using errcode='42501'; end if;
     if proposed->>'createdBy' is distinct from old->>'createdBy' or proposed->>'createdAt' is distinct from old->>'createdAt'
      or proposed->>'responsibleBy' is distinct from old->>'responsibleBy' then raise exception 'OWNER_IMMUTABLE'; end if;
     if k='cashsales' and (now()-(old->>'createdAt')::timestamptz)>interval '2 minutes' then raise exception 'EDIT_WINDOW_CLOSED'; end if;
     if k='debtors' and old->>'status'='paid' and proposed is distinct from old then raise exception 'ADMIN_ONLY_UNDO'; end if;
     if k='debtors' and proposed->>'paidBy' is not null and proposed->>'paidBy' is distinct from aid then raise exception 'PAYMENT_ACTOR_REQUIRED'; end if;
     if k='debtors' and proposed->>'status'='paid' and old->>'status'<>'paid' then proposed:=proposed||jsonb_build_object('paidBy',aid,'paidByName',actor->>'name','paidAt',now()); end if;
    end if;
   end if;
  end if;
  if k='debtors' and proposed is not null and coalesce(proposed->>'status','') not in ('paid','unpaid') then raise exception 'INVALID_DEBT_STATUS'; end if;
  if k in ('debtors','cashsales') and proposed is not null then
   foreach field_name in array array['jugs','packs','jugAmount','packAmount'] loop
    if jsonb_typeof(proposed->field_name) is distinct from 'number' or (proposed->>field_name)::numeric < 0 then raise exception 'INVALID_AMOUNT:%',field_name; end if;
   end loop;
   if (proposed->>'jugs')::numeric<>trunc((proposed->>'jugs')::numeric) or (proposed->>'packs')::numeric<>trunc((proposed->>'packs')::numeric) then raise exception 'INVALID_QUANTITY'; end if;
   if k='debtors' and (jsonb_typeof(proposed->'total') is distinct from 'number' or (proposed->>'total')::numeric<>(proposed->>'jugAmount')::numeric+(proposed->>'packAmount')::numeric) then raise exception 'INVALID_TOTAL'; end if;
   if inserted and not admin then proposed:=jsonb_set(proposed,'{createdAt}',to_jsonb(now())); end if;
  end if;
  if k='employees' and proposed is not null then
   if coalesce(proposed->>'role','') not in ('admin','staff') or coalesce(proposed->>'email','')='' then raise exception 'EMPLOYEE_EMAIL_ROLE_REQUIRED'; end if;
   if not exists(select 1 from auth.users where lower(email)=lower(proposed->>'email') and email_confirmed_at is not null) then raise exception 'CONFIRMED_AUTH_ACCOUNT_REQUIRED'; end if;
   if exists(select 1 from jsonb_array_elements(vals) x where x->>'id'<>rid and lower(x->>'email')=lower(proposed->>'email')) then raise exception 'DUPLICATE_EMAIL'; end if;
  end if;
  if k='audit' and old is not null then raise exception 'AUDIT_IMMUTABLE'; end if;
  if k='audit' and proposed is not null then proposed:=proposed||jsonb_build_object('userId',aid,'userName',actor->>'name','ts',now()); end if;
  if k='settings' then
   if proposed is null then raise exception 'SETTINGS_REQUIRED'; end if;
   vals:=proposed - 'db';
  else
   select coalesce(jsonb_agg(x),'[]') into vals from jsonb_array_elements(vals) x where x->>'id'<>rid;
   if proposed is not null then vals:=vals||jsonb_build_array(proposed); end if;
  end if;
  if k='employees' then
   select count(*) into count_admin from jsonb_array_elements(vals) x where x->>'role'='admin' and coalesce(x->>'status','active') not in ('inactive','disabled');
   if count_admin=0 then raise exception 'LAST_ADMIN_REQUIRED'; end if;
  end if;
  update public.freshy_store set value=vals,updated_at=now() where key=k;
  if k<>'audit' then
   insert into public.freshy_store(key,value) values('audit','[]') on conflict do nothing;
   update public.freshy_store set value=value||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'ts',now(),'userId',aid,'userName',actor->>'name','action','บันทึกออนไลน์','detail',k||':'||coalesce(rid,'settings'))),updated_at=now() where key='audit';
  end if;
 end loop;
 return public.freshy_read();
end $$;

create or replace function public.freshy_public_qr(customer_id text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare customer jsonb; debts jsonb; business jsonb; recorder jsonb;
begin
 if customer_id is null or length(customer_id)>160 then return null; end if;
 select x into customer from public.freshy_store s, jsonb_array_elements(s.value) x
 where s.key='customers' and x->>'id'=customer_id limit 1;
 if customer is null then return null; end if;
 select coalesce(jsonb_agg(x order by x->>'debtDate'),'[]'::jsonb) into debts
 from public.freshy_store s, jsonb_array_elements(s.value) x
 where s.key='debtors' and x->>'customerId'=customer_id and x->>'status'='unpaid';
 select coalesce(value->'business','{}'::jsonb) into business from public.freshy_store where key='settings';
 select jsonb_build_object('name',coalesce(e->>'name','-'),'role',coalesce(e->>'role','staff')) into recorder
 from public.freshy_store s, jsonb_array_elements(s.value) e
 where s.key='employees' and e->>'id'=coalesce(debts->0->>'createdBy','') limit 1;
 return jsonb_build_object('customer',customer-'createdBy'-'managedBy'-'responsibleBy','debtors',debts,
  'business',business-'email','recorder',coalesce(recorder,'{"name":"-","role":"staff"}'::jsonb));
end $$;

revoke all on function public.freshy_actor() from public,anon,authenticated;
revoke all on function public.freshy_visible(text,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.freshy_owns(jsonb,text) from public,anon,authenticated;
revoke all on function public.freshy_read() from public,anon;
revoke all on function public.freshy_apply(jsonb) from public,anon;
revoke all on function public.freshy_public_qr(text) from public;
grant execute on function public.freshy_read() to authenticated;
grant execute on function public.freshy_apply(jsonb) to authenticated;
grant execute on function public.freshy_public_qr(text) to anon,authenticated;
commit;
