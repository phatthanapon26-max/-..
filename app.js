/* ============================================================
   ระบบจัดการลูกหนี้ โรงน้ำดื่ม เฟรชชี่ วอเตอร์ — app.js
   - ฐานข้อมูล: Supabase Auth + protected RPC หรือโหมดสาธิต localStorage
   - real time polling, แยกจ่ายแล้ว/ค้างชำระ, แยกบ้านนาไฮ/บ้านอื่น
   ============================================================ */
(function(){
'use strict';

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s==null?'':s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const fmtN = n => Number(n||0).toLocaleString('th-TH');
const uid = () => Math.random().toString(36).slice(2,10)+Date.now().toString(36);
const pad2 = n => String(n).padStart(2,'0');
function todayStr(){const d=new Date();return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate());}
function fmtDate(d){return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate());}
function daysAgo(n){const d=new Date();d.setDate(d.getDate()-n);return fmtDate(d);}
function thDate(iso){if(!iso)return'-';const p=String(iso).split(' ')[0].split('-');if(p.length<3)return iso;return p[2]+'/'+p[1]+'/'+p[0];}
function thDateTime(iso){if(!iso)return'-';const d=new Date(iso);return pad2(d.getDate())+'/'+pad2(d.getMonth()+1)+'/'+d.getFullYear()+' '+pad2(d.getHours())+':'+pad2(d.getMinutes());}
function thDateTimeSec(iso){if(!iso)return'-';const d=new Date(iso);return pad2(d.getDate())+'/'+pad2(d.getMonth()+1)+'/'+d.getFullYear()+' '+pad2(d.getHours())+':'+pad2(d.getMinutes())+':'+pad2(d.getSeconds())+' น.';}
function nextCustomerCode(){let max=0;DB.customers.forEach(c=>{const m=String(c.code||'').match(/(\d+)/);if(m)max=Math.max(max,+m[1]);});return 'C'+String(max+1).padStart(3,'0');}
const GS_CODE=`function createFreshyWaterSheets(){
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tabs = {
    customers:['id','code','name','area','moo','village','address','createdAt','createdBy','managedBy','responsibleBy'],
    debtors_nai:['id','customerId','customerName','moo','debtDate','jugs','packs','jugAmount','packAmount','total','status','createdAt','createdBy','paidAt','paidByName'],
    debtors_other:['id','customerId','customerName','village','debtDate','jugs','packs','jugAmount','packAmount','total','status','createdAt','createdBy','paidAt','paidByName'],
    payments_nai:['id','customerId','customerName','moo','debtDate','total','paidAt','paidByName'],
    payments_other:['id','customerId','customerName','village','debtDate','total','paidAt','paidByName'],
    cashsales:['id','customerCode','customerName','village','moo','deliveryDate','createdBy','createdByName','responsibleBy','jugs','packs','jugAmount','packAmount','createdAt'],
    products:['id','code','name','price','returnable'],
    employees:['id','code','name','email','role','permissions'],
    villages:['id','name'],
    audit:['ts','userId','userName','action','detail'],
    approvals:['ts','employeeId','employeeName','area','debtorId','debtorName','amount','reason','status','token'],
    settings:['key','value']
  };
  for(var name in tabs){
    var sh = ss.getSheetByName(name);
    if(!sh){ sh = ss.insertSheet(name); sh.appendRow(tabs[name]); }
    else if(sh.getLastRow()===0){ sh.appendRow(tabs[name]); }
  }
  SpreadsheetApp.getUi().alert('สร้างโครงสร้างฐานข้อมูล เฟรชชี่ วอเตอร์ เรียบร้อยแล้ว');
}`;
function dayDiff(iso){const a=new Date(iso+'T00:00:00');const b=new Date(todayStr()+'T00:00:00');return Math.round((b-a)/86400000);}

/* ---------- toast ---------- */
function toast(msg, type){
  const w=$('#toastWrap'); const t=document.createElement('div');
  t.className='toast '+(type||'');
  t.innerHTML='<i data-lucide="'+(type==='error'?'circle-alert':type==='success'?'check-circle-2':'info')+'"></i><span>'+esc(msg)+'</span>';
  w.appendChild(t); if(window.lucide)lucide.createIcons();
  setTimeout(()=>{t.style.opacity='0';t.style.transition='opacity .3s';setTimeout(()=>t.remove(),300);},3200);
}

/* ---------- modal ---------- */
function openModal(html){
  $('#modalBox').className='modal';$('#modalBox').innerHTML=html; $('#modalBackdrop').classList.remove('hidden');
  if(window.lucide)lucide.createIcons();
}
function closeModal(){$('#modalBackdrop').classList.add('hidden');$('#modalBox').className='modal';$('#modalBox').innerHTML='';}
function modalIsOpen(){return !$('#modalBackdrop').classList.contains('hidden');}
$('#modalBackdrop').addEventListener('click',e=>{if(e.target.id==='modalBackdrop')closeModal();});

/* ============================================================
   ฐานข้อมูล (DB) — สาธิตในเครื่อง; ออนไลน์ใช้ Supabase Auth และ RPC
   ============================================================ */
const DBKEY='freshywater_db_v1';
const SESSKEY='freshywater_session_v1';
let DB=null; let session=null;

function defaultSettings(){
  return {
    business:{name:'โรงน้ำดื่ม เฟรชชี่ วอเตอร์',address:'บ้านนาไฮ ตำบลบ้านนาไฮ อำเภอเมือง จังหวัดนครราชสีมา',taxId:'',commercialId:'',phone:'08x-xxx-xxxx',email:'freshywater@example.com',menuName:'ระบบจัดการลูกหนี้'},
    header:{showLogo:true,showName:true,logoDataUrl:''},
    db:Object.assign({mode:'demo',sheetUrl:'',sheetId:'',apiKey:'',serviceEmail:'',serviceKey:'',supabaseUrl:'',supabaseKey:'',adminEmail:''},window.FRESHY_CONFIG||{}),
    email:{enabled:false,adminEmail:'',provider:'resend',apiKey:'',smtpHost:'',smtpPort:'587',smtpUser:'',smtpPass:'',alerts:{login:true,logout:true,addDebtor:true,undoRequest:true}},
    docPrefix:{debtor:'FWD',cash:'CSH',customer:'CUS'},
    doccounters:{}
  };
}
function seed(){
  const s={settings:defaultSettings(),employees:[],products:[],villages:[],customers:[],debtors:[],cashsales:[],audit:[],approvals:[],sentEmails:[]};
  s.employees=[
    {id:'emp_admin',code:'7716',name:'วิเชียร แก้วน้ำ',role:'admin',email:'admin@freshywater.com',permissions:{pages:{},canPrint:true,canEmail:true}},
    {id:'emp_s1',code:'1001',name:'สมชาย ใจดี',role:'staff',email:'somchai@freshywater.com',permissions:{pages:{dashboard:true,debtorsNai:true,debtorsOther:true,paymentsNai:true,paymentsOther:true,customersNai:true,customersOther:true,cashsales:true},canPrint:false,canEmail:false}},
    {id:'emp_s2',code:'1002',name:'สมศรี มีแสน',role:'staff',email:'somsri@freshywater.com',permissions:{pages:{dashboard:true,debtorsNai:true,debtorsOther:true,paymentsNai:true,paymentsOther:true,customersNai:true,customersOther:true,cashsales:true},canPrint:false,canEmail:false}}
  ];
  s.products=[
    {id:'p_jug',code:'JUG01',name:'น้ำดื่มถัง 18.9 ลิตร',price:20,returnable:true},
    {id:'p_pack',code:'PCK01',name:'น้ำดื่มแพ็ค 6 ขวด',price:30,returnable:false}
  ];
  s.villages=[{id:'v1',name:'บ้านดอนนกเอี้ยงเก่า'},{id:'v2',name:'บ้านตลาด'},{id:'v3',name:'บ้านโนนเสลา'}];
  const custs=[
    ['c001','C001','นายสมศรี ใจดี','nai','7','','บ้านนาไฮ หมู่ 7'],
    ['c002','C002','นางสาวพิมพ์ใจ รักน้ำ','nai','7','','บ้านนาไฮ หมู่ 7'],
    ['c003','C003','นายวิชาญ แก้วกุหลาบ','nai','16','','บ้านนาไฮ หมู่ 16'],
    ['c004','C004','นางสมใจ ดีงาม','nai','16','','บ้านนาไฮ หมู่ 16'],
    ['c005','C005','นายกิตติ ทองสุข','other','','บ้านดอนนกเอี้ยงเก่า','บ้านดอนนกเอี้ยงเก่า'],
    ['c006','C006','นางมะลิ ไพลิน','other','','บ้านตลาด','บ้านตลาด'],
    ['c007','C007','นายธนู รักษ์โลก','other','','บ้านโนนเสลา','บ้านโนนเสลา']
  ];
  custs.forEach((c,i)=>s.customers.push({id:c[0],code:c[1],name:c[2],area:c[3],moo:c[4],village:c[5],address:c[6],createdAt:daysAgo(30+i),createdBy:'emp_admin',managedBy:'emp_admin',responsibleBy:i%2?'emp_s1':'emp_s2'}));
  function debt(cid,area,moo,vill,ago,jugs,packs,by,status){
    const c=s.customers.find(x=>x.id===cid); const jp=20,pp=30;
    const ja=jugs*jp, pa=packs*pp;
    const d={id:uid(),customerId:cid,customerName:c.name,area,moo,village:vill,debtDate:daysAgo(ago),jugs,packs,jugAmount:ja,packAmount:pa,total:ja+pa,status:status||'unpaid',createdAt:daysAgo(ago)+'T08:00:00',createdBy:by};
    if(status==='paid'){d.paidAt=daysAgo(Math.max(0,ago-2))+'T15:30:00';d.paidBy='emp_s1';d.paidByName='สมชาย ใจดี';}
    s.debtors.push(d);
  }
  debt('c001','nai','7','',2,2,1,'emp_s1'); debt('c001','nai','7','',9,3,0,'emp_s1'); debt('c001','nai','7','',45,1,2,'emp_s2');
  debt('c002','nai','7','',5,4,1,'emp_s2');
  debt('c003','nai','16','',120,2,2,'emp_s1'); debt('c003','nai','16','',90,3,1,'emp_s1');
  debt('c005','other','','บ้านดอนนกเอี้ยงเก่า',7,2,3,'emp_s1'); debt('c005','other','','บ้านดอนนกเอี้ยงเก่า',3,1,1,'emp_s2');
  debt('c006','other','','บ้านตลาด',15,5,0,'emp_s2');
  debt('c004','nai','16','',10,2,1,'emp_s1','paid');
  debt('c007','other','','บ้านโนนเสลา',6,3,2,'emp_s2','paid');
  function cash(ccode,name,vill,moo,ago,jugs,packs,by){
    const ja=jugs*20,pa=packs*30;
    s.cashsales.push({id:uid(),customerCode:ccode,customerName:name,village:vill,moo:moo,deliveryDate:daysAgo(ago),createdBy:by,createdByName:(s.employees.find(e=>e.id===by)||{}).name||'ระบบ',dbSource:'สาธิต',responsibleBy:by,jugs,packs,jugAmount:ja,packAmount:pa,createdAt:new Date(Date.now()-ago*86400000).toISOString(),editHistory:[]});
  }
  cash('C001','นายสมศรี ใจดี','บ้านนาไฮ','7',0,5,2,'emp_s1');
  cash('C005','นายกิตติ ทองสุข','บ้านดอนนกเอี้ยงเก่า','',0,3,1,'emp_s2');
  cash('C003','นายวิชาญ แก้วกุหลาบ','บ้านนาไฮ','16',0,4,0,'emp_admin');
  cash('C002','นางสาวพิมพ์ใจ รักน้ำ','บ้านนาไฮ','7',1,2,3,'emp_s1');
  cash('C006','นางมะลิ ไพลิน','บ้านตลาด','',1,6,1,'emp_s2');
  return s;
}
function dbLoad(){
  let backup=null;
  try{backup=JSON.parse(localStorage.getItem('freshywater_dbconfig_v1'));}catch(e){}
  try{DB=JSON.parse(localStorage.getItem(DBKEY));}catch(e){DB=null;}
  if(!DB||!DB.settings)DB=seed();
  // Deployment config is applied last so stale browser data cannot switch production back to demo.
  DB.settings.db=Object.assign({},seed().settings.db,DB.settings.db||{},backup||{},window.FRESHY_CONFIG||{});
  if(!DB.audit)DB.audit=[]; if(!DB.approvals)DB.approvals=[]; if(!DB.sentEmails)DB.sentEmails=[];
  if(!DB.settings.doccounters)DB.settings.doccounters={};
  if(DB.settings.db.mode!=='supabase')localStorage.setItem(DBKEY,JSON.stringify(DB));
}
/* ---------- Supabase (ฐานข้อมูลออนไลน์) ---------- */
const SUPA_COLS=FreshySync.collections;
const SUPA_SQL=window.FRESHY_SQL||'ดูไฟล์ database.sql ในชุดติดตั้ง';
let authClient=null,authIdentity=null,remoteBase=null,syncBusy=false,syncTimer=null,syncBlocked=false;
function supaCfg(){const d=DB.settings.db;return d.mode==='supabase'&&d.supabaseUrl&&d.supabaseKey?{url:String(d.supabaseUrl).trim().replace(/\/$/,''),key:d.supabaseKey.trim()}:null;}
function authFor(cfg){
 if(!window.supabase)throw Error('โหลดระบบล็อกอินไม่สำเร็จ');
 if(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(cfg.url))throw Error('กรอก URL โครงการ Supabase แบบ https://ชื่อโครงการ.supabase.co');
 if(!authClient||authClient._freshyUrl!==cfg.url||authClient._freshyKey!==cfg.key){
  // Preserve an existing session from earlier versions that used sessionStorage.
  for(let i=0;i<sessionStorage.length;i++){const k=sessionStorage.key(i);if(k&&k.startsWith('sb-')&&k.endsWith('-auth-token')&&!localStorage.getItem(k)){const v=sessionStorage.getItem(k);if(v)localStorage.setItem(k,v);}}
  // localStorage keeps the authenticated session available when a QR report opens in a new tab.
  authClient=window.supabase.createClient(cfg.url,cfg.key,{auth:{storage:localStorage,persistSession:true,autoRefreshToken:true,detectSessionInUrl:false},global:{fetch:(url,opts)=>fetch(url,Object.assign({},opts,{signal:AbortSignal.timeout(45000)}))}});
  authClient._freshyUrl=cfg.url;authClient._freshyKey=cfg.key;
 }
 return authClient;
}
function safeCache(){
 const config=DB.settings.db;
 localStorage.setItem('freshywater_dbconfig_v1',JSON.stringify(config));
 if(config.mode!=='supabase'){localStorage.setItem(DBKEY,JSON.stringify(DB));return;}
 if(authIdentity&&remoteBase)localStorage.setItem(draftKey(),JSON.stringify({base:remoteBase,data:FreshySync.shared(DB)}));
}
function draftKey(){return 'freshy_draft_v2_'+authIdentity.id+'_'+supaCfg().url;}
function installRemote(payload,preserve){
 if(!payload||!payload.actor||!payload.data)throw Error('รูปแบบข้อมูลออนไลน์ไม่ถูกต้อง');
 const cfg=DB.settings.db;
 const defaults=defaultSettings();delete defaults.db;
 const data=Object.assign(Object.fromEntries(SUPA_COLS.map(k=>[k,k==='settings'?{}:[]])),payload.data);
 data.settings=Object.assign(defaults,data.settings||{});
 remoteBase=FreshySync.clone(data);
 const merged=FreshySync.overlay(data,preserve||[]);
 for(const k of SUPA_COLS){if(k==='settings')Object.assign(DB.settings,merged[k]);else DB[k]=merged[k];}
 DB.settings.db=cfg;
 if(!DB.employees.some(e=>e.id===payload.actor.id))DB.employees.push(payload.actor);
 session={empId:payload.actor.id,loginAt:new Date().toISOString(),online:true};
 safeCache();
}
async function rpc(name,body){
 const cfg=supaCfg();if(!cfg||!authIdentity)throw Error('กรุณาเข้าสู่ระบบออนไลน์');
 const client=authFor(cfg);
 const {data,error}=await client.rpc(name,body||{});
 if(error)throw Error(error.message||'คำขอฐานข้อมูลล้มเหลว');
 return data;
}
async function supabaseFetch(){
 if(!supaCfg()||!authIdentity||syncBusy||syncBlocked)return false;
 if(currentPage==='settings'||modalIsOpen())return false;
 if(remoteBase&&FreshySync.diff(remoteBase,FreshySync.shared(DB)).length)return flushOnline();
 syncBusy=true;
 try{
  const snapshot=FreshySync.shared(DB);
  const payload=await rpc('freshy_read');
  const edits=remoteBase?FreshySync.diff(snapshot,FreshySync.shared(DB)):[];
  installRemote(payload,edits);
  setStatus('เชื่อมต่อออนไลน์ · อัปเดตข้อมูลแล้ว','ok');
  if(session){refreshUserChip();if(currentPage!=='settings'&&!modalIsOpen()&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName))renderPage();}
  return true;
 }catch(e){setStatus('เชื่อมต่อไม่สำเร็จ · '+e.message,'err');return false;}
 finally{syncBusy=false;}
}
async function flushOnline(){
 if(!authIdentity||!remoteBase||syncBusy||syncBlocked)return false;
 const snapshot=FreshySync.shared(DB),changes=FreshySync.diff(remoteBase,snapshot);
 if(!changes.length)return true;
 syncBusy=true;setStatus('กำลังบันทึกออนไลน์ '+changes.length+' รายการ','warn');
 try{
  const payload=await rpc('freshy_apply',{changes});
  const edits=FreshySync.diff(snapshot,FreshySync.shared(DB));
  installRemote(payload,edits);setStatus('บันทึกออนไลน์แล้ว','ok');
  if(edits.length)supabasePush();
  return true;
 }catch(e){
  syncBlocked=/CONFLICT|FORBIDDEN|ONLY|REQUIRED|IMMUTABLE|INVALID|CLOSED|DUPLICATE|PGRST202|MEMBER_NOT_FOUND/.test(e.message);
  safeCache();setStatus('ยังไม่บันทึกออนไลน์ · '+e.message,'err');
  if(syncBlocked)toast('บันทึกถูกปฏิเสธ ข้อมูลรอส่งยังอยู่ในเครื่อง กดปุ่มจัดการข้อมูลรอส่ง','error');
  return false;
 }finally{syncBusy=false;}
}
function supabasePush(){if(!authIdentity||!remoteBase)return;clearTimeout(syncTimer);syncTimer=setTimeout(()=>flushOnline(),350);}
async function supabaseTest(cfg){
 try{const client=authFor(cfg);const {data,error}=await client.auth.getSession();if(error)throw error;
 if(!data.session)return {ok:false,error:'บันทึก URL/Key แล้ว ออกจากระบบสาธิตและเข้าสู่ระบบด้วยอีเมล/รหัสผ่านจริง'};
 const result=await client.rpc('freshy_read');if(result.error)throw result.error;return {ok:true};
 }catch(e){return {ok:false,error:e.message};}
}
function dbSave(){
 for(const k of SUPA_COLS)if(k!=='settings'&&Array.isArray(DB[k]))DB[k].forEach(x=>{if(!x.id)x.id=uid();});
 safeCache();supabasePush();
}
async function resolvePending(){
 if(!authIdentity||!remoteBase){toast('เข้าสู่ระบบออนไลน์ก่อน','error');return;}
 const changes=FreshySync.diff(remoteBase,FreshySync.shared(DB));
 openModal(`<div class="modal-head"><h3>ข้อมูลรอส่ง ${changes.length} รายการ</h3><button class="x" onclick="closeModal()">×</button></div><div class="modal-body"><p>เมื่อรายการถูกแก้จากเครื่องอื่นหรือสิทธิ์ไม่อนุญาต ระบบจะหยุดเพื่อให้ตรวจสอบ คุณสามารถเก็บสำเนาข้อมูลรอส่งก่อนเลือกใช้ข้อมูลออนไลน์</p></div><div class="modal-foot"><button class="btn btn-ghost" id="exportPending">ดาวน์โหลดสำเนา</button><button class="btn btn-primary" id="retryPending">ลองส่งอีกครั้ง</button><button class="btn btn-danger" id="discardPending">ใช้ข้อมูลออนไลน์</button></div>`);
 $('#exportPending').onclick=()=>{const blob=new Blob([JSON.stringify({exportedAt:new Date().toISOString(),changes},null,2)],{type:'application/json'});const u=URL.createObjectURL(blob);const a=document.createElement('a');a.href=u;a.download='freshy-pending.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);};
 $('#retryPending').onclick=()=>{syncBlocked=false;closeModal();flushOnline();};
 $('#discardPending').onclick=async()=>{if(!confirm('ยืนยันใช้ข้อมูลออนไลน์แทนรายการรอส่งในเครื่องนี้? ควรดาวน์โหลดสำเนาก่อน'))return;try{const payload=await rpc('freshy_read');installRemote(payload,[]);syncBlocked=false;closeModal();renderPage();setStatus('ใช้ข้อมูลออนไลน์แล้ว','ok');}catch(e){toast(e.message,'error');}};
}
window.resolvePending=resolvePending;
function configureLogin(){
 const online=DB.settings.db.mode==='supabase';
 const deploymentLocked=!!(window.FRESHY_CONFIG&&window.FRESHY_CONFIG.mode==='supabase');
 const configured=!!supaCfg();
 $('#onlineLogin').classList.toggle('hidden',!online);
 $('#demoLoginField').classList.toggle('hidden',online);
 $('#useDemo').classList.toggle('hidden',deploymentLocked);
 $('#connectionSetup').classList.toggle('hidden',configured||deploymentLocked);
 $('#loginPreviewNote').textContent=online?'โหมดออนไลน์ · ยืนยันบัญชีจริงผ่าน Supabase':'โหมดสาธิต · ข้อมูลตัวอย่างในเครื่องนี้';
 $('#connectUrl').value=DB.settings.db.supabaseUrl||'';$('#connectKey').value=DB.settings.db.supabaseKey||'';
 $('#connectAdmin').value=DB.settings.db.adminEmail||'';
}
async function startOnline(email,password){
 const cfg=supaCfg();if(!cfg)throw Error('ตั้งค่า URL และ Publishable/Anon Key ก่อน');
 const client=authFor(cfg);
 const {data,error}=await client.auth.signInWithPassword({email,password});
 if(error)throw error;
 authIdentity=data.user;
 try{await hydrateOnline();}catch(e){
  // Authentication succeeded. Never destroy a valid session merely because the
  // database connection pool is temporarily busy; restore the last real snapshot.
  if(resumeCachedOnline(data.user)){enterApp();setStatus('เข้าสู่ระบบแล้ว · ฐานข้อมูลกำลังเชื่อมต่อใหม่','warn');toast('ยืนยันบัญชีสำเร็จ ใช้ข้อมูลล่าสุดในเครื่องชั่วคราว','info');setTimeout(()=>supabaseFetch(),2500);return;}
  throw Error('ยืนยันบัญชีสำเร็จ แต่ฐานข้อมูลยังไม่ตอบสนอง กรุณากดเข้าสู่ระบบอีกครั้งในอีกสักครู่ ('+(e.message||'connection timeout')+')');
 }
}
function resumeCachedOnline(user){
 let cached=null;try{cached=JSON.parse(localStorage.getItem(draftKey()));}catch(e){}
 if(!cached||!cached.base||!cached.data)return false;
 const data=cached.data,employee=(data.employees||[]).find(e=>String(e.email||'').toLowerCase()===String(user.email||'').toLowerCase());
 if(!employee)return false;
 const cfg=DB.settings.db;
 for(const k of SUPA_COLS){if(k==='settings')DB.settings=Object.assign(defaultSettings(),data.settings||{});else DB[k]=data[k]||[];}
 DB.settings.db=cfg;remoteBase=cached.base;session={empId:employee.id,loginAt:new Date().toISOString(),online:true,cached:true};
 return true;
}
async function hydrateOnline(){
 const payload=await rpc('freshy_read');
 let cached=null;try{cached=JSON.parse(localStorage.getItem(draftKey()));}catch(e){}
 if(cached&&cached.base&&cached.data&&FreshySync.diff(cached.base,cached.data).length){
  const cfg=DB.settings.db;for(const k of SUPA_COLS)DB[k]=cached.data[k]||payload.data[k]||(k==='settings'?defaultSettings():[]);
  DB.settings.db=cfg;remoteBase=cached.base;
  session={empId:payload.actor.id,loginAt:new Date().toISOString(),online:true};
  if(!DB.employees.some(e=>e.id===payload.actor.id))DB.employees.push(payload.actor);
  await flushOnline();
 }else installRemote(payload,[]);
 enterApp();
}
async function resumeOnline(){
 const cfg=supaCfg();if(!cfg)return;
 try{const client=authFor(cfg);const {data,error}=await client.auth.getSession();if(error)throw error;
 if(!data.session)return;
 const verified=await client.auth.getUser();if(verified.error)throw verified.error;
 authIdentity=verified.data.user;await hydrateOnline();
 }catch(e){
  if(authIdentity&&resumeCachedOnline(authIdentity)){enterApp();setStatus('ฐานข้อมูลกำลังเชื่อมต่อใหม่ · ใช้ข้อมูลล่าสุดในเครื่อง','warn');setTimeout(()=>supabaseFetch(),2500);return;}
  session=null;$('#loginScreen').classList.remove('hidden');$('#appShell').classList.add('hidden');toast('ยืนยันบัญชีแล้ว แต่ฐานข้อมูลยังไม่พร้อม กรุณาลองอีกครั้ง','error');
 }
}
function dbAdd(col,doc){doc.id=doc.id||uid();DB[col].push(doc);dbSave();return doc;}
function dbUpdate(col,id,patch){const i=DB[col].findIndex(x=>x.id===id);if(i>=0){Object.assign(DB[col][i],patch);dbSave();return DB[col][i];}return null;}
function dbRemove(col,id){DB[col]=DB[col].filter(x=>x.id!==id);dbSave();}
function audit(action,detail){dbAdd('audit',{ts:new Date().toISOString(),userId:(me()||{}).id||'system',userName:(me()||{}).name||'ระบบ',action,detail});}

/* ---------- session / auth ---------- */
function me(){if(!session)return null;return DB.employees.find(e=>e.id===session.empId)||null;}
function isAdmin(){const u=me();return !!(u&&u.role==='admin');}
function canSee(page){const u=me();if(!u)return false;if(u.role==='admin')return true;return !!(u.permissions&&u.permissions.pages&&u.permissions.pages[page]);}
function canPrint(){const u=me();return !!(u&&(u.role==='admin'||u.permissions.canPrint));}
function canEmail(){const u=me();return !!(u&&(u.role==='admin'||u.permissions.canEmail));}
function scopeRows(rows){if(isAdmin())return rows;const id=me().id;return rows.filter(r=>r.createdBy===id||r.responsibleBy===id||r.paidBy===id);}

/* ---------- email alerts (ส่งผ่าน /api/email ถ้าตั้งค่าไว้ มิฉะนั้นบันทึก log) ---------- */
async function sendAlert(type,subject,bodyHtml,toOverride){
 const em=DB.settings.email;
 const entry={id:uid(),createdBy:(me()||{}).id||'demo',ts:new Date().toISOString(),type,to:toOverride||em.adminEmail||'',subject,body:bodyHtml,status:em.enabled&&em.adminEmail?'กำลังส่ง':'ร่าง (ยังไม่เปิดอีเมล)'};
 DB.sentEmails.unshift(entry);dbSave();
 if(!em.enabled||!entry.to)return false;
 if(!authIdentity){entry.status='ไม่ได้ส่ง — ต้องเข้าสู่ระบบออนไลน์';dbSave();return false;}
 try{
  const {data,error}=await authFor(supaCfg()).auth.getSession();if(error||!data.session)throw Error('เซสชันหมดอายุ');
  const r=await fetch('/api/email',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+data.session.access_token},body:JSON.stringify({type,to:entry.to,subject,html:bodyHtml,project:supaCfg()}),signal:AbortSignal.timeout(25000)});
  const j=await r.json();if(!r.ok||!j.ok)throw Error(j.error||'HTTP '+r.status);
  Object.assign(DB.sentEmails.find(x=>x.id===entry.id)||entry,{status:'ผู้ให้บริการรับอีเมลแล้ว',providerId:j.id||''});dbSave();return true;
 }catch(e){(DB.sentEmails.find(x=>x.id===entry.id)||entry).status='ส่งไม่สำเร็จ: '+e.message;dbSave();toast('อีเมลส่งไม่สำเร็จ: '+e.message,'error');return false;}
}

/* ============================================================
   NAV / ROUTER
   ============================================================ */
const PAGES=[
  {id:'dashboard',label:'ภาพรวมระบบ',icon:'layout-dashboard',group:'หลัก'},
  {id:'debtorsNai',label:'ลูกหนี้ค้างชำระ · บ้านนาไฮ',icon:'home',group:'ลูกหนี้ค้างชำระ'},
  {id:'debtorsOther',label:'ลูกหนี้ค้างชำระ · บ้านอื่น ๆ',icon:'map-pinned',group:'ลูกหนี้ค้างชำระ'},
  {id:'paymentsNai',label:'ประวัติรับชำระ · บ้านนาไฮ',icon:'circle-check-big',group:'ประวัติรับชำระ'},
  {id:'paymentsOther',label:'ประวัติรับชำระ · บ้านอื่น ๆ',icon:'circle-check-big',group:'ประวัติรับชำระ'},
  {id:'customersNai',label:'จัดการข้อมูลลูกค้า · บ้านนาไฮ',icon:'users',group:'ข้อมูลลูกค้า'},
  {id:'customersOther',label:'จัดการข้อมูลลูกค้า · บ้านอื่น ๆ',icon:'users',group:'ข้อมูลลูกค้า'},
  {id:'cashsales',label:'รายงานลูกค้าจ่ายสด',icon:'receipt-text',group:'ข้อมูลลูกค้า'},
  {id:'approvals',label:'คำขออนุมัติ',icon:'clipboard-check',group:'จัดการระบบ',admin:true},
  {id:'employees',label:'จัดการพนักงาน',icon:'user-cog',group:'จัดการระบบ',admin:true},
  {id:'audit',label:'ประวัติการแก้ไข',icon:'history',group:'จัดการระบบ',admin:true},
  {id:'settings',label:'การตั้งค่า',icon:'settings',group:'จัดการระบบ',admin:true}
];
let currentPage='dashboard';
function renderNav(){
  const nav=$('#navMenu'); let html=''; let lastGroup='';
  PAGES.forEach(p=>{
    if(p.admin&&!isAdmin())return;
    if(!canSee(p.id)&&!p.admin)return;
    if(p.group!==lastGroup){html+='<div class="nav-group-label">'+esc(p.group)+'</div>';lastGroup=p.group;}
    const badge=(p.id==='approvals')?('<span class="badge">'+DB.approvals.filter(a=>a.status==='pending').length+'</span>'):'';
    html+='<button class="nav-item'+(currentPage===p.id?' active':'')+'" data-page="'+p.id+'"><i data-lucide="'+p.icon+'"></i><span>'+esc(p.label)+'</span>'+badge+'</button>';
  });
  nav.innerHTML=html;
  nav.querySelectorAll('.nav-item').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.page)));
  if(window.lucide)lucide.createIcons();
}
function navigate(page){
  const p=PAGES.find(x=>x.id===page);if(!p)return;
  if(p.admin&&!isAdmin()){toast('คุณไม่มีสิทธิ์เข้าถึงหน้านี้','error');return;}
  if(!canSee(page)&&!p.admin){toast('แอดมินยังไม่เปิดสิทธิ์หน้านี้ให้คุณ','error');return;}
  currentPage=page;
  $('#pageTitle').innerHTML='<i data-lucide="'+p.icon+'"></i> '+esc(p.label);
  renderNav(); renderPage();
  $('#sidebar').classList.remove('open');
  if(window.lucide)lucide.createIcons();
  window.scrollTo(0,0);
}

/* ============================================================
   RENDER PAGE
   ============================================================ */
function renderPage(){
  const c=$('#pageContent');
  const fn={dashboard:renderDashboard,debtorsNai:()=>renderDebtors('nai'),debtorsOther:()=>renderDebtors('other'),
    paymentsNai:()=>renderPayments('nai'),paymentsOther:()=>renderPayments('other'),
    customersNai:()=>renderCustomers('nai'),customersOther:()=>renderCustomers('other'),
    cashsales:renderCashsales,approvals:renderApprovals,employees:renderEmployees,audit:renderAudit,settings:renderSettings};
  (fn[currentPage]||renderDashboard)();
  if(window.lucide)lucide.createIcons();
}

/* ---------- DASHBOARD ---------- */
function renderDashboard(){
  const today=todayStr();
  const cash=scopeRows(DB.cashsales).filter(r=>r.deliveryDate===today);
  const cashTotal=cash.reduce((s,r)=>s+(r.jugAmount||0)+(r.packAmount||0),0);
  const jugsToday=cash.reduce((s,r)=>s+(r.jugs||0),0)+scopeRows(DB.debtors).filter(d=>d.debtDate===today).reduce((s,d)=>s+(d.jugs||0),0);
  const debtToday=scopeRows(DB.debtors).filter(d=>d.status==='unpaid'&&d.debtDate===today).reduce((s,d)=>s+d.total,0);
  const unpaid=scopeRows(DB.debtors).filter(d=>d.status==='unpaid');
  const unpaidCust=new Set(unpaid.map(d=>d.customerId)).size;
  const unpaidTotal=unpaid.reduce((s,d)=>s+d.total,0);
  const unpaidJugs=unpaid.reduce((s,d)=>s+(d.jugs||0),0);
  const paidTotal=scopeRows(DB.debtors).filter(d=>d.status==='paid').reduce((s,d)=>s+d.total,0)+scopeRows(DB.cashsales).reduce((s,r)=>s+r.jugAmount+r.packAmount,0);
  // ทะเบียนรายได้พนักงานวันนี้
  const empRows=DB.employees.map(e=>{
    const c=DB.cashsales.filter(r=>r.createdBy===e.id&&r.deliveryDate===today);
    const d=DB.debtors.filter(r=>r.createdBy===e.id&&r.debtDate===today&&r.status==='unpaid');
    return {code:e.code==='7716'?'ADMIN':e.code,name:e.name,cash:c.reduce((s,r)=>s+r.jugAmount+r.packAmount,0),debt:d.reduce((s,r)=>s+r.total,0)};
  });
  if(!isAdmin()){empRows=empRows.filter(r=>DB.employees.find(e=>e.name===r.name)?.id===me().id);}
  let empHtml='<div class="tbl-wrap"><table class="tbl"><thead><tr><th>รหัสพนักงาน</th><th>ชื่อพนักงาน</th><th class="num">ยอดขายเงินสด</th><th class="num">ยอดลงลูกหนี้</th><th class="num">รวม</th></tr></thead><tbody>';
  empRows.forEach(r=>{
    empHtml+='<tr><td>'+esc(r.code)+'</td><td><b>'+esc(r.name)+'</b></td><td class="num" style="color:var(--green)">'+fmtN(r.cash)+'</td><td class="num" style="color:var(--red)">'+fmtN(r.debt)+'</td><td class="num"><b>'+fmtN(r.cash+r.debt)+'</b></td></tr>';
  });
  empHtml+='</tbody></table></div>';
  const maxTotal=Math.max(paidTotal,unpaidTotal,1);
  $('#pageContent').innerHTML=`
  <div class="page-head"><h2>ภาพรวมประจำวัน ${thDate(today)}</h2><span class="desc">ข้อมูลอัปเดตแบบเรียลไทม์ จากฐานข้อมูล</span></div>
  <div class="command-bar">
    <div><b><i data-lucide="zap"></i> เมนูทำงานด่วน</b><span>เลือกงานที่ใช้ประจำโดยไม่ต้องค้นหาเมนู</span></div>
    <div class="command-actions"><button class="btn btn-primary btn-sm" id="quickDebt"><i data-lucide="plus-circle"></i> เพิ่มลูกหนี้</button><button class="btn btn-success btn-sm" id="quickCash"><i data-lucide="banknote"></i> ลงยอดเงินสด</button><button class="btn btn-ghost btn-sm" id="quickCustomer"><i data-lucide="user-plus"></i> เพิ่มลูกค้า</button></div>
  </div>
  <div class="stats-grid">
    <div class="stat-card green"><div class="label"><i data-lucide="banknote"></i> ยอดขายเงินสดวันนี้</div><div class="value">${fmtN(cashTotal)} <span style="font-size:14px">บาท</span></div><div class="sub">จาก ${cash.length} รายการ</div></div>
    <div class="stat-card red"><div class="label"><i data-lucide="alert-triangle"></i> ลูกหนี้ค้างจ่ายวันนี้</div><div class="value">${fmtN(debtToday)} <span style="font-size:14px">บาท</span></div><div class="sub">ยอดค้างใหม่วันนี้</div></div>
    <div class="stat-card blue"><div class="label"><i data-lucide="package"></i> จำนวนถังที่ขายได้วันนี้</div><div class="value">${fmtN(jugsToday)} <span style="font-size:14px">ถัง</span></div><div class="sub">รวมทั้งเงินสดและลูกหนี้</div></div>
  </div>
  <div style="display:grid;grid-template-columns:2fr 1fr;gap:16px" class="dash-grid">
    <div class="panel"><div class="panel-head"><h3><i data-lucide="users"></i> ทะเบียนรายได้และผลงานพนักงานวันนี้</h3><span class="sync-tag">real time</span></div><div class="panel-body">${empHtml}</div></div>
    <div class="panel"><div class="panel-head"><h3><i data-lucide="scale"></i> เปรียบเทียบยอดรวมระบบ</h3></div><div class="panel-body">
      <div style="margin-bottom:14px"><div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px"><span style="color:var(--green);font-weight:700">ยอดชำระแล้ว</span><b>${fmtN(paidTotal)} บาท</b></div><div style="height:10px;background:#e5e7eb;border-radius:6px;overflow:hidden"><div style="height:100%;width:${(paidTotal/maxTotal*100).toFixed(1)}%;background:linear-gradient(90deg,#16a34a,#22c55e)"></div></div></div>
      <div><div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px"><span style="color:var(--red);font-weight:700">ยอดค้างชำระ</span><b>${fmtN(unpaidTotal)} บาท</b></div><div style="height:10px;background:#e5e7eb;border-radius:6px;overflow:hidden"><div style="height:100%;width:${(unpaidTotal/maxTotal*100).toFixed(1)}%;background:linear-gradient(90deg,#dc2626,#ef4444)"></div></div></div>
    </div></div>
  </div>
  <div class="panel" style="margin-top:18px"><div class="panel-head"><h3><i data-lucide="database"></i> ข้อมูลสะสมของระบบตั้งแต่เริ่มใช้งาน</h3></div><div class="panel-body">
    <div class="stats-grid" style="margin-bottom:0">
      <div class="stat-card purple"><div class="label"><i data-lucide="user-x"></i> ลูกหนี้ค้างชำระ</div><div class="value">${fmtN(unpaidCust)} <span style="font-size:14px">คน</span></div></div>
      <div class="stat-card red"><div class="label"><i data-lucide="wallet"></i> ยอดค้างรวมทั้งหมด</div><div class="value">${fmtN(unpaidTotal)} <span style="font-size:14px">บาท</span></div></div>
      <div class="stat-card green"><div class="label"><i data-lucide="circle-check-big"></i> ยอดชำระแล้ว</div><div class="value">${fmtN(paidTotal)} <span style="font-size:14px">บาท</span></div></div>
      <div class="stat-card blue"><div class="label"><i data-lucide="package"></i> จำนวนถังคงค้าง</div><div class="value">${fmtN(unpaidJugs)} <span style="font-size:14px">ถัง</span></div></div>
    </div>
  </div></div>
  <div class="report-schedule"><div class="report-clock"><i data-lucide="clock-3"></i></div><div><b>รายงานอัตโนมัติสำหรับผู้บริหาร</b><p>รอบเช้า 08:00 น. และรอบเย็น 18:00 น. · อ่านสรุปในอีเมลได้ทันที พร้อมแนบรายงาน PDF</p></div><span class="status-tag ok">ตั้งเวลาพร้อมใช้งาน</span></div>
  <style>@media(max-width:900px){.dash-grid{grid-template-columns:1fr !important}}</style>`;
  $('#quickDebt').onclick=()=>navigate('debtorsNai');
  $('#quickCash').onclick=()=>navigate('cashsales');
  $('#quickCustomer').onclick=()=>navigate('customersNai');
}

/* ---------- DEBTORS (nai / other) ---------- */
let debtorFilter={nai:'all',other:'all'}, debtorSearch='';
let custSearch={nai:'',other:''}, custCredit={nai:'all',other:'all'};
function renderDebtors(area){
  const tone=area==='nai'?'tone-blue':'tone-orange';
  let rows=scopeRows(DB.debtors).filter(d=>d.area===area&&d.status==='unpaid');
  // filter
  const f=debtorFilter[area];
  if(area==='nai'&&f!=='all')rows=rows.filter(d=>d.moo===f);
  if(area==='other'&&f!=='all')rows=rows.filter(d=>d.village===f);
  if(debtorSearch)rows=rows.filter(d=>d.customerName.includes(debtorSearch));
  // group by customer
  const groups={};
  rows.forEach(d=>{(groups[d.customerId]=groups[d.customerId]||[]).push(d);});
  const filterChips=area==='nai'
    ?['all|ทั้งหมด','7|หมู่ที่ 7','16|หมู่ที่ 16']
    :['all|ทั้งหมด'].concat(DB.villages.map(v=>v.name+'|'+v.name));
  let chipsHtml=filterChips.map(c=>{const [v,l]=c.split('|');return '<button class="chip'+(debtorFilter[area]===v?' active':'')+'" data-f="'+esc(v)+'">'+esc(l)+'</button>';}).join('');
  const emailBtn=canEmail()?'<button class="btn btn-ghost btn-sm" id="emailReportBtn"><i data-lucide="mail"></i> ส่งรายงานทางอีเมล</button>':'';
  const printBtn=canPrint()?'<button class="btn btn-ghost btn-sm" id="printReportBtn"><i data-lucide="printer"></i> ปริ้น A4 / PDF</button>':'';
  let cardsHtml=''; let idx=0;
  Object.keys(groups).forEach(cid=>{
    idx++; const list=groups[cid].sort((a,b)=>a.debtDate<b.debtDate?-1:1);
    const c=DB.customers.find(x=>x.id===cid)||{};
    const tj=list.reduce((s,d)=>s+(d.jugs||0),0), tp=list.reduce((s,d)=>s+(d.packs||0),0), tt=list.reduce((s,d)=>s+d.total,0);
    const latest=list.reduce((a,b)=>String(a.createdAt)>String(b.createdAt)?a:b);
    const creator=(DB.employees.find(e=>e.id===latest.createdBy)||{}).name||'-';
    const qrUrl=location.href.split('?')[0]+'?qr='+cid;
    const qrImg='https://api.qrserver.com/v1/create-qr-code/?size=140x140&margin=4&data='+encodeURIComponent(qrUrl);
    let rowsHtml='';
    list.forEach(d=>{
      rowsHtml+=`<tr><td>${thDate(d.debtDate)}</td><td class="num">${d.jugs||0}</td><td class="num">${d.packs||0}</td><td class="num">${fmtN(d.jugAmount)}</td><td class="num">${fmtN(d.packAmount)}</td><td class="num"><b>${fmtN(d.total)}</b></td><td class="ce"><button class="btn btn-success btn-sm payOne" data-id="${d.id}"><i data-lucide="check"></i> จ่ายแล้ว</button></td></tr>`;
    });
    const meta=area==='nai'?('หมู่ที่ '+(c.moo||list[0].moo||'-')):(c.village||list[0].village||'-');
    cardsHtml+=`<div class="debtor-card" data-name="${esc(list[0].customerName)}">
      <div class="dc-head"><div class="idx">${idx}</div><div><div class="cname">${esc(list[0].customerName)}</div><div class="cmeta">${esc(meta)} · ค้าง ${list.length} ครั้ง</div></div>
      <button class="btn btn-gold btn-sm payAll" data-cid="${cid}"><i data-lucide="badge-check"></i> จ่ายทั้งหมด</button>
      <a class="qr-wrap" href="${qrUrl}" aria-label="เปิดรายงานลูกหนี้ ${esc(list[0].customerName)}"><img class="qr-mini" src="${qrImg}" alt="QR รายงานลูกหนี้" title="แตะเพื่อเปิดรายงานลูกหนี้"><small><b>เปิดเอกสารลูกหนี้</b><br>แสดงในหน้าปัจจุบัน</small></a></div>
      <div class="tbl-scroll"><table><thead><tr><th>วันที่ค้าง</th><th class="num">ถัง</th><th class="num">แพ็ค</th><th class="num">เงินน้ำถัง</th><th class="num">เงินน้ำแพ็ค</th><th class="num">ยอดรวม</th><th class="ce">จัดการ</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
      <div class="dc-foot"><span>รวม <b>${tj}</b> ถัง</span><span><b>${tp}</b> แพ็ค</span><span class="total">ค้างทั้งหมด ${fmtN(tt)} บาท</span><span style="width:100%;font-size:11px;color:var(--muted);margin-top:4px;border-top:1px dashed var(--border);padding-top:6px">บันทึกล่าสุดโดย <b>${esc(creator)}</b> · ${thDateTimeSec(latest.createdAt)}</span></div>
    </div>`;
  });
  if(!cardsHtml)cardsHtml='<div class="empty-state"><i data-lucide="party-popper"></i><p>ไม่มีลูกหนี้ค้างชำระในหมวดนี้</p></div>';
  $('#pageContent').innerHTML=`
  <div class="${tone}">
    <div class="page-head"><h2>ลูกหนี้ค้างชำระ ${area==='nai'?'บ้านนาไฮ':'บ้านอื่น ๆ'}</h2><span class="desc">แสดงแบบ 1 ลูกค้า 1 ตาราง · ข้อมูลแยกอัตโนมัติจากฐานข้อมูล</span>
      <div class="actions"><button class="btn btn-gold btn-sm" id="addDebtorBtn"><i data-lucide="plus"></i> เพิ่มรายการลูกหนี้</button>${printBtn}${emailBtn}</div></div>
    <div class="toolbar">
      <div class="search-box"><i data-lucide="search"></i><input id="debtorSearch" placeholder="พิมพ์ชื่อลูกหนี้เพื่อค้นหา..." value="${esc(debtorSearch)}"><div class="search-suggest hidden" id="searchSuggest"></div></div>
      <div class="filter-chips">${chipsHtml}</div>
    </div>
    <div class="debtor-cards">${cardsHtml}</div>
  </div>`;
  // events
  $('#pageContent').querySelectorAll('.chip').forEach(b=>b.addEventListener('click',()=>{debtorFilter[area]=b.dataset.f;renderDebtors(area);}));
  const si=$('#debtorSearch'); const sug=$('#searchSuggest');
  si.addEventListener('input',()=>{
    debtorSearch=si.value.trim();
    const names=[...new Set(DB.debtors.filter(d=>d.area===area&&d.status==='unpaid').map(d=>d.customerName))].filter(n=>n.includes(debtorSearch)).slice(0,6);
    if(debtorSearch&&names.length){sug.innerHTML=names.map(n=>'<div data-n="'+esc(n)+'">'+esc(n)+'</div>').join('');sug.classList.remove('hidden');sug.querySelectorAll('div').forEach(d=>d.addEventListener('click',()=>{si.value=d.dataset.n;debtorSearch=d.dataset.n;sug.classList.add('hidden');renderDebtors(area);}));}
    else sug.classList.add('hidden');
    document.querySelectorAll('.debtor-card').forEach(c=>{c.style.display = debtorSearch && !(c.dataset.name||'').includes(debtorSearch) ? 'none' : '';});
  });
  $('#addDebtorBtn').addEventListener('click',()=>openAddDebtor(area));
  $('#pageContent').querySelectorAll('.payOne').forEach(b=>b.addEventListener('click',()=>markPaid(b.dataset.id)));
  $('#pageContent').querySelectorAll('.payAll').forEach(b=>b.addEventListener('click',()=>{
    scopeRows(DB.debtors).filter(d=>d.customerId===b.dataset.cid&&d.status==='unpaid').forEach(d=>markPaid(d.id,true));
    renderDebtors(area);
  }));
  if(printBtn)$('#printReportBtn').addEventListener('click',()=>openPrintOptions(area));
  if(emailBtn)$('#emailReportBtn').addEventListener('click',()=>openEmailReport(area));
  if(window.lucide)lucide.createIcons();
}
function markPaid(id,silent){
  const d=dbUpdate('debtors',id,{status:'paid',paidAt:new Date().toISOString(),paidBy:me().id,paidByName:me().name});
  audit('รับชำระเงิน','ลูกหนี้ '+d.customerName+' จ่าย '+fmtN(d.total)+' บาท');
  if(!silent){toast('บันทึกรับชำระเงินแล้ว ย้ายไปประวัติรับชำระ','success');renderPage();}
}
function openAddDebtor(area){
  const villageList=DB.villages.map(v=>v.name);
  openModal(`
    <div class="modal-head"><h3><i data-lucide="plus-circle"></i> เพิ่มรายการลูกหนี้ค้างจ่าย ${area==='nai'?'บ้านนาไฮ':'บ้านอื่น ๆ'}</h3><button class="x" onclick="closeModal()"><i data-lucide="x"></i></button></div>
    <div class="modal-body">
      <p style="font-size:13px;color:var(--muted);margin-bottom:12px">เลือกชื่อลูกหนี้ กรอกจำนวนและยอดเงิน แล้วกดปุ่มบันทึกด้านล่าง</p>
      <div class="form-grid debt-form-grid">
        <div class="field full" style="position:relative"><label>ชื่อลูกหนี้ <span style="color:var(--red)">*</span></label>
          <input id="f_name" class="f-step" autocomplete="off" placeholder="พิมพ์ชื่อลูกหนี้...">
          <div class="search-suggest hidden" id="f_nameSug" style="position:absolute;top:auto;left:0;right:0;z-index:40"></div>
        </div>
        <div class="field"><label>รหัสลูกหนี้ (ระบบรันอัตโนมัติ)</label><input id="f_code" readonly style="background:#f1f3f6;font-weight:700;color:var(--navy2)" value="รอพิมพ์ชื่อ"></div>
        <div class="field"><label>${area==='nai'?'หมู่ที่ (พิมพ์ 7 หรือ 16 ได้)':'ชื่อบ้าน / หมู่บ้าน'}</label><input id="f_area" class="f-step" autocomplete="off" placeholder="${area==='nai'?'เช่น 7 หรือ 16':'เลือก/พิมพ์หมู่บ้าน'}"></div>
        <div class="debt-product-group jug-group full"><div class="field"><label>จำนวนถังที่ค้าง</label><input type="number" inputmode="numeric" id="f_jugs" class="f-step" value="0" min="0"></div><div class="field"><label>เงินค้างน้ำถัง (บาท)</label><input type="number" inputmode="decimal" id="f_ja" class="f-step debt-money" value="0" min="0"></div></div>
        <div class="debt-product-group pack-group full"><div class="field"><label>จำนวนแพ็คที่ค้าง</label><input type="number" inputmode="numeric" id="f_packs" class="f-step" value="0" min="0"></div><div class="field"><label>เงินค้างน้ำแพ็ค (บาท)</label><input type="number" inputmode="decimal" id="f_pa" class="f-step debt-money" value="0" min="0"></div></div>
        <div class="field full"><label>วันที่ค้างชำระ</label><input type="date" id="f_date" class="f-step" value="${todayStr()}"></div>
        <div class="debt-total-preview full"><span>ยอดค้างรวมที่จะบันทึก</span><strong id="debtTotalPreview">0 บาท</strong></div>
      </div>
    </div>
    <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">ยกเลิก</button><button class="btn btn-primary" id="saveDebtor"><i data-lucide="save"></i> ยืนยันบันทึกลูกหนี้</button></div>`);
  $('#modalBox').classList.add('debt-entry-modal');
  let selectedCustId=null;
  const nameI=$('#f_name'), sug=$('#f_nameSug'), codeI=$('#f_code'), areaI=$('#f_area');
  function applyCustomer(c){
    if(c){selectedCustId=c.id;codeI.value=c.code;areaI.value=area==='nai'?(c.moo||''):(c.village||'');}
    else{selectedCustId=null;codeI.value=nextCustomerCode();}
  }
  nameI.addEventListener('input',()=>{
    const v=nameI.value.trim();
    const matches=DB.customers.filter(c=>c.area===area&&c.name.includes(v)).slice(0,6);
    if(v&&matches.length){
      sug.innerHTML=matches.map(c=>`<div data-id="${c.id}">${esc(c.name)} · ${esc(c.code)}${area==='nai'?' · หมู่ '+c.moo:' · '+c.village}</div>`).join('');
      sug.classList.remove('hidden');
      sug.querySelectorAll('div').forEach(d=>d.addEventListener('click',()=>{
        const c=DB.customers.find(x=>x.id===d.dataset.id);nameI.value=c.name;applyCustomer(c);sug.classList.add('hidden');areaI.focus();
      }));
      const exact=DB.customers.find(c=>c.area===area&&c.name===v);
      if(exact)applyCustomer(exact); else if(!matches.some(m=>m.name===v)){selectedCustId=null;codeI.value=nextCustomerCode()+' (ลูกค้าใหม่)';}
    }else{sug.classList.add('hidden');if(v){selectedCustId=null;codeI.value=nextCustomerCode()+' (ลูกค้าใหม่)';}else{codeI.value='รอพิมพ์ชื่อ';}}
  });
  // Enter navigation
  const steps=()=>[...$('#modalBox').querySelectorAll('.f-step')];
  function focusNext(el){const s=steps();const i=s.indexOf(el);if(i<s.length-1)s[i+1].focus();else $('#saveDebtor').click();}
  $('#modalBox').querySelectorAll('.f-step').forEach(el=>{
    el.addEventListener('keydown',e=>{
      if(e.key!=='Enter')return; e.preventDefault();
      if(el.id==='f_name'){
        const first=sug.querySelector('div');
        if(!sug.classList.contains('hidden')&&first){first.click();return;}
        if(!nameI.value.trim()){toast('กรุณาพิมพ์ชื่อลูกหนี้ก่อน','error');return;}
        const exact=DB.customers.find(c=>c.area===area&&c.name===nameI.value.trim());
        if(exact)applyCustomer(exact);else applyCustomer(null);
        sug.classList.add('hidden');
      }
      focusNext(el);
    });
  });
  nameI.focus();
  const refreshDebtTotal=()=>{$('#debtTotalPreview').textContent=fmtN((+$('#f_ja').value||0)+(+$('#f_pa').value||0))+' บาท';};
  ['#f_ja','#f_pa'].forEach(sel=>$(sel).addEventListener('input',refreshDebtTotal));
  $('#modalBox').querySelectorAll('input[type="number"]').forEach(el=>el.addEventListener('focus',()=>el.select()));
  $('#saveDebtor').addEventListener('click',()=>{
    const name=nameI.value.trim(); if(!name){toast('กรุณาพิมพ์ชื่อลูกหนี้','error');nameI.focus();return;}
    const jugs=+$('#f_jugs').value||0, packs=+$('#f_packs').value||0, ja=+$('#f_ja').value||0, pa=+$('#f_pa').value||0;
    if(jugs+packs===0){toast('กรุณาระบุจำนวนถังหรือแพ็ค','error');return;}
    let c=selectedCustId?DB.customers.find(x=>x.id===selectedCustId):null;
    if(!c){
      const code=nextCustomerCode();
      c=dbAdd('customers',{code,name,area,moo:area==='nai'?areaI.value.trim():'',village:area==='other'?areaI.value.trim():'',address:'',createdAt:todayStr(),createdBy:me().id,managedBy:me().id,responsibleBy:me().id});
      audit('เพิ่มลูกค้าใหม่',name+' ('+code+')');
      sendAlert('newcustomer','[แจ้งเตือน] พนักงานเพิ่มลูกหนี้ใหม่ รหัสใหม่ '+code,'<p>พนักงาน <b>'+esc(me().name)+'</b> ได้เพิ่มลูกหนี้ใหม่ในระบบ</p><ul><li>ชื่อ: '+esc(name)+'</li><li>รหัสลูกหนี้ใหม่: <b>'+code+'</b> (ระบบรันอัตโนมัติ ไม่ซ้ำกับคนอื่น)</li><li>หมวด: '+(area==='nai'?'บ้านนาไฮ':'บ้านอื่น ๆ')+'</li></ul>');
    }
    const moo=area==='nai'?(areaI.value.trim()||c.moo||''):(c.moo||'');
    const village=area==='other'?(areaI.value.trim()||c.village||''):(c.village||'');
    const d=dbAdd('debtors',{customerId:c.id,customerName:c.name,area,moo,village,debtDate:$('#f_date').value,jugs,packs,jugAmount:ja,packAmount:pa,total:ja+pa,status:'unpaid',createdAt:new Date().toISOString(),createdBy:me().id});
    audit('เพิ่มลูกหนี้',c.name+' ค้าง '+fmtN(d.total)+' บาท');
    if(DB.settings.email.alerts.addDebtor)sendAlert('addDebtor','[แจ้งเตือน] พนักงานเพิ่มรายการลูกหนี้',
      `<p>พนักงาน <b>${esc(me().name)}</b> เพิ่มรายการลูกหนี้</p><ul><li>ชื่อลูกหนี้: ${esc(c.name)} (${esc(c.code)})</li><li>หมู่บ้าน/หมู่ที่: ${esc(area==='nai'?'บ้านนาไฮ หมู่ที่ '+moo:village)}</li><li>วันที่ค้าง: ${thDate(d.debtDate)}</li><li>จำนวนถังค้าง: ${jugs} ถัง</li><li>จำนวนแพ็คค้าง: ${packs} แพ็ค</li><li>เงินค้างน้ำแพ็ค: ${fmtN(pa)} บาท</li><li>ยอดค้างรวม: ${fmtN(d.total)} บาท</li></ul>`);
    closeModal();toast('เพิ่มรายการลูกหนี้แล้ว (รหัส '+c.code+') · ตรวจสถานะอีเมลในประวัติ','success');renderPage();
  });
}

/* ---------- PAYMENTS (ประวัติรับชำระ) ---------- */
let paySearch='';
function renderPayments(area){
  let rows=scopeRows(DB.debtors).filter(d=>d.area===area&&d.status==='paid');
  if(paySearch)rows=rows.filter(d=>d.customerName.includes(paySearch));
  rows.sort((a,b)=>a.paidAt<b.paidAt?1:-1);
  let html='<div class="tbl-wrap"><table class="tbl"><thead><tr><th>ลำดับ</th><th>ชื่อลูกหนี้</th><th class="num">จ่ายแล้ว</th><th>วันที่ค้างชำระ</th><th>วันที่กดจ่ายแล้ว</th><th>ผู้ดำเนินการ</th><th class="ce">จัดการ</th></tr></thead><tbody>';
  rows.forEach((d,i)=>{
    html+=`<tr><td>${i+1}</td><td><b>${esc(d.customerName)}</b></td><td class="num" style="color:var(--green);font-weight:700">${fmtN(d.total)} บาท</td><td>${thDate(d.debtDate)}</td><td>${thDateTimeSec(d.paidAt)}</td><td>${esc(d.paidByName||'-')}</td>
    <td class="ce"><button class="btn btn-danger btn-sm undoBtn" data-id="${d.id}"><i data-lucide="rotate-ccw"></i> ยกเลิก กลับไปค้าง</button></td></tr>`;
  });
  html+='</tbody></table></div>';
  if(!rows.length)html='<div class="empty-state"><i data-lucide="inbox"></i><p>ยังไม่มีประวัติรับชำระ</p></div>';
  $('#pageContent').innerHTML=`
  <div class="page-head"><h2>ประวัติรับชำระ ${area==='nai'?'บ้านนาไฮ':'บ้านอื่น ๆ'}</h2><span class="desc">รายการที่จ่ายแล้ว แยกจากหน้าลูกหนี้ค้างชำระอัตโนมัติ</span></div>
  <div class="toolbar"><div class="search-box"><i data-lucide="search"></i><input id="paySearch" placeholder="ค้นหาชื่อคนที่จ่ายแล้ว..." value="${esc(paySearch)}"></div></div>
  <div class="panel"><div class="panel-body">${html}</div></div>`;
  $('#paySearch').addEventListener('input',e=>{paySearch=e.target.value.trim();renderPayments(area);const i=$('#paySearch');if(i){i.focus();i.setSelectionRange(i.value.length,i.value.length);}});
  $('#pageContent').querySelectorAll('.undoBtn').forEach(b=>b.addEventListener('click',()=>requestUndo(b.dataset.id,area)));
  if(window.lucide)lucide.createIcons();
}
function requestUndo(id,area){
  const d=DB.debtors.find(x=>x.id===id);
  if(isAdmin()){
    openModal(`<div class="modal-head"><h3><i data-lucide="rotate-ccw"></i> ยืนยันยกเลิกกลับไปค้างชำระ</h3><button class="x" onclick="closeModal()"><i data-lucide="x"></i></button></div>
      <div class="modal-body"><p>แอดมินสามารถยกเลิกได้ทันที รายการของ <b>${esc(d.customerName)}</b> (${fmtN(d.total)} บาท) จะกลับไปอยู่ในหน้าลูกหนี้ค้างชำระทันที</p></div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">ยกเลิก</button><button class="btn btn-danger" id="confirmUndo"><i data-lucide="check"></i> ยืนยันกลับไปค้าง</button></div>`);
    $('#confirmUndo').addEventListener('click',()=>{
      dbUpdate('debtors',id,{status:'unpaid',paidAt:null,paidBy:null,paidByName:null});
      audit('แอดมินยกเลิกการชำระ',d.customerName+' กลับไปค้าง '+fmtN(d.total)+' บาท');
      closeModal();toast('ยกเลิกแล้ว ข้อมูลกลับไปค้างชำระ','success');renderPage();
    });
  }else{
    openModal(`<div class="modal-head"><h3><i data-lucide="send"></i> ส่งคำขอยกเลิกกลับไปค้างชำระ</h3><button class="x" onclick="closeModal()"><i data-lucide="x"></i></button></div>
      <div class="modal-body"><p>พนักงานไม่สามารถยกเลิกได้ทันที กรุณากรอกเหตุผล ระบบจะส่งคำขอให้แอดมินอนุมัติ</p>
      <div class="field"><label>เหตุผล (เช่น กดผิดครับ)</label><textarea id="undoReason" rows="3" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:10px"></textarea></div></div>
      <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">ยกเลิก</button><button class="btn btn-primary" id="sendUndo"><i data-lucide="send"></i> ส่งคำขอให้แอดมิน</button></div>`);
    $('#sendUndo').addEventListener('click',()=>{
      const reason=$('#undoReason').value.trim(); if(!reason){toast('กรุณากรอกเหตุผล','error');return;}
      const token=uid();
      const appr=dbAdd('approvals',{ts:new Date().toISOString(),employeeId:me().id,employeeName:me().name,area,debtorId:id,debtorName:d.customerName,amount:d.total,reason,status:'pending',token});
      if(DB.settings.email.alerts.undoRequest){
        const base=location.origin+location.pathname;
        sendAlert('undo','[คำขออนุมัติ] พนักงานขอยกเลิกกลับไปค้างชำระ',
          `<p>พนักงาน <b>${esc(me().name)}</b> ต้องการจัดการข้อมูลในหน้าประวัติรับชำระ (${area==='nai'?'บ้านนาไฮ':'บ้านอื่น ๆ'})</p><p>ต้องการให้รายการ <b>${esc(d.customerName)}</b> (${fmtN(d.total)} บาท) กลับไปค้างชำระ เนื่องจากเหตุผล: <b>${esc(reason)}</b></p><p>เข้าสู่ระบบแอดมินเพื่อตัดสินใจ:<br><br><a href="${base}?approval=${appr.id}&token=${token}&action=approve" style="display:inline-block;background:#16a34a;color:#fff;padding:9px 18px;border-radius:8px;text-decoration:none;margin-right:10px;font-weight:700">อนุมัติ (กลับไปค้าง)</a> <a href="${base}?approval=${appr.id}&token=${token}&action=reject" style="display:inline-block;background:#dc2626;color:#fff;padding:9px 18px;border-radius:8px;text-decoration:none;font-weight:700">ไม่อนุมัติ</a></p><p style="margin-top:10px">หรือเข้าระบบที่หน้า คำขออนุมัติ เพื่อตัดสินใจ</p>`);
      }
      closeModal();toast('บันทึกคำขอแล้ว · ตรวจสถานะการซิงก์และอีเมล','success');renderPage();
    });
  }
}

/* ---------- APPROVALS (admin) ---------- */
function renderApprovals(){
  const rows=DB.approvals.slice().sort((a,b)=>a.ts<b.ts?1:-1);
  let html='';
  rows.forEach(a=>{
    const st=a.status==='pending'?'<span class="pill gold">รออนุมัติ</span>':a.status==='approved'?'<span class="pill green">อนุมัติแล้ว</span>':'<span class="pill red">ไม่อนุมัติ';
    html+=`<div class="panel"><div class="panel-body" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
      <div style="flex:1;min-width:240px"><div style="font-weight:700;color:var(--navy)">${esc(a.employeeName)} ขอยกเลิกรายการ ${esc(a.debtorName)} (${fmtN(a.amount)} บาท)</div>
      <div style="font-size:12px;color:var(--muted);margin-top:3px">เหตุผล: ${esc(a.reason)} · ${thDateTime(a.ts)} · หมวด: ${a.area==='nai'?'บ้านนาไฮ':'บ้านอื่น ๆ'}</div></div>
      <div>${st}</div>
      ${a.status==='pending'?`<button class="btn btn-success btn-sm appr" data-id="${a.id}" data-v="approved"><i data-lucide="check"></i> อนุมัติ</button> <button class="btn btn-danger btn-sm appr" data-id="${a.id}" data-v="rejected"><i data-lucide="x"></i> ไม่อนุมัติ</button>`:''}
    </div></div>`;
  });
  if(!rows.length)html='<div class="empty-state"><i data-lucide="clipboard-check"></i><p>ไม่มีคำขออนุมัติค้างอยู่</p></div>';
  $('#pageContent').innerHTML='<div class="page-head"><h2>คำขออนุมัติจากพนักงาน</h2><span class="desc">คำขอยกเลิกกลับไปค้างชำระจากพนักงาน รอแอดมินตัดสินใจ</span></div>'+html;
  $('#pageContent').querySelectorAll('.appr').forEach(b=>b.addEventListener('click',()=>{
    const a=DB.approvals.find(x=>x.id===b.dataset.id);
    dbUpdate('approvals',a.id,{status:b.dataset.v,decidedBy:me().name,decidedAt:new Date().toISOString()});
    if(b.dataset.v==='approved'){
      dbUpdate('debtors',a.debtorId,{status:'unpaid',paidAt:null,paidBy:null,paidByName:null});
      audit('อนุมัติยกเลิกการชำระ',a.debtorName+' กลับไปค้าง (โดย '+a.employeeName+')');
      toast('อนุมัติแล้ว ข้อมูลกลับไปค้างชำระอัตโนมัติ','success');
    }else{audit('ไม่อนุมัติยกเลิก',a.debtorName);toast('บันทึกการไม่อนุมัติแล้ว','success');}
    renderPage();
  }));
  if(window.lucide)lucide.createIcons();
}

/* ---------- CUSTOMERS ---------- */
function creditStatus(customerId){
  const unpaid=DB.debtors.filter(d=>d.customerId===customerId&&d.status==='unpaid');
  if(!unpaid.length)return{cls:'green',txt:'เครดิตดีเยี่ยม'};
  const oldest=Math.max(...unpaid.map(d=>dayDiff(d.debtDate)));
  if(oldest<=10)return{cls:'green',txt:'เครดิตดีเยี่ยม'};
  if(oldest<=30)return{cls:'blue',txt:'เครดิตดี'};
  if(oldest<=100)return{cls:'gray',txt:'เครดิตสีเทา'};
  return{cls:'red',txt:'เครดิตไม่ดี'};
}
function renderCustomers(area){
  let rows=DB.customers.filter(c=>c.area===area);
  const q=custSearch[area];
  if(q)rows=rows.filter(c=>c.name.includes(q)||String(c.code||'').toLowerCase().includes(q.toLowerCase()));
  if(custCredit[area]!=='all')rows=rows.filter(c=>creditStatus(c.id).txt===custCredit[area]);
  let html='<div class="tbl-wrap"><table class="tbl"><thead><tr><th>ลำดับ</th><th>รหัสลูกค้า</th><th>ชื่อลูกค้า</th>'+(area==='nai'?'<th>หมู่ที่</th>':'<th>หมู่บ้านที่อยู่</th>')+'<th>ที่อยู่</th><th>วันที่นำลงระบบ</th><th>ผู้นำลงระบบ</th><th>ผู้จัดการข้อมูล</th><th>ผู้รับผิดชอบ</th><th>ประวัติลูกหนี้</th></tr></thead><tbody>';
  rows.forEach((c,i)=>{
    const cs=creditStatus(c.id);
    const byName=id=>(DB.employees.find(e=>e.id===id)||{}).name||'-';
    html+=`<tr><td>${i+1}</td><td>${esc(c.code)}</td><td><b>${esc(c.name)}</b></td><td>${esc(area==='nai'?('หมู่ที่ '+c.moo):c.village)}</td><td>${esc(c.address||'-')}</td><td>${thDate(c.createdAt)}</td><td>${esc(byName(c.createdBy))}</td><td>${esc(byName(c.managedBy))}</td><td>${esc(byName(c.responsibleBy))}</td><td><span class="pill ${cs.cls}">${cs.txt}</span></td></tr>`;
  });
  html+='</tbody></table></div>';
  if(!rows.length)html='<div class="empty-state"><i data-lucide="users"></i><p>ไม่พบข้อมูลลูกค้าตามเงื่อนไข</p></div>';
  const chips=[['all','ทั้งหมด'],['เครดิตดีเยี่ยม','เครดิตดีเยี่ยม'],['เครดิตดี','เครดิตดี'],['เครดิตสีเทา','เครดิตสีเทา'],['เครดิตไม่ดี','เครดิตไม่ดี']].map(([v,l])=>'<button class="chip'+(custCredit[area]===v?' active':'')+'" data-cr="'+v+'">'+l+'</button>').join('');
  const printBtn=canPrint()?'<button class="btn btn-ghost btn-sm" id="custPrintBtn"><i data-lucide="printer"></i> ปริ้น / PDF</button>':'';
  const emailBtn=canEmail()?'<button class="btn btn-ghost btn-sm" id="custEmailBtn"><i data-lucide="mail"></i> ส่งรายงานทางอีเมล</button>':'';
  $('#pageContent').innerHTML=`
  <div class="page-head"><h2>จัดการข้อมูลลูกค้า ${area==='nai'?'บ้านนาไฮ':'บ้านอื่น ๆ'}</h2><span class="desc">สถานะเครดิตคำนวณอัตโนมัติจากวันที่ค้างชำระเก่าสุด ค้นหาด้วยชื่อ/รหัส หรือกดกรองตามเครดิต</span>
  <div class="actions"><button class="btn btn-gold btn-sm" id="addCustBtn"><i data-lucide="user-plus"></i> เพิ่มลูกค้า</button>${printBtn}${emailBtn}</div></div>
  <div class="toolbar">
    <div class="search-box"><i data-lucide="search"></i><input id="custSearch" placeholder="ค้นหาชื่อลูกค้าหรือรหัสลูกค้า..." value="${esc(q)}"></div>
    <div class="filter-chips">${chips}</div>
  </div>
  <div class="panel"><div class="panel-body">${html}</div></div>`;
  $('#custSearch').addEventListener('input',e=>{custSearch[area]=e.target.value.trim();renderCustomers(area);const i=$('#custSearch');if(i){i.focus();i.setSelectionRange(i.value.length,i.value.length);}});
  $('#pageContent').querySelectorAll('[data-cr]').forEach(b=>b.addEventListener('click',()=>{custCredit[area]=b.dataset.cr;renderCustomers(area);}));
  $('#addCustBtn').addEventListener('click',()=>openAddCustomer(area));
  if(printBtn)$('#custPrintBtn').addEventListener('click',()=>printCustomers(area));
  if(emailBtn)$('#custEmailBtn').addEventListener('click',()=>openEmailReport('customers-'+area));
  if(window.lucide)lucide.createIcons();
}
function printCustomers(area){
  const rows=DB.customers.filter(c=>c.area===area);
  const docNo=nextDocNo(DB.settings.docPrefix.customer);
  let body=docHeader('รายงานข้อมูลลูกค้า '+(area==='nai'?'บ้านนาไฮ':'บ้านอื่น ๆ'),docNo);
  body+='<table class="doc-table"><thead><tr><th>ลำดับ</th><th>รหัส</th><th>ชื่อลูกค้า</th><th>'+(area==='nai'?'หมู่ที่':'หมู่บ้าน')+'</th><th>ที่อยู่</th><th>วันที่ลงระบบ</th><th>ผู้รับผิดชอบ</th><th>สถานะเครดิต</th></tr></thead><tbody>';
  rows.forEach((c,i)=>{const cs=creditStatus(c.id);const by=(DB.employees.find(e=>e.id===c.responsibleBy)||{}).name||'-';
    body+=`<tr><td>${i+1}</td><td>${esc(c.code)}</td><td class="l">${esc(c.name)}</td><td>${esc(area==='nai'?('หมู่ที่ '+c.moo):c.village)}</td><td class="l">${esc(c.address||'-')}</td><td>${thDate(c.createdAt)}</td><td>${esc(by)}</td><td>${esc(cs.txt)}</td></tr>`;});
  body+='</tbody></table>'+docFooter(docNo);
  $('#printArea').innerHTML='<div class="doc-page">'+body+'</div>';
  setTimeout(()=>window.print(),200);
}
function buildCustomerReportHtml(area){
  const rows=DB.customers.filter(c=>c.area===area);
  const docNo=nextDocNo(DB.settings.docPrefix.customer);
  let body=docHeader('รายงานข้อมูลลูกค้า '+(area==='nai'?'บ้านนาไฮ':'บ้านอื่น ๆ'),docNo);
  body+='<table class="doc-table"><thead><tr><th>ลำดับ</th><th>รหัส</th><th>ชื่อลูกค้า</th><th>'+(area==='nai'?'หมู่ที่':'หมู่บ้าน')+'</th><th>สถานะเครดิต</th></tr></thead><tbody>';
  rows.forEach((c,i)=>{const cs=creditStatus(c.id);body+=`<tr><td>${i+1}</td><td>${esc(c.code)}</td><td class="l">${esc(c.name)}</td><td>${esc(area==='nai'?('หมู่ที่ '+c.moo):c.village)}</td><td>${esc(cs.txt)}</td></tr>`;});
  body+='</tbody></table>'+docFooter(docNo);
  return {html:body,docNo};
}
function openAddCustomer(area){
  const villageOpts=area==='other'?DB.villages.map(v=>'<option value="'+esc(v.name)+'">'+esc(v.name)+'</option>').join(''):'';
  openModal(`<div class="modal-head"><h3><i data-lucide="user-plus"></i> เพิ่มข้อมูลลูกค้า</h3><button class="x" onclick="closeModal()"><i data-lucide="x"></i></button></div>
  <div class="modal-body"><div class="form-grid">
    <div class="field"><label>รหัสลูกค้า</label><input id="c_code" placeholder="C008"></div>
    <div class="field"><label>ชื่อลูกค้า</label><input id="c_name"></div>
    ${area==='nai'?'<div class="field"><label>หมู่ที่</label><select id="c_moo" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:10px"><option value="7">หมู่ที่ 7</option><option value="16">หมู่ที่ 16</option></select></div>':'<div class="field"><label>หมู่บ้าน</label><select id="c_village" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:10px">'+villageOpts+'</select></div>'}
    <div class="field full"><label>ที่อยู่</label><input id="c_addr"></div>
  </div></div>
  <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">ยกเลิก</button><button class="btn btn-primary" id="saveCust"><i data-lucide="save"></i> บันทึก</button></div>`);
  $('#saveCust').addEventListener('click',()=>{
    const name=$('#c_name').value.trim(); if(!name){toast('กรุณากรอกชื่อลูกค้า','error');return;}
    dbAdd('customers',{code:$('#c_code').value.trim()||('C'+String(DB.customers.length+1).padStart(3,'0')),name,area,
      moo:area==='nai'?$('#c_moo').value:'',village:area==='other'?$('#c_village').value:'',address:$('#c_addr').value.trim(),
      createdAt:todayStr(),createdBy:me().id,managedBy:me().id,responsibleBy:me().id});
    audit('เพิ่มลูกค้า',name);closeModal();toast('เพิ่มลูกค้าแล้ว','success');renderPage();
  });
}

/* ---------- CASHSALES (ลูกค้าจ่ายสด) ---------- */
let cashDateFilter=todayStr();
function renderCashsales(){
  let rows=scopeRows(DB.cashsales).slice().sort((a,b)=>a.deliveryDate<b.deliveryDate?1:-1);
  if(cashDateFilter)rows=rows.filter(r=>r.deliveryDate===cashDateFilter);
  const now=Date.now();
  let html='<div class="tbl-wrap"><table class="tbl" style="font-size:12px"><thead><tr><th>ลำดับ</th><th>รหัสลูกค้า</th><th>ชื่อลูกค้า</th><th>หมู่บ้าน</th><th>หมู่ที่</th><th>วันที่จัดส่ง</th><th>ผู้ลงระบบ</th><th>ข้อมูลจาก DB</th><th>ผู้รับผิดชอบ</th><th class="num">ถัง</th><th class="num">แพ็ค</th><th class="num">เงินถัง</th><th class="num">เงินแพ็ค</th><th class="ce">แก้ไข</th></tr></thead><tbody>';
  rows.forEach((r,i)=>{
    const age=now-new Date(r.createdAt).getTime();
    const editable=isAdmin()||age<120000;
    const lockText=isAdmin()?'แอดมินแก้ได้ตลอด':(editable?'เหลือ '+Math.ceil((120000-age)/1000)+' วิ':'ล็อกแล้ว');
    html+=`<tr><td>${i+1}</td><td>${esc(r.customerCode)}</td><td><b>${esc(r.customerName)}</b></td><td>${esc(r.village||'-')}</td><td>${esc(r.moo||'-')}</td><td>${thDate(r.deliveryDate)}</td><td>${esc(r.createdByName)}</td><td>${esc(r.dbSource)}</td><td>${esc((DB.employees.find(e=>e.id===r.responsibleBy)||{}).name||'-')}</td><td class="num">${r.jugs}</td><td class="num">${r.packs}</td><td class="num">${fmtN(r.jugAmount)}</td><td class="num">${fmtN(r.packAmount)}</td>
    <td class="ce">${editable?`<button class="btn btn-ghost btn-sm editCash" data-id="${r.id}"><i data-lucide="pencil"></i> แก้ไข</button>`:'<span class="countdown-lock"><i data-lucide="lock"></i> '+lockText+'</span>'}</td></tr>`;
  });
  html+='</tbody></table></div>';
  if(!rows.length)html='<div class="empty-state"><i data-lucide="receipt-text"></i><p>ไม่มีรายการลูกค้าจ่ายสดในวันที่เลือก</p></div>';
  const emailBtn=canEmail()?'<button class="btn btn-ghost btn-sm" id="cashEmailBtn"><i data-lucide="mail"></i> ส่งรายงานทางอีเมล</button>':'';
  const printBtn=canPrint()?'<button class="btn btn-ghost btn-sm" id="cashPrintBtn"><i data-lucide="printer"></i> ปริ้นรายงานวันที่เลือก</button>':'';
  $('#pageContent').innerHTML=`
  <div class="page-head"><h2>รายงานการขายน้ำ — ลูกค้าจ่ายสด</h2><span class="desc">พนักงานแก้ไขได้ภายใน 2 นาทีหลังเพิ่มข้อมูล หลังจากนั้นล็อกอัตโนมัติ แอดมินแก้ไขได้ตลอด</span>
  <div class="actions"><button class="btn btn-gold btn-sm" id="addCashBtn"><i data-lucide="plus"></i> เพิ่มรายการจ่ายสด</button>${printBtn}${emailBtn}</div></div>
  <div class="toolbar"><label style="font-size:13px;font-weight:600;color:var(--navy)">เลือกวันที่: <input type="date" id="cashDate" value="${cashDateFilter}" style="padding:8px 10px;border:1.5px solid var(--border);border-radius:8px;margin-left:6px"></label></div>
  <div class="panel"><div class="panel-body">${html}</div></div>`;
  $('#cashDate').addEventListener('change',e=>{cashDateFilter=e.target.value;renderCashsales();});
  $('#addCashBtn').addEventListener('click',openAddCash);
  $('#pageContent').querySelectorAll('.editCash').forEach(b=>b.addEventListener('click',()=>openEditCash(b.dataset.id)));
  if(printBtn)$('#cashPrintBtn').addEventListener('click',()=>printCashReport(cashDateFilter));
  if(emailBtn)$('#cashEmailBtn').addEventListener('click',()=>openEmailReport('cash'));
  if(window.lucide)lucide.createIcons();
}
function openAddCash(){
  const custOpts=DB.customers.map(c=>'<option value="'+c.id+'">'+esc(c.name)+' ('+esc(c.code)+')</option>').join('');
  openModal(`<div class="modal-head"><h3><i data-lucide="plus-circle"></i> เพิ่มรายการลูกค้าจ่ายสด</h3><button class="x" onclick="closeModal()"><i data-lucide="x"></i></button></div>
  <div class="modal-body"><div class="form-grid">
    <div class="field full"><label>ลูกค้า</label><select id="cs_cust" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:10px"><option value="">— เลือกลูกค้า —</option>${custOpts}</select></div>
    <div class="field"><label>วันที่จัดส่งน้ำ</label><input type="date" id="cs_date" value="${todayStr()}"></div>
    <div class="field"><label>จำนวนถัง</label><input type="number" id="cs_jugs" value="0" min="0"></div>
    <div class="field"><label>จำนวนน้ำแพ็ค</label><input type="number" id="cs_packs" value="0" min="0"></div>
    <div class="field"><label>เงินน้ำถัง</label><input type="number" id="cs_ja" value="0" min="0"></div>
    <div class="field"><label>เงินน้ำแพ็ค</label><input type="number" id="cs_pa" value="0" min="0"></div>
  </div></div>
  <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">ยกเลิก</button><button class="btn btn-primary" id="saveCash"><i data-lucide="save"></i> บันทึก</button></div>`);
  $('#saveCash').addEventListener('click',()=>{
    const cid=$('#cs_cust').value;if(!cid){toast('กรุณาเลือกลูกค้า','error');return;}
    const c=DB.customers.find(x=>x.id===cid);
    dbAdd('cashsales',{customerCode:c.code,customerName:c.name,village:c.village||'บ้านนาไฮ',moo:c.moo||'',deliveryDate:$('#cs_date').value,createdBy:me().id,createdByName:me().name,dbSource:DB.settings.db.mode==='supabase'?'Supabase':'สาธิต',responsibleBy:me().id,jugs:+$('#cs_jugs').value||0,packs:+$('#cs_packs').value||0,jugAmount:+$('#cs_ja').value||0,packAmount:+$('#cs_pa').value||0,createdAt:new Date().toISOString(),editHistory:[]});
    audit('เพิ่มลูกค้าจ่ายสด',c.name);closeModal();toast('บันทึกรายการจ่ายสดแล้ว','success');renderPage();
  });
}
function openEditCash(id){
  const r=DB.cashsales.find(x=>x.id===id);
  openModal(`<div class="modal-head"><h3><i data-lucide="pencil"></i> แก้ไขรายการจ่ายสด</h3><button class="x" onclick="closeModal()"><i data-lucide="x"></i></button></div>
  <div class="modal-body"><div class="form-grid">
    <div class="field"><label>จำนวนถัง</label><input type="number" id="e_jugs" value="${r.jugs}"></div>
    <div class="field"><label>จำนวนแพ็ค</label><input type="number" id="e_packs" value="${r.packs}"></div>
    <div class="field"><label>เงินน้ำถัง</label><input type="number" id="e_ja" value="${r.jugAmount}"></div>
    <div class="field"><label>เงินน้ำแพ็ค</label><input type="number" id="e_pa" value="${r.packAmount}"></div>
  </div></div>
  <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">ยกเลิก</button><button class="btn btn-primary" id="saveEdit"><i data-lucide="save"></i> บันทึกการแก้ไข</button></div>`);
  $('#saveEdit').addEventListener('click',()=>{
    const before=JSON.stringify({jugs:r.jugs,packs:r.packs,jugAmount:r.jugAmount,packAmount:r.packAmount});
    const patch={jugs:+$('#e_jugs').value||0,packs:+$('#e_packs').value||0,jugAmount:+$('#e_ja').value||0,packAmount:+$('#e_pa').value||0};
    r.editHistory.push({ts:new Date().toISOString(),by:me().name,before,after:JSON.stringify(patch)});
    dbUpdate('cashsales',id,patch);
    audit('แก้ไขลูกค้าจ่ายสด',r.customerName+' (ประวัติแก้ไขบันทึก '+r.editHistory.length+' ครั้ง)');
    closeModal();toast('บันทึกการแก้ไขแล้ว','success');renderPage();
  });
}

/* ---------- EMPLOYEES (admin) ---------- */
function renderEmployees(){
  let html='';
  DB.employees.forEach(e=>{
    const perms=Object.keys((e.permissions&&e.permissions.pages)||{}).filter(k=>e.permissions.pages[k]).length;
    html+=`<div class="panel"><div class="panel-body" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
      <div class="avatar" style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,var(--gold),var(--gold2));color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700">${esc(e.name.charAt(0))}</div>
      <div style="flex:1;min-width:200px"><div style="font-weight:700;color:var(--navy)">${esc(e.name)} <span class="pill ${e.role==='admin'?'gold':'blue'}">${e.role==='admin'?'แอดมิน':'พนักงาน'}</span></div>
      <div style="font-size:12px;color:var(--muted);margin-top:2px">รหัส: ${esc(e.code)} · ${esc(e.email||'ไม่มีอีเมล')} · เห็นหน้า ${perms} หน้า · ปริ้น:${e.permissions.canPrint?'ได้':'ไม่ได้'} · ส่งอีเมล:${e.permissions.canEmail?'ได้':'ไม่ได้'}</div></div>
      <button class="btn btn-ghost btn-sm printEmp" data-id="${e.id}"><i data-lucide="printer"></i> ปริ้นประวัติ</button> <button class="btn btn-ghost btn-sm editEmp" data-id="${e.id}"><i data-lucide="pencil"></i> แก้ไข</button></div></div>`;
  });
  $('#pageContent').innerHTML='<div class="page-head"><h2>จัดการข้อมูลพนักงานและสิทธิ์</h2><span class="desc">ชื่อพนักงานที่แสดงในรายงานจะใช้ชื่อจริงที่ตั้งค่าไว้ ไม่ใช่ชื่อสิทธิ์ admin</span><div class="actions"><button class="btn btn-gold btn-sm" id="addEmpBtn"><i data-lucide="user-plus"></i> เพิ่มพนักงาน</button></div></div>'+html;
  $('#addEmpBtn').addEventListener('click',()=>openEditEmp(null));
  $('#pageContent').querySelectorAll('.editEmp').forEach(b=>b.addEventListener('click',()=>openEditEmp(b.dataset.id)));
  $('#pageContent').querySelectorAll('.printEmp').forEach(b=>b.addEventListener('click',()=>printEmployeeReport(b.dataset.id)));
  if(window.lucide)lucide.createIcons();
}
function openEditEmp(id){
  const e=id?DB.employees.find(x=>x.id===id):{name:'',code:'',email:'',role:'staff',permissions:{pages:{dashboard:true,debtorsNai:true,debtorsOther:true,paymentsNai:true,paymentsOther:true,customersNai:true,customersOther:true,cashsales:true},canPrint:false,canEmail:false}};
  const pagePerms=PAGES.filter(p=>!p.admin).map(p=>{
    const on=e.permissions.pages&&e.permissions.pages[p.id];
    return `<label class="perm-item"><input type="checkbox" data-page="${p.id}" ${on?'checked':''}> ${esc(p.label)}</label>`;
  }).join('');
  openModal(`<div class="modal-head"><h3><i data-lucide="user-cog"></i> ${id?'แก้ไข':'เพิ่ม'}พนักงาน</h3><button class="x" onclick="closeModal()"><i data-lucide="x"></i></button></div>
  <div class="modal-body"><div class="form-grid">
    <div class="field"><label>ชื่อพนักงาน (จริง)</label><input id="e_name" value="${esc(e.name)}"></div>
    <div class="field"><label>รหัสพนักงาน (รหัสล็อกอิน)</label><input id="e_code" value="${esc(e.code)}"></div>
    <div class="field"><label>อีเมลบัญชีจริง (สร้างใน Supabase Authentication ก่อน)</label><input id="e_email" value="${esc(e.email||'')}"></div>
    <div class="field"><label>บทบาท</label><select id="e_role" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:10px"><option value="staff" ${e.role==='staff'?'selected':''}>พนักงาน</option><option value="admin" ${e.role==='admin'?'selected':''}>แอดมิน</option></select></div>
    <div class="field full"><label>สิทธิ์การเข้าถึงแต่ละหน้า</label><div class="perm-grid">${pagePerms}</div></div>
    <label class="perm-item"><input type="checkbox" id="e_print" ${e.permissions.canPrint?'checked':''}> อนุญาตให้ปริ้นรายงาน</label>
    <label class="perm-item"><input type="checkbox" id="e_email" ${e.permissions.canEmail?'checked':''}> อนุญาตให้ส่งรายงานทางอีเมล</label>
  </div></div>
  <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">ยกเลิก</button><button class="btn btn-primary" id="saveEmp"><i data-lucide="save"></i> บันทึก</button></div>`);
  $('#saveEmp').addEventListener('click',()=>{
    const name=$('#e_name').value.trim(),code=$('#e_code').value.trim();
    if(!name||!code){toast('กรุณากรอกชื่อและรหัสพนักงาน','error');return;}
    const pages={};$('#modalBox').querySelectorAll('[data-page]').forEach(c=>pages[c.dataset.page]=c.checked);
    const patch={name,code,email:$('#e_email').value.trim(),role:$('#e_role').value,permissions:{pages,canPrint:$('#e_print').checked,canEmail:$('#e_email').checked}};
    if(id){dbUpdate('employees',id,patch);audit('แก้ไขพนักงาน',name);}
    else{dbAdd('employees',Object.assign({id:uid()},patch));audit('เพิ่มพนักงาน',name);}
    closeModal();toast('บันทึกข้อมูลพนักงานแล้ว','success');renderPage();
  });
}

/* ---------- AUDIT ---------- */
function printEmployeeReport(empId){
  const e=DB.employees.find(x=>x.id===empId);if(!e)return;
  const acts=[];
  DB.debtors.filter(d=>d.createdBy===empId).forEach(d=>acts.push({ts:d.createdAt,type:'เพิ่มลูกหนี้',detail:d.customerName+' ค้าง '+fmtN(d.total)+' บาท ('+(d.area==='nai'?'บ้านนาไฮ':'บ้านอื่น')+')'}));
  DB.debtors.filter(d=>d.paidBy===empId).forEach(d=>acts.push({ts:d.paidAt,type:'รับชำระเงิน',detail:d.customerName+' จ่าย '+fmtN(d.total)+' บาท'}));
  DB.cashsales.filter(r=>r.createdBy===empId).forEach(r=>acts.push({ts:r.createdAt,type:'ขายเงินสด',detail:r.customerName+' จำนวนเงิน '+fmtN(r.jugAmount+r.packAmount)+' บาท'}));
  DB.audit.filter(a=>a.userId===empId).forEach(a=>acts.push({ts:a.ts,type:a.action,detail:a.detail||''}));
  acts.sort((a,b)=>String(a.ts)<String(b.ts)?1:-1);
  const docNo=nextDocNo('EMP');
  let body=docHeader('รายงานประวัติการทำงานของพนักงาน '+e.name,docNo);
  body+='<p style="font-size:12px;margin-bottom:8px">รหัสพนักงาน: <b>'+esc(e.code)+'</b> · ตำแหน่ง: <b>'+(e.role==='admin'?'แอดมิน':'พนักงาน')+'</b> · จำนวนกิจกรรมทั้งหมด '+acts.length+' รายการ</p>';
  body+='<table class="doc-table"><thead><tr><th>ลำดับ</th><th>วัน-เวลา (ยันวินาที)</th><th>ประเภทกิจกรรม</th><th>รายละเอียด</th></tr></thead><tbody>';
  acts.slice(0,500).forEach((a,i)=>{body+=`<tr><td>${i+1}</td><td>${thDateTimeSec(a.ts)}</td><td class="l">${esc(a.type)}</td><td class="l">${esc(a.detail)}</td></tr>`;});
  body+='</tbody></table>'+docFooter(docNo);
  $('#printArea').innerHTML='<div class="doc-page">'+body+'</div>';
  setTimeout(()=>window.print(),200);
}
function renderPublicQrReport(cid){
  const c=DB.customers.find(x=>x.id===cid);
  if(!c){document.body.innerHTML='<div style="padding:40px;font-family:Sarabun,sans-serif"><h2>ไม่พบข้อมูลลูกหนี้</h2><p>รหัสลูกหนี้ไม่ถูกต้อง</p></div>';return;}
  const debts=DB.debtors.filter(d=>d.customerId===cid&&d.status==='unpaid').sort((a,b)=>a.debtDate<b.debtDate?-1:1);
  const first=debts[0]||{};
  const emp=DB.employees.find(e=>e.id===first.createdBy)||{};
  const docNo=nextDocNo(DB.settings.docPrefix.debtor);
  const qrUrl=location.href.split('?')[0]+'?qr='+cid;
  const qrImg='https://api.qrserver.com/v1/create-qr-code/?size=160x160&margin=4&data='+encodeURIComponent(qrUrl);
  const cs=creditStatus(cid);
  const total=debts.reduce((s,d)=>s+d.total,0);
  const days=(iso)=>Math.max(0,Math.floor((new Date()-new Date(iso))/86400000));
  let rows='';
  debts.forEach((d,i)=>{rows+=`<tr><td>${i+1}</td><td>${thDate(d.debtDate)}</td><td class="num">${days(d.debtDate)}</td><td>${cs.txt}</td><td class="num">${d.jugs||0}</td><td class="num">${fmtN(d.jugAmount||0)}</td><td class="num">${d.packs||0}</td><td class="num">${fmtN(d.packAmount||0)}</td><td class="num">${fmtN(d.total)}</td></tr>`;});
  const mobileRows=debts.map((d,i)=>`<article class="qr-debt-card"><div class="qr-debt-head"><b>รายการที่ ${i+1}</b><span>${thDate(d.debtDate)}</span></div><div class="qr-debt-grid"><span>ค้างมา <b>${days(d.debtDate)} วัน</b></span><span>เครดิต <b>${cs.txt}</b></span><span>น้ำถัง <b>${d.jugs||0} ถัง · ${fmtN(d.jugAmount||0)} บาท</b></span><span>น้ำแพ็ค <b>${d.packs||0} แพ็ค · ${fmtN(d.packAmount||0)} บาท</b></span></div><div class="qr-debt-total">ยอดรายการ <b>${fmtN(d.total)} บาท</b></div></article>`).join('');
  const sign=(t)=>`<div style="flex:1;text-align:center;font-size:12px"><div style="margin-top:50px;border-top:1px solid #333;padding-top:4px">${t}</div></div>`;
  document.body.innerHTML=`
  <style>
  *{box-sizing:border-box}body{margin:0;background:linear-gradient(135deg,#dfe7ed,#f6f8f9);color:#102739;font-family:'Sarabun',sans-serif}.qr-page{max-width:940px;margin:0 auto;padding:18px}.qr-actions{display:flex;gap:9px;margin-bottom:14px;position:sticky;top:0;z-index:5;padding:8px 0;background:linear-gradient(180deg,#e6ecef 70%,transparent)}.qr-btn{padding:11px 17px;border:1px solid #254a62;border-radius:7px;font:800 14px 'Sarabun';cursor:pointer}.qr-btn.primary{background:#0a3b5b;color:#fff}.qr-btn.back{background:#fff;color:#153a52}.qr-sheet{background:#fff;padding:30px;color:#111;border:1px solid #8fa2af;border-radius:8px;box-shadow:0 20px 55px rgba(4,32,51,.18)}.qr-hero{text-align:center;border:1.5px solid #111;border-bottom:4px double #111;padding:14px;margin-bottom:0}.qr-hero:before{content:'เอกสารควบคุมของหน่วยงาน';display:block;font-size:10px;font-weight:800;letter-spacing:.12em;text-align:right}.qr-hero .brand{font-size:23px;font-weight:900;color:#000}.qr-hero .contact{font-size:12px;color:#222}.qr-hero .title{font-size:17px;font-weight:900;margin-top:9px;color:#000;text-decoration:underline;text-underline-offset:4px}.qr-meta{display:grid;grid-template-columns:repeat(4,1fr);gap:0;margin-bottom:15px;border:1px solid #333;border-top:0}.qr-meta div{padding:9px;border-radius:0;background:#fff;border:0;border-right:1px solid #777;border-bottom:1px solid #999;font-size:11.5px}.qr-meta div:nth-child(4n){border-right:0}.qr-meta b{display:block;color:#111;margin-bottom:2px}.qr-table-wrap{overflow-x:auto;border:1px solid #222;border-radius:0}.qr-table{width:100%;border-collapse:collapse;font-size:12px;min-width:720px}.qr-table th{background:#263746;color:#fff;padding:8px;border:1px solid #111}.qr-table td{padding:8px;border:1px solid #666;text-align:center}.qr-table tbody tr:nth-child(even){background:#f0f2f3}.qr-table tfoot td{background:#e5e8ea;font-weight:900}.qr-mobile-list{display:none}.qr-summary{display:flex;gap:18px;align-items:center;margin-top:14px;padding:14px;border:1.5px solid #222;border-radius:0;background:#f3f5f6}.qr-summary .copy{flex:1;font-size:11.5px;color:#243746}.qr-summary .amount{font-size:22px;font-weight:900;color:#000;margin-top:6px}.qr-code{width:116px;height:116px;border:6px solid #fff;outline:1px solid #555;box-shadow:none}.qr-signs{display:flex;gap:12px;margin-top:36px;font-size:11px}
  @media(max-width:640px){.qr-page{padding:9px}.qr-actions{padding-top:5px}.qr-btn{flex:1;padding:12px 8px}.qr-sheet{padding:13px 11px;border-radius:6px}.qr-hero{padding:11px 8px}.qr-hero .brand{font-size:20px}.qr-hero .title{font-size:15px}.qr-meta{grid-template-columns:1fr 1fr}.qr-meta div{padding:8px;font-size:11px;border-right:1px solid #777}.qr-meta div:nth-child(2n){border-right:0}.qr-table-wrap{display:none}.qr-mobile-list{display:grid;gap:8px}.qr-debt-card{border:1px solid #8799a5;border-left:5px solid #163f59;border-radius:6px;overflow:hidden;background:#fff}.qr-debt-head{display:flex;justify-content:space-between;padding:9px 11px;background:#e5ebef;color:#17384e}.qr-debt-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:10px;font-size:11.5px}.qr-debt-grid span{color:#596b78}.qr-debt-grid b{display:block;color:#18384d;margin-top:2px}.qr-debt-total{display:flex;justify-content:space-between;padding:9px 11px;background:#edf1f3;color:#475e6e}.qr-debt-total b{font-size:16px;color:#111}.qr-summary{align-items:flex-start;padding:11px;gap:9px}.qr-summary .amount{font-size:19px}.qr-code{width:90px;height:90px}.qr-signs{display:none}}
  @media print{body{background:#fff!important}.no-print{display:none!important}.qr-page{max-width:none;padding:0}.qr-sheet{padding:0;border:0;box-shadow:none}.qr-mobile-list{display:none!important}.qr-table-wrap{display:block!important}.qr-signs{display:flex!important}@page{size:A4;margin:14mm 12mm}}
  </style>
  <div class="qr-page">
    <div class="qr-actions no-print"><button class="qr-btn primary" onclick="window.print()">พิมพ์เอกสาร / บันทึก PDF</button><button class="qr-btn back" onclick="location.replace(location.pathname)">กลับสู่ระบบ</button></div>
    <div class="qr-sheet">
      <div class="qr-hero">
        <div class="brand">โรงน้ำดื่ม เฟรชชี่ วอเตอร์</div>
        <div class="contact">นครราชสีมา · โทร. 08X-XXX-XXXX</div>
        <div class="title">ทะเบียนติดตามลูกหนี้ค้างชำระ</div>
      </div>
      <div class="qr-meta"><div><b>เลขที่เอกสาร</b>${docNo}</div><div><b>วันที่เปิดรายงาน</b>${thDateTimeSec(new Date().toISOString())}</div><div><b>รหัสลูกหนี้</b>${esc(c.code)}</div><div><b>ชื่อลูกหนี้</b>${esc(c.name)}</div><div><b>ผู้บันทึก</b>${esc(emp.name||'-')}</div><div><b>ตำแหน่ง</b>${emp.role==='admin'?'ผู้ดูแลระบบ':'พนักงาน'}</div><div><b>จำนวนค้าง</b>${debts.length} รายการ</div><div><b>เครดิต</b>${cs.txt}</div></div>
      <div class="qr-table-wrap"><table class="qr-table"><thead><tr><th>ลำดับ</th><th>วันที่ค้าง</th><th>ค้างมา (วัน)</th><th>เครดิต</th><th>ถัง</th><th>เงินน้ำถัง</th><th>แพ็ค</th><th>เงินน้ำแพ็ค</th><th>รวม (บาท)</th></tr></thead><tbody>${rows||'<tr><td colspan="9">ไม่มีรายการค้าง</td></tr>'}</tbody><tfoot><tr><td colspan="8" style="text-align:right">ยอดค้างรวมทั้งหมด</td><td>${fmtN(total)} บาท</td></tr></tfoot></table></div>
      <div class="qr-mobile-list">${mobileRows||'<div style="text-align:center;padding:20px">ไม่มีรายการค้าง</div>'}</div>
      <div class="qr-summary">
        <div class="copy">เอกสารนี้ออกโดยระบบสารสนเทศจัดการลูกหนี้<br>โรงน้ำดื่ม เฟรชชี่ วอเตอร์ · เลขที่เอกสาร <b>${docNo}</b><div class="amount">ยอดค้างรวม ${fmtN(total)} บาท</div></div>
        <img class="qr-code" src="${qrImg}" alt="QR Code รายงานลูกหนี้">
      </div>
      <div class="qr-signs">
        ${sign('ผู้จัดการข้อมูล')}${sign('ผู้กรอกข้อมูล')}${sign('ผู้ออก QR Code')}${sign('ผู้ตรวจสอบ')}${sign('หัวหน้า / ผู้บริหาร')}
      </div>
    </div>
  </div>`;
}
function renderAudit(){
  const rows=DB.audit.slice().sort((a,b)=>a.ts<b.ts?1:-1).slice(0,200);
  let html=rows.map(a=>`<div class="audit-item"><span class="ts">${thDateTime(a.ts)}</span><span class="who">${esc(a.userName)}</span><span>${esc(a.action)} — ${esc(a.detail||'')}</span></div>`).join('');
  if(!rows.length)html='<div class="empty-state"><i data-lucide="history"></i><p>ยังไม่มีประวัติการแก้ไข</p></div>';
  $('#pageContent').innerHTML='<div class="page-head"><h2>ประวัติการแก้ไขทั้งหมด</h2><span class="desc">แสดง 200 รายการล่าสุด</span></div><div class="panel"><div class="panel-body">'+html+'</div></div>';
}

/* ---------- SETTINGS (tabs) ---------- */
let settingTab='profile';
function renderSettings(){
  const s=DB.settings; const u=me();
  const tabs=[['profile','ข้อมูลผู้ใช้'],['business','สถานประกอบการ'],['header','โลโก้/หัวกระดาษ'],['db','ฐานข้อมูล'],['products','สินค้า'],['villages','หมู่บ้าน'],['email','อีเมลแจ้งเตือน'],['system','ระบบ/ข้อมูล']];
  const tabsHtml=tabs.map(t=>'<button class="tab'+(settingTab===t[0]?' active':'')+'" data-t="'+t[0]+'">'+t[1]+'</button>').join('');
  let body='';
  if(settingTab==='profile')body=`<div class="panel"><div class="panel-head"><h3><i data-lucide="user"></i> ข้อมูลผู้ใช้และโปรไฟล์</h3></div><div class="panel-body"><div class="form-grid">
    <div class="field"><label>ชื่อผู้ใช้ (ชื่อจริง แสดงในรายงาน)</label><input id="s_name" value="${esc(u.name)}"></div>
    <div class="field"><label>รหัสพนักงาน</label><input id="s_code" value="${esc(u.code)}"></div>
    <div class="field"><label>อีเมล</label><input id="s_email" ${!isAdmin()&&authIdentity?'readonly':''} value="${esc(u.email||'')}"></div>
    <div class="field"><label>รูปโปรไฟล์ URL (เว้นว่างใช้ตัวอักษร)</label><input id="s_avatar" value="${esc(u.avatarUrl||'')}"></div>
  </div><button class="btn btn-primary" id="saveProfile"><i data-lucide="save"></i> บันทึกโปรไฟล์</button></div></div>`;
  else if(settingTab==='business')body=`<div class="panel"><div class="panel-head"><h3><i data-lucide="building-2"></i> ข้อมูลสถานประกอบการ</h3></div><div class="panel-body"><div class="form-grid">
    <div class="field full"><label>ชื่อสถานประกอบการ</label><input id="b_name" value="${esc(s.business.name)}"></div>
    <div class="field full"><label>สถานที่ตั้ง</label><input id="b_addr" value="${esc(s.business.address)}"></div>
    <div class="field"><label>เลข อย.</label><input id="b_tax" value="${esc(s.business.taxId)}"></div>
    <div class="field"><label>เลขพาณิชย์</label><input id="b_com" value="${esc(s.business.commercialId)}"></div>
    <div class="field"><label>หมายเลขโทรศัพท์</label><input id="b_phone" value="${esc(s.business.phone)}"></div>
    <div class="field"><label>อีเมลโรงน้ำ</label><input id="b_email" value="${esc(s.business.email)}"></div>
    <div class="field full"><label>ชื่อเมนูระบบ</label><input id="b_menu" value="${esc(s.business.menuName)}"></div>
  </div><div style="display:flex;gap:8px;margin-top:6px"><button class="btn btn-primary" id="saveBiz"><i data-lucide="save"></i> บันทึก</button><button class="btn btn-ghost" id="resetBiz"><i data-lucide="rotate-ccw"></i> รีเซ็ต</button></div></div></div>`;
  else if(settingTab==='header')body=`<div class="panel"><div class="panel-head"><h3><i data-lucide="file-text"></i> โลโก้และหัวกระดาษสำหรับพิมพ์เอกสาร</h3></div><div class="panel-body">
    <label class="perm-item"><input type="checkbox" id="h_logo" ${s.header.showLogo?'checked':''}> แสดงโลโก้ตอนพิมพ์</label>
    <label class="perm-item" style="margin-top:8px"><input type="checkbox" id="h_name" ${s.header.showName?'checked':''}> แสดงชื่อร้านตอนพิมพ์</label>
    <div class="field" style="margin-top:12px"><label>โลโก้ (วาง URL หรือ data URL)</label><input id="h_logoUrl" value="${esc(s.header.logoDataUrl||'')}"></div>
    <button class="btn btn-primary" id="saveHeader" style="margin-top:8px"><i data-lucide="save"></i> บันทึก</button></div></div>`;
  else if(settingTab==='db')body=`<div class="panel"><div class="panel-head"><h3><i data-lucide="database"></i> การเชื่อมต่อฐานข้อมูล Supabase</h3></div><div class="panel-body">
    <div class="field"><label>โหมดฐานข้อมูล</label><select id="d_mode" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:10px"><option value="demo" ${s.db.mode==='demo'?'selected':''}>โหมดสาธิต (บันทึกในเบราว์เซอร์)</option><option value="supabase" ${s.db.mode==='supabase'?'selected':''}>Supabase (ฐานข้อมูลออนไลน์ แนะนำ)</option></select></div>
    <div class="field full"><label>Supabase Project URL</label><input id="d_url" value="${esc(s.db.supabaseUrl||'')}" placeholder="https://xxxxxx.supabase.co"></div>
    <div class="field full"><label>Supabase Publishable / Anon Key (ห้ามใช้ Service Role Key)</label><textarea id="d_sk" rows="2" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:10px" placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...">${esc(s.db.supabaseKey||'')}</textarea></div>
    <p style="font-size:12px;color:var(--muted);margin-bottom:10px">โหมดออนไลน์ต้องรัน SQL ฉบับใหม่และมีบัญชีใน Supabase Authentication ก่อน ล็อกอินด้วยอีเมลและรหัสผ่าน ระบบจะไม่ส่งข้อมูลตัวอย่างขึ้นฐานข้อมูลโดยอัตโนมัติ</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <button class="btn btn-primary" id="saveDb"><i data-lucide="save"></i> บันทึกการเชื่อมต่อ</button>
      <button class="btn btn-navy" id="testDbBtn"><i data-lucide="wifi"></i> ทดสอบการเชื่อมต่อ</button>
      <span id="testDbStatus" style="font-size:12.5px"></span>
    </div>
    <div style="margin-top:14px;border-top:1px dashed var(--border);padding-top:12px">
      <p style="font-size:12.5px;color:var(--muted);margin-bottom:8px"><b>สร้างตารางฐานข้อมูลครั้งแรก:</b> เปิด Supabase → เมนู SQL Editor → กด New query → คัดโค้ดด้านล่างไปวาง → กด Run (ระบบจะสร้างตารางเก็บข้อมูลให้เอง) จากนั้นนำ Project URL + Anon Key มาวางด้านบน</p>
      <textarea readonly rows="10" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:10px;font-size:11px;font-family:monospace;white-space:pre;overflow:auto">${esc(SUPA_SQL)}</textarea>
      <button class="btn btn-ghost btn-sm" id="copyGsBtn" style="margin-top:8px"><i data-lucide="copy"></i> คัดลอก SQL</button>
    </div></div></div>`;
  else if(settingTab==='products'){
    const phtml=DB.products.map((p,i)=>`<div class="panel" style="margin-bottom:10px"><div class="panel-body" style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:10px;align-items:center">
      <input value="${esc(p.code)}" class="p_code" data-i="${i}" style="padding:8px;border:1.5px solid var(--border);border-radius:8px" placeholder="รหัส">
      <input value="${esc(p.name)}" class="p_name" data-i="${i}" style="padding:8px;border:1.5px solid var(--border);border-radius:8px" placeholder="ชื่อสินค้า">
      <input type="number" value="${p.price}" class="p_price" data-i="${i}" style="padding:8px;border:1.5px solid var(--border);border-radius:8px" placeholder="ราคา/หน่วย">
      <label class="perm-item"><input type="checkbox" class="p_ret" data-i="${i}" ${p.returnable?'checked':''}> นำกลับ</label></div></div>`).join('');
    body=`<div class="panel"><div class="panel-head"><h3><i data-lucide="package"></i> การจัดการสินค้า</h3><button class="btn btn-ghost btn-sm" id="addProd"><i data-lucide="plus"></i> เพิ่มสินค้า</button></div><div class="panel-body" id="prodList">${phtml}</div>
    <div class="panel-body" style="border-top:1px solid var(--border)"><button class="btn btn-primary" id="saveProd"><i data-lucide="save"></i> บันทึกรายการสินค้า</button></div></div>`;
  }
  else if(settingTab==='villages'){
    const vhtml=DB.villages.map(v=>`<span class="pill orange" style="margin:3px">${esc(v.name)} <button class="delV" data-id="${v.id}" style="color:var(--red);margin-left:6px;font-weight:700">×</button></span>`).join('');
    body=`<div class="panel"><div class="panel-head"><h3><i data-lucide="map-pinned"></i> รายชื่อหมู่บ้าน (ลูกหนี้บ้านอื่น ๆ)</h3></div><div class="panel-body">
      <div style="margin-bottom:12px">${vhtml||'<span style="color:var(--muted);font-size:13px">ยังไม่มีหมู่บ้านเพิ่มเติม</span>'}</div>
      <div style="display:flex;gap:8px"><input id="v_name" placeholder="ชื่อหมู่บ้าน เช่น บ้านโนนสูง" style="flex:1;padding:10px;border:1.5px solid var(--border);border-radius:10px"><button class="btn btn-gold" id="addVillage"><i data-lucide="plus"></i> เพิ่ม</button></div></div></div>`;
  }
  else if(settingTab==='email')body=`<div class="panel"><div class="panel-head"><h3><i data-lucide="mail"></i> การตั้งค่าอีเมลแจ้งเตือน</h3></div><div class="panel-body"><div class="form-grid">
    <label class="perm-item full"><input type="checkbox" id="em_en" ${s.email.enabled?'checked':''}> เปิดใช้งานการส่งอีเมลแจ้งเตือน</label>
    <div class="field full"><label>อีเมลแอดมินสำหรับรับการแจ้งเตือน</label><input id="em_to" value="${esc(s.email.adminEmail)}"></div>
    <div class="field"><label>ผู้ให้บริการ</label><select id="em_prov" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:10px"><option value="resend" ${s.email.provider==='resend'?'selected':''}>Resend API</option><option value="smtp" ${s.email.provider==='smtp'?'selected':''}>SMTP</option></select></div>
    <div class="field"><label>API Key / SMTP Password</label><input type="password" id="em_key" value="${esc(s.email.apiKey)}"></div>
    <div class="field full"><label>อีเมลผู้ส่ง (โดเมนยืนยันกับ Resend)</label><input id="em_from" value="${esc(s.email.fromEmail||'')}"></div><div class="field"><label>SMTP Host (ตั้งค่าที่เซิร์ฟเวอร์)</label><input id="em_host" value="${esc(s.email.smtpHost)}"></div>
    <div class="field"><label>SMTP Port</label><input id="em_port" value="${esc(s.email.smtpPort)}"></div>
    <div class="field"><label>SMTP User</label><input id="em_user" value="${esc(s.email.smtpUser)}"></div>
    <div class="field full" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <label class="perm-item"><input type="checkbox" id="al_login" ${s.email.alerts.login?'checked':''}> แจ้งพนักงานล็อกอิน</label>
      <label class="perm-item"><input type="checkbox" id="al_logout" ${s.email.alerts.logout?'checked':''}> แจ้งพนักงานออกระบบ</label>
      <label class="perm-item"><input type="checkbox" id="al_add" ${s.email.alerts.addDebtor?'checked':''}> แจ้งเพิ่มรายการลูกหนี้</label>
      <label class="perm-item"><input type="checkbox" id="al_undo" ${s.email.alerts.undoRequest?'checked':''}> แจ้งคำขอกลับไปค้าง</label>
    </div>
  </div><button class="btn btn-primary" id="saveEmail" style="margin-top:6px"><i data-lucide="save"></i> บันทึก</button></div></div>`;
  else if(settingTab==='system')body=`<div class="panel"><div class="panel-head"><h3><i data-lucide="settings-2"></i> ระบบและข้อมูล</h3></div><div class="panel-body">
    <p style="font-size:13px;color:var(--muted);margin-bottom:10px">เลือกหมวดข้อมูลที่ต้องการสำรอง หรือเลือกทั้งหมด (แอดมินเท่านั้น)</p>
    <div class="perm-grid" style="margin-bottom:12px">
      <label class="perm-item"><input type="checkbox" class="bk" data-col="all" checked> ทั้งหมด</label>
      <label class="perm-item"><input type="checkbox" class="bk" data-col="debtors"> ลูกหนี้ค้างชำระ</label>
      <label class="perm-item"><input type="checkbox" class="bk" data-col="customers"> ข้อมูลลูกค้า</label>
      <label class="perm-item"><input type="checkbox" class="bk" data-col="cashsales"> ลูกค้าจ่ายสด</label>
      <label class="perm-item"><input type="checkbox" class="bk" data-col="employees"> พนักงาน</label>
      <label class="perm-item"><input type="checkbox" class="bk" data-col="products"> สินค้า</label>
      <label class="perm-item"><input type="checkbox" class="bk" data-col="villages"> หมู่บ้าน</label>
      <label class="perm-item"><input type="checkbox" class="bk" data-col="audit"> ประวัติการแก้ไข</label>
      <label class="perm-item"><input type="checkbox" class="bk" data-col="approvals"> คำขออนุมัติ</label>
      <label class="perm-item"><input type="checkbox" class="bk" data-col="settings"> การตั้งค่า</label>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-navy" id="backupBtn"><i data-lucide="download"></i> สำรองข้อมูลที่เลือก (JSON)</button>
      <button class="btn btn-ghost" id="restoreBtn"><i data-lucide="upload"></i> กู้คืนจากไฟล์สำรอง</button>
      <input type="file" id="restoreFile" accept="application/json" style="display:none">
      <button class="btn btn-danger" id="resetBtn"><i data-lucide="trash-2"></i> รีเซ็ตข้อมูลทั้งหมด</button>
    </div>
    <div style="margin-top:18px"><h4 style="font-size:13px;color:var(--navy);margin-bottom:8px">อีเมลแจ้งเตือนที่ส่งล่าสุด (${DB.sentEmails.length} รายการ)</h4>
    ${DB.sentEmails.slice(0,5).map(e=>'<div class="audit-item"><span class="ts">'+thDateTime(e.ts)+'</span><span><b>'+esc(e.subject)+'</b> — '+esc(e.status)+'</span></div>').join('')||'<span style="color:var(--muted);font-size:12.5px">ยังไม่มี</span>'}</div>
  </div></div>`;
  $('#pageContent').innerHTML='<div class="page-head"><h2>การตั้งค่าระบบ</h2><span class="desc">แยกเป็นหมวดหมู่ชัดเจน ไม่ต้องแก้ไขโค้ด</span></div><div class="tabs">'+tabsHtml+'</div>'+body;
  $('#pageContent').querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>{settingTab=t.dataset.t;renderSettings();}));
  // save handlers
  const bind=(id,fn)=>{const el=$(id);if(el)el.addEventListener('click',fn);};
  bind('#saveProfile',()=>{const oldName=u.name;const newName=$('#s_name').value.trim();dbUpdate('employees',u.id,{name:newName,code:$('#s_code').value.trim(),email:$('#s_email').value.trim(),avatarUrl:$('#s_avatar').value.trim()});if(newName&&newName!==oldName)sendAlert('profile','[แจ้งเตือน] ผู้ใช้เปลี่ยนชื่อโปรไฟล์','<p>ผู้ใช้รหัส '+esc(u.code)+' ได้เปลี่ยนชื่อจาก <b>'+esc(oldName)+'</b> เป็น <b>'+esc(newName)+'</b></p>');toast('บันทึกโปรไฟล์แล้ว'+(newName!==oldName?' · ตรวจผลอีเมลในประวัติ':''),'success');refreshUserChip();});
  bind('#saveBiz',()=>{Object.assign(s.business,{name:$('#b_name').value,address:$('#b_addr').value,taxId:$('#b_tax').value,commercialId:$('#b_com').value,phone:$('#b_phone').value,email:$('#b_email').value,menuName:$('#b_menu').value});dbSave();toast('บันทึกข้อมูลสถานประกอบการแล้ว','success');});
  bind('#resetBiz',()=>{s.business=defaultSettings().business;dbSave();renderSettings();toast('รีเซ็ตแล้ว','success');});
  bind('#saveHeader',()=>{Object.assign(s.header,{showLogo:$('#h_logo').checked,showName:$('#h_name').checked,logoDataUrl:$('#h_logoUrl').value});dbSave();toast('บันทึกแล้ว','success');});
  bind('#saveDb',async()=>{
    const mode=$('#d_mode').value,url=$('#d_url').value.trim().replace(/\/$/,''),key=$('#d_sk').value.trim();
    if(mode==='supabase'&&(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)||!key)){toast('กรอก Project URL และ Publishable/Anon Key ให้ครบ','error');return;}
    if(key.startsWith('sb_secret_')){toast('ห้ามใช้ Secret Key ในหน้าเว็บ','error');return;}
    try{const part=key.split('.')[1];if(part&&JSON.parse(atob(part.replace(/-/g,'+').replace(/_/g,'/'))).role==='service_role'){toast('ห้ามใช้ Service Role Key','error');return;}}catch(e){}
    const current=supaCfg();
    const sameConnection=mode==='supabase'&&current&&current.url===url&&current.key===key;
    if(sameConnection&&authIdentity){Object.assign(DB.settings.db,{mode,supabaseUrl:url,supabaseKey:key});safeCache();configureLogin();toast('ยืนยันการเชื่อมต่อฐานข้อมูลจริงแล้ว · ยังอยู่ในระบบ','success');return;}
    if(authIdentity){if(FreshySync.diff(remoteBase,FreshySync.shared(DB)).length&&!(await flushOnline())){toast('จัดการข้อมูลรอส่งก่อนเปลี่ยนการเชื่อมต่อ','error');return;}await authFor(supaCfg()).auth.signOut();}
    authIdentity=null;remoteBase=null;syncBlocked=false;session=null;localStorage.removeItem(SESSKEY);
    Object.assign(DB.settings.db,{mode,supabaseUrl:url,supabaseKey:key});safeCache();configureLogin();
    $('#appShell').classList.add('hidden');$('#loginScreen').classList.remove('hidden');toast('เปลี่ยนโครงการฐานข้อมูลแล้ว กรุณายืนยันบัญชีอีกครั้ง','success');
  });
  bind('#testDbBtn',()=>{
    const st=$('#testDbStatus');if(!st)return;
    const url=($('#d_url').value||'').trim().replace(/\/$/,'');const key=($('#d_sk').value||'').trim();
    if(!url||!key){st.textContent='✗ กรุณากรอก Supabase Project URL และ Anon Key ให้ครบ';st.style.color='var(--red)';return;}
    st.textContent='กำลังทดสอบการเชื่อมต่อ...';st.style.color='var(--orange)';
    supabaseTest({url,key}).then(j=>{
      if(j.ok){Object.assign(DB.settings.db,{mode:'supabase',supabaseUrl:url,supabaseKey:key});safeCache();st.textContent='✓ เชื่อมต่อฐานข้อมูล Supabase สำเร็จ (บันทึกแล้ว)';st.style.color='var(--green)';setStatus('เชื่อมต่อฐานข้อมูล Supabase','ok');supabaseFetch();}
      else{st.textContent='✗ ไม่สำเร็จ: '+(j.error||'ไม่ทราบสาเหตุ');st.style.color='var(--red)';}
    });
  });
  bind('#copyGsBtn',()=>{const ta=document.querySelector('#pageContent textarea[readonly]');if(!ta)return;if(navigator.clipboard)navigator.clipboard.writeText(ta.value).then(()=>toast('คัดลอก SQL แล้ว วางใน Supabase → SQL Editor แล้วกด Run','success')).catch(()=>toast('คัดลอก SQL แล้ว','success'));else{ta.select();document.execCommand('copy');toast('คัดลอก SQL แล้ว','success');}});
  bind('#addProd',()=>{DB.products.push({id:uid(),code:'NEW',name:'สินค้าใหม่',price:0,returnable:false});dbSave();renderSettings();});
  bind('#saveProd',()=>{
    $('#prodList').querySelectorAll('.p_code').forEach((el,i)=>{
      const idx=+el.dataset.i; DB.products[idx].code=el.value;
      DB.products[idx].name=$('#prodList').querySelector('.p_name[data-i="'+idx+'"]').value;
      DB.products[idx].price=+$('#prodList').querySelector('.p_price[data-i="'+idx+'"]').value||0;
      DB.products[idx].returnable=$('#prodList').querySelector('.p_ret[data-i="'+idx+'"]').checked;
    });dbSave();toast('บันทึกรายการสินค้าแล้ว','success');
  });
  bind('#addVillage',()=>{const name=$('#v_name').value.trim();if(!name)return;if(DB.villages.some(v=>v.name===name)){toast('ชื่อหมู่บ้านนี้มีอยู่แล้ว','error');return;}dbAdd('villages',{name});toast('เพิ่มหมู่บ้านแล้ว','success');renderSettings();});
  $('#pageContent').querySelectorAll('.delV').forEach(b=>b.addEventListener('click',()=>{dbRemove('villages',b.dataset.id);renderSettings();}));
  bind('#saveEmail',()=>{Object.assign(s.email,{enabled:$('#em_en').checked,adminEmail:$('#em_to').value,provider:$('#em_prov').value,apiKey:$('#em_key').value,fromEmail:$('#em_from').value.trim(),smtpHost:$('#em_host').value,smtpPort:$('#em_port').value,smtpUser:$('#em_user').value,alerts:{login:$('#al_login').checked,logout:$('#al_logout').checked,addDebtor:$('#al_add').checked,undoRequest:$('#al_undo').checked}});dbSave();toast('บันทึกการตั้งค่าอีเมลแล้ว','success');});
  bind('#backupBtn',()=>{
    const all=[...document.querySelectorAll('.bk')].find(c=>c.dataset.col==='all').checked;
    const data={};
    if(all){Object.assign(data,DB);}
    else{document.querySelectorAll('.bk:checked').forEach(c=>{if(c.dataset.col!=='all'&&DB[c.dataset.col])data[c.dataset.col]=DB[c.dataset.col];});}
    if(!Object.keys(data).length){toast('กรุณาเลือกหมวดข้อมูลอย่างน้อย 1 หมวด','error');return;}
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='freshywater-backup-'+todayStr()+'.json';a.click();toast('ดาวน์โหลดไฟล์สำรองแล้ว ('+Object.keys(data).length+' หมวด)','success');
  });
  bind('#restoreBtn',()=>$('#restoreFile').click());
  const rf=$('#restoreFile');if(rf)rf.addEventListener('change',e=>{
    const f=e.target.files[0];if(!f)return;
    const rd=new FileReader();rd.onload=()=>{
      try{const data=JSON.parse(rd.result);
        if(!data||typeof data!=='object')throw new Error('ไฟล์ไม่ถูกต้อง');
        if(!confirm('จะกู้คืนข้อมูลจากไฟล์นี้หรือ? ข้อมูลที่มีอยู่จะถูกผสานทับ (คีย์เดียวกันจะถูกแทนที่)'))return;
        Object.keys(data).forEach(k=>{if(SUPA_COLS.includes(k)&&Array.isArray(data[k])&&DB[k]!==undefined){if(authIdentity){const rows=new Map(DB[k].map(x=>[x.id,x]));data[k].forEach(x=>{if(x&&typeof x==='object'){x.id=x.id||uid();if(k!=='audit'||!rows.has(x.id))rows.set(x.id,x);}});DB[k]=Array.from(rows.values());}else DB[k]=data[k];}});
        if(data.settings){const connection=DB.settings.db;Object.assign(DB.settings,defaultSettings(),data.settings);DB.settings.db=connection;}
        dbSave();toast(authIdentity?'ผสานไฟล์ในเครื่องแล้ว · รอผลบันทึกออนไลน์':'กู้คืนในเครื่องแล้ว','success');renderPage();
      }catch(err){toast('ไฟล์สำรองไม่ถูกต้อง: '+err.message,'error');}
    };rd.readAsText(f);
  });
  bind('#resetBtn',()=>{if(DB.settings.db.mode==='supabase'){toast('ปุ่มนี้ใช้รีเซ็ตโหมดสาธิตเท่านั้น ข้อมูลออนไลน์จะไม่ถูกลบ','info');return;}if(confirm('แน่ใจหรือ? ข้อมูลทั้งหมดจะถูกลบและเริ่มใหม่')){localStorage.removeItem(DBKEY);dbLoad();toast('รีเซ็ตข้อมูลแล้ว','success');renderPage();}});
  if(window.lucide)lucide.createIcons();
}
function refreshUserChip(){const u=me();if(!u)return;$('#userName').textContent=u.name;$('#userRole').textContent=u.role==='admin'?'แอดมินระบบ':'พนักงาน';$('#userAvatar').textContent=u.name.charAt(0);}

/* ============================================================
   PRINT / PDF / EMAIL REPORT (A4, เลขที่เอกสารไม่ซ้ำ)
   ============================================================ */
function nextDocNo(prefix){
  const d=new Date();const key=prefix+pad2(d.getDate())+pad2(d.getMonth()+1)+String(d.getFullYear()).slice(2);
  const n=(DB.settings.doccounters[key]||0)+1;DB.settings.doccounters[key]=n;dbSave();
  return key+'-'+String(n).padStart(3,'0');
}
function docHeader(reportTitle,docNo){
  const s=DB.settings; const d=new Date();
  const logo=s.header.showLogo&&s.header.logoDataUrl?('<img src="'+esc(s.header.logoDataUrl)+'" alt="logo">'):'<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#122c4d" stroke-width="2"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>';
  return `<div class="doc-head">
    <div class="doc-logo">${logo}</div>
    <div class="doc-title">
      ${s.header.showName?`<div class="factory">${esc(s.business.name)}</div>`:''}
      <div class="factory-sub">${esc(s.business.address)}<br>โทรศัพท์ ${esc(s.business.phone)} · เลข อย. ${esc(s.business.taxId||'-')}</div>
      <div class="report-name">${esc(reportTitle)}</div>
    </div>
    <div class="doc-control"><div class="control-label">เอกสารควบคุมของหน่วยงาน</div><strong>เลขที่ ${esc(docNo)}</strong><span>ฉบับที่ 1 · หน้า 1</span><span>ชั้นความลับ: ใช้ภายใน</span></div>
  </div>
  <div class="doc-meta">
    <div><b>ส่วนงาน</b> งานทะเบียนและติดตามลูกหนี้</div>
    <div><b>วันที่ออกเอกสาร</b> ${pad2(d.getDate())}/${pad2(d.getMonth()+1)}/${d.getFullYear()+543} · ${pad2(d.getHours())}:${pad2(d.getMinutes())} น.</div>
    <div class="doc-no">เลขอ้างอิง ${esc(docNo)}</div>
  </div>`;
}
function docFooter(docNo){
  const u=me();
  return `<div class="sign-row">
    <div class="sign-box"><div class="line">${esc(u.name)}</div><div class="role">ผู้จัดทำข้อมูล</div><div class="sign-date">วันที่ ____/____/______</div></div>
    <div class="sign-box"><div class="line">&nbsp;</div><div class="role">พนักงานส่งน้ำ</div><div class="sign-date">วันที่ ____/____/______</div></div>
    <div class="sign-box"><div class="line">&nbsp;</div><div class="role">ผู้ตรวจสอบ</div><div class="sign-date">วันที่ ____/____/______</div></div>
    <div class="sign-box"><div class="line">&nbsp;</div><div class="role">ผู้อนุมัติ</div><div class="sign-date">วันที่ ____/____/______</div></div>
  </div>
  <div class="doc-foot"><span><strong>เลขที่เอกสาร ${esc(docNo)}</strong> · เอกสารภายใน ห้ามแก้ไขโดยไม่ได้รับอนุญาต</span><span>ระบบสารสนเทศจัดการลูกหนี้ · เฟรชชี่ วอเตอร์</span></div>`;
}
function buildDebtorReportHtml(area,filter,mode){
  let rows=DB.debtors.filter(d=>d.area===area&&d.status==='unpaid');
  if(area==='nai'&&filter&&filter!=='all')rows=rows.filter(d=>d.moo===filter);
  if(area==='other'&&filter&&filter!=='all')rows=rows.filter(d=>d.village===filter);
  const groups={};rows.forEach(d=>{(groups[d.customerId]=groups[d.customerId]||[]).push(d);});
  const docNo=nextDocNo(DB.settings.docPrefix.debtor);
  let body=docHeader('รายงานลูกหนี้ค้างชำระ '+(area==='nai'?'บ้านนาไฮ':'บ้านอื่น ๆ')+(filter&&filter!=='all'?' ('+(area==='nai'?'หมู่ที่ '+filter:filter)+')':''),docNo);
  const renderGroup=(list,title)=>{
    let h='';if(title)h+='<div class="doc-section-title">'+esc(title)+'</div>';
    Object.keys(list).forEach(cid=>{
      const dl=list[cid].sort((a,b)=>a.debtDate<b.debtDate?-1:1);
      const tj=dl.reduce((s,d)=>s+(d.jugs||0),0),tp=dl.reduce((s,d)=>s+(d.packs||0),0),tt=dl.reduce((s,d)=>s+d.total,0);
      h+='<table class="doc-table"><thead><tr><th>ลำดับ</th><th>ชื่อลูกหนี้</th><th>วันที่ค้าง</th><th>ถัง</th><th>แพ็ค</th><th>เงินน้ำถัง</th><th>เงินน้ำแพ็ค</th><th>ยอดรวม</th></tr></thead><tbody>';
      dl.forEach((d,i)=>{h+=`<tr><td>${i+1}</td><td class="l">${i===0?esc(d.customerName):''}</td><td>${thDate(d.debtDate)}</td><td>${d.jugs||0}</td><td>${d.packs||0}</td><td class="r">${fmtN(d.jugAmount)}</td><td class="r">${fmtN(d.packAmount)}</td><td class="r">${fmtN(d.total)}</td></tr>`;});
      h+='</tbody></table><div class="doc-summary">รวม '+esc(dl[0].customerName)+' : '+tj+' ถัง, '+tp+' แพ็ค, รวมทั้งหมด '+fmtN(tt)+' บาท</div><div class="doc-gap"></div>';
    });
    return h;
  };
  if(mode==='split'&&area==='nai'){
    const g7={},g16={};Object.keys(groups).forEach(cid=>{const m=groups[cid][0].moo==='7'?g7:g16;m[cid]=groups[cid];});
    body+=renderGroup(g7,'หมู่ที่ 7')+renderGroup(g16,'หมู่ที่ 16');
  }else if(mode==='split'&&area==='other'){
    const byV={};Object.keys(groups).forEach(cid=>{const v=groups[cid][0].village||'อื่น ๆ';(byV[v]=byV[v]||{})[cid]=groups[cid];});
    Object.keys(byV).forEach(v=>{body+=renderGroup(byV[v],v);});
  }else body+=renderGroup(groups,'');
  body+=docFooter(docNo);
  return {html:body,docNo};
}
function openPrintOptions(area){
  openModal(`<div class="modal-head"><h3><i data-lucide="printer"></i> ตัวเลือกการปริ้นรายงาน</h3><button class="x" onclick="closeModal()"><i data-lucide="x"></i></button></div>
  <div class="modal-body">
    <div class="field"><label>รูปแบบการปริ้น</label><select id="po_mode" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:10px"><option value="combined">ปริ้นรวม (ทุกหมู่ในรายงานเดียว)</option><option value="split">ปริ้นแยก (แยกตามหมู่/หมู่บ้าน)</option></select></div>
    <div class="field"><label>กรองข้อมูล</label><select id="po_filter" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:10px"><option value="all">ทั้งหมด</option>${area==='nai'?'<option value="7">เฉพาะหมู่ที่ 7</option><option value="16">เฉพาะหมู่ที่ 16</option>':DB.villages.map(v=>'<option value="'+esc(v.name)+'">'+esc(v.name)+'</option>').join('')}</select></div>
    <p style="font-size:12px;color:var(--muted)">ระบบจะเปิดหน้าพิมพ์ A4 ให้เลือกบันทึกเป็น PDF หรือส่งไปเครื่องพิมพ์ เลขที่เอกสารไม่ซ้ำกันอัตโนมัติ</p>
  </div>
  <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">ยกเลิก</button><button class="btn btn-primary" id="doPrint"><i data-lucide="printer"></i> ปริ้น / ส่งออก PDF</button></div>`);
  $('#doPrint').addEventListener('click',()=>{const r=buildDebtorReportHtml(area,$('#po_filter').value,$('#po_mode').value);$('#printArea').innerHTML='<div class="doc-page">'+r.html+'</div>';closeModal();setTimeout(()=>window.print(),200);});
}
function printCashReport(date){
  const rows=DB.cashsales.filter(r=>r.deliveryDate===date);
  const docNo=nextDocNo(DB.settings.docPrefix.cash);
  let body=docHeader('รายงานการส่งน้ำยอดเงินลูกค้าจ่ายสด วันที่ '+thDate(date),docNo);
  body+='<table class="doc-table"><thead><tr><th>ลำดับ</th><th>รหัส</th><th>ชื่อลูกค้า</th><th>หมู่บ้าน</th><th>หมู่ที่</th><th>ถัง</th><th>แพ็ค</th><th>เงินถัง</th><th>เงินแพ็ค</th><th>รวม</th></tr></thead><tbody>';
  rows.forEach((r,i)=>{body+=`<tr><td>${i+1}</td><td>${esc(r.customerCode)}</td><td class="l">${esc(r.customerName)}</td><td>${esc(r.village||'-')}</td><td>${esc(r.moo||'-')}</td><td>${r.jugs}</td><td>${r.packs}</td><td class="r">${fmtN(r.jugAmount)}</td><td class="r">${fmtN(r.packAmount)}</td><td class="r">${fmtN(r.jugAmount+r.packAmount)}</td></tr>`;});
  const tj=rows.reduce((s,r)=>s+r.jugs,0),tp=rows.reduce((s,r)=>s+r.packs,0),tt=rows.reduce((s,r)=>s+r.jugAmount+r.packAmount,0);
  body+=`<tr style="background:#eef2f7;font-weight:700"><td colspan="5">รวมทั้งหมด</td><td>${tj}</td><td>${tp}</td><td class="r">${fmtN(rows.reduce((s,r)=>s+r.jugAmount,0))}</td><td class="r">${fmtN(rows.reduce((s,r)=>s+r.packAmount,0))}</td><td class="r">${fmtN(tt)}</td></tr></tbody></table>`;
  body+=`<div class="sign-row">
    <div class="sign-box"><div class="line">${esc(me().name)}</div><div class="role">ผู้ออกเอกสาร</div></div>
    <div class="sign-box"><div class="line">&nbsp;</div><div class="role">ข้อมูลจากฐานระบบ</div></div>
    <div class="sign-box"><div class="line">&nbsp;</div><div class="role">ชื่อผู้รับผิดชอบ</div></div>
    <div class="sign-box"><div class="line">&nbsp;</div><div class="role">ผู้ส่งน้ำ</div></div>
    <div class="sign-box"><div class="line">&nbsp;</div><div class="role">ผู้ตรวจสอบ / หัวหน้า</div></div>
  </div><div class="doc-foot">เลขที่เอกสาร ${docNo} ออกเอกสารโดยระบบจัดการลูกหนี้โรงน้ำดื่ม เฟรชชี่ วอเตอร์</div>`;
  $('#printArea').innerHTML='<div class="doc-page">'+body+'</div>';
  setTimeout(()=>window.print(),200);
}
function openEmailReport(kind){
  openModal(`<div class="modal-head"><h3><i data-lucide="mail"></i> ส่งรายงานทางอีเมล</h3><button class="x" onclick="closeModal()"><i data-lucide="x"></i></button></div>
  <div class="modal-body"><div class="form-grid">
    <div class="field full"><label>อีเมลผู้รับ (คั่นด้วยเครื่องหมายจุลภาค)</label><input id="er_to" value="${esc(DB.settings.email.adminEmail||'')}"></div>
    <div class="field full"><label>รูปแบบอีเมล</label><select id="er_fmt" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:10px"><option value="simple">แบบเรียบง่าย</option><option value="formal">แบบเป็นทางการ</option></select></div>
    <p style="font-size:12px;color:var(--muted);grid-column:1/-1">ระบบจะแนบรายงานเป็น HTML ในอีเมล ต้องตั้งค่าผู้ให้บริการอีเมลในหน้าการตั้งค่าก่อน</p>
  </div></div>
  <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">ยกเลิก</button><button class="btn btn-gold" id="doSendEmail"><i data-lucide="send"></i> ส่งรายงาน</button></div>`);
  $('#doSendEmail').addEventListener('click',async()=>{
    const to=$('#er_to').value.trim();if(!to){toast('กรุณากรอกอีเมลผู้รับ','error');return;}
    let r;
    if(kind==='cash')r={html:'(รายงานลูกค้าจ่ายสด)',docNo:nextDocNo(DB.settings.docPrefix.cash)};
    else if(kind&&kind.startsWith('customers-'))r=buildCustomerReportHtml(kind.split('-')[1]);
    else r=buildDebtorReportHtml(kind==='nai'?'nai':'other','all','combined');
    const sent=await sendAlert('report','[รายงาน] '+ (kind==='cash'?'รายงานลูกค้าจ่ายสด':'รายงานลูกหนี้') +' เลขที่ '+r.docNo, ( $('#er_fmt').value==='formal'?'<p>เรียน ผู้เกี่ยวข้อง</p><p>ทางโรงน้ำดื่ม เฟรชชี่ วอเตอร์ ขอส่งรายงานฉบับนี้ให้เพื่อทราบ</p><hr>':'<p>ส่งรายงานให้ครับ</p>') + r.html,to);
    if(sent){closeModal();toast('ผู้ให้บริการรับรายงานแล้ว','success');}
  });
}

/* ============================================================
   PRIVACY PROTECTION (ป้องกันแคปหน้าจอ / เปิดซ้อนหน้าจอ)
   ============================================================ */
const overlay=$('#privacyOverlay');
function showPrivacy(){if(!session)return;overlay.classList.remove('hidden');}
function hidePrivacy(){overlay.classList.add('hidden');}
window.addEventListener('blur',showPrivacy);
window.addEventListener('focus',hidePrivacy);
document.addEventListener('visibilitychange',()=>{if(document.hidden)showPrivacy();else hidePrivacy();});
document.addEventListener('keydown',e=>{
  if(e.key==='PrintScreen'||(e.ctrlKey&&(e.key==='p'||e.key==='P'||e.key==='s'||e.key==='S'))||(e.ctrlKey&&e.shiftKey&&(e.key==='I'||e.key==='J'||e.key==='C'))){
    e.preventDefault();showPrivacy();toast('สงวนสิทธิ์ ไม่สามารถแคปหน้าจอหรือเปิดซ้อนหน้าจอได้','error');
    setTimeout(hidePrivacy,1500);
  }
});
document.addEventListener('contextmenu',e=>{if(session){e.preventDefault();toast('สงวนสิทธิ์ ข้อมูลส่วนบุคคล ห้ามคลิกขวา','error');}});
document.addEventListener('dragstart',e=>e.preventDefault());

/* ============================================================
   LOGIN / LOGOUT
   ============================================================ */
$('#loginBtn').addEventListener('click',doLogin);
$('#loginCode').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin();});
$('#loginCode').addEventListener('input',()=>{
  if(DB.settings.db.mode==='supabase')return;
  const v=$('#loginCode').value.trim(); const pv=$('#loginNamePreview'); if(!pv)return;
  if(!v){pv.classList.add('hidden');return;}
  const u=DB.employees.find(e=>e.code===v);
  if(u){pv.classList.remove('hidden');pv.classList.remove('err');pv.innerHTML='<i data-lucide="user-check" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px"></i>ยินดีต้อนรับ คุณ'+esc(u.name)+' · '+(u.role==='admin'?'แอดมินระบบ':'พนักงาน');if(window.lucide)lucide.createIcons();}
  else{pv.classList.remove('hidden');pv.classList.add('err');pv.textContent='รหัสนี้ยังไม่ตรงกับผู้ใช้ใด ๆ';}
});
async function doLogin(){
  if(DB.settings.db.mode==='supabase'){const btn=$('#loginBtn');btn.disabled=true;try{await startOnline($('#loginEmail').value.trim(),$('#loginPassword').value);$('#loginPassword').value='';}catch(e){toast('เข้าสู่ระบบไม่สำเร็จ: '+e.message,'error');}finally{btn.disabled=false;}return;}
  const code=$('#loginCode').value.trim();
  const u=DB.employees.find(e=>e.code===code);
  if(!u){toast('รหัสผู้ใช้งานไม่ถูกต้อง','error');return;}
  session={empId:u.id,loginAt:new Date().toISOString()};
  localStorage.setItem(SESSKEY,JSON.stringify(session));
  if(DB.settings.email.alerts.login&&u.role!=='admin')sendAlert('login','[แจ้งเตือน] พนักงานล็อกอินเข้าระบบ','<p>พนักงาน <b>'+esc(u.name)+'</b> ล็อกอินเข้าระบบเมื่อ '+thDateTime(new Date().toISOString())+'</p>');
  enterApp();
}
function enterApp(){
  const qrCustomer=new URLSearchParams(location.search).get('qr');
  if(qrCustomer){renderPublicQrReport(qrCustomer);return;}
  $('#loginScreen').classList.add('hidden');
  $('#appShell').classList.remove('hidden');
  refreshUserChip();
  const _m=DB.settings.db.mode;if(syncBlocked)setStatus('ข้อมูลรอส่ง · ต้องตรวจสอบก่อนบันทึก','err');else{setStatus(_m==='supabase'?'กำลังตรวจสอบฐานข้อมูล':'โหมดสาธิต','info');if(_m==='supabase')supabaseFetch();}
  navigate(new URLSearchParams(location.search).has('approval')&&isAdmin()?'approvals':'dashboard');
}
$('#logoutBtn').addEventListener('click',()=>{
  openModal(`<div class="modal-head"><h3><i data-lucide="log-out"></i> ยืนยันออกจากระบบ</h3><button class="x" onclick="closeModal()"><i data-lucide="x"></i></button></div>
  <div class="modal-body"><p>หากออกจากระบบแล้ว ระบบจะส่งอีเมลแจ้งเตือนไปหาแอดมิน และคุณจะต้องกรอกรหัสผู้ใช้งานอีกครั้งเพื่อเข้าใช้งาน ข้อมูลทั้งหมดที่บันทึกไว้จะยังคงอยู่ในระบบ</p></div>
  <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">ยกเลิก</button><button class="btn btn-danger" id="confirmLogout"><i data-lucide="log-out"></i> ยืนยันออกจากระบบ</button></div>`);
  $('#confirmLogout').addEventListener('click',async()=>{
    if(authIdentity){const pending=FreshySync.diff(remoteBase||{},FreshySync.shared(DB));if(pending.length&&!(await flushOnline())){toast('ยังมีข้อมูลรอส่ง กรุณาจัดการก่อนออกจากระบบ','error');return;}}
    const u=me();
    if(DB.settings.email.alerts.logout&&u&&u.role!=='admin')await sendAlert('logout','[แจ้งเตือน] พนักงานออกจากระบบ','<p>พนักงาน <b>'+esc(u.name)+'</b> ออกจากระบบเมื่อ '+thDateTime(new Date().toISOString())+'</p>');
    if(authIdentity){await flushOnline();await authFor(supaCfg()).auth.signOut();authIdentity=null;remoteBase=null;syncBlocked=false;}
    session=null;localStorage.removeItem(SESSKEY);
    closeModal();$('#appShell').classList.add('hidden');$('#loginScreen').classList.remove('hidden');$('#loginCode').value='';
    toast('ออกจากระบบแล้ว','success');
  });
});
$('#menuToggle').addEventListener('click',()=>$('#sidebar').classList.toggle('open'));
const mobileNavScrim=$('#mobileNavScrim');
if(mobileNavScrim)mobileNavScrim.addEventListener('click',()=>$('#sidebar').classList.remove('open'));

/* ============================================================
   REAL TIME SYNC (polling ทุก 5 วินาที)
   ============================================================ */
let lastDataHash='';
function dataHash(){return JSON.stringify(DB).length+'_'+DB.debtors.length+'_'+DB.cashsales.length+'_'+DB.audit.length;}
setInterval(()=>{
  if(!session)return;
  if(DB.settings.db.mode!=='supabase')dbLoad();
  const h=dataHash();
  if(h!==lastDataHash){lastDataHash=h;renderPage();if(window.lucide)lucide.createIcons();}
  // ถ้าโหมด Sheets จะดึงจาก /api/sheets ทุก 15 วินาที
},5000);
setInterval(()=>{if(DB&&DB.settings.db.mode==='supabase'&&session)supabaseFetch();},10000);

/* ============================================================
   INIT
   ============================================================ */
dbLoad();
/* ---------- ธีม (สว่าง/มืด/ตามระบบ) + สถานะการเชื่อมต่อ ---------- */
const THEMEKEY='freshy_theme';
function applyTheme(){
  let pref=localStorage.getItem(THEMEKEY)||'auto';
  let t=pref==='auto'?(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):pref;
  document.documentElement.setAttribute('data-theme',t);
  const btn=$('#themeToggle');if(btn){btn.innerHTML='<i data-lucide="'+(t==='dark'?'sun':'moon')+'"></i><span id="themeLabel" style="font-size:11px;margin-left:2px">'+(pref==='auto'?'อัตโนมัติ':t==='dark'?'มืด':'สว่าง')+'</span>';if(window.lucide)lucide.createIcons();}
}
function cycleTheme(){const cur=localStorage.getItem(THEMEKEY)||'auto';const next=cur==='light'?'dark':cur==='dark'?'auto':'light';localStorage.setItem(THEMEKEY,next);applyTheme();}
applyTheme();
if(window.matchMedia)window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change',applyTheme);
function setStatus(text,cls){const el=$('#modeTag');if(!el)return;el.className='status-tag '+(cls||'info');const t=$('#modeTagText');if(t)t.textContent=text;}
window.addEventListener('online',()=>{if(authIdentity)supabaseFetch();else setStatus(DB.settings.db.mode==='supabase'?'ออนไลน์ · กรุณาเข้าสู่ระบบ':'โหมดสาธิต','info');});
window.addEventListener('offline',()=>setStatus('ไม่มีการเชื่อมต่ออินเทอร์เน็ต ไม่สามารถบันทึกได้','err'));
if(!navigator.onLine)setStatus('ไม่มีการเชื่อมต่ออินเทอร์เน็ต','err');
if(DB.settings.db.mode==='supabase')setStatus('ออนไลน์ · กรุณาเข้าสู่ระบบ','info');
const tbtn=$('#themeToggle');if(tbtn)tbtn.addEventListener('click',cycleTheme);
/* กด Enter บนหน้าลูกหนี้ = เปิดฟอร์มเพิ่มรายการลูกหนี้ทันที (หลังบันทึกเสร็จ กด Enter อีกครั้ง = เพิ่มรายต่อไป) */
document.addEventListener('keydown',e=>{
  if(e.key!=='Enter')return;
  if(currentPage!=='debtorsNai'&&currentPage!=='debtorsOther')return;
  if(modalIsOpen())return;
  const t=e.target;
  if(t&&(t.tagName==='INPUT'||t.tagName==='SELECT'||t.tagName==='TEXTAREA'||t.tagName==='BUTTON'))return;
  e.preventDefault();
  const b=document.querySelector('#addDebtorBtn');
  if(b)b.click();
});
// Approval links identify the request; only an authenticated admin can decide in the approvals page.
const _qr=new URLSearchParams(location.search).get('qr');
if(_qr&&DB.settings.db.mode!=='supabase'){renderPublicQrReport(_qr);return;}
try{session=JSON.parse(localStorage.getItem(SESSKEY));}catch(e){session=null;}
if(DB.settings.db.mode==='supabase'){session=null;configureLogin();resumeOnline();}else{configureLogin();if(session&&DB.employees.find(e=>e.id===session.empId))enterApp();}
if(window.lucide)lucide.createIcons();
lastDataHash=dataHash();


$('#loginPassword').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin();});
$('#connectSave').onclick=()=>{
 const url=$('#connectUrl').value.trim().replace(/\/$/,''),key=$('#connectKey').value.trim(),adminEmail=$('#connectAdmin').value.trim();
 if(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)||!key){toast('กรอก Project URL และ Publishable/Anon Key ให้ครบ','error');return;}
 if(key.startsWith('sb_secret_')){toast('ห้ามใส่ Secret หรือ Service Role Key ในหน้าเว็บ','error');return;}
 try{const part=key.split('.')[1];if(part&&JSON.parse(atob(part.replace(/-/g,'+').replace(/_/g,'/'))).role==='service_role'){toast('ห้ามใช้ Service Role Key','error');return;}}catch(e){}
 Object.assign(DB.settings.db,{mode:'supabase',supabaseUrl:url,supabaseKey:key,adminEmail});safeCache();configureLogin();toast('บันทึกการเชื่อมต่อฐานข้อมูลจริงแล้ว','success');
};
$('#downloadSql').onclick=()=>{
 const email=$('#connectAdmin').value.trim();if(!/^[^\s@']+@[^\s@']+\.[^\s@']+$/.test(email)){toast('กรอกอีเมลแอดมินจริงก่อน','error');return;}
 const sql=SUPA_SQL.replaceAll('CHANGE_ADMIN_EMAIL@example.com',email);
 // Preserve the bootstrap guard sentinel after substituting the declaration.
 const corrected=sql.replace("if admin_email = '"+email+"' then","if admin_email = 'CHANGE_ADMIN_EMAIL@example.com' then");
 const blob=new Blob([corrected],{type:'text/plain'}),u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download='database.sql';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);
};
$('#useDemo').onclick=async()=>{if(!confirm('เปิดโหมดสาธิตในเครื่องนี้? ข้อมูลออนไลน์จะไม่ถูกเปลี่ยน'))return;if(authClient)await authClient.auth.signOut();const cfg=DB.settings.db;authIdentity=null;remoteBase=null;DB=seed();DB.settings.db=Object.assign({},cfg,{mode:'demo'});session=null;localStorage.removeItem(SESSKEY);dbSave();configureLogin();};
// expose for inline onclick handlers
window.closeModal=closeModal;
})();
