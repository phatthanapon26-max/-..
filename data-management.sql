-- Install definitions only. This migration does not reset any data.
begin;
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
   if coalesce(proposed->>'_resetRevision','') is distinct from coalesce(reset_revision,'') then raise exception 'RESET_REVISION_IMMUTABLE'; end if;
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


revoke all on function public.freshy_apply(jsonb) from public,anon;
grant execute on function public.freshy_apply(jsonb) to authenticated;
notify pgrst, 'reload schema';
commit;
