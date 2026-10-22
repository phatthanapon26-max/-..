-- Additive guard. No stored customer, debt, receipt or audit is rewritten.
create or replace function public.freshy_admin_debt_corrections() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
declare actor jsonb; prior jsonb; current_row jsonb; fields text[]:=array['customerId','customerName','area','moo','village','debtDate','jugs','packs','jugAmount','packAmount','total'];
begin
 if new.key<>'debtors' or old.value is not distinct from new.value then return new; end if;
 -- Privileged server maintenance is governed by its own server authorization.
 if auth.uid() is null then return new; end if;
 actor:=public.freshy_actor();if actor->>'role'='admin' then return new; end if;
 for prior in select x from jsonb_array_elements(old.value) x loop
  select x into current_row from jsonb_array_elements(new.value) x where x->>'id'=prior->>'id' limit 1;
  if current_row is null then raise exception 'ADMIN_ONLY_DELETE' using errcode='42501'; end if;
  if (select jsonb_object_agg(k,prior->k) from unnest(fields) k) is distinct from
     (select jsonb_object_agg(k,current_row->k) from unnest(fields) k)
  then raise exception 'ADMIN_ONLY_DEBT_CORRECTION' using errcode='42501'; end if;
 end loop;
 return new;
end $$;
revoke all on function public.freshy_admin_debt_corrections() from public,anon,authenticated;
drop trigger if exists freshy_admin_debt_corrections_trigger on public.freshy_store;
create trigger freshy_admin_debt_corrections_trigger before update on public.freshy_store
for each row when (old.key='debtors') execute function public.freshy_admin_debt_corrections();
