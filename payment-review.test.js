'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {PGlite}=require('@electric-sql/pglite'),{JSDOM}=require('jsdom'),P=require('./payments'),S=require('./sync');
const source=fs.readFileSync('app.js','utf8');
const uidAdmin='00000000-0000-0000-0000-000000000001',uidStaff='00000000-0000-0000-0000-000000000002',uidOther='00000000-0000-0000-0000-000000000003';
class Storage{constructor(){this.m=new Map()}getItem(k){return this.m.get(k)||null}setItem(k,v){this.m.set(k,String(v))}removeItem(k){this.m.delete(k)}}
function dom(initial){
 const d=new JSDOM(fs.readFileSync('index.html','utf8'),{url:'https://fixture.test/design-preview',runScripts:'outside-only'}),w=d.window;
 w.FRESHY_CONFIG={mode:'demo'};w.FRESHY_PREVIEW=true;w.localStorage.setItem('freshywater_demo_v8',JSON.stringify(initial));
 w.structuredClone=structuredClone;w.setInterval=()=>0;w.scrollTo=()=>{};w.matchMedia=()=>({matches:false,addEventListener(){}});
 for(const file of ['sync.js','features.js','payments.js','data-tools.js','vendor/qrcode.js','dashboard.js','app.js'])w.eval(fs.readFileSync(file,'utf8'));
 return d;
}
const pause=()=>new Promise(r=>setTimeout(r,20));
(async()=>{
 const pg=new PGlite();
 await pg.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
 insert into auth.users values('${uidAdmin}','phatthanapon26@gmail.com',now()),('${uidStaff}','staff@fixture.test',now()),('${uidOther}','other@fixture.test',now());`);
 await pg.exec(fs.readFileSync('database.sql','utf8'));
 const as=async(who,fn)=>pg.transaction(async tx=>{await tx.query("select set_config('test.uid',$1,true)",[who]);return fn(tx);});
 const read=async(who=uidAdmin)=>as(who,async tx=>(await tx.query('select freshy_read() as payload')).rows[0].payload);
 const admin=(await read()).actor,staff={id:'staff',name:'พนักงานหนึ่ง',code:'1001',email:'staff@fixture.test',role:'staff',status:'active',permissions:{pages:{}}},other={...staff,id:'other',code:'1002',name:'พนักงานสอง',email:'other@fixture.test'};
 const put=async(k,v)=>pg.query('insert into freshy_store(key,value) values($1,$2::jsonb) on conflict(key) do update set value=excluded.value',[k,JSON.stringify(v)]);
 await put('employees',[admin,staff,other]);await put('settings',{email:{smtpPass:'private',apiKey:'private',serviceKey:'private'},db:{secret:'private'}});
 const debt=(id,by=admin.id)=>({id,customerId:'c-'+id,customerName:'ลูกค้า '+id,area:'other',village:'บ้านทดสอบ',status:'unpaid',jugs:2,packs:0,jugAmount:30,packAmount:0,total:30,createdBy:by,createdAt:'2026-10-08T03:00:00Z',debtDate:'2026-10-08'});
 const debts=[debt('shared'),debt('other-worker',other.id),debt('cancel'),debt('retry'),debt('race'),debt('bulk-one'),debt('bulk-two'),{...debt('legacy'),status:'paid',paidBy:'staff',paidByName:staff.name,paidAt:'2026-10-08T03:00:00Z'}];
 await put('customers',debts.map(d=>({id:d.customerId,name:d.customerName,area:d.area,createdBy:d.createdBy})));await put('debtors',debts);await put('cashsales',[{id:'cash',createdBy:other.id,jugAmount:100}]);
 const hash=async()=>(await pg.query("select md5(string_agg(key||':'||value::text,'|' order by key)) as hash from freshy_store")).rows[0].hash;
 const initialHash=await hash();await pg.exec(fs.readFileSync('shared-payments-review.sql','utf8'));assert.equal(await hash(),initialHash,'Migration must preserve all stored business rows');
 let payload=await read(uidStaff);assert.equal(payload.data.debtors.length,debts.length);assert.equal(payload.data.customers.length,debts.length);assert.equal(payload.data.cashsales.length,1);assert.deepEqual(payload.data.employees,[staff]);assert(!payload.data.settings.db);assert.deepEqual(payload.data.settings.email,{});assert(payload.recorders.some(x=>x.id===other.id));assert(payload.recorders.every(x=>Object.keys(x).sort().join(',')==='id,name'));
 assert(P.confirmed(payload.data.debtors.find(d=>d.id==='legacy')),'Legacy paid rows retain their historical status');
 let seq=0;
 const command=async(who,action,ids,reason='',request='payment-test-'+(++seq),expectedOverride,revisionOverride)=>{
  const p=await read(who),expected=expectedOverride||Object.fromEntries(ids.map(id=>[id,p.data.debtors.find(d=>d.id===id)]));
  const body={action,ids,reason,request,expected};
  const revision=revisionOverride??(p.data.settings?._resetRevision||'');
  const result=await as(who,async tx=>(await tx.query('select freshy_payment($1::jsonb,$2,$3,$4::jsonb,$5,$6) as payload',[JSON.stringify(ids),action,request,JSON.stringify(expected),reason,revision])).rows[0].payload);
  return {body,result};
 };
 const row=(p,id)=>p.data.debtors.find(d=>d.id===id);
 let received=await command(uidStaff,'receive',['shared','other-worker']);payload=received.result;
 assert.equal(row(payload,'shared').paymentReviewStatus,'pending');assert.equal(row(payload,'shared').paidBy,staff.id);assert.equal(row(payload,'shared').createdBy,admin.id);assert.equal(payload.data.approvals.filter(a=>a.type==='payment'&&a.status==='pending').length,2);assert(!P.confirmed(row(payload,'shared')));
 assert.equal(row(await read(uidOther),'shared').paymentReviewStatus,'pending','Another employee immediately reads the receipt');
 await assert.rejects(()=>command(uidOther,'approve',['shared']),/ADMIN_ONLY_PAYMENT_APPROVAL/);
 await assert.rejects(()=>command(uidOther,'cancel',['shared'],'not mine'),/PAYMENT_CANCEL_FORBIDDEN/);
 await assert.rejects(()=>command(uidStaff,'cancel',['shared'],' '),/PAYMENT_REASON_REQUIRED/);
 const shared=row(await read(uidStaff),'shared');
 await assert.rejects(()=>as(uidStaff,tx=>tx.query('select freshy_apply($1::jsonb)',[JSON.stringify([{collection:'debtors',id:shared.id,expected:shared,value:{...shared,paymentReviewStatus:'approved'}}])])),/PAYMENT_WORKFLOW_REQUIRED/);
 payload=(await command(uidAdmin,'approve',['shared'])).result;assert(P.confirmed(row(payload,'shared')));assert.equal(row(payload,'shared').paymentApprovedBy,admin.id);assert.equal(payload.data.approvals.find(a=>a.debtorId==='shared').status,'approved');
 await assert.rejects(()=>command(uidStaff,'cancel',['shared'],'approved'),/PAYMENT_CANCEL_FORBIDDEN/);
 await command(uidStaff,'request_undo',['shared'],'กดรับชำระผิด');assert.equal(row(await read(),'shared').status,'paid');
 payload=(await command(uidAdmin,'approve_undo',['shared'])).result;assert.equal(row(payload,'shared').status,'unpaid');assert.equal(row(payload,'shared').paymentCancellationReason,'กดรับชำระผิด');
 await command(uidStaff,'receive',['cancel']);payload=(await command(uidStaff,'cancel',['cancel'],'ลูกค้ายังไม่ได้ชำระ')).result;
 assert.equal(row(payload,'cancel').status,'unpaid');assert.equal(payload.data.approvals.find(a=>a.debtorId==='cancel').status,'cancelled');assert(payload.data.audit.some(a=>a.paymentCommand?.reason==='ลูกค้ายังไม่ได้ชำระ'));
 await command(uidStaff,'receive',['cancel']);payload=(await command(uidAdmin,'reject',['cancel'],'ยอดเงินยังไม่ครบ')).result;assert.equal(row(payload,'cancel').status,'unpaid');assert.equal(payload.data.approvals.filter(a=>a.debtorId==='cancel'&&a.status==='pending').length,0);
 payload=(await command(uidAdmin,'receive',['shared'])).result;assert(P.confirmed(row(payload,'shared')));assert.equal(payload.data.approvals.filter(a=>a.debtorId==='shared'&&a.type==='payment'&&a.status==='pending').length,0);
 const retry=(await command(uidStaff,'receive',['retry'],'','lost-response-001'));
 await command(uidStaff,'receive',['retry'],'',retry.body.request,retry.body.expected);
 payload=await read();assert.equal(payload.data.approvals.filter(a=>a.debtorId==='retry').length,1);assert.equal(payload.data.audit.filter(a=>a.id==='payment:lost-response-001').length,1,'Response-loss retry is idempotent');
 await assert.rejects(()=>command(uidOther,'receive',['retry'],'',retry.body.request,retry.body.expected),/PAYMENT_REQUEST_REUSED/);
 const bulkExpected=Object.fromEntries((await read(uidStaff)).data.debtors.filter(d=>d.id.startsWith('bulk-')).map(d=>[d.id,d]));bulkExpected['bulk-two']={...bulkExpected['bulk-two'],total:999};
 await assert.rejects(()=>command(uidStaff,'receive',['bulk-one','bulk-two'],'','bulk-rollback-001',bulkExpected),/PAYMENT_STALE/);assert.equal(row(await read(),'bulk-one').status,'unpaid','A failed second row must roll back the entire batch');
 const racing=row(await read(uidStaff),'race'),expectRace={race:racing};
 const raceResults=await Promise.allSettled([command(uidStaff,'receive',['race'],'','race-command-001',expectRace),command(uidOther,'receive',['race'],'','race-command-002',expectRace)]);
 assert.equal(raceResults.filter(x=>x.status==='fulfilled').length,1);assert.equal((await read()).data.approvals.filter(a=>a.debtorId==='race').length,1,'Two receivers cannot both claim the same debt');
 assert.equal((await pg.query("select has_function_privilege('anon','freshy_payment(jsonb,text,text,jsonb,text,text)','execute') as allowed")).rows[0].allowed,false);
 // Exercise the production client queue against PostgreSQL, including a restart after a lost reply.
 const storage=new Storage();let lost=true;
 function client(initial){let num=0;const c={DB:structuredClone(initial.data),authIdentity:{id:uidStaff},remoteBase:structuredClone(initial.data),localStorage:storage,supaCfg:()=>({url:'fixture'}),FreshySync:S,uid:()=> 'durable-request-'+(++num),updateSyncNotice(){},toast(){},flushOnline:async()=>true,broadcastOnlineChange(){},refreshSyncedView(){},lastSyncAt:0,acceptRemote:p=>{c.DB=structuredClone(p.data);c.remoteBase=structuredClone(p.data);},rpc:async(name,b)=>{assert.equal(name,'freshy_payment');const p=(await command(uidStaff,b.action,b.debtor_ids,b.reason,b.request_id,b.expected,b.expected_revision)).result;if(lost){lost=false;throw Error('TimeoutError: response lost after commit');}return p;}};vm.createContext(c);vm.runInContext(source.slice(source.indexOf("let paySearch="),source.indexOf('function renderPayments(')),c);return c;}
 const c1=client(await read(uidStaff));await assert.rejects(()=>c1.paymentAction('receive',['bulk-one']),/ยังยืนยัน/);assert.equal(c1.paymentQueue().length,1);assert.equal(c1.paymentQueue()[0].body.expected_revision,'');const c2=client(await read(uidStaff));await c2.retryPaymentCommands();assert.equal(c2.paymentQueue().length,0);assert.equal((await read()).data.approvals.filter(a=>a.debtorId==='bulk-one').length,1);
 // DOM flow: shared record is actionable by staff, pending history appears immediately,
 // cancelling requires a reason, admin's history waits for approval, and approved rows show the reviewer.
 const seed=new JSDOM(fs.readFileSync('index.html','utf8'),{url:'https://fixture.test/',runScripts:'outside-only'});seed.window.FRESHY_CONFIG={mode:'demo'};seed.window.FRESHY_PREVIEW=true;seed.window.setInterval=()=>0;seed.window.scrollTo=()=>{};seed.window.matchMedia=()=>({matches:false,addEventListener(){}});for(const f of ['sync.js','features.js','payments.js','data-tools.js','dashboard.js','app.js'])seed.window.eval(fs.readFileSync(f,'utf8'));
 let initial=JSON.parse(seed.window.localStorage.getItem('freshywater_demo_v8'));seed.window.close();initial.customers=[{id:'ui-c',name:'ข้อมูลของแอดมิน',area:'other',createdBy:'emp_admin'}];initial.debtors=[{...debt('ui-debt','emp_admin'),customerId:'ui-c',customerName:'ข้อมูลของแอดมิน'}];initial.approvals=[];
 let d=dom(initial),w=d.window,q=s=>w.document.querySelector(s);q('#loginCode').value='1001';q('#loginBtn').click();q('[data-page="debtorsOther"]').click();assert(q('.payOne'));q('.payOne').click();await pause();initial=JSON.parse(w.localStorage.getItem('freshywater_demo_v8'));assert.equal(initial.debtors[0].paymentReviewStatus,'pending');q('[data-page="paymentsOther"]').click();assert(q('#pageContent').textContent.includes('รับชำระแล้ว รอแอดมินตรวจสอบ'));assert(!q('.undoBtn').disabled);q('.undoBtn').click();q('#confirmUndo').click();await pause();assert.equal(JSON.parse(w.localStorage.getItem('freshywater_demo_v8')).debtors[0].status,'paid');q('#undoReason').value='กดผิด';q('#confirmUndo').click();await pause();initial=JSON.parse(w.localStorage.getItem('freshywater_demo_v8'));assert.equal(initial.debtors[0].status,'unpaid');q('[data-page="debtorsOther"]').click();q('.payOne').click();await pause();initial=JSON.parse(w.localStorage.getItem('freshywater_demo_v8'));d.window.close();
 d=dom(initial);w=d.window;q=s=>w.document.querySelector(s);q('#loginCode').value='7716';q('#loginBtn').click();q('[data-page="paymentsOther"]').click();assert(!q('.undoBtn'),'Admin history excludes unapproved receipts');q('[data-page="approvals"]').click();q('.reviewApprove').click();await pause();initial=JSON.parse(w.localStorage.getItem('freshywater_demo_v8'));assert.equal(initial.debtors[0].paymentReviewStatus,'approved');q('[data-page="paymentsOther"]').click();assert(q('#pageContent').textContent.includes('ตรวจสอบและอนุมัติแล้ว'));assert(q('.payment-reviewer'));d.window.close();
 assert.equal(require('./api/daily-report').summarize({debtors:[{status:'paid',paymentReviewStatus:'pending',paidAt:'2026-10-08T03:00:00Z',total:30},{status:'paid',paymentReviewStatus:'approved',paidAt:'2026-10-08T03:00:00Z',total:40}],cashsales:[]},'2026-10-08').paidTotal,40);
 const unchanged=row(await read(uidStaff),'bulk-two');const settings=(await read()).data.settings;await put('settings',{...settings,_resetRevision:'after-reset'});
 await assert.rejects(()=>command(uidStaff,'receive',['bulk-two'],'','queued-before-reset',{['bulk-two']:unchanged},''),/RESET_STALE/);
 assert.equal(row(await read(),'bulk-two').status,'unpaid');assert.equal(row((await command(uidStaff,'receive',['bulk-two'])).result,'bulk-two').paymentReviewStatus,'pending');
 await pg.close();console.log('Passed: shared reads, private settings protection, atomic receipt/review, all actors receive shared records, staff cannot approve or cancel another receiver, cancellation/rejection reasons and audit, preserved legacy receipts, admin receipt/undo, lost-response idempotency, restartable client queue, stale-reset rejection, simultaneous receive conflict, bulk rollback, anonymous denial, staff/admin history DOM and approved-only report totals.');
})().catch(e=>{console.error(e);process.exitCode=1;});
