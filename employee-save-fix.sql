-- Definitions only: save employee roster records without granting unverified accounts access.
begin;
create or replace function public.freshy_actor() returns jsonb
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


revoke all on function public.freshy_actor() from public,anon,authenticated;
revoke all on function public.freshy_apply(jsonb) from public,anon;
grant execute on function public.freshy_apply(jsonb) to authenticated;
notify pgrst, 'reload schema';
commit;
