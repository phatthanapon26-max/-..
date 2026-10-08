-- Freshy Water 8.4: shared operational data and atomic payment review.
-- This migration changes functions only; existing business records remain untouched.
begin;
select pg_advisory_xact_lock(7248219);
-- Stop if another update has changed the write function since this version was prepared.
do $$begin
 if not exists(select 1 from pg_proc where oid='public.freshy_apply(jsonb)'::regprocedure
  and md5(prosrc) in ('ff58ab3db84aa97aca3c62a9b9d10e46','7d9e03cf34c3a987a81ddf2d8ac8705e')) then
  raise exception 'WRITE_FUNCTION_CHANGED: inspect the current function before installing';
 end if;
end $$;
select set_config('freshy.payment_migration_hash',coalesce((select md5(string_agg(key||':'||value::text||':'||updated_at::text,'|' order by key)) from public.freshy_store),'empty'),true);

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
 return jsonb_build_object('actor',actor,'data',result,'recorders',recorders);
end $$;
revoke all on function public.freshy_read() from public,anon;
grant execute on function public.freshy_read() to authenticated;

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


-- Roll back the installation if any business row or its update time changed.
do $$begin
 if coalesce((select md5(string_agg(key||':'||value::text||':'||updated_at::text,'|' order by key)) from public.freshy_store),'empty')
  is distinct from current_setting('freshy.payment_migration_hash') then
  raise exception 'BUSINESS_DATA_CHANGED_DURING_MIGRATION';
 end if;
end $$;
notify pgrst, 'reload schema';
commit;
select 'installed; original business rows preserved by transaction check' as payment_review,
 (select md5(string_agg(key||':'||value::text,'|' order by key)) from public.freshy_store) as data_fingerprint,
 (select jsonb_object_agg(key,case when jsonb_typeof(value)='array' then jsonb_array_length(value)::text else jsonb_typeof(value) end) from public.freshy_store) as counts,
 has_function_privilege('authenticated','public.freshy_payment(jsonb,text,text,jsonb,text,text)','execute') as members_can_receive,
 has_function_privilege('anon','public.freshy_payment(jsonb,text,text,jsonb,text,text)','execute') as anonymous_can_receive;
