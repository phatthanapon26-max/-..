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

create or replace function public.freshy_owns(v jsonb, actor_id text) returns boolean
language sql immutable set search_path=pg_catalog as $$
 select coalesce(v->>'createdBy'=actor_id,false) or coalesce(v->>'responsibleBy'=actor_id,false)
 or coalesce(v->>'paidBy'=actor_id,false) or coalesce(v->>'userId'=actor_id,false)
 or coalesce(v->>'employeeId'=actor_id,false)
$$;

create or replace function public.freshy_visible(k text,v jsonb,a jsonb) returns boolean
language sql immutable set search_path=pg_catalog as $$
 select case when k='customers' then
  coalesce((a#>>array['permissions','pages',case when v->>'area'='nai' then 'customersNai' else 'customersOther' end])::boolean,false)
  or coalesce((a#>>array['permissions','pages',case when v->>'area'='nai' then 'debtorsNai' else 'debtorsOther' end])::boolean,false)
  or coalesce((a#>>array['permissions','pages',case when v->>'area'='nai' then 'paymentsNai' else 'paymentsOther' end])::boolean,false)
 when k in ('debtors','cashsales','audit') then coalesce((a#>>array['permissions','pages',
 case when k='debtors' then case when v->>'status'='paid' then case when v->>'area'='nai' then 'paymentsNai' else 'paymentsOther' end else case when v->>'area'='nai' then 'debtorsNai' else 'debtorsOther' end end
 else k end])::boolean,false) else true end
$$;

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
revoke all on function public.freshy_read() from public,anon;
grant execute on function public.freshy_read() to authenticated;

create or replace function public.freshy_customer_code() returns text
language plpgsql security definer set search_path=pg_catalog,public as $$
declare actor jsonb; serial bigint; existing bigint;
begin
 perform pg_advisory_xact_lock(7248219);
 actor:=public.freshy_actor();
 if actor->>'role'<>'admin' and not (coalesce((actor#>>'{permissions,pages,customersNai}')::boolean,false) or coalesce((actor#>>'{permissions,pages,customersOther}')::boolean,false) or coalesce((actor#>>'{permissions,pages,debtorsNai}')::boolean,false) or coalesce((actor#>>'{permissions,pages,debtorsOther}')::boolean,false)) then raise exception 'PAGE_FORBIDDEN' using errcode='42501'; end if;
 select coalesce(max(substring(x->>'code' from '^C([0-9]{1,12})$')::bigint),0) into existing from public.freshy_store s,jsonb_array_elements(s.value) x where s.key='customers';
 select coalesce((value->>'next')::bigint,0) into serial from public.freshy_store where key='customer_sequence';
 serial:=greatest(coalesce(serial,0),existing)+1;
 insert into public.freshy_store(key,value) values('customer_sequence',jsonb_build_object('next',serial)) on conflict(key) do update set value=excluded.value,updated_at=now();
 return 'C'||case when serial<1000 then lpad(serial::text,3,'0') else serial::text end;
end $$;
revoke all on function public.freshy_customer_code() from public,anon;
grant execute on function public.freshy_customer_code() to authenticated;

create or replace function public.freshy_apply(changes jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare actor jsonb; aid text; admin boolean;
 c jsonb; k text; rid text; vals jsonb; old jsonb; proposed jsonb; expected jsonb; inserted boolean;
 pages jsonb; page_name text; field_name text; count_admin integer; reset_revision text; requested_revision text; debtor jsonb;
begin
 if jsonb_typeof(changes)<>'array' or jsonb_array_length(changes)>2500 then raise exception 'INVALID_BATCH'; end if;
 -- Serialize batches for cross-collection transactions; compare expected rows to prevent stale updates.
 perform pg_advisory_xact_lock(7248219);
 actor:=public.freshy_actor();aid:=actor->>'id';admin:=actor->>'role'='admin';pages:=coalesce(actor#>'{permissions,pages}','{}');
 select coalesce(value->>'_resetRevision','') into reset_revision from public.freshy_store where key='settings';
 requested_revision:=coalesce(nullif(current_setting('request.headers',true),'')::jsonb->>'x-freshy-revision','');
 if coalesce(reset_revision,'')<>requested_revision then raise exception 'RESET_STALE' using errcode='PT409'; end if;
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
  -- A lost response can retry an already committed audit. Only the author can
  -- acknowledge identical immutable content; server timestamps are ignored.
  if k='audit' and old is not null and expected='null'::jsonb
   and old->>'userId'=aid and proposed->>'userId'=aid
   and (old-'ts'-'userName')=(proposed-'ts'-'userName') then continue; end if;
  if coalesce(old,'null'::jsonb) is distinct from coalesce(expected,'null'::jsonb) then
   raise exception 'CONFLICT:%:%',k,coalesce(rid,'settings') using errcode='PT409';
  end if;
  if proposed='null'::jsonb then proposed:=null; end if;
  if proposed is not null and jsonb_typeof(proposed)<>'object' then raise exception 'INVALID_VALUE'; end if;
  if k<>'settings' and proposed is not null and proposed->>'id' is distinct from rid then raise exception 'ID_IMMUTABLE'; end if;
  -- Payment transitions and receipt reviews must be atomic and server-authored.
  if k='debtors' and old is not null and proposed is not null and
   (proposed->>'status' is distinct from old->>'status' or
    (select jsonb_object_agg(f,proposed->f) from unnest(array['paidAt','paidBy','paidByName','paymentReviewStatus','paymentRequestId','paymentApprovedAt','paymentApprovedBy','paymentApprovedByName','paymentCancellationReason','paymentCancelledAt','paymentCancelledBy']) f)
    is distinct from
    (select jsonb_object_agg(f,old->f) from unnest(array['paidAt','paidBy','paidByName','paymentReviewStatus','paymentRequestId','paymentApprovedAt','paymentApprovedBy','paymentApprovedByName','paymentCancellationReason','paymentCancelledAt','paymentCancelledBy']) f))
  then raise exception 'PAYMENT_WORKFLOW_REQUIRED' using errcode='42501'; end if;
  if k='debtors' and old is null and not admin and proposed->>'paymentReviewStatus' is not null then raise exception 'PAYMENT_WORKFLOW_REQUIRED' using errcode='42501'; end if;
  if k='approvals' and (proposed->>'type'='payment' or old->>'type'='payment') then raise exception 'PAYMENT_WORKFLOW_REQUIRED' using errcode='42501'; end if;
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
    select x into debtor from public.freshy_store s,jsonb_array_elements(s.value) x where s.key='debtors' and x->>'id'=proposed->>'debtorId' limit 1;
    if debtor is null or debtor->>'status' is distinct from 'paid' or not public.freshy_owns(debtor,aid) or not public.freshy_visible('debtors',debtor,actor) then raise exception 'APPROVAL_DEBT_FORBIDDEN' using errcode='42501'; end if;
    if length(trim(coalesce(proposed->>'reason','')))=0 then raise exception 'APPROVAL_REASON_REQUIRED'; end if;
    if exists(select 1 from jsonb_array_elements(vals) x where x->>'debtorId'=proposed->>'debtorId' and x->>'employeeId'=aid and x->>'status'='pending') then raise exception 'DUPLICATE_APPROVAL'; end if;
    proposed:=proposed||jsonb_build_object('employeeName',actor->>'name','debtorName',debtor->>'customerName','amount',debtor->'total','area',debtor->>'area','ts',now());
   else
    page_name := case k when 'cashsales' then 'cashsales'
     when 'customers' then case when proposed->>'area'='nai' then 'customersNai' else 'customersOther' end
     else case when proposed->>'area'='nai' then 'debtorsNai' else 'debtorsOther' end end;
    -- New debtors need a customer reference even when the separate customer menu is hidden.
    -- Ownership still limits reads and writes; existing customer edits require that menu permission.
    if not coalesce((pages->>page_name)::boolean,false) and not (k='customers' and inserted and coalesce((pages->>case when proposed->>'area'='nai' then 'debtorsNai' else 'debtorsOther' end)::boolean,false)) then raise exception 'PAGE_FORBIDDEN' using errcode='42501'; end if;
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
  if k='customers' and proposed is not null and coalesce(proposed->>'code','')<>''
   and exists(select 1 from jsonb_array_elements(vals) x where x->>'id'<>rid and lower(trim(x->>'code'))=lower(trim(proposed->>'code')))
   and (inserted or proposed->>'code' is distinct from old->>'code') then raise exception 'DUPLICATE_CUSTOMER_CODE'; end if;
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
   if coalesce(proposed->>'role','') not in ('admin','staff') or length(trim(coalesce(proposed->>'name','')))=0 or length(trim(coalesce(proposed->>'code','')))=0 then raise exception 'EMPLOYEE_NAME_CODE_ROLE_REQUIRED'; end if;
   proposed:=proposed||jsonb_build_object('email',lower(trim(coalesce(proposed->>'email',''))),'code',trim(proposed->>'code'),'name',trim(proposed->>'name'));
   if length(proposed->>'code')>80 or length(proposed->>'name')>200 or length(proposed->>'email')>254 then raise exception 'INVALID_EMPLOYEE'; end if;
   if proposed->>'email'<>'' and proposed->>'email' !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then raise exception 'INVALID_EMPLOYEE_EMAIL'; end if;
   if exists(select 1 from jsonb_array_elements(vals) x where x->>'id'<>rid and x->>'code'=proposed->>'code') then raise exception 'DUPLICATE_EMPLOYEE_CODE'; end if;
   if proposed->>'email'<>'' and exists(select 1 from jsonb_array_elements(vals) x where x->>'id'<>rid and lower(x->>'email')=proposed->>'email') then raise exception 'DUPLICATE_EMAIL'; end if;
   -- A roster record is not a login grant. Unconfirmed or absent accounts stay pending.
   if not exists(select 1 from auth.users where lower(email)=proposed->>'email' and email_confirmed_at is not null) then
    proposed:=proposed||jsonb_build_object('status','pending');
   elsif coalesce(proposed->>'status','active') not in ('active','pending','inactive','disabled') then raise exception 'INVALID_EMPLOYEE_STATUS';
   end if;
  end if;
  if k='audit' and old is not null then raise exception 'AUDIT_IMMUTABLE'; end if;
  if k='audit' and proposed is not null then proposed:=proposed||jsonb_build_object('userId',aid,'userName',actor->>'name','ts',now()); end if;
  if k='settings' then
   if proposed is null then raise exception 'SETTINGS_REQUIRED'; end if;
   if coalesce(proposed->>'_resetRevision','') is distinct from coalesce(reset_revision,'') then raise exception 'RESET_REVISION_IMMUTABLE'; end if;
   vals:=proposed - 'db';
  else
   select coalesce(jsonb_agg(x),'[]') into vals from jsonb_array_elements(vals) x where x->>'id'<>rid;
   if proposed is not null then vals:=vals||jsonb_build_array(proposed); end if;
  end if;
  if k='employees' then
   select count(*) into count_admin from jsonb_array_elements(vals) x where x->>'role'='admin' and coalesce(x->>'status','active') not in ('pending','inactive','disabled');
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

-- Atomic payment commands. Existing paid records without a review field remain approved.
create or replace function public.freshy_payment(debtor_ids jsonb, action text, request_id text, expected jsonb, reason text default '', expected_revision text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare actor jsonb; aid text; admin boolean; ids text[]; rid text; d jsonb; v jsonb; approvals jsonb; a jsonb; old_request jsonb; command jsonb;
 now_at timestamptz:=now(); review text; revision text; requested_revision text; event_id text; change_count integer:=0;
begin
 perform pg_advisory_xact_lock(7248219);
 actor:=public.freshy_actor();aid:=actor->>'id';admin:=actor->>'role'='admin';
 if action not in ('receive','approve','reject','cancel','request_undo','approve_undo','reject_undo') or action is null then raise exception 'INVALID_PAYMENT_ACTION'; end if;
 if request_id is null or request_id !~ '^[A-Za-z0-9_-]{8,160}$' then raise exception 'INVALID_PAYMENT_REQUEST'; end if;
 if jsonb_typeof(debtor_ids) is distinct from 'array' or jsonb_array_length(debtor_ids) not between 1 and 2500 then raise exception 'INVALID_PAYMENT_IDS'; end if;
 if exists(select 1 from jsonb_array_elements(debtor_ids) x where jsonb_typeof(x) is distinct from 'string') then raise exception 'INVALID_PAYMENT_IDS'; end if;
 select array_agg(distinct x order by x) into ids from jsonb_array_elements_text(debtor_ids) x;
 if array_length(ids,1)<>jsonb_array_length(debtor_ids) then raise exception 'DUPLICATE_PAYMENT_IDS'; end if;
 if jsonb_typeof(expected) is distinct from 'object' then raise exception 'PAYMENT_EXPECTED_REQUIRED'; end if;
 reason:=trim(coalesce(reason,''));
 if length(reason)>2000 then raise exception 'INVALID_PAYMENT_REASON'; end if;
 if action in ('reject','cancel','request_undo') and reason='' then raise exception 'PAYMENT_REASON_REQUIRED'; end if;
 if action in ('approve','reject','approve_undo','reject_undo') and not admin then raise exception 'ADMIN_ONLY_PAYMENT_APPROVAL' using errcode='42501'; end if;
 select coalesce(value->>'_resetRevision','') into revision from public.freshy_store where key='settings';
 requested_revision:=coalesce(expected_revision,nullif(current_setting('request.headers',true),'')::jsonb->>'x-freshy-revision','');
 if coalesce(revision,'')<>requested_revision then raise exception 'RESET_STALE' using errcode='PT409'; end if;
 command:=jsonb_build_object('action',action,'ids',to_jsonb(ids),'reason',reason,'expected',expected);
 event_id:='payment:'||request_id;
 select x into old_request from public.freshy_store s,jsonb_array_elements(s.value) x where s.key='audit' and x->>'id'=event_id;
 if old_request is not null then
  if old_request->>'userId' is distinct from aid or old_request->'paymentCommand' is distinct from command then raise exception 'PAYMENT_REQUEST_REUSED'; end if;
  return public.freshy_read();
 end if;
 select value into v from public.freshy_store where key='debtors' for update;
 select coalesce(value,'[]') into approvals from public.freshy_store where key='approvals' for update;
 approvals:=coalesce(approvals,'[]');
 foreach rid in array ids loop
  select x into d from jsonb_array_elements(coalesce(v,'[]')) x where x->>'id'=rid;
  if d is null then raise exception 'PAYMENT_NOT_FOUND' using errcode='PT409'; end if;
  if expected->rid is distinct from d then raise exception 'PAYMENT_STALE' using errcode='PT409'; end if;
  review:=coalesce(d->>'paymentReviewStatus','approved');
  a:=null;
  if action='receive' then
   if d->>'status' is distinct from 'unpaid' then raise exception 'PAYMENT_ALREADY_RECEIVED' using errcode='PT409'; end if;
   -- Each new receipt has its own review, including a receipt after cancellation.
   d:=(d-'paymentApprovedBy'-'paymentApprovedByName'-'paymentApprovedAt'-'paymentCancellationReason'-'paymentCancelledAt'-'paymentCancelledBy')||jsonb_build_object('status','paid','paidBy',aid,'paidByName',actor->>'name','paidAt',now_at,'paymentReviewStatus',case when admin then 'approved' else 'pending' end,'paymentRequestId',request_id);
   if admin then
    d:=d||jsonb_build_object('paymentApprovedBy',aid,'paymentApprovedByName',actor->>'name','paymentApprovedAt',now_at);
   else
    a:=jsonb_build_object('id',gen_random_uuid()::text,'type','payment','status','pending','debtorId',rid,'debtorName',d->>'customerName','area',d->>'area','amount',d->'total','employeeId',aid,'employeeName',actor->>'name','ts',now_at,'paymentRequestId',request_id);
    approvals:=approvals||jsonb_build_array(a);
   end if;
  elsif action in ('approve','reject','cancel') then
   if d->>'status' is distinct from 'paid' then raise exception 'PAYMENT_NOT_RECEIVED' using errcode='PT409'; end if;
   if action<>'cancel' and review<>'pending' then raise exception 'PAYMENT_NOT_PENDING' using errcode='PT409'; end if;
   if action='cancel' and not admin and (review<>'pending' or d->>'paidBy' is distinct from aid) then raise exception 'PAYMENT_CANCEL_FORBIDDEN' using errcode='42501'; end if;
   select x into a from jsonb_array_elements(approvals) x where x->>'debtorId'=rid and x->>'type'='payment' and x->>'status'='pending' and x->>'paymentRequestId'=d->>'paymentRequestId';
   if review='pending' and a is null then raise exception 'PAYMENT_REVIEW_MISSING' using errcode='PT409'; end if;
   if action='approve' then
    d:=d||jsonb_build_object('paymentReviewStatus','approved','paymentApprovedBy',aid,'paymentApprovedByName',actor->>'name','paymentApprovedAt',now_at);
   else
    d:=(d-'paidBy'-'paidByName'-'paidAt'-'paymentApprovedBy'-'paymentApprovedByName'-'paymentApprovedAt'-'paymentRequestId')||jsonb_build_object('status','unpaid','paymentReviewStatus','cancelled','paymentCancellationReason',reason,'paymentCancelledBy',aid,'paymentCancelledAt',now_at);
   end if;
   if a is not null then
    a:=a||jsonb_build_object('status',case action when 'approve' then 'approved' when 'reject' then 'rejected' else 'cancelled' end,'decidedBy',actor->>'name','decidedById',aid,'decidedAt',now_at,'decisionReason',reason);
    select coalesce(jsonb_agg(case when x->>'id'=a->>'id' then a else x end),'[]') into approvals from jsonb_array_elements(approvals) x;
   end if;
   -- Returning to unpaid also closes any older undo requests for that receipt.
   if action in ('cancel','reject') then
    select coalesce(jsonb_agg(case when x->>'debtorId'=rid and x->>'status'='pending' then x||jsonb_build_object('status','cancelled','decisionReason',reason,'decidedBy',actor->>'name','decidedById',aid,'decidedAt',now_at) else x end),'[]') into approvals from jsonb_array_elements(approvals) x;
   end if;
  elsif action='request_undo' then
   if d->>'status' is distinct from 'paid' or review<>'approved' then raise exception 'PAYMENT_NOT_APPROVED' using errcode='PT409'; end if;
   if not admin and d->>'paidBy' is distinct from aid then raise exception 'PAYMENT_CANCEL_FORBIDDEN' using errcode='42501'; end if;
   if exists(select 1 from jsonb_array_elements(approvals) x where x->>'debtorId'=rid and x->>'status'='pending') then raise exception 'DUPLICATE_APPROVAL'; end if;
   approvals:=approvals||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'type','undo','status','pending','debtorId',rid,'debtorName',d->>'customerName','area',d->>'area','amount',d->'total','employeeId',aid,'employeeName',actor->>'name','reason',reason,'ts',now_at));
  else
   select x into a from jsonb_array_elements(approvals) x where x->>'debtorId'=rid and coalesce(x->>'type','undo')='undo' and x->>'status'='pending' limit 1;
   if a is null or d->>'status' is distinct from 'paid' or review<>'approved' then raise exception 'UNDO_NOT_PENDING' using errcode='PT409'; end if;
   if action='approve_undo' then
    d:=(d-'paidBy'-'paidByName'-'paidAt'-'paymentApprovedBy'-'paymentApprovedByName'-'paymentApprovedAt'-'paymentRequestId')||jsonb_build_object('status','unpaid','paymentReviewStatus','cancelled','paymentCancellationReason',a->>'reason','paymentCancelledBy',aid,'paymentCancelledAt',now_at);
   end if;
   a:=a||jsonb_build_object('status',case when action='approve_undo' then 'approved' else 'rejected' end,'decidedBy',actor->>'name','decidedById',aid,'decidedAt',now_at);
   select coalesce(jsonb_agg(case when x->>'id'=a->>'id' then a else x end),'[]') into approvals from jsonb_array_elements(approvals) x;
  end if;
  select coalesce(jsonb_agg(case when x->>'id'=rid then d else x end),'[]') into v from jsonb_array_elements(v) x;
  change_count:=change_count+1;
 end loop;
 update public.freshy_store set value=v,updated_at=now_at where key='debtors';
 insert into public.freshy_store(key,value,updated_at) values('approvals',approvals,now_at) on conflict(key) do update set value=excluded.value,updated_at=excluded.updated_at;
 insert into public.freshy_store(key,value) values('audit','[]') on conflict do nothing;
 update public.freshy_store set value=value||jsonb_build_array(jsonb_build_object('id',event_id,'ts',now_at,'userId',aid,'userName',actor->>'name','action',case action when 'receive' then case when admin then 'รับชำระและอนุมัติ' else 'รับชำระ รอตรวจสอบ' end when 'approve' then 'ตรวจสอบและอนุมัติการรับชำระ' when 'reject' then 'ไม่อนุมัติการรับชำระ' when 'cancel' then 'ยกเลิกการรับชำระ กลับไปค้าง' when 'request_undo' then 'ขอยกเลิกการรับชำระ' when 'approve_undo' then 'อนุมัติยกเลิกการรับชำระ' else 'ไม่อนุมัติยกเลิกการรับชำระ' end,'detail',change_count||' รายการ'||case when reason<>'' then ' · '||reason else '' end,'paymentCommand',command)),updated_at=now_at where key='audit';
 return public.freshy_read();
end $$;
revoke all on function public.freshy_payment(jsonb,text,text,jsonb,text,text) from public,anon;
grant execute on function public.freshy_payment(jsonb,text,text,jsonb,text,text) to authenticated;


create or replace function public.freshy_reset(categories jsonb, confirmation_code text, expected_revision text, full_reset boolean default false) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare actor jsonb; chosen text[]; k text; revision text; new_revision text:=gen_random_uuid()::text; removed_ids text[]; before_counts jsonb:='{}'; r record;
begin
 perform pg_advisory_xact_lock(7248219);
 actor:=public.freshy_actor();
 if actor->>'role' is distinct from 'admin' then raise exception 'ADMIN_ONLY_RESET' using errcode='42501'; end if;
 if confirmation_code is null or confirmation_code not in ('7716','7816') then raise exception 'INVALID_RESET_CODE' using errcode='42501'; end if;
 select coalesce(value->>'_resetRevision','') into revision from public.freshy_store where key='settings';
 if coalesce(expected_revision,'') is distinct from coalesce(revision,'') then raise exception 'RESET_STALE' using errcode='PT409'; end if;
 if categories is null or jsonb_typeof(categories)<>'array' then raise exception 'INVALID_RESET_SELECTION'; end if;
 select array_agg(x) into chosen from jsonb_array_elements_text(categories) x;
 if not coalesce(full_reset,false) and coalesce(cardinality(chosen),0)=0 then raise exception 'RESET_SELECTION_REQUIRED'; end if;
 foreach k in array coalesce(chosen,array[]::text[]) loop
  if k is null or k not in ('unpaid','paid','customers','cashsales','employees','products','villages','audit','approvals','documents','emailLogs','settings') then raise exception 'INVALID_RESET_SELECTION'; end if;
 end loop;
 for r in select key,value from public.freshy_store where jsonb_typeof(value)='array' loop
  before_counts:=before_counts||jsonb_build_object(r.key,jsonb_array_length(r.value));
 end loop;
 if coalesce(full_reset,false) then
  delete from public.freshy_store;
  insert into public.freshy_store(key,value) values('employees',jsonb_build_array(actor)),('settings',jsonb_build_object('_resetRevision',new_revision));
 else
  select coalesce(array_agg(x->>'id'),array[]::text[]) into removed_ids
  from public.freshy_store s,jsonb_array_elements(s.value) x where s.key='debtors'
  and ('customers'=any(chosen) or (x->>'status'='unpaid' and 'unpaid'=any(chosen)) or (x->>'status'='paid' and 'paid'=any(chosen)));
  update public.freshy_store set value=(select coalesce(jsonb_agg(x),'[]'::jsonb) from jsonb_array_elements(value) x where not (x->>'id'=any(removed_ids))),updated_at=now() where key='debtors';
  update public.freshy_store set value=(select coalesce(jsonb_agg(x),'[]'::jsonb) from jsonb_array_elements(value) x where not coalesce(x->>'debtorId'=any(removed_ids),false)),updated_at=now() where key='approvals';
  foreach k in array chosen loop
   if k in ('customers','cashsales','products','villages','audit','approvals') then
    insert into public.freshy_store(key,value) values(k,'[]'::jsonb) on conflict(key) do update set value='[]'::jsonb,updated_at=now();
   elsif k='employees' then update public.freshy_store set value=jsonb_build_array(actor),updated_at=now() where key=k;
   elsif k='settings' then update public.freshy_store set value='{}'::jsonb,updated_at=now() where key=k;
   elsif k='documents' then
    delete from public.freshy_store where key like 'document:%';
    update public.freshy_store set value=(select coalesce(jsonb_agg(x),'[]'::jsonb) from jsonb_array_elements(value) x where coalesce(x->>'type','')<>'document'),updated_at=now() where key='sentEmails';
   elsif k='emailLogs' then
    update public.freshy_store set value=(select coalesce(jsonb_agg(x),'[]'::jsonb) from jsonb_array_elements(value) x where x->>'type'='document'),updated_at=now() where key='sentEmails';
    delete from public.freshy_store where key like 'mail-job:%';
   end if;
  end loop;
  insert into public.freshy_store(key,value) values('settings',jsonb_build_object('_resetRevision',new_revision)) on conflict(key) do update set value=public.freshy_store.value||jsonb_build_object('_resetRevision',new_revision),updated_at=now();
 end if;
 insert into public.freshy_store(key,value) values('audit','[]'::jsonb) on conflict do nothing;
 update public.freshy_store set value=value||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'ts',now(),'userId',actor->>'id','userName',actor->>'name','action','ล้างข้อมูล','detail',case when full_reset then 'ทั้งหมด (เก็บบัญชีแอดมินปัจจุบัน)' else array_to_string(chosen,', ') end)),updated_at=now() where key='audit';
 return public.freshy_read()||jsonb_build_object('reset',jsonb_build_object('full',coalesce(full_reset,false),'categories',categories,'before',before_counts));
end $$;
revoke all on function public.freshy_reset(jsonb,text,text,boolean) from public,anon;
grant execute on function public.freshy_reset(jsonb,text,text,boolean) to authenticated;

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
