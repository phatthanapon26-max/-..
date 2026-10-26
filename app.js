/* ============================================================
   ระบบจัดการลูกหนี้ โรงน้ำดื่ม เฟรชชี่ วอเตอร์ — app.js
   - ฐานข้อมูล: Supabase Auth + protected RPC หรือโหมดสาธิต localStorage
   - realtime broadcast, แยกจ่ายแล้ว/ค้างชำระ, แยกบ้านนาไฮ/บ้านอื่น
   ============================================================ */
(function(){
'use strict';

/* New workflows deliberately keep the original database and pending queue. */
let dashboardDays=7,notificationHistory=[],adminScheduleTimer=null,backupBusy=false,backupFolder=null,backupFolderLoaded=false,lastScheduledAttempt=0;
// Lucide retains its source attribute on generated SVGs; render only new placeholders.
function renderIcons(){
 if(!window.lucide||!document.querySelector('i[data-lucide]'))return;
 document.querySelectorAll('svg[data-lucide]').forEach(icon=>icon.removeAttribute('data-lucide'));
 lucide.createIcons();
}
function bindSearch(input,onValue,render){
 let timer;
 input.addEventListener('input',()=>{
  onValue(input.value.trim());clearTimeout(timer);
  timer=setTimeout(()=>{
   if(!input.isConnected)return;
   const focus=document.activeElement===input,start=input.selectionStart,end=input.selectionEnd;
   render();
   const next=document.getElementById(input.id);
   if(focus&&next){next.focus({preventScroll:true});if(Number.isInteger(start))next.setSelectionRange(start,end);}
  },160);
 });
}
function localQr(url){const qr=qrcode(0,'M');qr.addData(url);qr.make();return 'data:image/svg+xml;base64,'+btoa(qr.createSvgTag({cellSize:3,margin:12,scalable:true}));}
async function apiRequest(path,options={}){
 if(!authIdentity)throw Error('กรุณาเข้าสู่ระบบออนไลน์');const {data,error}=await authFor(supaCfg()).auth.getSession();if(error||!data.session)throw Error('เซสชันหมดอายุ');
 const r=await fetch(path,{...options,headers:{'Content-Type':'application/json',Authorization:'Bearer '+data.session.access_token,...options.headers},signal:AbortSignal.timeout(28000)});const j=await r.json();if(!r.ok||!j.ok)throw Error(j.error||'ดำเนินการไม่สำเร็จ');return j;
}
async function persistDocument(html,docNo,privateOnly=false){
 if(authIdentity&&!(await flushOnline()))throw Error('ยังมีข้อมูลรอส่ง กรุณาซิงก์ให้สำเร็จก่อนออก QR');
 const snapshot=FreshyFeatures.documentSnapshot(html,docNo,DB.settings.business,me(),document);if(!authIdentity){if(DB.settings.db.mode!=='demo')throw Error('กรุณาเข้าสู่ระบบก่อนออกเอกสาร');const id=crypto.randomUUID().replaceAll('-','').padEnd(64,'0');DB.sentEmails.unshift({id:'document:'+id,type:'document',createdBy:me().id,ts:snapshot.issuedAt,document:snapshot});dbSave();if(snapshot.invoice?.version===2)invoiceIssued.loaded=false;return null;}const result=await apiRequest('/api/document',{method:'POST',body:JSON.stringify({snapshot,private:privateOnly})});
 if(snapshot.invoice?.version===2)invoiceIssued.loaded=false;
 return location.origin+'/document?id='+result.id+(result.access==='private'?'&access=private':'');
}
async function preparePrint(html,docNo,showQr){
 if(html.includes('data-invoice='))showQr=false;
 if(showQr===undefined){openModal('<div class="modal-head"><h3>ตัวเลือกเอกสาร A4</h3><button class="x" onclick="closeModal()">×</button></div><div class="modal-body"><p>เอกสารพื้นขาว ตัวอักษรดำ พร้อมเลขอ้างอิงและช่องลงนาม</p><label class="perm-item"><input id="printDocumentQr" type="checkbox" checked> แสดง QR เอกสารตรงมุมบนขวา</label><p class="help-text">QR เปิดเอกสารฉบับนี้ตามสิทธิ์บัญชี ผู้สแกนต้องเข้าสู่ระบบ</p></div><div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">ยกเลิก</button><button id="confirmDocumentPrint" class="btn btn-primary">พิมพ์ / บันทึก PDF</button></div>');$('#confirmDocumentPrint').onclick=()=>preparePrint(html,docNo,$('#printDocumentQr').checked);return;}
 const button=$('#confirmDocumentPrint')||$('#doPrint');if(button){button.disabled=true;button.textContent='กำลังเตรียมเอกสาร…';}
 try{const qrUrl=await persistDocument(html,docNo,!showQr);$('#printArea').innerHTML='<div class="doc-page">'+html+'</div>';
 if(showQr&&qrUrl){const control=$('#printArea .doc-control');const img=document.createElement('img');img.src=localQr(qrUrl);img.className='document-qr';img.alt='QR เอกสาร '+docNo;control.prepend(img);}
 closeModal();const previousTitle=document.title;document.title=docNo+' '+DB.settings.business.name;window.addEventListener('afterprint',()=>{document.title=previousTitle;},{once:true});if(document.fonts)await document.fonts.ready;await Promise.all([...$('#printArea').querySelectorAll('img')].map(img=>img.complete?Promise.resolve():new Promise(resolve=>{img.onload=resolve;img.onerror=resolve;setTimeout(resolve,5000);})));window.print();
 }catch(e){if(button&&button.isConnected){button.disabled=false;button.textContent='ลองเตรียมเอกสารอีกครั้ง';}toast(e.message,'error');}
}
function askContinueDebtor(area){
 openModal('<div class="modal-head"><h3>บันทึกเรียบร้อยแล้ว</h3></div><div class="modal-body"><p>ต้องการเพิ่มรายการลูกหนี้ต่ออีกหรือไม่?</p><p class="help-text">Enter = เพิ่มต่อ · Backspace / Delete = เสร็จสิ้น</p></div><div class="modal-foot"><button class="btn btn-ghost" id="finishDebtorEntry">ยกเลิก / เสร็จสิ้น</button><button class="btn btn-primary" id="continueDebtorEntry">ยืนยันเพิ่มต่อ</button></div>');
 const box=$('#modalBox');const finish=()=>{closeModal();$('#addDebtorBtn')?.focus();};$('#finishDebtorEntry').onclick=finish;$('#continueDebtorEntry').onclick=()=>openAddDebtor(area);
 box.tabIndex=-1;box.focus();box.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();e.stopPropagation();openAddDebtor(area);}else if(['Backspace','Delete','Escape'].includes(e.key)){e.preventDefault();e.stopPropagation();finish();}};
}
async function ensureVillage(name){
 const found=DB.villages.find(v=>v.name.trim()===name);if(found){const code=FreshyFeatures.villageCode(DB.villages,name);if(!found.code&&isAdmin()){dbUpdate('villages',found.id,{code});if(authIdentity&&!(await flushOnline()))throw Error('รหัสหมู่บ้านยังรอส่ง กรุณาตรวจสถานะฐานข้อมูล');}return {...found,code};}
 if(isAdmin()||!authIdentity){const row=dbAdd('villages',{name,code:FreshyFeatures.villageCode(DB.villages,name),createdBy:me().id});if(authIdentity&&!(await flushOnline()))throw Error('รหัสหมู่บ้านยังรอส่ง กรุณาตรวจฐานข้อมูลก่อนบันทึกลูกหนี้');return row;}
 const result=await apiRequest('/api/village',{method:'POST',body:JSON.stringify({name})});await supabaseFetch();return result.village;
}
function attachCsv(){
 const pages=['debtorsNai','debtorsOther','customersNai','customersOther','paymentsNai','paymentsOther','cashsales'];if(!pages.includes(currentPage)||$('#exportCsv'))return;
 const target=$('#pageContent .actions')||$('#pageContent .page-head');if(!target)return;const button=document.createElement('button');button.id='exportCsv';button.className='btn btn-ghost btn-sm csv-btn';button.textContent='ส่งออก CSV';target.append(button);
 button.onclick=()=>{const area=currentPage.endsWith('Nai')?'nai':'other';let headers,rows;
 if(currentPage.startsWith('customers')){let data=DB.customers.filter(x=>x.area===area);const query=custSearch[area]||'';if(query)data=data.filter(x=>x.name.includes(query)||String(x.code||'').toLowerCase().includes(query.toLowerCase()));if(custCredit[area]!=='all')data=data.filter(x=>creditStatus(x.id).txt===custCredit[area]);headers=['รหัสลูกค้า','ชื่อลูกค้า','หมู่ที่','หมู่บ้าน','รหัสหมู่บ้าน','ที่อยู่','วันที่บันทึก'];rows=data.map(x=>[x.code,x.name,x.moo,x.village,x.villageCode,x.address,x.createdAt]);}
 else if(currentPage==='cashsales'){const data=scopeRows(DB.cashsales).filter(x=>x.deliveryDate===cashDateFilter);headers=['รหัสลูกค้า','ชื่อลูกค้า','วันที่ส่ง','หมู่ที่','หมู่บ้าน','ถัง','แพ็ค','เงินถัง','เงินแพ็ค','ยอดรวม'];rows=data.map(x=>[x.customerCode,x.customerName,x.deliveryDate,x.moo,x.village,x.jugs,x.packs,x.jugAmount,x.packAmount,Number(x.jugAmount||0)+Number(x.packAmount||0)]);}
 else{const paid=currentPage.startsWith('payments');let data=scopeRows(DB.debtors).filter(x=>x.area===area&&x.status===(paid?'paid':'unpaid'));const query=paid?paySearch:debtorSearch;if(query)data=data.filter(x=>x.customerName.includes(query));if(!paid&&debtorFilter[area]!=='all')data=data.filter(x=>String(area==='nai'?x.moo:x.village)===debtorFilter[area]);const customers=new Map(DB.customers.map(x=>[x.id,x]));headers=['รหัสลูกค้า','ชื่อลูกหนี้','วันที่ค้าง','หมู่ที่','หมู่บ้าน','รหัสหมู่บ้าน','ถัง','แพ็ค','เงินถัง','เงินแพ็ค','ยอดรวม','สถานะ','วันที่รับชำระ'];rows=data.map(x=>[customers.get(x.customerId)?.code||'',x.customerName,x.debtDate,x.moo,x.village,x.villageCode,x.jugs,x.packs,x.jugAmount,x.packAmount,x.total,paid?FreshyPayments.label(x):'ค้างชำระ',x.paidAt||'']);}
 const blob=new Blob([FreshyFeatures.csv(headers,rows)],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='freshy-'+currentPage+'-'+todayStr()+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('เริ่มดาวน์โหลด CSV '+rows.length+' รายการ','info');};
}
async function loginByCode(){
 const code=$('#loginEmployeeCode').value.trim(),password=$('#loginPassword').value,email=$('#loginEmail').value.trim();if(!password)throw Error('กรุณากรอกรหัสผ่าน');
 if(email){await startOnline(email,password);return;}if(!code)throw Error('กรุณากรอกรหัสพนักงาน');
 if(code.includes('@')){await startOnline(code,password);return;}const known=code==='7716'?DB.settings.db.adminEmail:verifiedLoginDirectory()[code];if(known){try{await startOnline(known,password);$('#loginEmail').value=known;return;}catch(e){if(!/Invalid login credentials/i.test(e.message))throw e;}}
 const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,password}),signal:AbortSignal.timeout(25000)}),j=await r.json();if(!r.ok||!j.ok)throw Error(j.error||'เข้าสู่ระบบไม่สำเร็จ');
 const {error}=await authFor(supaCfg()).auth.setSession({access_token:j.access_token,refresh_token:j.refresh_token});if(error)throw error;$('#loginEmail').value=j.email||'';await resumeOnline();
}
function verifiedLoginDirectory(){try{return JSON.parse(localStorage.getItem('freshy_login_codes_v1')||'{}');}catch{return {};}}
function bindCodeLogin(){const input=$('#loginEmployeeCode');if(!input)return;input.addEventListener('input',()=>{const code=input.value.trim(),known=code==='7716'?DB.settings.db.adminEmail:verifiedLoginDirectory()[code];$('#loginEmail').value=known||'';$('#loginEmailHint').textContent=known?'บัญชี '+known:'ระบบจะเลือกบัญชีหลังยืนยันรหัสผ่าน';});input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();$('#loginPassword').focus();}});}
function rememberVerifiedLogin(){const u=me();if(!authIdentity||!u)return;const directory=verifiedLoginDirectory();directory[u.code]=u.email;localStorage.setItem('freshy_login_codes_v1',JSON.stringify(directory));}
function attachSettingsFeatures(){
 if(isAdmin()&&authIdentity&&['email','system'].includes(settingTab)){const note=document.createElement('p');note.className='help-text';note.id='serverFeaturesStatus';$('#pageContent .panel-body')?.append(note);note.textContent='กำลังตรวจความพร้อมของเซิร์ฟเวอร์…';apiRequest('/api/config-status').then(s=>{if(!note.isConnected)return;note.textContent=(s.documentStorage?'QR เอกสารพร้อมใช้งานผ่านฐานข้อมูลเดิม':'กำลังรออัปเดตส่วนเก็บเอกสาร QR')+' · '+(s.backgroundSchedule?'รายงานเบื้องหลังพร้อมใช้งาน':'รายงานขณะปิดเว็บยังรอการเชื่อมต่อฝั่งเซิร์ฟเวอร์');}).catch(e=>{if(note.isConnected)note.textContent=e.message;});}
 const file=$('#profileFile');if(file)file.onchange=async()=>{const selected=file.files[0];if(!selected)return;if(!['image/jpeg','image/png','image/webp'].includes(selected.type)||selected.size>5*1024*1024){toast('เลือกรูป JPG / PNG / WebP ไม่เกิน 5 MB','error');file.value='';return;}const save=$('#saveProfile');save.disabled=true;try{const image=await createImageBitmap(selected);const canvas=document.createElement('canvas');canvas.width=canvas.height=256;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,256,256);const size=Math.min(image.width,image.height);ctx.drawImage(image,(image.width-size)/2,(image.height-size)/2,size,size,0,0,256,256);image.close();$('#s_avatar').value=canvas.toDataURL('image/jpeg',.85);$('#profilePreview').src=$('#s_avatar').value;$('#profilePreview').hidden=false;}catch{toast('อ่านรูปไม่ได้ กรุณาเลือกรูปใหม่','error');}finally{save.disabled=false;}};
 if(settingTab==='system'){
  const panel=$('#pageContent .panel-body'),section=document.createElement('div');section.className='backup-settings';section.innerHTML='<h3>สำรองข้อมูลวันที่ 1 / 15 / 31</h3><p class="help-text">ทำงานบนเครื่องแอดมินเมื่อเปิดระบบ โดยใช้เวลาประเทศไทย หากพลาดรอบ ระบบจะทำรอบล่าสุดเมื่อเปิดใช้งานอีกครั้ง เดือนที่ไม่มีวันที่ 31 จะข้ามวันนั้น</p><label class="perm-item"><input id="autoBackupEnabled" type="checkbox" '+(DB.settings.backup?.enabled!==false?'checked':'')+'> เปิดการสำรองตามรอบ</label><div class="actions"><button id="chooseBackupFolder" class="btn btn-ghost">เลือกโฟลเดอร์สำรองในเครื่อง</button><button id="fullBackupNow" class="btn btn-primary">สำรองทั้งหมดตอนนี้</button></div><p id="backupStatus" class="help-text"></p>';panel.prepend(section);
  $('#autoBackupEnabled').onchange=()=>{DB.settings.backup={...(DB.settings.backup||{}),enabled:$('#autoBackupEnabled').checked,days:[1,15,31]};dbSave();};$('#chooseBackupFolder').onclick=async()=>{if(!window.showDirectoryPicker){toast('เบราว์เซอร์นี้ใช้โฟลเดอร์ดาวน์โหลดตามปกติ','info');return;}try{backupFolder=await window.showDirectoryPicker({id:'freshy-backups',mode:'readwrite'});await folderStore('write',backupFolder);$('#backupStatus').textContent='เลือกโฟลเดอร์แล้ว: '+backupFolder.name;toast('เลือกโฟลเดอร์สำรองแล้ว','success');}catch(e){if(e.name!=='AbortError')toast('เลือกโฟลเดอร์ไม่สำเร็จ','error');}};$('#fullBackupNow').onclick=()=>performBackup(true);
 }
}
function folderStore(action,value){return new Promise((resolve,reject)=>{const request=indexedDB.open('freshy-backup-preferences',1);request.onupgradeneeded=()=>request.result.createObjectStore('preferences');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction('preferences',action==='write'?'readwrite':'readonly'),store=tx.objectStore('preferences'),result=action==='write'?store.put(value,'folder'):store.get('folder');result.onsuccess=()=>resolve(result.result);result.onerror=()=>reject(result.error);tx.oncomplete=()=>db.close();};});}
async function performBackup(manual=false){
 if(backupBusy||!isAdmin()||!authIdentity)return;const due=FreshyFeatures.latestBackupDate(),key='freshy_backup_'+authIdentity.id+'_'+supaCfg().url+'_'+due;
 if(!manual&&localStorage.getItem(key))return;backupBusy=true;
 try{if(!(await flushOnline())||!(await supabaseFetch()))throw Error('ยังมีข้อมูลรอส่ง ไม่สามารถยืนยันสำรองฐานข้อมูลล่าสุดได้');
 let snapshot={schema:2,exportedAt:new Date().toISOString(),data:FreshySync.clone(FreshySync.shared(DB)),rows:[]};try{let cursor=0;do{const page=await apiRequest('/api/backup?cursor='+cursor);snapshot.rows.push(...page.rows);cursor=page.nextCursor;}while(cursor!==null);}catch(e){snapshot.scope='ข้อมูลหลัก และเอกสาร QR ที่อ่านได้ก่อนเกิดข้อผิดพลาด';snapshot.warning=e.message;toast('สำรองข้อมูลหลักได้ แต่เอกสาร QR ยังอ่านไม่ครบ โปรดตรวจการตั้งค่าเซิร์ฟเวอร์','info');}
 snapshot.backupPeriod=due;snapshot.pending=FreshySync.diff(remoteBase,FreshySync.shared(DB));const text=JSON.stringify(snapshot,null,2),filename='freshy-full-backup-'+due+'-'+Date.now()+'.json';
 if(!backupFolderLoaded){backupFolderLoaded=true;try{backupFolder=await folderStore('read');}catch{}}
 let verified=false;if(backupFolder){let permission=await backupFolder.queryPermission({mode:'readwrite'});if(permission!=='granted'&&manual)permission=await backupFolder.requestPermission({mode:'readwrite'});if(permission==='granted'){const handle=await backupFolder.getFileHandle(filename,{create:true}),stream=await handle.createWritable();await stream.write(text);await stream.close();const file=await handle.getFile();if(await file.text()!==text)throw Error('ตรวจสอบไฟล์สำรองไม่สำเร็จ');verified=true;}}
 if(!verified){const blob=new Blob([text],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1500);}
 localStorage.setItem(key,JSON.stringify({time:new Date().toISOString(),verified,complete:!snapshot.warning}));const message=verified?'บันทึกไฟล์สำรองและตรวจอ่านไฟล์แล้ว':'เริ่มดาวน์โหลดสำรองแล้ว โปรดตรวจไฟล์ในโฟลเดอร์ดาวน์โหลด';if($('#backupStatus'))$('#backupStatus').textContent=message;toast(message,'info');
 }catch(e){if(manual)toast(e.message,'error');}finally{backupBusy=false;}
}
function startAdminSchedule(){
 rememberVerifiedLogin();if(adminScheduleTimer)clearInterval(adminScheduleTimer);if(!isAdmin()||!authIdentity)return;
 const tick=async()=>{if(!session||!authIdentity||!isAdmin()||document.hidden||modalIsOpen())return;if(DB.settings.backup?.enabled!==false)await performBackup();if(DB.settings.email.enabled&&DB.settings.email.reportsEnabled&&Date.now()-lastScheduledAttempt>60000){lastScheduledAttempt=Date.now();try{await apiRequest('/api/daily-report',{method:'POST',body:'{}'});}catch(e){console.warn('งานรายงานยังไม่พร้อม:',e.message);}}};adminScheduleTimer=setInterval(tick,60000);setTimeout(tick,1500);
}

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s==null?'':s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const numberFormatter=new Intl.NumberFormat('th-TH');
const fmtN = n => numberFormatter.format(Number(n||0));
const uid = () => Math.random().toString(36).slice(2,10)+Date.now().toString(36);
const pad2 = n => String(n).padStart(2,'0');
function todayStr(){const second=Math.floor(Date.now()/1000);if(todayStr.second!==second){todayStr.second=second;todayStr.value=FreshyFeatures.bangkokParts().date;}return todayStr.value;}
function fmtDate(d){return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate());}
function daysAgo(n){const d=new Date();d.setDate(d.getDate()-n);return fmtDate(d);}
function thDate(iso){if(!iso)return'-';const p=String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);if(!p)return String(iso);const year=Number(p[1]);return p[3]+'/'+p[2]+'/'+(year<2400?year+543:year);}
function thDateTime(iso){if(!iso)return'-';const d=new Date(iso);return pad2(d.getDate())+'/'+pad2(d.getMonth()+1)+'/'+d.getFullYear()+' '+pad2(d.getHours())+':'+pad2(d.getMinutes());}
function thDateTimeSec(iso){if(!iso)return'-';const d=new Date(iso);return pad2(d.getDate())+'/'+pad2(d.getMonth()+1)+'/'+d.getFullYear()+' '+pad2(d.getHours())+':'+pad2(d.getMinutes())+':'+pad2(d.getSeconds())+' น.';}
function nextCustomerCode(){let max=0;DB.customers.forEach(c=>{const m=String(c.code||'').match(/^C(\d+)$/);if(m)max=Math.max(max,+m[1]);});return 'C'+String(max+1).padStart(3,'0');}
async function reserveCustomerCode(){if(!authIdentity)return nextCustomerCode();try{return await rpc('freshy_customer_code');}catch(error){if(/PAGE_FORBIDDEN|MEMBER_NOT_FOUND|AUTH_REQUIRED/.test(error.message||''))throw error;return 'C-'+String(me()?.code||'LOCAL').replace(/[^A-Za-z0-9]/g,'').slice(0,16)+'-'+uid().toUpperCase();}}

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
  notificationHistory.unshift({message:String(msg),type:type||'info',at:Date.now()});notificationHistory=notificationHistory.slice(0,30);const bell=$('#notificationsBtn');if(bell)bell.dataset.unread='true';
  const w=$('#toastWrap');
  // Keep repeated network errors readable: update the existing notice instead
  // of filling the screen when a user taps the sync badge more than once.
  const existing=[...w.children].find(x=>x.dataset.message===String(msg));
  if(existing){existing.dataset.repeated=String((+existing.dataset.repeated||1)+1);return;}
  const t=document.createElement('div');
  t.className='toast '+(type||'');
  t.dataset.message=String(msg);t.dataset.repeated='1';
  t.setAttribute('role',type==='error'?'alert':'status');
  t.innerHTML='<i data-lucide="'+(type==='error'?'circle-alert':type==='success'?'check-circle-2':'info')+'"></i><span>'+esc(msg)+'</span><button class="toast-dismiss" type="button" aria-label="ปิดการแจ้งเตือน">×</button>';t.querySelector('button').onclick=()=>t.remove();
  w.appendChild(t); renderIcons();
  setTimeout(()=>{t.style.opacity='0';t.style.transition='opacity .3s';setTimeout(()=>t.remove(),300);},3200);
}

/* ---------- modal ---------- */
function openModal(html){
  $('#modalBox').className='modal';$('#modalBox').onkeydown=null;$('#modalBox').removeAttribute('tabindex');$('#modalBox').innerHTML=html; $('#modalBackdrop').classList.remove('hidden');
  renderIcons();
}
function closeModal(){$('#modalBackdrop').classList.add('hidden');$('#modalBox').className='modal';$('#modalBox').onkeydown=null;$('#modalBox').removeAttribute('tabindex');$('#modalBox').innerHTML='';if(syncViewDirty)setTimeout(refreshSyncedView,0);}
function modalIsOpen(){return !$('#modalBackdrop').classList.contains('hidden');}
$('#modalBackdrop').addEventListener('click',e=>{if(e.target.id==='modalBackdrop')closeModal();});

/* ============================================================
   ฐานข้อมูล (DB) — สาธิตในเครื่อง; ออนไลน์ใช้ Supabase Auth และ RPC
   ============================================================ */
const DBKEY=window.FRESHY_PREVIEW?'freshywater_demo_v8':'freshywater_db_v1';
const SESSKEY=window.FRESHY_PREVIEW?'freshywater_demo_session_v8':'freshywater_session_v1';
let DB=null; let session=null;

function defaultSettings(){
  return {
    business:{name:'โรงน้ำดื่ม เฟรชชี่ วอเตอร์',address:'',taxId:'',commercialId:'',phone:'',email:'',menuName:'ระบบจัดการลูกหนี้'},
    header:{showLogo:true,showName:true,logoDataUrl:''},
    db:Object.assign({mode:'demo',sheetUrl:'',sheetId:'',apiKey:'',serviceEmail:'',serviceKey:'',supabaseUrl:'',supabaseKey:'',adminEmail:''},window.FRESHY_CONFIG||{}),
    email:{enabled:false,adminEmail:'',provider:'gmail',apiKey:'',smtpHost:'',smtpPort:'587',smtpUser:'',smtpPass:'',reportTimes:['08:00','18:00'],reportsEnabled:false,alerts:{login:true,logout:true,addDebtor:true,undoRequest:true,newcustomer:true,profile:true,payment:true,cash:true}},
    docPrefix:{debtor:'FWD',cash:'CSH',customer:'CUS'},
    doccounters:{},backup:{enabled:true,days:[1,15,31]},accessHours:{enabled:false,start:'06:30',end:'19:00',timeZone:'Asia/Bangkok'}
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
    s.cashsales.push({id:uid(),customerCode:ccode,customerName:name,village:vill,moo:moo,deliveryDate:daysAgo(ago),createdBy:by,createdByName:(s.employees.find(e=>e.id===by)||{}).name||'ระบบ',dbSource:'สาธิต',isDemo:true,responsibleBy:by,jugs,packs,jugAmount:ja,packAmount:pa,createdAt:new Date(Date.now()-ago*86400000).toISOString(),editHistory:[]});
  }
  cash('C001','นายสมศรี ใจดี','บ้านนาไฮ','7',0,5,2,'emp_s1');
  cash('C005','นายกิตติ ทองสุข','บ้านดอนนกเอี้ยงเก่า','',0,3,1,'emp_s2');
  cash('C003','นายวิชาญ แก้วกุหลาบ','บ้านนาไฮ','16',0,4,0,'emp_admin');
  cash('C002','นางสาวพิมพ์ใจ รักน้ำ','บ้านนาไฮ','7',1,2,3,'emp_s1');
  cash('C006','นางมะลิ ไพลิน','บ้านตลาด','',1,6,1,'emp_s2');
  for(const key of ['customers','debtors','cashsales','approvals'])for(const row of s[key])row.isDemo=true;
  return s;
}
function dbLoad(){
  let backup=null;
  try{backup=JSON.parse(localStorage.getItem('freshywater_dbconfig_v1'));}catch(e){}
  try{DB=JSON.parse(localStorage.getItem(DBKEY));}catch(e){DB=null;}
  if(!DB||!DB.settings)DB=seed();if(window.FRESHY_PREVIEW)backup=null;
  // Deployment config is applied last so stale browser data cannot switch production back to demo.
  DB.settings.db=Object.assign({},seed().settings.db,DB.settings.db||{},backup||{},window.FRESHY_CONFIG||{});
  if(!DB.audit)DB.audit=[]; if(!DB.approvals)DB.approvals=[]; if(!DB.sentEmails)DB.sentEmails=[];
  if(!DB.settings.doccounters)DB.settings.doccounters={};for(const key of ['business','header','email','docPrefix','backup'])DB.settings[key]=Object.assign({},defaultSettings()[key],DB.settings[key]||{});DB.settings.email.alerts=Object.assign({},defaultSettings().email.alerts,DB.settings.email.alerts||{});
  if(DB.settings.db.mode!=='supabase')localStorage.setItem(DBKEY,JSON.stringify(DB));
}
/* ---------- Supabase (ฐานข้อมูลออนไลน์) ---------- */
const SUPA_COLS=FreshySync.collections;
const SUPA_SQL=window.FRESHY_SQL||'ดูไฟล์ database.sql ในชุดติดตั้ง';
let authClient=null,authIdentity=null,remoteBase=null,remoteSettings=null,syncBusy=false,syncTimer=null,syncRetryTimer=null,syncPromise=null,syncBlocked=false,syncRetryCount=0,realtimeChannel=null,realtimeRefreshTimer=null,syncReadPromise=null,syncIssues=[],syncViewDirty=false,lastSyncAt=0,remoteRecorders=[];
let operatingLocked=false,operatingTimer=null,operatingClockOffset=0,operatingPolicy=null;
function updateOperatingClock(value){const time=Date.parse(value);if(Number.isFinite(time))operatingClockOffset=time-Date.now();}
function lockOperatingHours(policy){
 if(policy)operatingPolicy=policy;
 operatingLocked=true;
 if(authIdentity&&remoteBase)safeCache();
 $('#appShell')?.classList.add('hidden');$('#loginScreen')?.classList.add('hidden');$('#accessHoursLock')?.classList.remove('hidden');
 const p=operatingPolicy||DB.settings.accessHours;
 if($('#accessHoursMessage'))$('#accessHoursMessage').textContent=p?.enabled?'เข้าใช้งานได้ทุกวัน เวลา '+p.start+'–'+p.end+' น. (เวลาไทย)'+(p.start>p.end?' · สิ้นสุดในวันถัดไป':''):'กรุณาตรวจสอบช่วงเวลาเข้าใช้งานกับแอดมิน';
}
function enforceOperatingHours(){
 clearTimeout(operatingTimer);operatingTimer=null;
 if(!session)return !operatingLocked;
 const state=FreshyFeatures.accessWindow(operatingPolicy||DB.settings.accessHours,me()?.role,new Date(Date.now()+operatingClockOffset));
 if(!state.allowed)lockOperatingHours(state.policy);
 if(state.nextChangeMs!=null)operatingTimer=setTimeout(()=>{if(operatingLocked&&document.visibilityState==='visible')verifyOperatingAccess();else enforceOperatingHours();},Math.max(20,Math.min(60000,state.nextChangeMs+20)));
 return state.allowed&&!operatingLocked;
}
async function authorizeCachedOperatingSession(){
 if(isAdmin())return true;
 const status=await rpc('freshy_access_status');updateOperatingClock(status.serverTime);operatingPolicy=FreshyFeatures.accessHours(status.accessHours);
 if(!status.allowed){lockOperatingHours(operatingPolicy);return false;}
 return true;
}
async function verifyOperatingAccess(){
 if(!authIdentity){const allowed=FreshyFeatures.accessWindow(DB.settings.accessHours,me()?.role).allowed;if(allowed){operatingLocked=false;operatingPolicy=null;enterApp();}return allowed;}
 try{const status=await rpc('freshy_access_status');if(!status.allowed){lockOperatingHours(status.accessHours);return false;}operatingPolicy=status.accessHours;operatingLocked=false;await hydrateOnline();return true;}catch(e){lockOperatingHours(operatingPolicy);if($('#accessHoursStatus'))$('#accessHoursStatus').textContent=e.message;return false;}
}
async function switchOperatingAccount(){
 if(authIdentity&&remoteBase&&!safeCache())return;
 if(authIdentity){if(realtimeChannel){try{await authFor(supaCfg()).removeChannel(realtimeChannel);}catch{}realtimeChannel=null;}await authFor(supaCfg()).auth.signOut({scope:'local'});}
 clearTimeout(operatingTimer);operatingTimer=null;operatingLocked=false;operatingPolicy=null;operatingClockOffset=0;authIdentity=null;remoteBase=null;remoteSettings=null;remoteRecorders=[];session=null;syncBlocked=false;localStorage.removeItem(SESSKEY);
 closeModal();$('#accessHoursLock')?.classList.add('hidden');$('#appShell').classList.add('hidden');$('#loginScreen').classList.remove('hidden');configureLogin();
}
const syncTabId=uid();
function supaCfg(){const d=DB.settings.db;return d.mode==='supabase'&&d.supabaseUrl&&d.supabaseKey?{url:String(d.supabaseUrl).trim().replace(/\/$/,''),key:d.supabaseKey.trim()}:null;}
function authFor(cfg){
 if(!window.supabase)throw Error('โหลดระบบล็อกอินไม่สำเร็จ');
 if(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(cfg.url))throw Error('กรอก URL โครงการ Supabase แบบ https://ชื่อโครงการ.supabase.co');
 if(!authClient||authClient._freshyUrl!==cfg.url||authClient._freshyKey!==cfg.key){
  // Preserve an existing session from earlier versions that used sessionStorage.
  for(let i=0;i<sessionStorage.length;i++){const k=sessionStorage.key(i);if(k&&k.startsWith('sb-')&&k.endsWith('-auth-token')&&!localStorage.getItem(k)){const v=sessionStorage.getItem(k);if(v)localStorage.setItem(k,v);}}
  // localStorage keeps the authenticated session available when a QR report opens in a new tab.
  authClient=window.supabase.createClient(cfg.url,cfg.key,{auth:{storage:localStorage,persistSession:true,autoRefreshToken:true,detectSessionInUrl:false},global:{fetch:(url,opts)=>{const headers=new Headers(opts?.headers);if((typeof url==='string'?url:url.url)===cfg.url+'/rest/v1/rpc/freshy_apply')headers.set('x-freshy-revision',remoteBase?.settings?._resetRevision||'');return fetch(url,Object.assign({},opts,{headers,signal:AbortSignal.timeout(45000)}));}}});
  authClient._freshyUrl=cfg.url;authClient._freshyKey=cfg.key;
 }
 return authClient;
}
function journalPrefix(){return 'freshy_outbox_v3_'+authIdentity.id+'_'+supaCfg().url+'_';}
function journalKey(){return journalPrefix()+syncTabId;}
function draftKey(){return 'freshy_draft_v2_'+authIdentity.id+'_'+supaCfg().url;}
function safeCache(){
 const config=DB.settings.db;
 const writeChanged=(key,value)=>{if(localStorage.getItem(key)!==value)localStorage.setItem(key,value);};
 try{writeChanged(window.FRESHY_PREVIEW?'freshywater_demo_config_v8':'freshywater_dbconfig_v1',JSON.stringify(config));
 if(config.mode!=='supabase'){writeChanged(DBKEY,JSON.stringify(DB));return true;}
 if(authIdentity&&remoteBase){
  // A separate small journal per tab prevents one device/tab from replacing another's unsent work.
  const entry={changes:FreshySync.diff(remoteBase,FreshySync.shared(DB)),issues:syncIssues,revision:remoteBase.settings?._resetRevision||''};
  let previous;try{previous=JSON.parse(localStorage.getItem(journalKey()));}catch{}
  if(!previous||!FreshySync.equal(entry,{changes:previous.changes,issues:previous.issues,revision:previous.revision}))localStorage.setItem(journalKey(),JSON.stringify({...entry,updatedAt:Date.now()}));
  try{writeChanged(draftKey(),JSON.stringify({base:remoteBase,rawSettings:remoteSettings,recorders:remoteRecorders}));}catch(error){console.warn('Snapshot cache is full; the pending journal remains saved.');}
 }
 return true;
 }catch(error){toast('พื้นที่เก็บข้อมูลในเครื่องเต็ม กรุณาส่งข้อมูลออนไลน์หรือดาวน์โหลดสำเนาก่อนปิดหน้า','error');return false;}
}
function loadDraft(){
 let cached;try{cached=JSON.parse(localStorage.getItem(draftKey()));}catch{return null;}if(!cached?.base)return null;
 const changes=FreshySync.diff(cached.base,cached.data||cached.base),issues=[],byId=new Map(),blocked=new Set();
 for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(!key.startsWith(journalPrefix()))continue;try{const entry=JSON.parse(localStorage.getItem(key));issues.push(...entry.issues||[]);if(String(entry.revision||'')!==String(cached.base.settings?._resetRevision||'')){issues.push(...(entry.changes||[]).map(change=>({change,reason:'ข้อมูลก่อนแอดมินล้างระบบ',at:entry.updatedAt})));continue;}changes.push(...entry.changes||[]);}catch{}}
 for(const change of changes){const key=change.collection+':'+change.id,existing=byId.get(key);if(blocked.has(key)||(existing&&!FreshySync.equal(existing,change))){if(existing)issues.push({change:existing,reason:'มีการแก้รายการเดียวกันจากหลายแท็บ',at:Date.now()});issues.push({change,reason:'มีการแก้รายการเดียวกันจากหลายแท็บ',at:Date.now()});byId.delete(key);blocked.add(key);continue;}byId.set(key,change);}
 const uniqueIssues=issues.filter((item,index)=>issues.findIndex(other=>FreshySync.equal(other.change,item.change))===index);return {...cached,data:FreshySync.overlay(cached.base,[...byId.values()]),issues:uniqueIssues};
}
function archiveSyncChanges(changes,reason){
 for(const change of changes||[]){if(!syncIssues.some(item=>FreshySync.equal(item.change,change)))syncIssues.push({id:uid(),change:FreshySync.clone(change),reason,at:Date.now()});}
}
function normalizedRemote(data){const defaults=defaultSettings();delete defaults.db;const settings=Object.assign(defaults,data.settings||{});for(const key of ['business','header','email','docPrefix','backup'])settings[key]=Object.assign({},defaultSettings()[key],data.settings?.[key]||{});settings.email.alerts=Object.assign({},defaultSettings().email.alerts,data.settings?.email?.alerts||{});delete settings.db;return {...data,settings};}
function acceptRemote(payload,changes){
 const signature=JSON.stringify({actor:payload.actor,data:payload.data,recorders:payload.recorders});
 // Skip cloning/reconciling the entire database for identical reads with no local edits.
 const siblingJournal=authIdentity&&Array.from({length:localStorage.length},(_,i)=>localStorage.key(i)).some(key=>key.startsWith(journalPrefix())&&key!==journalKey());
 if(signature===acceptRemote.signature&&Array.isArray(changes)&&!changes.length&&!syncIssues.length&&!siblingJournal){lastSyncAt=Date.now();updateSyncNotice();refreshSyncedView();return;}
 const before=FreshySync.shared(DB),recordersBefore=remoteRecorders,incoming=normalizedRemote(payload.data);
 changes=changes||FreshySync.diff(remoteBase||{},before);
 if(remoteBase&&String(remoteBase.settings?._resetRevision||'')!==String(payload.data.settings?._resetRevision||'')){archiveSyncChanges(changes,'ข้อมูลก่อนแอดมินล้างระบบ');changes=[];}
 const stillUncommitted=item=>{if(/ก่อนแอดมินล้าง/.test(item.reason||''))return true;try{return FreshySync.rebase(incoming,[item.change]).length>0;}catch{return true;}};
 syncIssues=syncIssues.filter(stillUncommitted);
 const result=FreshySync.reconcile(incoming,changes);
 for(const issue of result.conflicts)archiveSyncChanges([issue.change],'รายการถูกแก้จากเครื่องอื่น ต้องตรวจสอบก่อนส่ง');
 installRemote(payload,result.pending);lastSyncAt=Date.now();
 // Prune only exact operations already committed, with a storage compare to protect concurrent tab edits.
 for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(!key.startsWith(journalPrefix())||key===journalKey())continue;try{const raw=localStorage.getItem(key),entry=JSON.parse(raw);entry.issues=(entry.issues||[]).filter(stillUncommitted);entry.changes=(entry.changes||[]).filter(change=>{try{return FreshySync.rebase(incoming,[change]).length>0;}catch{return true;}});const next=JSON.stringify(entry);if(next!==raw&&raw===localStorage.getItem(key))localStorage.setItem(key,next);}catch{}}
 acceptRemote.signature=signature;
 syncViewDirty=syncViewDirty||!FreshySync.equal(before,FreshySync.shared(DB))||!FreshySync.equal(recordersBefore,remoteRecorders);updateSyncNotice();refreshSyncedView();
}
function updateSyncNotice(){const button=document.querySelector('.pending-btn');if(button&&authIdentity){const commands=typeof paymentQueue==='function'?paymentQueue():[];const count=(remoteBase?FreshySync.diff(remoteBase,FreshySync.shared(DB)).length:0)+commands.length;button.textContent=syncIssues.length?'ตรวจสอบ '+syncIssues.length+' รายการ':count?'รอส่ง '+count+' รายการ':'ข้อมูลบันทึกแล้ว';button.dataset.state=syncIssues.length?'review':count?'sending':'saved';}const time=$('#syncLastUpdated');if(time)time.textContent=lastSyncAt?'อัปเดต '+new Date(lastSyncAt).toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):authIdentity?'กำลังตรวจข้อมูล':'ข้อมูลสาธิต';}
let lastScrollActivity=0,scrollRefreshTimer=null;
// Scroll listeners record time only: no DOM work or layout reads per frame.
for(const type of ['scroll','touchmove','wheel'])document.addEventListener(type,()=>{lastScrollActivity=Date.now();},{passive:true,capture:true});
function refreshSyncedView(){
 if(typeof operatingLocked!=='undefined'&&operatingLocked)return;
 if(!session||!syncViewDirty||modalIsOpen()||currentPage==='settings')return;
 if(lastScrollActivity){if(!scrollRefreshTimer)scrollRefreshTimer=setTimeout(()=>{scrollRefreshTimer=null;if(Date.now()-lastScrollActivity>=250)lastScrollActivity=0;refreshSyncedView();},250);return;}
 const active=document.activeElement,filterIds=['debtorSearch','paySearch','custSearch','cashDate','auditEmployeeFilter'];
 if(['INPUT','TEXTAREA','SELECT'].includes(active?.tagName)&&!filterIds.includes(active.id))return;
 const focus=filterIds.includes(active?.id)?{id:active.id,value:active.value,start:active.selectionStart,end:active.selectionEnd}:null;
 const top=$('.topbar')?.getBoundingClientRect().bottom||0;
 const anchor=currentPage.startsWith('debtors')?[...document.querySelectorAll('.debtor-card')].map(card=>({id:card.dataset.cid,top:card.getBoundingClientRect().top,bottom:card.getBoundingClientRect().bottom})).find(card=>card.bottom>top):null;
 syncViewDirty=false;refreshUserChip();if(typeof renderNav==='function')renderNav();renderPage();
 if(anchor){const card=[...document.querySelectorAll('.debtor-card')].find(card=>card.dataset.cid===anchor.id);if(card){const shift=card.getBoundingClientRect().top-anchor.top;if(Math.abs(shift)>1)window.scrollTo({top:window.scrollY+shift,behavior:'instant'});}}
 if(focus){const input=$('#'+focus.id);if(input){input.value=focus.value;input.focus({preventScroll:true});if(Number.isInteger(focus.start)&&typeof input.setSelectionRange==='function')input.setSelectionRange(focus.start,focus.end);}}
}

function quarantineSyncChange(change,message){
 const pending=FreshySync.diff(remoteBase,FreshySync.shared(DB)),affected=[change];
 if(change.collection==='customers')affected.push(...pending.filter(c=>['debtors','cashsales'].includes(c.collection)&&c.value?.customerId===change.id));
 archiveSyncChanges(affected,message);const ids=new Set(affected.map(c=>c.collection+':'+c.id));
 const actor=FreshySync.clone(me());installRemote({actor,data:{...remoteBase,settings:remoteSettings||remoteBase.settings}},pending.filter(c=>!ids.has(c.collection+':'+c.id)));updateSyncNotice();
}
function installRemote(payload,preserve){
 if(typeof acceptRemote==='function')acceptRemote.signature=null;
 if(!payload||!payload.actor||!payload.data)throw Error('รูปแบบข้อมูลออนไลน์ไม่ถูกต้อง');
 const cfg=DB.settings.db;
 const approvedNotices=(payload.data.debtors||[]).filter(row=>row.paymentReviewStatus==='approved'&&row.paidBy===payload.actor.id&&remoteBase?.debtors?.some(old=>old.id===row.id&&old.paymentReviewStatus==='pending'));
 const defaults=defaultSettings();delete defaults.db;
 const data=Object.assign(Object.fromEntries(SUPA_COLS.map(k=>[k,k==='settings'?{}:[]])),payload.data);
 if(remoteBase&&String(remoteBase.settings?._resetRevision||'')!==String(data.settings?._resetRevision||'')){archiveSyncChanges(preserve,'ข้อมูลก่อนแอดมินล้างระบบ');preserve=[];}
 remoteRecorders=FreshySync.clone(payload.recorders||remoteRecorders||[]);
 remoteSettings=FreshySync.clone(data.settings||{});
 data.settings=Object.assign(defaults,remoteSettings);for(const key of ['business','header','email','docPrefix','backup'])data.settings[key]=Object.assign({},defaultSettings()[key],remoteSettings[key]||{});data.settings.email.alerts=Object.assign({},defaultSettings().email.alerts,remoteSettings.email?.alerts||{});delete data.settings.db;
 remoteBase=FreshySync.clone(data);
 const merged=FreshySync.overlay(data,preserve||[]);
 for(const k of SUPA_COLS){if(k==='settings')DB.settings=FreshySync.clone(merged[k]);else DB[k]=merged[k];}
 DB.settings.db=cfg;
 if(!DB.employees.some(e=>e.id===payload.actor.id))DB.employees.push(payload.actor);
 session={empId:payload.actor.id,loginAt:new Date().toISOString(),online:true};
 safeCache();if(typeof updateOperatingClock==='function'){updateOperatingClock(payload.serverTime);operatingPolicy=DB.settings.accessHours;enforceOperatingHours();}for(const row of approvedNotices)toast('รายการของ '+row.customerName+' ตรวจสอบและอนุมัติแล้ว','success');
}
async function rpc(name,body){
 const cfg=supaCfg();if(!cfg||!authIdentity)throw Error('กรุณาเข้าสู่ระบบออนไลน์');
 const client=authFor(cfg);
 const request=FreshySync.clone(body||{});
 if(name==='freshy_apply')for(const c of request.changes||[])if(c.collection==='settings')c.expected=FreshySync.clone(remoteSettings||c.expected||{});
 const {data,error}=await client.rpc(name,request);
 if(error){const failure=Error(error.message||'คำขอฐานข้อมูลล้มเหลว');failure.code=error.code;if(/ACCESS_HOURS_CLOSED/.test(error.message||'')){let detail;try{detail=JSON.parse(error.details);}catch{}if(typeof lockOperatingHours==='function'){updateOperatingClock(detail?.serverTime);lockOperatingHours(detail?.accessHours);}failure.code='ACCESS_HOURS_CLOSED';failure.message='อยู่นอกเวลาเข้าใช้งานที่แอดมินกำหนด';}throw failure;}
 if(typeof updateOperatingClock==='function')updateOperatingClock(data?.serverTime);
 return data;
}
async function supabaseFetch(){
 if(supabaseFetch.pending)return supabaseFetch.pending;
 const run=(async()=>{
 if(!supaCfg()||!authIdentity)return false;
 if(typeof operatingLocked!=='undefined'&&operatingLocked)return verifyOperatingAccess();
 if(syncReadPromise)return syncReadPromise;
 if(typeof retryPaymentCommands==='function')await retryPaymentCommands();
 if(syncPromise){await syncPromise;if(!authIdentity)return false;}
 if(remoteBase&&!syncBlocked&&FreshySync.diff(remoteBase,FreshySync.shared(DB)).length)await flushOnline();
 syncBusy=true;
 syncReadPromise=(async()=>{try{
  const payload=await rpc('freshy_read');
  acceptRemote(payload,remoteBase?FreshySync.diff(remoteBase,FreshySync.shared(DB)):[]);
  setStatus(syncIssues.length?'ข้อมูลอัปเดตแล้ว · '+syncIssues.length+' รายการต้องตรวจสอบ':'ข้อมูลตรงกับฐานข้อมูลแล้ว','ok');
  return true;
 }catch(error){setStatus('เก็บข้อมูลในเครื่อง · กำลังเชื่อมต่อใหม่','warn');return false;}
 finally{syncBusy=false;syncReadPromise=null;updateSyncNotice();}})();return syncReadPromise;

 })();supabaseFetch.pending=run;
 try{return await run;}finally{supabaseFetch.pending=null;}
}
async function flushOnline(){
 if(typeof operatingLocked!=='undefined'&&operatingLocked)return false;
 if(syncPromise)return syncPromise;
 if(syncReadPromise){await syncReadPromise;return flushOnline();}
 if(!authIdentity||!remoteBase||syncBlocked)return false;
 flushOnline.lastError='';
 const initialChanges=FreshySync.diff(remoteBase,FreshySync.shared(DB));if(!initialChanges.length)return true;
 syncBusy=true;safeCache();setStatus('กำลังส่ง '+initialChanges.length+' รายการ','warn');
 syncPromise=(async()=>{try{
  let completed=0,batchSize=10,attempts=0;
  while(true){
   const before=FreshySync.shared(DB),pending=FreshySync.diff(remoteBase,before);if(!pending.length)break;
   if(++attempts>60){safeCache();clearTimeout(syncRetryTimer);syncRetryTimer=setTimeout(()=>flushOnline(),100);return false;}
   const chunk=pending.slice(0,batchSize);setStatus('ส่งแล้ว '+completed+' · รอส่ง '+pending.length,'warn');
   let payload;
   try{payload=await rpc('freshy_apply',{changes:chunk});}
   catch(error){
    if(/RESET_STALE/.test(error.message||'')){acceptRemote(await rpc('freshy_read'),FreshySync.diff(remoteBase,FreshySync.shared(DB)));toast('แอดมินล้างข้อมูลแล้ว · สำเนารายการเดิมยังเก็บไว้ในข้อมูลรอส่ง','info');return false;}
    if(/CONFLICT:/.test(error.message||'')){acceptRemote(await rpc('freshy_read'),FreshySync.diff(remoteBase,FreshySync.shared(DB)));continue;}
    if(/MEMBER_NOT_FOUND|JWT|PGRST202/.test(error.message||''))throw error;
    if(/FORBIDDEN|ONLY|REQUIRED|IMMUTABLE|INVALID|CLOSED|DUPLICATE/.test(error.message||'')){
     if(chunk.length>1){batchSize=1;continue;}
     quarantineSyncChange(chunk[0],error.message);toast('เก็บรายการที่ต้องตรวจสอบไว้แล้ว · รายการอื่นส่งต่อได้','info');continue;
    }
    throw error;
   }
   const during=FreshySync.diff(before,FreshySync.shared(DB));
   acceptRemote(payload,pending.slice(chunk.length).concat(during));lastSyncAt=Date.now();completed+=chunk.length;broadcastOnlineChange();
   updateSyncNotice();
  }
  syncRetryCount=0;clearTimeout(syncRetryTimer);setStatus(syncIssues.length?'บันทึกครบ · '+syncIssues.length+' รายการต้องตรวจสอบ':'บันทึกออนไลน์ครบ '+completed+' รายการ','ok');syncViewDirty=true;refreshSyncedView();return true;
 }catch(error){
  flushOnline.lastError=error.message;syncBlocked=/MEMBER_NOT_FOUND|PGRST202|JWT/.test(error.message);
  safeCache();syncRetryCount=Math.min(syncRetryCount+1,6);const wait=Math.min(30000,1000*Math.pow(2,syncRetryCount-1));
  setStatus(syncBlocked?'บัญชีต้องตรวจสอบ · ข้อมูลรอส่งยังอยู่':'เก็บรายการไว้ในเครื่อง · ส่งซ้ำอัตโนมัติ','warn');clearTimeout(syncRetryTimer);if(!syncBlocked)syncRetryTimer=setTimeout(()=>flushOnline(),wait);return false;
 }finally{syncBusy=false;syncPromise=null;updateSyncNotice();}})();return syncPromise;
}
function supabasePush(){if(!authIdentity||!remoteBase)return;clearTimeout(syncTimer);syncTimer=setTimeout(()=>flushOnline(),350);}
async function startRealtime(){
 if(!authIdentity||!supaCfg())return;
 const client=authFor(supaCfg());
 if(realtimeChannel){try{await client.removeChannel(realtimeChannel);}catch(e){}}
 // Broadcast carries no business data; receivers fetch only after a successful commit.
 // This avoids the high CPU cost of decoding Postgres WAL on small Supabase plans.
 realtimeChannel=client.channel('freshy-data-v1',{config:{broadcast:{self:false}}})
  .on('broadcast',{event:'freshy-updated'},()=>{
   if(!realtimeRefreshTimer)realtimeRefreshTimer=setTimeout(()=>{realtimeRefreshTimer=null;if(document.visibilityState==='visible')supabaseFetch();},700);
  })
  .subscribe(status=>{if(status==='SUBSCRIBED'&&session&&!syncBusy&&!syncBlocked&&!FreshySync.diff(remoteBase,FreshySync.shared(DB)).length)setStatus('เชื่อมต่อฐานข้อมูลแบบเรียลไทม์','ok');});
}
function broadcastOnlineChange(){
 if(!realtimeChannel)return;
 try{realtimeChannel.send({type:'broadcast',event:'freshy-updated',payload:{at:Date.now()}});}catch(e){}
}
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
 const rows=syncIssues.map((item,index)=>{const c=item.change,v=c.value||c.expected||{},current=(remoteBase[c.collection]||[]).find(x=>x.id===c.id)||{},label=v.customerName||v.name||v.code||v.action||c.id,oldReset=/ก่อนแอดมินล้าง/.test(item.reason);return '<tr><td><input type="checkbox" class="retry-issue" value="'+index+'" '+(oldReset?'disabled':'')+' aria-label="เลือก '+esc(label)+'"></td><td>'+esc(label)+'<small>'+esc(oldReset?'สำเนาก่อนล้างระบบ':syncErrorText(item.reason))+'</small></td><td>'+esc(current.total??current.name??current.status??'—')+'</td><td>'+esc(v.total??v.name??v.status??'—')+'</td></tr>';}).join('');
 openModal('<div class="modal-head"><h3>สถานะการบันทึกข้อมูล</h3><button class="x" onclick="closeModal()">×</button></div><div class="modal-body"><p>รอส่ง '+changes.length+' รายการ · ต้องตรวจสอบ '+syncIssues.length+' รายการ</p><p class="help-text">ระบบส่งรายการที่ถูกต้องต่อได้โดยอัตโนมัติ สำเนารายการที่มีปัญหายังอยู่ในเครื่อง เลือกเฉพาะรายการที่ต้องการใช้ข้อมูลของคุณแทนค่าออนไลน์แล้วส่งใหม่</p>'+ (rows?'<div class="tbl-scroll"><table class="tbl sync-review"><thead><tr><th>เลือก</th><th>รายการ</th><th>ออนไลน์</th><th>ข้อมูลของคุณ</th></tr></thead><tbody>'+rows+'</tbody></table></div>':'<div class="sync-empty"><i data-lucide="cloud-check"></i><b>'+(changes.length?'กำลังส่งรายการเข้าฐานข้อมูล':'ข้อมูลบันทึกครบแล้ว')+'</b></div>')+'</div><div class="modal-foot"><button class="btn btn-ghost" id="exportPending">ดาวน์โหลดสำเนา</button><button class="btn btn-primary" id="retryPending">ส่งรายการที่เลือก / ซิงก์อีกครั้ง</button></div>');
 $('#exportPending').onclick=()=>downloadSystemSnapshot({exportedAt:new Date().toISOString(),changes,issues:syncIssues},'freshy-pending');
 $('#retryPending').onclick=async()=>{try{const selected=[...document.querySelectorAll('.retry-issue:checked')].map(el=>+el.value);await supabaseFetch();const next=[];for(const index of selected){const item=syncIssues[index];if(!item||/ก่อนแอดมินล้าง/.test(item.reason))continue;const change=item.change,expected=change.collection==='settings'?remoteBase.settings:(remoteBase[change.collection]||[]).find(x=>x.id===change.id)||null;next.push({...change,expected});}const remaining=syncIssues.filter((_,index)=>!selected.includes(index));const current=FreshySync.diff(remoteBase,FreshySync.shared(DB));syncIssues=remaining;installRemote({actor:me(),data:{...remoteBase,settings:remoteSettings||remoteBase.settings}},current.concat(next));syncBlocked=false;safeCache();closeModal();await flushOnline();refreshSyncedView();}catch(error){toast(error.message,'error');}};
}
function syncErrorText(message){if(/CONFLICT|เครื่องอื่น/.test(message))return 'ข้อมูลถูกแก้จากเครื่องอื่น';if(/OWNER|FORBIDDEN|ONLY|IMMUTABLE/.test(message))return 'ต้องตรวจสอบสิทธิ์หรือส่งคำขอให้แอดมิน';if(/DUPLICATE/.test(message))return 'มีข้อมูลหรือรหัสซ้ำ';if(/INVALID|REQUIRED/.test(message))return 'ข้อมูลบางช่องยังไม่ถูกต้องหรือไม่ครบ';return message;}
window.resolvePending=resolvePending;
function downloadSystemSnapshot(data,label){
 const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');
 a.href=url;a.download=(label||'freshywater-backup')+'-'+todayStr()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1200);
}
function openRealReset(){
 if(!isAdmin())return;
 openModal(`<div class="modal-head"><h3>ล้างข้อมูลระบบ</h3><button class="x" onclick="closeModal()">×</button></div><div class="modal-body"><p>เลือกข้อมูลที่ต้องการล้างจากฐานข้อมูลจริง การล้างไม่สามารถย้อนกลับได้ ควรดาวน์โหลดสำรองก่อน</p><label class="perm-item"><input type="radio" name="resetMode" value="partial" checked> ล้างเฉพาะข้อมูลที่เลือก</label><label class="perm-item"><input type="radio" name="resetMode" value="all"> ล้างระบบทั้งหมด</label><div id="resetCategories" class="perm-grid">${Object.entries(FreshyData.resetCategories).map(([k,label])=>`<label class="perm-item"><input type="checkbox" class="reset-category" value="${k}"> ${esc(label)}</label>`).join('')}</div><p class="help-text">ล้างทั้งหมด: ลบลูกค้า ลูกหนี้ ประวัติรับชำระ ขายสด พนักงานอื่น เอกสาร QR อีเมล ข้อมูลในหน้ากู้คืน และการตั้งค่า เก็บบัญชีแอดมินที่ใช้งานอยู่ การเชื่อมต่อ และบันทึกการล้างครั้งนี้ไว้ บัญชีเข้าสู่ระบบของพนักงานจะหมดสิทธิ์เข้าโรงงาน</p><div class="field"><label>รหัสยืนยันการล้างข้อมูล</label><input type="password" id="resetCode" autocomplete="off" inputmode="numeric" maxlength="4" placeholder="กรอกรหัสยืนยัน"></div><p id="resetError" role="alert"></p></div><div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">ยกเลิก</button><button class="btn btn-danger" id="confirmReset">ยืนยันล้างข้อมูล</button></div>`);
 document.querySelectorAll('[name="resetMode"]').forEach(el=>el.onchange=()=>{const all=document.querySelector('[name="resetMode"]:checked').value==='all';document.querySelectorAll('.reset-category').forEach(x=>{x.disabled=all;});});
 $('#confirmReset').onclick=async()=>{
  const full=document.querySelector('[name="resetMode"]:checked').value==='all',categories=[...document.querySelectorAll('.reset-category:checked')].map(x=>x.value),code=$('#resetCode').value;
  if(!full&&!categories.length){$('#resetError').textContent='กรุณาติ๊กเลือกข้อมูลอย่างน้อยหนึ่งส่วน';return;}
  if(!['7716','7816'].includes(code)){$('#resetError').textContent='รหัสยืนยันไม่ถูกต้อง';return;}
  const btn=$('#confirmReset');btn.disabled=true;btn.textContent='กำลังล้างข้อมูล…';
  try{
   if(authIdentity){if(!(await flushOnline()))throw Error('ต้องบันทึกข้อมูลรอส่งให้สำเร็จก่อนล้าง');if(!full&&categories.includes('emailLogs')&&DB.sentEmails.some(x=>x.type==='deleted-debt'&&x.status==='deleted'))throw Error('ยังมีข้อมูลที่ลบรอกู้คืน จึงไม่ล้างประวัติส่วนนี้เพื่อรักษาสำเนากู้คืน');const payload=await rpc('freshy_reset',{categories,confirmation_code:code,expected_revision:remoteBase.settings._resetRevision||'',full_reset:full});installRemote(payload,[]);broadcastOnlineChange();}
   else{const actor=FreshySync.clone(me()),connection=DB.settings.db;const removed=DB.debtors.filter(d=>full||categories.includes('customers')||categories.includes(d.status==='paid'?'paid':'unpaid')).map(d=>d.id);if(full){for(const k of SUPA_COLS)DB[k]=k==='settings'?defaultSettings():[];DB.employees=[actor];}
    else{DB.debtors=DB.debtors.filter(d=>!removed.includes(d.id));DB.approvals=DB.approvals.filter(a=>!removed.includes(a.debtorId));for(const k of categories){if(['customers','cashsales','products','villages','audit','approvals'].includes(k))DB[k]=[];if(k==='employees')DB.employees=[actor];if(k==='settings')DB.settings=defaultSettings();if(k==='documents')DB.sentEmails=DB.sentEmails.filter(x=>x.type!=='document');if(k==='emailLogs')DB.sentEmails=DB.sentEmails.filter(x=>['document','deleted-debt'].includes(x.type));}}
    DB.settings.db=connection;DB.settings._resetRevision=uid();audit('ล้างข้อมูล',full?'ทั้งหมด (เก็บแอดมินปัจจุบัน)':categories.join(', '));safeCache();}
   closeModal();refreshUserChip();renderPage();toast(authIdentity?'ล้างข้อมูลที่เลือกจากฐานข้อมูลแล้ว':'ล้างข้อมูลในโหมดสาธิตแล้ว','success');
  }catch(e){$('#resetError').textContent=e.message;btn.disabled=false;btn.textContent='ยืนยันล้างข้อมูล';}
 };
}
async function exportSettingsCsv(){
 if(!isAdmin())return;try{if(authIdentity){if(!(await flushOnline()))throw Error('กรุณาบันทึกข้อมูลรอส่งก่อนดาวน์โหลด');installRemote(await rpc('freshy_read'),[]);}const kind=$('#csvKind').value,blob=new Blob([FreshyFeatures.csv(FreshyData.headers,FreshyData.cells(DB,kind))],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='freshy-'+kind+'-'+todayStr()+'.csv';a.click();URL.revokeObjectURL(url);toast('ดาวน์โหลด CSV แล้ว','success');}catch(e){toast(e.message,'error');}
}
async function previewCsvImport(file){
 if(!isAdmin()||!file)return;try{if(file.size>2000000)throw Error('ไฟล์ CSV ต้องไม่เกิน 2 MB');if(authIdentity){if(!(await flushOnline()))throw Error('กรุณาบันทึกข้อมูลรอส่งก่อนนำเข้า');installRemote(await rpc('freshy_read'),[]);}const text=await file.text(),plan=FreshyData.plan(text,DB,me(),uid),expectedRevision=DB.settings._resetRevision||'';const c=plan.counts;
 openModal(`<div class="modal-head"><h3>ตรวจสอบก่อนนำเข้า CSV</h3><button class="x" onclick="closeModal()">×</button></div><div class="modal-body"><p>${esc(file.name)} · ${plan.rows} แถว</p><p>ลูกค้าใหม่ ${c.customers} · ลูกหนี้ค้างชำระใหม่ ${c.debtors}<br>ปรับปรุงข้อมูลเดิม ${c.updated} · ข้ามข้อมูลซ้ำ ${c.skipped}</p><p>นำเข้าเฉพาะลูกค้าและลูกหนี้ค้างชำระ โดยคงประวัติรับชำระไว้ทั้งหมด</p><p id="importError" role="alert"></p></div><div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">ยกเลิก</button><button class="btn btn-primary" id="confirmCsvImport" ${plan.changes.length?'':'disabled'}>ยืนยันนำเข้า</button></div>`);
 $('#confirmCsvImport').onclick=async()=>{const btn=$('#confirmCsvImport');btn.disabled=true;try{if(authIdentity){const result=await apiRequest('/api/data-import',{method:'POST',body:JSON.stringify({csv:text,expectedRevision})});installRemote(result.payload,[]);broadcastOnlineChange();}else{const next=FreshySync.overlay(FreshySync.shared(DB),plan.changes);for(const k of ['customers','debtors'])DB[k]=next[k];audit('นำเข้า CSV',plan.rows+' แถว');dbSave();}closeModal();renderPage();toast('นำเข้า CSV สำเร็จ','success');}catch(e){$('#importError').textContent=e.message;btn.disabled=false;}};
 }catch(e){toast(e.message,'error');}
}

async function clearDemoData(){
 if(!isAdmin())return;const keys=['customers','debtors','cashsales','approvals'];const count=keys.reduce((s,k)=>s+DB[k].filter(x=>x.isDemo===true).length,0);if(!count){toast('ไม่มีรายการที่ระบุว่าเป็นข้อมูลจำลอง ข้อมูลจริงยังคงอยู่','info');return;}
 if(!confirm('ล้างเฉพาะข้อมูลจำลอง '+count+' รายการ? ข้อมูลจริง ผู้ใช้ และค่าตั้งค่าจะคงอยู่'))return;
 downloadSystemSnapshot({exportedAt:new Date().toISOString(),data:FreshySync.shared(DB)},'freshy-before-demo-reset');for(const key of keys)DB[key]=DB[key].filter(x=>x.isDemo!==true);audit('ล้างข้อมูลจำลอง',count+' รายการ');dbSave();const online=authIdentity?await flushOnline():true;toast(online?'ล้างข้อมูลจำลองแล้ว ค่าตั้งค่าและข้อมูลจริงยังอยู่':'รายการล้างยังรอส่ง กรุณาตรวจสถานะฐานข้อมูล',online?'success':'info');renderPage();
}
function configureLogin(){
 const online=DB.settings.db.mode==='supabase';
 const deploymentLocked=!!(window.FRESHY_CONFIG&&window.FRESHY_CONFIG.mode==='supabase');
 const configured=!!supaCfg();
 $('#onlineLogin').classList.toggle('hidden',!online);
 $('#demoLoginField').classList.toggle('hidden',online);
 $('#useDemo').classList.toggle('hidden',deploymentLocked);
 $('#connectionSetup').classList.toggle('hidden',configured||deploymentLocked);
 $('#loginPreviewNote').textContent=online?'สำหรับผู้ดูแลและพนักงานที่ได้รับสิทธิ์':'โหมดสาธิต · ข้อมูลตัวอย่างในเครื่องนี้';
 $('#connectUrl').value=DB.settings.db.supabaseUrl||'';$('#connectKey').value=DB.settings.db.supabaseKey||'';
 $('#connectAdmin').value=DB.settings.db.adminEmail||'';
}
async function startOnline(email,password){
 const cfg=supaCfg();if(!cfg)throw Error('ตั้งค่า URL และ Publishable/Anon Key ก่อน');
 const client=authFor(cfg);
 const {data,error}=await client.auth.signInWithPassword({email,password});
 if(error)throw error;
 authIdentity=data.user;
 // Staff verify the current hours with a small server response before cached UI opens.
 if(resumeCachedOnline(data.user)){
  if(!(await authorizeCachedOperatingSession()))return;
  enterApp();setStatus('เข้าสู่ระบบแล้ว · กำลังซิงก์ฐานข้อมูลเบื้องหลัง','warn');
  hydrateOnline().catch(()=>{setStatus('ใช้งานข้อมูลล่าสุด · รายการใหม่จะรอส่งอัตโนมัติ','warn');});
  return;
 }
 try{await hydrateOnline();}catch(e){
  // Authentication succeeded. Never destroy a valid session merely because the
  // database connection pool is temporarily busy; restore the last real snapshot.
  if(e.code==='ACCESS_HOURS_CLOSED')throw e;
  if(resumeCachedOnline(data.user)&&isAdmin()){enterApp();setStatus('เข้าสู่ระบบแล้ว · ฐานข้อมูลกำลังเชื่อมต่อใหม่','warn');toast('ยืนยันบัญชีสำเร็จ ใช้ข้อมูลล่าสุดในเครื่องชั่วคราว','info');setTimeout(()=>supabaseFetch(),2500);return;}
  throw Error('ยืนยันบัญชีสำเร็จ แต่ฐานข้อมูลยังไม่ตอบสนอง กรุณากดเข้าสู่ระบบอีกครั้งในอีกสักครู่ ('+(e.message||'connection timeout')+')');
 }
}
function resumeCachedOnline(user){
 let cached=loadDraft();
 if(!cached||!cached.base||!cached.data)return false;
 syncIssues=cached.issues||[];remoteRecorders=cached.recorders||[];const data=cached.data,employee=(data.employees||[]).find(e=>String(e.email||'').toLowerCase()===String(user.email||'').toLowerCase());
 if(!employee)return false;
 const cfg=DB.settings.db;
 for(const k of SUPA_COLS){if(k==='settings')DB.settings=Object.assign(defaultSettings(),data.settings||{});else DB[k]=data[k]||[];}
 DB.settings.db=cfg;remoteBase=FreshySync.shared(cached.base);remoteSettings=FreshySync.clone(cached.rawSettings||remoteBase.settings);session={empId:employee.id,loginAt:new Date().toISOString(),online:true,cached:true};
 return true;
}
async function hydrateOnline(){
 const payload=await rpc('freshy_read'),cached=loadDraft();if(cached?.base&&cached.data){syncIssues=cached.issues||[];let pending=FreshySync.diff(cached.base,cached.data);if(String(cached.base.settings?._resetRevision||'')!==String(payload.data.settings?._resetRevision||'')){archiveSyncChanges(pending,'ข้อมูลก่อนแอดมินล้างระบบ');pending=[];}acceptRemote(payload,pending);await flushOnline();}else{installRemote(payload,[]);lastSyncAt=Date.now();}enterApp();
}
async function resumeOnline(){
 const cfg=supaCfg();if(!cfg)return;
 try{const client=authFor(cfg);const {data,error}=await client.auth.getSession();if(error)throw error;
 if(!data.session)return;
 // getSession reads the verified Supabase session from local storage instantly.
 // Do not block the first screen on an additional network getUser request.
 authIdentity=data.session.user;
 if(resumeCachedOnline(authIdentity)){
  if(!(await authorizeCachedOperatingSession()))return;
  enterApp();setStatus('เปิดระบบจากข้อมูลจริงล่าสุด · กำลังซิงก์เบื้องหลัง','warn');
  client.auth.getUser().then(v=>{if(v.error)throw v.error;return hydrateOnline();}).catch(()=>setStatus('ใช้งานข้อมูลล่าสุด · ฐานข้อมูลจะเชื่อมต่อซ้ำอัตโนมัติ','warn'));
  return;
 }
 const verified=await client.auth.getUser();if(verified.error)throw verified.error;authIdentity=verified.data.user;await hydrateOnline();
 }catch(e){
  if(e.code==='ACCESS_HOURS_CLOSED'||operatingLocked)return;
  if(authIdentity&&resumeCachedOnline(authIdentity)&&isAdmin()){enterApp();setStatus('ฐานข้อมูลกำลังเชื่อมต่อใหม่ · ใช้ข้อมูลล่าสุดในเครื่อง','warn');setTimeout(()=>supabaseFetch(),2500);return;}
  session=null;$('#loginScreen').classList.remove('hidden');$('#appShell').classList.add('hidden');toast('ยืนยันบัญชีแล้ว แต่ฐานข้อมูลยังไม่พร้อม กรุณาลองอีกครั้ง','error');
 }
}
function dbAdd(col,doc){if(DB.settings.db.mode==='demo'&&['customers','debtors','cashsales','approvals'].includes(col))doc.isDemo=true;doc.id=doc.id||uid();DB[col].push(doc);dbSave();return doc;}
function dbUpdate(col,id,patch){const i=DB[col].findIndex(x=>x.id===id);if(i>=0){Object.assign(DB[col][i],patch);dbSave();return DB[col][i];}return null;}
function dbRemove(col,id){DB[col]=DB[col].filter(x=>x.id!==id);dbSave();}
function audit(action,detail){dbAdd('audit',{ts:new Date().toISOString(),userId:(me()||{}).id||'system',userName:(me()||{}).name||'ระบบ',action,detail});}

/* ---------- session / auth ---------- */
function me(){if(!session)return null;return DB.employees.find(e=>e.id===session.empId)||null;}
function isAdmin(){const u=me();return !!(u&&u.role==='admin');}
function canSee(page){const u=me();if(!u)return false;if(u.role==='admin'||['dailyDebts','dashboard','debtorsNai','debtorsOther','paymentsNai','paymentsOther','customersNai','customersOther','cashsales','approvals'].includes(page))return true;return !!(u.permissions&&u.permissions.pages&&u.permissions.pages[page]);}
function canPrint(){const u=me();return !!(u&&(u.role==='admin'||u.permissions.canPrint));}
function canEmail(){const u=me();return !!(u&&(u.role==='admin'||u.permissions.canEmail));}
function canManageRecord(row){const id=me()?.id;return !!row&&(isAdmin()||row.createdBy===id||row.responsibleBy===id||row.paidBy===id);}
function scopeRows(rows){return rows;}
function recorderName(id){return (DB.employees.find(e=>e.id===id)||remoteRecorders.find(e=>e.id===id)||{}).name||'-';}

/* ---------- email alerts (ส่งผ่าน /api/email ถ้าตั้งค่าไว้ มิฉะนั้นบันทึก log) ---------- */
async function sendAlert(type,subject,bodyHtml,toOverride,reportOptions={}){
 const em=DB.settings.email;const alertKey={undo:'undoRequest'}[type]||type;if(type!=='report'&&em.alerts?.[alertKey]===false)return false;
 if(!em.enabled){if(type==='report')toast('ยังไม่เปิดการส่งอีเมล กรุณาเปิดใช้งานในหน้าตั้งค่าอีเมลครั้งแรก','error');return false;}
 const entry={id:uid(),createdBy:(me()||{}).id||'demo',ts:new Date().toISOString(),type,to:toOverride||em.adminEmail||'',subject,body:bodyHtml,status:em.enabled&&em.adminEmail?'กำลังส่ง':'ร่าง (ยังไม่เปิดอีเมล)'};
 DB.sentEmails.unshift(entry);dbSave();
 if(!em.enabled||!entry.to){if(type==='report')toast('กรุณาระบุอีเมลผู้รับรายงาน','error');return false;}
 if(!authIdentity){entry.status='ไม่ได้ส่ง — ต้องเข้าสู่ระบบออนไลน์';dbSave();if(type==='report')toast('กรุณาเข้าสู่ระบบออนไลน์ก่อนส่งรายงาน','error');return false;}
 try{
  if(!(await flushOnline()))throw Error('ค่าตั้งค่าหรือข้อมูลรายงานยังบันทึกออนไลน์ไม่สำเร็จ กรุณาซิงก์แล้วลองส่งอีกครั้ง');
  const {data,error}=await authFor(supaCfg()).auth.getSession();if(error||!data.session)throw Error('เซสชันหมดอายุ');
  const r=await fetch('/api/email',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+data.session.access_token},body:JSON.stringify({type,to:entry.to,subject,html:bodyHtml,format:reportOptions.format,snapshot:reportOptions.snapshot}),signal:AbortSignal.timeout(25000)});
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
  {id:'dailyDebts',label:'ข้อมูลลูกหนี้รายวัน',icon:'calendar-days',group:'ประวัติรับชำระ'},
  {id:'customersNai',label:'จัดการข้อมูลลูกค้า · บ้านนาไฮ',icon:'users',group:'ข้อมูลลูกค้า'},
  {id:'customersOther',label:'จัดการข้อมูลลูกค้า · บ้านอื่น ๆ',icon:'users',group:'ข้อมูลลูกค้า'},
  {id:'cashsales',label:'รายงานลูกค้าจ่ายสด',icon:'receipt-text',group:'ข้อมูลลูกค้า'},
  {id:'approvals',label:'ตรวจสอบการรับชำระ',icon:'clipboard-check',group:'ประวัติรับชำระ'},
  {id:'employees',label:'จัดการพนักงาน',icon:'user-cog',group:'จัดการระบบ',admin:true},
  {id:'deletedRecovery',label:'กู้คืนข้อมูลที่ลบ',icon:'archive-restore',group:'จัดการระบบ',admin:true},
  {id:'invoiceDocuments',label:'จัดการใบแจ้งหนี้',icon:'file-text',group:'เอกสารใบแจ้งหนี้',admin:true},
  {id:'invoiceTemplates',label:'แบบฟอร์มใบแจ้งหนี้',icon:'panels-top-left',group:'เอกสารใบแจ้งหนี้',admin:true},
  {id:'documentHistory',label:'ประวัติเลขที่เอกสาร / การพิมพ์',icon:'files',group:'จัดการระบบ',admin:true},
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
    const badge=(p.id==='approvals')?('<span class="badge">'+DB.approvals.filter(a=>a.status==='pending'&&DB.debtors.some(d=>d.id===a.debtorId)).length+'</span>'):'';
    html+='<button class="nav-item'+(currentPage===p.id?' active':'')+'" data-page="'+p.id+'"><i data-lucide="'+p.icon+'"></i><span>'+esc(p.label)+'</span>'+badge+'</button>';
  });
  nav.innerHTML=html;
  nav.querySelectorAll('.nav-item').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.page)));
  renderIcons();
}
function navigate(page){
  const p=PAGES.find(x=>x.id===page);if(!p)return;
  if(p.admin&&!isAdmin()){toast('คุณไม่มีสิทธิ์เข้าถึงหน้านี้','error');return;}
  if(!canSee(page)&&!p.admin){toast('แอดมินยังไม่เปิดสิทธิ์หน้านี้ให้คุณ','error');return;}
  if(currentPage==='deletedRecovery'&&page!==currentPage)lockRecovery();
  currentPage=page;
  $('#pageTitle').innerHTML='<i data-lucide="'+p.icon+'"></i> '+esc(p.label);
  renderNav(); renderPage();
  $('#sidebar').classList.remove('open');
  renderIcons();
  window.scrollTo(0,0);
}

/* ============================================================
   RENDER PAGE
   ============================================================ */
function renderPage(){
  if(currentPage==='invoiceDocuments'&&invoiceEditing&&document.querySelector('#invoiceDraftPaper'))return;
  if(currentPage==='invoiceTemplates'&&invoiceTemplateDirty&&document.querySelector('#invoiceTemplateCanvas'))return;
  const c=$('#pageContent');
  const fn={dailyDebts:renderDailyDebts,dashboard:renderDashboard,debtorsNai:()=>renderDebtors('nai'),debtorsOther:()=>renderDebtors('other'),
    paymentsNai:()=>renderPayments('nai'),paymentsOther:()=>renderPayments('other'),
    customersNai:()=>renderCustomers('nai'),customersOther:()=>renderCustomers('other'),
    invoiceDocuments:renderInvoiceDocuments,invoiceTemplates:renderInvoiceTemplates,deletedRecovery:renderDeletedRecovery,documentHistory:renderDocumentHistory,cashsales:renderCashsales,approvals:renderApprovals,employees:renderEmployees,audit:renderAudit,settings:renderSettings};
  (fn[currentPage]||renderDashboard)();
  attachCsv();updateSyncNotice();
  renderIcons();
}

let dailyDebtDate='';
function renderDailyDebts(){
 if(!dailyDebtDate)dailyDebtDate=todayStr();
 const rows=FreshyDailyDebts.select(DB.debtors,dailyDebtDate),sum=key=>rows.reduce((n,r)=>n+(Number(r[key])||0),0);
 $('#pageContent').innerHTML=`<div class="page-head"><div><h2>ข้อมูลลูกหนี้รายวัน</h2><p class="desc">รายการที่บันทึกเข้าระบบในวันที่เลือก · เวลาไทย · รวมทุกรูปแบบการชำระ</p></div></div><section class="panel"><div class="panel-body"><form id="dailyDebtForm" class="daily-date-form"><div class="field"><label for="dailyDebtDate">วันที่บันทึกเข้าระบบ</label><input id="dailyDebtDate" type="date" required value="${esc(dailyDebtDate)}"></div><button class="btn btn-primary" type="submit">ค้นหาวันที่</button></form><p role="status">วันที่ ${esc(thDate(dailyDebtDate))} · พบ ${rows.length} รายการ</p><div class="daily-summary"><span>รวมถัง <b>${fmtN(sum('jugs'))}</b></span><span>รวมแพ็ค <b>${fmtN(sum('packs'))}</b></span><span>ยอดที่บันทึก <b>${fmtN(sum('total'))} บาท</b></span></div><div class="daily-records">${rows.map(r=>`<article class="daily-record"><header><h3>${esc(r.customerName||'-')}</h3><span class="pill ${r.status==='unpaid'?'orange':'gray'}">${r.status==='unpaid'?'ค้างชำระ':r.status==='paid'?'รับชำระแล้ว':'รอตรวจสอบ'}</span></header><p>${esc(r.area==='nai'?'บ้านนาไฮ · หมู่ที่ '+(r.moo||'-'):r.village||'บ้านอื่น ๆ')}</p><dl><div><dt>บันทึกเข้าระบบ</dt><dd>${esc(FreshyDailyDebts.displayTime(r.createdAt))}</dd></div><div><dt>วันที่ค้าง</dt><dd>${esc(thDate(r.debtDate))}</dd></div><div><dt>ถัง / แพ็ค</dt><dd>${fmtN(r.jugs)} / ${fmtN(r.packs)}</dd></div><div><dt>เงินน้ำถัง / แพ็ค</dt><dd>${fmtN(r.jugAmount)} / ${fmtN(r.packAmount)} บาท</dd></div><div><dt>ผู้บันทึก</dt><dd>${esc(recorderName(r.createdBy))}</dd></div><div class="daily-total"><dt>ยอดรวม</dt><dd>${fmtN(r.total)} บาท</dd></div></dl></article>`).join('')||'<div class="empty-state"><p>ไม่พบข้อมูล</p><small>ไม่มีรายการลูกหนี้ที่บันทึกเข้าระบบในวันที่เลือก</small></div>'}</div><p class="help-text">อ้างอิงวันที่บันทึกเดิมของรายการ ไม่รวมรายการที่ลบแล้ว รายการเก่าที่ไม่มีวันที่บันทึกจะไม่ถูกคาดเดาวันที่</p></div></section>`;
 $('#dailyDebtForm').onsubmit=e=>{e.preventDefault();const date=$('#dailyDebtDate').value;if(!date)return;dailyDebtDate=date;renderDailyDebts();renderIcons();};
}

/* ---------- SAVED DOCUMENT HISTORY ---------- */
let documentHistory={query:'',records:[],nextCursor:null,loaded:false,busy:false,error:'',request:0};
async function loadDocumentHistory(more=false){
 if(!isAdmin())return;
 const request=++documentHistory.request,query=documentHistory.query;
 documentHistory.busy=true;documentHistory.error='';renderDocumentHistory();
 try{
  let result;
  if(authIdentity){const params=new URLSearchParams({q:query});if(more&&documentHistory.nextCursor)params.set('cursor',documentHistory.nextCursor);result=await apiRequest('/api/document-history?'+params);}
  else{const needle=query.toLowerCase();result={records:DB.sentEmails.filter(r=>r.type==='document'&&r.document&&[r.document.docNo,r.document.title,r.document.author?.name].join(' ').toLowerCase().includes(needle)).map(r=>({id:r.id.slice(9),docNo:r.document.docNo,title:r.document.title,issuedAt:r.document.issuedAt,author:r.document.author?.name,access:'demo'})).sort((a,b)=>b.issuedAt.localeCompare(a.issuedAt)),nextCursor:null};}
  if(request!==documentHistory.request)return;
  documentHistory.records=more?[...new Map([...documentHistory.records,...result.records].map(r=>[r.id,r])).values()]:result.records;documentHistory.nextCursor=result.nextCursor;documentHistory.loaded=true;
 }catch(e){if(request===documentHistory.request)documentHistory.error=e.message;}
 finally{if(request===documentHistory.request){documentHistory.busy=false;if(currentPage==='documentHistory')renderDocumentHistory();}}
}
function renderDocumentHistory(){
 if(!isAdmin())return;
 const state=documentHistory;
 $('#pageContent').innerHTML='<div class="page-head"><div><h2>ประวัติเลขที่เอกสาร / การพิมพ์</h2><p class="desc">เปิดข้อมูลที่บันทึกไว้ ณ ตอนออกเอกสาร และพิมพ์ซ้ำด้วยเลขเดิม</p></div><button class="btn btn-ghost" id="refreshDocumentHistory" '+(state.busy?'disabled':'')+'>โหลดข้อมูลล่าสุด</button></div><div class="panel"><div class="panel-body"><form id="documentHistorySearchForm" class="toolbar"><input id="documentHistorySearch" aria-label="ค้นหาเลขที่เอกสาร" placeholder="เลขที่เอกสาร ชื่อรายงาน หรือผู้ออกเอกสาร" value="'+esc(state.query)+'" style="flex:1;min-width:180px;padding:10px"><button class="btn btn-primary" '+(state.busy?'disabled':'')+'>ค้นหา</button></form><p class="help-text">รายการนี้บันทึกเมื่อระบบเตรียมเอกสารก่อนเปิดหน้าพิมพ์ รวมการบันทึกเป็น PDF เอกสารเก่าจะแสดงเฉพาะฉบับที่เคยบันทึกสำเนาไว้</p><p role="status">'+(state.busy?'กำลังโหลด…':esc(state.error))+'</p><div class="tbl-wrap"><table class="tbl"><thead><tr><th>เลขที่เอกสาร</th><th>ชื่อเอกสาร</th><th>วันที่ออกเอกสาร</th><th>ผู้ออกเอกสาร</th><th>ข้อมูลฉบับเดิม</th></tr></thead><tbody>'+state.records.map(r=>'<tr><td><b>'+esc(r.docNo)+'</b></td><td>'+esc(r.title)+'</td><td>'+esc(thDateTime(r.issuedAt))+'</td><td>'+esc(r.author||'-')+'</td><td>'+(r.access==='demo'?'<button class="btn btn-ghost btn-sm" data-demo-document="'+esc(r.id)+'">ดูเอกสาร</button>':'<a class="btn btn-ghost btn-sm" target="_blank" rel="noopener" href="/document?id='+encodeURIComponent(r.id)+'&access=private">ดูเอกสาร / พิมพ์ซ้ำ</a>')+'</td></tr>').join('')+'</tbody></table></div>'+(!state.busy&&!state.error&&!state.records.length?'<div class="empty-state">ไม่พบเอกสารที่บันทึกไว้'+(state.query?'ตามคำค้น':'')+'</div>':'')+(state.nextCursor?'<button class="btn btn-ghost" id="moreDocumentHistory" '+(state.busy?'disabled':'')+'>โหลดเอกสารก่อนหน้า</button>':'')+'</div></div>';
 $('#refreshDocumentHistory').onclick=()=>loadDocumentHistory();
 $('#documentHistorySearchForm').onsubmit=e=>{e.preventDefault();state.query=$('#documentHistorySearch').value.trim();loadDocumentHistory();};
 $('#moreDocumentHistory')?.addEventListener('click',()=>loadDocumentHistory(true));
 document.querySelectorAll('[data-demo-document]').forEach(button=>button.onclick=()=>{const d=DB.sentEmails.find(r=>r.id==='document:'+button.dataset.demoDocument)?.document;if(!d)return;openModal('<div class="modal-head"><h3>'+esc(d.docNo)+'</h3><button class="x" onclick="closeModal()">×</button></div><div class="modal-body"><h4>'+esc(d.title)+'</h4>'+d.tables.map(t=>'<h4>'+esc(t.title)+'</h4><div class="tbl-wrap"><table class="tbl"><thead><tr>'+t.headers.map(v=>'<th>'+esc(v)+'</th>').join('')+'</tr></thead><tbody>'+t.rows.map(row=>'<tr>'+row.map(v=>'<td>'+esc(v)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>').join('')+'</div>');});
 if(!state.loaded&&!state.busy&&!state.error)loadDocumentHistory();
}


/* ---------- DASHBOARD ---------- */
function quickMenuEnabled(){if(typeof DB.settings.header?.showQuickMenu==='boolean')return DB.settings.header.showQuickMenu;try{return localStorage.getItem('freshy_quick_menu')!=='off';}catch{return true;}}
function renderDashboard(){
 const today=todayStr(),cashRows=scopeRows(DB.cashsales),debtRows=scopeRows(DB.debtors),cash=cashRows.filter(r=>r.deliveryDate===today),unpaid=debtRows.filter(d=>d.status==='unpaid');
 const sum=(rows,key)=>rows.reduce((total,row)=>total+Number(row[key]||0),0),cashSum=rows=>sum(rows,'jugAmount')+sum(rows,'packAmount');
 const cashTotal=cashSum(cash),debtToday=sum(unpaid.filter(d=>d.debtDate===today),'total'),jugsToday=sum(cash,'jugs')+sum(debtRows.filter(d=>d.debtDate===today),'jugs'),unpaidTotal=sum(unpaid,'total'),paidTotal=sum(debtRows.filter(FreshyPayments.confirmed),'total')+cashSum(cashRows),unpaidCust=new Set(unpaid.map(d=>d.customerId)).size,unpaidJugs=sum(unpaid,'jugs');
 const days=FreshyDashboard.series(cashRows,debtRows,today,dashboardDays),paidPercent=paidTotal+unpaidTotal?Math.round(paidTotal/(paidTotal+unpaidTotal)*100):0;
 const employees=(isAdmin()?DB.employees:DB.employees.filter(e=>e.id===me().id)).map(e=>{const employeeCash=cash.filter(r=>r.createdBy===e.id),employeeDebts=debtRows.filter(r=>r.createdBy===e.id&&r.debtDate===today);return {code:e.code==='7716'?'ADMIN':e.code,name:e.name,cash:cashSum(employeeCash),debt:sum(employeeDebts,'total')};});
 const empHtml='<div class="tbl-wrap"><table class="tbl"><thead><tr><th>รหัสพนักงาน</th><th>ชื่อพนักงาน</th><th class="num">ยอดขายเงินสด</th><th class="num">ยอดลงลูกหนี้</th><th class="num">รวม</th></tr></thead><tbody>'+employees.map(r=>'<tr><td>'+esc(r.code)+'</td><td><b>'+esc(r.name)+'</b></td><td class="num" style="color:var(--green)">'+fmtN(r.cash)+'</td><td class="num" style="color:var(--red)">'+fmtN(r.debt)+'</td><td class="num"><b>'+fmtN(r.cash+r.debt)+'</b></td></tr>').join('')+'</tbody></table></div>';
 const card=(tone,icon,label,value,unit,sub='')=>'<div class="stat-card '+tone+'"><div class="label"><i data-lucide="'+icon+'"></i>'+label+'</div><div class="value">'+fmtN(value)+' <span style="font-size:13px;font-weight:500">'+unit+'</span></div><div class="sub">'+sub+'</div></div>';
 $('#pageContent').innerHTML='<div class="dashboard-hero"><div class="page-head"><p class="hero-eyebrow">FRESHY WATER · ภาพรวมการทำงาน</p><h2>ภาพรวมประจำวัน '+thDate(today)+'</h2><span class="desc">สวัสดี '+esc(me()?.name||'')+' · ติดตามยอดและผลงานของวันนี้</span></div><div class="hero-status"><i></i><div><b>'+(authIdentity?'เชื่อมต่อฐานข้อมูลกลาง':'ตัวอย่างข้อมูลสาธิต')+'</b><span id="syncLastUpdated"></span></div></div></div>'+
 '<div class="command-bar" id="dashboardQuickMenu"><div><b><i data-lucide="zap"></i> เมนูทำงานด่วน</b><span>เลือกงานที่ใช้ประจำโดยไม่ต้องค้นหาเมนู</span></div><div class="command-actions"><button class="btn btn-ghost btn-sm" id="quickDailyDebts"><i data-lucide="calendar-days"></i> ลูกหนี้รายวัน</button><button class="btn btn-primary btn-sm" id="quickDebt"><i data-lucide="plus-circle"></i> เพิ่มลูกหนี้</button><button class="btn btn-success btn-sm" id="quickCash"><i data-lucide="banknote"></i> ลงยอดเงินสด</button>'+(isAdmin()?'<button class="btn btn-ghost btn-sm" id="quickDocumentHistory"><i data-lucide="files"></i> เลขที่เอกสาร / ประวัติพิมพ์</button>':'')+'<button class="btn btn-ghost btn-sm" id="quickCustomer"><i data-lucide="user-plus"></i> เพิ่มลูกค้า</button></div></div>'+
 '<div class="stats-grid">'+card('green','banknote','ยอดขายเงินสดวันนี้',cashTotal,'บาท','จาก '+cash.length+' รายการ')+card('red','wallet','ลูกหนี้ค้างจ่ายวันนี้',debtToday,'บาท','ยอดค้างใหม่วันนี้')+card('orange','package','จำนวนถังที่ขายได้วันนี้',jugsToday,'ถัง','รวมทั้งเงินสดและลูกหนี้')+card('gold','clock-3','รับชำระรอตรวจสอบ',sum(debtRows.filter(d=>FreshyPayments.review(d)==='pending'),'total'),'บาท',debtRows.filter(d=>FreshyPayments.review(d)==='pending').length+' รายการ · ยังไม่รวมยอดอนุมัติ')+'</div>'+
 '<div class="analytics-grid"><div class="panel"><div class="panel-body"><div class="chart-toolbar"><div class="chart-title"><h3>แนวโน้มยอดบันทึกรายวัน</h3><p>เงินสดและยอดบันทึกลูกหนี้ · '+dashboardDays+' วันล่าสุด</p></div><div class="chart-ranges" aria-label="ช่วงวันที่กราฟ">'+[7,14,30].map(d=>'<button type="button" data-chart-days="'+d+'" aria-pressed="'+(d===dashboardDays)+'">'+d+' วัน</button>').join('')+'</div></div><div class="chart-legend"><span><i></i>เงินสด</span><span><i class="debt-key"></i>ยอดบันทึกลูกหนี้</span></div>'+FreshyDashboard.chart(days)+'<div class="chart-readout" id="chartReadout" aria-live="polite">เลือกจุดบนกราฟเพื่อดูยอดของแต่ละวัน</div></div></div>'+
 '<div class="panel"><div class="panel-head"><h3><i data-lucide="chart-pie"></i> เปรียบเทียบยอดรวมระบบ</h3></div><div class="panel-body"><div class="donut-wrap"><div class="debt-donut" role="img" aria-label="ชำระแล้ว '+paidPercent+' เปอร์เซ็นต์" style="background:conic-gradient(#12a878 0% '+paidPercent+'%,#e94d65 '+paidPercent+'% 100%)"><div><b>'+paidPercent+'%</b><span>สัดส่วนยอดชำระแล้ว</span></div></div></div><div class="donut-legend"><div><span>ยอดชำระแล้ว</span><b>'+fmtN(paidTotal)+' บาท</b></div><div><span class="unpaid">ยอดค้างชำระ</span><b>'+fmtN(unpaidTotal)+' บาท</b></div></div></div></div></div>'+
 '<div class="panel"><div class="panel-head"><h3><i data-lucide="users"></i> ทะเบียนรายได้และผลงานพนักงานวันนี้</h3><span class="sync-tag">ข้อมูลตามสิทธิ์ของบัญชี</span></div><div class="panel-body">'+empHtml+'</div></div>'+
 '<div class="panel" style="margin-top:20px"><div class="panel-head"><h3><i data-lucide="database"></i> ข้อมูลสะสมของระบบตั้งแต่เริ่มใช้งาน</h3></div><div class="panel-body"><div class="stats-grid" style="margin-bottom:0">'+card('gold','users','ลูกหนี้ค้างชำระ',unpaidCust,'คน')+card('red','wallet','ยอดค้างรวมทั้งหมด',unpaidTotal,'บาท')+card('green','circle-check-big','ยอดชำระแล้ว',paidTotal,'บาท')+card('orange','package','จำนวนถังคงค้าง',unpaidJugs,'ถัง')+'</div></div></div>'+
 '<div class="report-schedule"><div class="report-clock"><i data-lucide="clock-3"></i></div><div><b>รายงานอัตโนมัติสำหรับผู้บริหาร</b><p>เวลารายงาน '+(DB.settings.email.reportTimes||['08:00','18:00']).join(' / ')+' น. · '+(DB.settings.email.enabled&&DB.settings.email.reportsEnabled?'เปิดการส่งตามเวลา':'ยังไม่เปิดการส่งตามเวลา')+'</p></div></div>';
 const debtArea=canSee('debtorsNai')?'nai':canSee('debtorsOther')?'other':null,customerArea=canSee('customersNai')?'nai':canSee('customersOther')?'other':null;
 $('#quickDebt').hidden=!debtArea;$('#quickCash').hidden=!canSee('cashsales');$('#quickCustomer').hidden=!customerArea;
 $('#dashboardQuickMenu').hidden=!quickMenuEnabled();$('#quickDailyDebts').onclick=()=>navigate('dailyDebts');
 $('#quickDocumentHistory')?.addEventListener('click',()=>navigate('documentHistory'));$('#quickDebt').onclick=()=>{navigate(debtArea==='nai'?'debtorsNai':'debtorsOther');openAddDebtor(debtArea);};$('#quickCash').onclick=()=>{navigate('cashsales');openAddCash();};$('#quickCustomer').onclick=()=>{navigate(customerArea==='nai'?'customersNai':'customersOther');openAddCustomer(customerArea);};
 document.querySelectorAll('[data-chart-days]').forEach(button=>button.onclick=()=>{dashboardDays=+button.dataset.chartDays;renderDashboard();updateSyncNotice();renderIcons();});
 document.querySelectorAll('[data-day]').forEach(point=>{const show=()=>{const day=days[+point.dataset.day];$('#chartReadout').textContent=thDate(day.date)+' · เงินสด '+fmtN(day.cash)+' บาท · ลูกหนี้ '+fmtN(day.debt)+' บาท · '+fmtN(day.jugs)+' ถัง';};point.addEventListener('mouseenter',show);point.addEventListener('focus',show);point.addEventListener('click',show);});updateSyncNotice();
}
function showNotifications(){const bell=$('#notificationsBtn');if(bell)bell.dataset.unread='false';openModal('<div class="modal-head"><h3>การแจ้งเตือนล่าสุด</h3><button class="x" onclick="closeModal()">×</button></div><div class="modal-body">'+(notificationHistory.map(item=>'<div class="notification-entry"><i data-lucide="'+(item.type==='error'?'circle-alert':item.type==='success'?'check-circle-2':'info')+'"></i><div><p>'+esc(item.message)+'</p><time>'+new Date(item.at).toLocaleTimeString('th-TH')+'</time></div></div>').join('')||'<div class="sync-empty"><i data-lucide="bell"></i><b>ยังไม่มีการแจ้งเตือน</b></div>')+'</div>');}
/* Invoice documents are separate snapshots. These editors never update debtors/customers. */
let invoiceEditing=null,invoiceEditingId=null,invoiceDraftOperation=null,invoiceExpected=null,invoiceUndo=[],invoiceRedo=[],invoiceTemplateDraft=null,invoiceTemplateUndo=[],invoiceTemplateRedo=[],invoiceTemplateDirty=false,invoiceSearch='',invoiceIssued={records:[],cursor:null,busy:false,loaded:false,error:''};
function invoiceConfig(){return DB.settings.header.invoice||{};}
function invoiceModel(area,cid,options={}){const rows=scopeRows(DB.debtors).filter(d=>d.area===area&&d.status==='unpaid'&&d.customerId===cid).sort((a,b)=>a.debtDate.localeCompare(b.debtDate));const model=FreshyInvoice.fromDebts(rows,DB.customers.find(c=>c.id===cid)||{},DB.products,invoiceConfig(),{docNo:nextDocNo('INV'),issuedAt:new Date().toISOString(),dueDate:options.dueDate||'',reference:options.reference||'',note:options.note||'',business:DB.settings.business});return model;}
function invoiceHtml(model){return FreshyInvoice.render(model);}
function invoicePreview(model,saved=false){openModal('<div class="modal-head"><h3>ตัวอย่างใบแจ้งหนี้ A4</h3><button class="x" onclick="closeModal()">×</button></div><div class="modal-body"><div class="invoice-sheet-scroll"><div class="doc-page">'+invoiceHtml(model)+'</div></div></div><div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">ปิด</button><button class="btn btn-primary" id="printInvoicePreview">พิมพ์ / บันทึก PDF</button></div>');if(!saved&&!model.source?.debtIds?.length){$('#printInvoicePreview').disabled=true;$('#printInvoicePreview').textContent='ตัวอย่างแบบฟอร์ม';}$('#printInvoicePreview').onclick=async()=>{if(!saved){preparePrint(invoiceHtml(model),model.docNo);return;}$('#printArea').innerHTML='<div class="doc-page">'+invoiceHtml(model)+'</div>';closeModal();if(document.fonts)await document.fonts.ready;await Promise.all([...$('#printArea').querySelectorAll('img')].map(img=>img.complete?Promise.resolve():new Promise(resolve=>{img.onload=resolve;img.onerror=resolve;setTimeout(resolve,5000);})));window.print();};}
function invoiceDraftStart(model,row=null){if(!isAdmin())return;invoiceEditing=FreshyInvoice.normalize(model);invoiceEditingId=row?.id||null;invoiceDraftOperation=crypto.randomUUID();invoiceExpected=row?FreshySync.clone(row):null;invoiceUndo=[];invoiceRedo=[];navigate('invoiceDocuments');renderInvoiceEditor();}
function invoiceRemember(){invoiceUndo.push(FreshySync.clone(invoiceEditing));invoiceUndo=invoiceUndo.slice(-40);invoiceRedo=[];}
function invoiceRowFields(){return ['code','description','quantity','unit','unitPrice','amount'];}
function renderInvoiceEditor(){if(!isAdmin()||!invoiceEditing)return;const d=invoiceEditing;
 $('#pageContent').innerHTML='<div class="page-head"><div><h2>ใบแจ้งหนี้ · ข้อมูลจากระบบ</h2><p class="desc">ข้อมูลเอกสารถูกล็อกให้ตรงกับข้อมูลลูกหนี้ต้นทาง</p></div><button id="invoiceBack" class="btn btn-ghost">กลับรายการเอกสาร</button></div><section class="panel"><div class="panel-body"><p class="invoice-lock-note">🔒 ชื่อ ที่อยู่ ผู้ติดต่อ รายการสินค้า จำนวน ราคา ยอดเงิน เลขเอกสาร และข้อมูลโรงน้ำ อ่านได้อย่างเดียว</p><dl class="invoice-locked-details">'+[['เลขที่เอกสาร',d.docNo],['ลูกค้า',d.customerName],['ที่อยู่',d.address],['ผู้ติดต่อ',d.phone],['ยอดรวม',FreshyInvoice.money(d.total)+' บาท'],['จำนวนรายการ',d.items.length]].map(([k,v])=>'<div><dt>'+esc(k)+'</dt><dd>'+esc(v)+'</dd></div>').join('')+'</dl><div class="invoice-actions"><button id="invoiceSaveDraft" class="btn btn-primary">บันทึกฉบับร่าง</button><button id="invoicePreviewDraft" class="btn btn-ghost">ดูตัวอย่าง / พิมพ์</button></div><p id="invoiceDraftStatus" class="invoice-status" role="status"></p><div id="invoiceDraftPaper" class="invoice-sheet-scroll"><div class="doc-page">'+invoiceHtml(d)+'</div></div></div></section>';
 $('#invoiceBack').onclick=()=>{invoiceEditing=null;renderInvoiceDocuments();};$('#invoiceSaveDraft').onclick=saveInvoiceDraft;$('#invoicePreviewDraft').onclick=()=>invoicePreview(invoiceEditing);
}
async function saveInvoiceDraft(){if(!isAdmin()||!invoiceEditing)return;const button=$('#invoiceSaveDraft'),status=$('#invoiceDraftStatus');button.disabled=true;try{const invoice=FreshyInvoice.normalize(invoiceEditing);if(!invoice.customerName.trim()||!invoice.docNo.trim()||!invoice.items.length)throw Error('กรอกชื่อลูกค้า เลขที่เอกสาร และรายการสินค้า');if(authIdentity){if(!(await flushOnline()))throw Error('ยังมีข้อมูลรอส่ง กรุณาตรวจการซิงก์');const before=FreshySync.shared(DB),result=await apiRequest('/api/document?action=invoice-draft',{method:'POST',body:JSON.stringify({id:invoiceEditingId,operationId:invoiceDraftOperation,expected:invoiceExpected,invoice,expectedRevision:remoteBase?.settings?._resetRevision||''})});acceptRemote(result.payload,FreshySync.diff(before,FreshySync.shared(DB)));invoiceEditingId=result.id;broadcastOnlineChange();}else{const now=new Date().toISOString(),row={id:invoiceEditingId||'invoice-draft:'+crypto.randomUUID(),type:'invoice-draft',createdBy:me().id,updatedAt:now,createdAt:invoiceExpected?.createdAt||now,invoice};if(invoiceEditingId)dbUpdate('sentEmails',invoiceEditingId,row);else dbAdd('sentEmails',row);invoiceEditingId=row.id;}invoiceExpected=FreshySync.clone(DB.sentEmails.find(x=>x.id===invoiceEditingId));status.textContent='บันทึกฉบับร่างแล้ว · ไม่กระทบยอดลูกหนี้';}catch(e){status.textContent=e.message;}finally{button.disabled=false;}}
async function loadInvoiceIssued(more=false){if(!isAdmin()||invoiceIssued.busy)return;invoiceIssued.busy=true;invoiceIssued.error='';renderInvoiceDocuments();try{let result;if(authIdentity){const params=new URLSearchParams({q:invoiceSearch||'ใบแจ้งหนี้'});if(more&&invoiceIssued.cursor)params.set('cursor',invoiceIssued.cursor);result=await apiRequest('/api/document-history?'+params);}else{result={records:DB.sentEmails.filter(x=>x.type==='document'&&x.document?.title==='ใบแจ้งหนี้').map(x=>({id:x.id.slice(9),docNo:x.document.docNo,title:x.document.title,issuedAt:x.ts,author:x.document.author?.name,access:'demo'})),nextCursor:null};}const records=result.records.filter(r=>r.title==='ใบแจ้งหนี้');invoiceIssued.records=more?[...invoiceIssued.records,...records]:records;invoiceIssued.cursor=result.nextCursor;invoiceIssued.loaded=true;}catch(e){invoiceIssued.error=e.message;}finally{invoiceIssued.busy=false;if(currentPage==='invoiceDocuments'&&!invoiceEditing)renderInvoiceDocuments();}}
function renderInvoiceDocuments(){if(!isAdmin())return;if(invoiceEditing){renderInvoiceEditor();return;}const drafts=DB.sentEmails.filter(x=>x.type==='invoice-draft'&&x.invoice&&(!invoiceSearch||JSON.stringify(x.invoice).toLowerCase().includes(invoiceSearch.toLowerCase()))).sort((a,b)=>String(b.updatedAt).localeCompare(a.updatedAt));$('#pageContent').innerHTML='<div class="page-head"><div><h2>จัดการใบแจ้งหนี้</h2><p class="desc">ฉบับร่างและเอกสารที่ออกแล้ว · ข้อมูลเอกสารตรงกับระบบและอ่านอย่างเดียว</p></div><div class="actions"><button id="invoiceCreate" class="btn btn-primary">สร้างจากยอดลูกหนี้</button><button id="invoiceGoTemplate" class="btn btn-ghost">ปรับแบบฟอร์ม</button></div></div><form id="invoiceSearchForm" class="toolbar"><input id="invoiceSearch" placeholder="ค้นหาเลขที่เอกสาร / ชื่อลูกค้า" value="'+esc(invoiceSearch)+'"><button class="btn btn-ghost">ค้นหา</button><button type="button" id="invoiceReload" class="btn btn-ghost">โหลดข้อมูลล่าสุด</button></form><h3>ฉบับร่าง</h3>'+drafts.map(row=>'<article class="invoice-manager-card"><header><b>'+esc(row.invoice.docNo)+'</b><span>ฉบับร่าง</span></header><p>'+esc(row.invoice.customerName)+' · '+FreshyInvoice.money(FreshyInvoice.normalize(row.invoice).total)+' บาท</p><div class="invoice-actions"><button class="btn btn-ghost" data-edit-invoice="'+esc(row.id)+'">เปิดเอกสาร (ข้อมูลล็อก)</button><button class="btn btn-primary" data-preview-invoice="'+esc(row.id)+'">ดูตัวอย่าง / ออกเอกสาร</button></div></article>').join('')+(!drafts.length?'<p class="help-text">ไม่พบฉบับร่าง</p>':'')+'<h3>ใบแจ้งหนี้ที่ออกแล้ว</h3><p role="status">'+esc(invoiceIssued.error|| (invoiceIssued.busy?'กำลังโหลด…':''))+'</p>'+invoiceIssued.records.map(row=>'<article class="invoice-manager-card"><header><b>'+esc(row.docNo)+'</b><span>'+esc(thDateTime(row.issuedAt))+'</span></header><p>'+esc(row.author||'-')+'</p><div class="invoice-actions">'+(row.access==='demo'?'<button class="btn btn-ghost" data-preview-issued="'+esc(row.id)+'">พิมพ์ฉบับเดิม</button>':'<a class="btn btn-ghost" href="/document?id='+encodeURIComponent(row.id)+'&access=private" target="_blank" rel="noopener">พิมพ์ฉบับเดิม</a>')+'<button class="btn btn-ghost" data-copy-invoice="'+esc(row.id)+'">คัดลอกเป็นฉบับร่างใหม่</button></div></article>').join('')+(!invoiceIssued.records.length&&!invoiceIssued.busy?'<p class="help-text">ไม่พบใบแจ้งหนี้ที่ออกแล้ว</p>':'')+(invoiceIssued.cursor?'<button id="invoiceMore" class="btn btn-ghost">โหลดก่อนหน้า</button>':'');
 $('#invoiceCreate').onclick=()=>openNewInvoiceDraft();$('#invoiceGoTemplate').onclick=()=>navigate('invoiceTemplates');$('#invoiceSearchForm').onsubmit=e=>{e.preventDefault();invoiceSearch=$('#invoiceSearch').value.trim();loadInvoiceIssued();};$('#invoiceReload').onclick=()=>loadInvoiceIssued();$('#invoiceMore')?.addEventListener('click',()=>loadInvoiceIssued(true));$('#pageContent').querySelectorAll('[data-edit-invoice]').forEach(b=>b.onclick=()=>{const row=DB.sentEmails.find(x=>x.id===b.dataset.editInvoice);invoiceDraftStart(row.invoice,row);});$('#pageContent').querySelectorAll('[data-preview-invoice]').forEach(b=>b.onclick=()=>invoicePreview(DB.sentEmails.find(x=>x.id===b.dataset.previewInvoice).invoice));$('#pageContent').querySelectorAll('[data-preview-issued]').forEach(b=>b.onclick=()=>{const saved=DB.sentEmails.find(x=>x.id==='document:'+b.dataset.previewIssued)?.document;if(saved?.invoice?.version===2)invoicePreview(saved.invoice,true);else toast('เอกสารฉบับนี้ใช้รูปแบบก่อนหน้า','info');});$('#pageContent').querySelectorAll('[data-copy-invoice]').forEach(b=>b.onclick=async()=>{try{const id=b.dataset.copyInvoice,saved=authIdentity?(await apiRequest('/api/document?id='+id+'&access=private')).document:DB.sentEmails.find(x=>x.id==='document:'+id)?.document;if(saved?.invoice?.version!==2)throw Error('เอกสารรูปแบบก่อนหน้าเปิดพิมพ์ได้ แต่ต้องสร้างฉบับร่างใหม่จากยอดลูกหนี้');const source=saved.invoice.source;if(!source?.customerId)throw Error('เอกสารเดิมไม่มีการเชื่อมโยงลูกหนี้ กรุณาสร้างใหม่จากยอดค้าง');invoiceDraftStart(invoiceModel(source.area,source.customerId,{reference:saved.docNo}));}catch(e){toast(e.message,'error');}});
 if(!invoiceIssued.loaded&&!invoiceIssued.busy)loadInvoiceIssued();
}
function openNewInvoiceDraft(){if(!isAdmin())return;const choices=new Map();scopeRows(DB.debtors).filter(d=>d.status==='unpaid').forEach(d=>choices.set(d.customerId,{name:d.customerName,area:d.area}));openModal('<div class="modal-head"><h3>สร้างฉบับร่างจากยอดค้าง</h3><button class="x" onclick="closeModal()">×</button></div><div class="modal-body"><div class="field"><label for="newInvoiceCustomer">ลูกค้า</label><select id="newInvoiceCustomer">'+[...choices].map(([id,c])=>'<option value="'+esc(id)+'">'+esc(c.name)+'</option>').join('')+'</select></div><p class="help-text">ดึงเฉพาะยอดค้างชำระปัจจุบันมาเป็นสำเนาในเอกสาร</p></div><div class="modal-foot"><button class="btn btn-primary" id="newInvoiceConfirm">เปิดฉบับร่าง</button></div>');$('#newInvoiceConfirm').onclick=()=>{try{const cid=$('#newInvoiceCustomer').value,c=choices.get(cid);if(!c)throw Error('ไม่พบลูกหนี้ค้างชำระ');const model=invoiceModel(c.area,cid);closeModal();invoiceDraftStart(model);}catch(e){toast(e.message,'error');}};}
const INVOICE_SECTION_NAMES={heading:'โลโก้ / ใบแจ้งหนี้ (ตำแหน่งมุมบนล็อก)',issuer:'ผู้ออกเอกสาร',customer:'ลูกค้า',items:'ตารางสินค้า',summary:'หมายเหตุ / ยอดรวม',signatures:'ช่องลงชื่อ',footer:'ท้ายเอกสาร'};
function templateRemember(){invoiceTemplateUndo.push(FreshySync.clone(invoiceTemplateDraft));invoiceTemplateUndo=invoiceTemplateUndo.slice(-40);invoiceTemplateRedo=[];invoiceTemplateDirty=true;}
function templateSample(){const model=FreshyInvoice.normalize({docNo:'INV-00000001',issuedAt:new Date().toISOString(),dueDate:'',customerName:'ชื่อลูกค้า (ตัวอย่าง)',customerCode:'C001',address:'บ้านสมุนไพร ตำบลบ้านหัน อำเภอเกษตรสมบูรณ์ จังหวัดชัยภูมิ 36120',phone:'-',issuer:{...FreshyInvoice.ISSUER,...invoiceConfig().issuer},items:[{code:DB.products[0]?.code||'-',description:'น้ำดื่มชนิดถัง',quantity:2,unit:'ถัง',unitPrice:15,amount:30}],note:'ตัวอย่างรูปแบบเอกสาร',template:invoiceTemplateDraft});return model;}
function renderInvoiceTemplates(){if(!isAdmin())return;if(!invoiceTemplateDraft)invoiceTemplateDraft=FreshyInvoice.template(invoiceConfig().template);const t=invoiceTemplateDraft;$('#pageContent').innerHTML='<div class="page-head"><div><h2>ปรับแบบฟอร์มใบแจ้งหนี้</h2><p class="desc">ลากส่วนเอกสาร สลับคอลัมน์ แก้หัวตาราง และกำหนดขนาดได้ · ใช้กับเอกสารใหม่</p></div><div class="actions"><button id="invoiceTemplateSave" class="btn btn-primary">บันทึกแบบฟอร์ม</button><button id="invoiceTemplatePreview" class="btn btn-ghost">ดูตัวอย่าง A4</button></div></div><div class="invoice-template-layout"><aside class="invoice-template-controls"><div class="invoice-actions"><button id="templateUndo" class="btn btn-ghost" '+(!invoiceTemplateUndo.length?'disabled':'')+'>เลิกทำ</button><button id="templateRedo" class="btn btn-ghost" '+(!invoiceTemplateRedo.length?'disabled':'')+'>ทำซ้ำ</button><button id="templateReset" class="btn btn-ghost">แบบมาตรฐาน</button></div><b>ลำดับส่วนเอกสาร</b><div class="invoice-section-list">'+t.sections.map((id,i)=>'<div draggable="true" data-template-section="'+id+'"><span>'+esc(INVOICE_SECTION_NAMES[id])+'</span><button data-section-up="'+i+'" title="ย้ายขึ้น">↑</button><button data-section-down="'+i+'" title="ย้ายลง">↓</button></div>').join('')+'</div><hr><b>คอลัมน์ตาราง</b><div class="invoice-column-list">'+t.columns.map((c,i)=>'<div><button data-column-up="'+i+'" title="ย้ายคอลัมน์ซ้าย">←</button><input aria-label="หัวคอลัมน์ '+c.key+'" data-column-label="'+c.key+'" value="'+esc(c.label)+'"><input aria-label="ความกว้าง '+c.key+'" data-column-width="'+c.key+'" type="number" min="5" max="65" value="'+c.width+'" style="width:65px"><button data-column-down="'+i+'" title="ย้ายคอลัมน์ขวา">→</button></div>').join('')+'</div><p class="help-text">ตัวเลขคือสัดส่วนความกว้างคอลัมน์ แก้หัวตารางบนกระดาษได้โดยตรง</p><div class="invoice-inspector">'+[['fontSize','ขนาดตัวอักษร',9,18],['rowHeight','ความสูงแถว',18,60],['bodyHeight','พื้นที่ตาราง',0,510],['logoSize','ขนาดโลโก้',96,180],['titleSize','ขนาดชื่อเอกสาร',22,38],['signatureGap','ช่องว่างเซ็นชื่อ',48,120]].map(([key,label,min,max])=>'<label>'+label+'<input data-template-size="'+key+'" type="number" min="'+min+'" max="'+max+'" value="'+t[key]+'"></label>').join('')+'</div><hr><div class="field"><label>ชื่อผู้อนุมัติ (ใต้เส้น)</label><input id="templateSignerName" value="'+esc(t.signerName)+'"></div><div class="field"><label>ตำแหน่งผู้ลงชื่อฝั่งซ้าย</label><input id="templateSignerRole" value="'+esc(t.signerRole)+'"></div><div class="field"><label>ชื่อผู้รับใบแจ้งหนี้</label><input readonly id="templateReceiverName" value="ดึงชื่อลูกค้าอัตโนมัติ"></div><div class="field"><label>ตำแหน่งผู้ลงชื่อฝั่งขวา</label><input id="templateReceiverRole" value="'+esc(t.receiverRole)+'"></div><p id="invoiceTemplateStatus" class="invoice-status" role="status">'+(invoiceTemplateDirty?'มีการแก้ไขที่ยังไม่ได้บันทึก':'')+'</p></aside><div id="invoiceTemplateCanvas" class="invoice-sheet-scroll"><div class="doc-page">'+FreshyInvoice.render(templateSample(),{editor:true})+'</div></div></div>';
 const rerender=()=>{invoiceTemplateDraft=FreshyInvoice.template(t);renderInvoiceTemplates();};const move=(list,i,j)=>{if(j<0||j>=list.length||(list===t.sections&&(i===0||j===0)))return;templateRemember();[list[i],list[j]]=[list[j],list[i]];rerender();};
 $('#pageContent').querySelectorAll('[data-section-up]').forEach(b=>b.onclick=()=>move(t.sections,+b.dataset.sectionUp,+b.dataset.sectionUp-1));$('#pageContent').querySelectorAll('[data-section-down]').forEach(b=>b.onclick=()=>move(t.sections,+b.dataset.sectionDown,+b.dataset.sectionDown+1));$('#pageContent').querySelectorAll('[data-column-up]').forEach(b=>b.onclick=()=>move(t.columns,+b.dataset.columnUp,+b.dataset.columnUp-1));$('#pageContent').querySelectorAll('[data-column-down]').forEach(b=>b.onclick=()=>move(t.columns,+b.dataset.columnDown,+b.dataset.columnDown+1));
 const columnChange=(key,field,value)=>{templateRemember();const col=t.columns.find(c=>c.key===key);col[field]=value;rerender();};$('#pageContent').querySelectorAll('[data-column-label]').forEach(e=>e.onchange=()=>columnChange(e.dataset.columnLabel,'label',e.value));$('#pageContent').querySelectorAll('[data-column-width]').forEach(e=>e.onchange=()=>columnChange(e.dataset.columnWidth,'width',Number(e.value)));$('#invoiceTemplateCanvas').querySelectorAll('[contenteditable]').forEach(e=>{e.onblur=()=>{if(e.textContent.trim()!==t.columns.find(c=>c.key===e.dataset.columnKey).label)columnChange(e.dataset.columnKey,'label',e.textContent.trim());};e.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();e.blur();}};e.onpaste=event=>{event.preventDefault();e.textContent=event.clipboardData.getData('text/plain').slice(0,80);};});
 $('#pageContent').querySelectorAll('[data-template-size]').forEach(e=>e.onchange=()=>{templateRemember();t[e.dataset.templateSize]=Number(e.value);rerender();});for(const [id,key] of [['templateSignerName','signerName'],['templateSignerRole','signerRole'],['templateReceiverRole','receiverRole']])$('#'+id).onchange=e=>{templateRemember();t[key]=e.target.value;rerender();};
 let dragged=null;$('#pageContent').querySelectorAll('[data-template-section],[data-invoice-section]').forEach(e=>{e.ondragstart=event=>{if(event.target.closest('[contenteditable]')){event.preventDefault();return;}dragged=e.dataset.templateSection||e.dataset.invoiceSection;event.dataTransfer.setData('text/plain',dragged);};e.ondragover=event=>event.preventDefault();e.ondrop=event=>{event.preventDefault();event.stopPropagation();const target=e.dataset.templateSection||e.dataset.invoiceSection;if(!dragged||dragged===target||dragged==='heading'||target==='heading')return;templateRemember();const index=t.sections.indexOf(dragged);t.sections.splice(index,1);t.sections.splice(t.sections.indexOf(target),0,dragged);dragged=null;rerender();};});
 $('#templateUndo').onclick=()=>{if(!invoiceTemplateUndo.length)return;invoiceTemplateRedo.push(FreshySync.clone(t));invoiceTemplateDraft=invoiceTemplateUndo.pop();invoiceTemplateDirty=true;renderInvoiceTemplates();};$('#templateRedo').onclick=()=>{if(!invoiceTemplateRedo.length)return;invoiceTemplateUndo.push(FreshySync.clone(t));invoiceTemplateDraft=invoiceTemplateRedo.pop();invoiceTemplateDirty=true;renderInvoiceTemplates();};$('#templateReset').onclick=()=>{templateRemember();invoiceTemplateDraft=FreshyInvoice.defaults();renderInvoiceTemplates();};$('#invoiceTemplatePreview').onclick=()=>invoicePreview(templateSample());$('#invoiceTemplateSave').onclick=async()=>{const button=$('#invoiceTemplateSave'),status=$('#invoiceTemplateStatus');button.disabled=true;try{const prior=FreshySync.clone(DB.settings);DB.settings.header.invoice={...invoiceConfig(),template:FreshyInvoice.template(t)};dbSave();if(authIdentity&&!(await flushOnline()))throw Error('แบบฟอร์มยังรอส่ง กรุณาตรวจการซิงก์แล้วกดบันทึกอีกครั้ง');invoiceTemplateDirty=false;status.textContent='บันทึกแล้ว · เอกสารที่ออกก่อนหน้านี้ยังใช้แบบเดิม';}catch(e){status.textContent=e.message;}finally{button.disabled=false;}};
}
function invoiceSettingsHtml(){const c=invoiceConfig(),issuer={...FreshyInvoice.ISSUER};return '<div class="panel"><div class="panel-head"><h3>ข้อมูลใบแจ้งหนี้ / รหัสสินค้า</h3></div><div class="panel-body"><p class="help-text">ข้อมูลโรงน้ำและ Tax ID ถูกล็อกตามข้อมูลที่ยืนยันแล้ว · ตั้งรหัสสินค้าและปรับขนาดโลโก้ได้</p><div class="invoice-options">'+[['name','ชื่อผู้ออกเอกสาร'],['address','ที่อยู่โรงน้ำ'],['taxId','เลขประจำตัวผู้เสียภาษี / Tax ID'],['phone','เบอร์โทรโรงน้ำ (2 เบอร์)']].map(([k,label])=>'<div class="field"><label>'+label+'</label><input readonly id="invoiceIssuer_'+k+'" value="'+esc(issuer[k])+'"></div>').join('')+[['jugs','สินค้าน้ำถัง'],['packs','สินค้าน้ำแพ็ค']].map(([k,label])=>'<div class="field"><label>'+label+'</label><select id="invoiceProduct_'+k+'"><option value="">จับคู่จากชื่อสินค้า</option>'+DB.products.map(p=>'<option value="'+esc(p.id)+'" '+(c.productMap?.[k]===p.id?'selected':'')+'>'+esc(p.code+' · '+p.name)+'</option>').join('')+'</select></div>').join('')+'<div class="field"><label>ตำบล / อำเภอ / จังหวัด ต่อท้ายชื่อหมู่บ้าน</label><input id="invoiceCustomerLocality" value="'+esc(c.customerLocality||'ตำบลบ้านหัน อำเภอเกษตรสมบูรณ์ จังหวัดชัยภูมิ 36120')+'"></div></div><div class="invoice-actions"><button id="saveInvoiceSettings" class="btn btn-primary">บันทึกข้อมูลใบแจ้งหนี้</button><button id="invoiceSettingsProducts" class="btn btn-ghost">ตั้งรหัสสินค้า</button><button id="invoiceSettingsTemplate" class="btn btn-ghost">ปรับแบบฟอร์ม</button></div><p id="invoiceSettingsStatus" role="status"></p></div></div>';}
function bindInvoiceSettings(){if(!$('#saveInvoiceSettings'))return;$('#invoiceSettingsProducts').onclick=()=>{settingTab='products';renderSettings();};$('#invoiceSettingsTemplate').onclick=()=>navigate('invoiceTemplates');$('#saveInvoiceSettings').onclick=async()=>{const button=$('#saveInvoiceSettings');button.disabled=true;try{const issuer={};for(const k of ['name','address','taxId','phone'])issuer[k]=$('#invoiceIssuer_'+k).value.trim();if(!issuer.name||!issuer.address||!issuer.phone)throw Error('กรอกชื่อ ที่อยู่ และเบอร์โทรโรงน้ำ');DB.settings.header.invoice={...invoiceConfig(),issuer,productMap:{jugs:$('#invoiceProduct_jugs').value,packs:$('#invoiceProduct_packs').value},customerLocality:$('#invoiceCustomerLocality').value.trim()};dbSave();if(authIdentity&&!(await flushOnline()))throw Error('ข้อมูลยังรอส่ง กรุณาตรวจการซิงก์');$('#invoiceSettingsStatus').textContent='บันทึกข้อมูลใบแจ้งหนี้แล้ว';}catch(e){$('#invoiceSettingsStatus').textContent=e.message;}finally{button.disabled=false;}};}

/* ---------- DEBTORS (nai / other) ---------- */
let debtorFilter={nai:'all',other:'all'}, debtorSearch='';
let custSearch={nai:'',other:''}, custCredit={nai:'all',other:'all'};
let debtorPage={nai:0,other:0},debtorRowPages=Object.create(null);
const DEBT_ROWS_PER_PAGE=10;
/* ---------- ADMIN DEBT CORRECTION AND PASSWORD-GATED RECOVERY ---------- */
let recoveryRecords=null,recoveryUnlocked=false,recoveryError='',recoveryTimer=null,recoveryLoading=false,recoveryGeneration=0;
function adminDebtButtons(record){return isAdmin()?'<button class="btn btn-ghost btn-sm editAdminDebt" data-id="'+esc(record.id)+'">แก้ไขรายการ</button> <button class="btn btn-danger btn-sm deleteAdminDebt" data-id="'+esc(record.id)+'">ลบรายการ</button>':'';}
async function adminDebtRequest(action,args={}){
 if(!isAdmin())throw Error('เฉพาะแอดมินเท่านั้น');if(!authIdentity)throw Error('กรุณาเข้าสู่ระบบออนไลน์');
 if(['edit','delete','restore'].includes(action)&&!(await flushOnline()))throw Error('กรุณาส่งข้อมูลรอซิงก์ให้สำเร็จก่อน');
 const before=FreshySync.shared(DB),result=await apiRequest('/api/debt-admin',{method:'POST',body:JSON.stringify({...args,action,expectedRevision:remoteBase?.settings?._resetRevision||''})});
 if(result.payload){acceptRemote(result.payload,FreshySync.diff(before,FreshySync.shared(DB)));broadcastOnlineChange();renderNav();}
 return result;
}
function openEditAdminDebt(id){
 if(!isAdmin())return;const record=DB.debtors.find(x=>x.id===id);if(!record)return;const expected=FreshySync.clone(record);
 const options=DB.customers.map(c=>'<option value="'+esc(c.id)+'" '+(c.id===record.customerId?'selected':'')+'>'+esc(c.code||'')+' · '+esc(c.name)+'</option>').join(''),hasCustomer=DB.customers.some(c=>c.id===record.customerId);
 openModal('<div class="modal-head"><h3>แก้ไขรายการลูกหนี้ · แอดมิน</h3><button class="x" onclick="closeModal()">×</button></div><div class="modal-body"><p>แก้เฉพาะรายการนี้ สถานะค้างชำระหรือรับชำระยังคงเดิม</p><div class="form-grid"><div class="field full"><label for="adminDebtCustomer">ชื่อลูกค้า / รหัสลูกค้า (เลือกรายที่ถูกต้อง)</label><select id="adminDebtCustomer">'+(!hasCustomer?'<option value="'+esc(record.customerId)+'">'+esc(record.customerName)+'</option>':'')+options+'</select></div><div class="field"><label for="adminDebtDate">วันที่ค้างชำระ</label><input id="adminDebtDate" type="date" value="'+esc(record.debtDate)+'"></div>'+[['jugs','จำนวนถัง'],['packs','จำนวนแพ็ค'],['jugAmount','เงินน้ำถัง (บาท)'],['packAmount','เงินน้ำแพ็ค (บาท)']].map(([k,label])=>'<div class="field"><label for="adminDebt_'+k+'">'+label+'</label><input id="adminDebt_'+k+'" type="number" min="0" step="'+(k==='jugs'||k==='packs'?'1':'0.01')+'" value="'+esc(record[k]??0)+'"></div>').join('')+'</div><p class="help-text">ยอดรวมคำนวณจากเงินน้ำถัง + เงินน้ำแพ็ค</p><p id="adminDebtError" role="alert"></p></div><div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">ยกเลิก</button><button class="btn btn-primary" id="saveAdminDebt">บันทึกการแก้ไข</button></div>');
 $('#saveAdminDebt').onclick=async()=>{const button=$('#saveAdminDebt');button.disabled=true;try{const patch={customerId:$('#adminDebtCustomer').value,debtDate:$('#adminDebtDate').value};for(const k of ['jugs','packs','jugAmount','packAmount'])patch[k]=Number($('#adminDebt_'+k).value);await adminDebtRequest('edit',{id,expected,patch});closeModal();renderPage();toast('แก้ไขรายการแล้ว','success');}catch(e){$('#adminDebtError').textContent=e.message;button.disabled=false;}};
}
function openDeleteAdminDebt(id){
 if(!isAdmin())return;const record=DB.debtors.find(x=>x.id===id);if(!record)return;const expected=FreshySync.clone(record),operationId=crypto.randomUUID();
 openModal('<div class="modal-head"><h3>ลบ'+(record.status==='paid'?'ประวัติรับชำระ':'รายการค้างชำระ')+'</h3><button class="x" onclick="closeModal()">×</button></div><div class="modal-body"><p><b>'+esc(record.customerName)+'</b> · '+esc(thDate(record.debtDate))+' · '+fmtN(record.total)+' บาท</p><p>รายการนี้จะออกจากยอดและรายงานปัจจุบัน เก็บสำเนาเข้ารหัสไว้ในหน้ากู้คืนข้อมูลที่ลบ โดยไม่กดรับชำระ</p><div class="field"><label for="adminDeleteReason">เหตุผลที่ลบ</label><textarea id="adminDeleteReason" maxlength="2000" rows="3" placeholder="เช่น กรอกชื่อผิด หรือบันทึกซ้ำ"></textarea></div><p id="adminDeleteError" role="alert"></p></div><div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">ยกเลิก</button><button class="btn btn-danger" id="confirmAdminDelete">ยืนยันลบรายการ</button></div>');
 $('#confirmAdminDelete').onclick=async()=>{const reason=$('#adminDeleteReason').value.trim();if(!reason){$('#adminDeleteError').textContent='กรอกเหตุผลที่ลบ';return;}const button=$('#confirmAdminDelete');button.disabled=true;try{await adminDebtRequest('delete',{id,expected,reason,operationId});closeModal();renderPage();toast('ลบรายการแล้ว · กู้คืนได้จากหน้ากู้คืนข้อมูลที่ลบ','success');}catch(e){$('#adminDeleteError').textContent=e.message;button.disabled=false;}};
}
function bindAdminDebtButtons(root=$('#pageContent')){root.querySelectorAll('.editAdminDebt').forEach(b=>b.onclick=()=>openEditAdminDebt(b.dataset.id));root.querySelectorAll('.deleteAdminDebt').forEach(b=>b.onclick=()=>openDeleteAdminDebt(b.dataset.id));}
function lockRecovery(){recoveryGeneration++;clearTimeout(recoveryTimer);recoveryTimer=null;recoveryRecords=null;recoveryUnlocked=false;recoveryError='';recoveryLoading=false;if(authIdentity&&isAdmin())adminDebtRequest('lock').catch(()=>{});}
async function loadDeletedRecovery(){
 const generation=recoveryGeneration;recoveryLoading=true;renderDeletedRecovery();try{const data=await apiRequest('/api/debt-admin',{method:'GET'});if(generation!==recoveryGeneration)return;recoveryRecords=data.records;}catch(e){if(generation===recoveryGeneration){recoveryRecords=null;recoveryUnlocked=false;recoveryError=e.message;}}finally{if(generation===recoveryGeneration){recoveryLoading=false;if(currentPage==='deletedRecovery')renderDeletedRecovery();}}
}
function renderDeletedRecovery(){
 if(!isAdmin())return;
 if(!recoveryUnlocked){$('#pageContent').innerHTML='<div class="page-head"><h2>กู้คืนข้อมูลที่ลบ</h2></div><div class="panel"><div class="panel-body"><h3>ยืนยันตัวตนแอดมิน</h3><p>กรอกรหัสผ่านบัญชีที่กำลังเข้าสู่ระบบก่อนดูหรือกู้คืนรายการที่ลบ</p><form id="recoveryUnlockForm"><div class="field"><label for="recoveryPassword">รหัสผ่านบัญชีแอดมิน</label><input id="recoveryPassword" type="password" autocomplete="current-password" maxlength="1024" required></div><p id="recoveryUnlockError" role="alert">'+esc(recoveryError)+'</p><button class="btn btn-primary" id="unlockRecovery">ยืนยันและเข้าหน้ากู้คืน</button></form></div></div>';
 $('#recoveryUnlockForm').onsubmit=async e=>{e.preventDefault();const generation=recoveryGeneration,input=$('#recoveryPassword'),password=input.value,button=$('#unlockRecovery');input.value='';button.disabled=true;try{await adminDebtRequest('unlock',{password});if(generation!==recoveryGeneration||currentPage!=='deletedRecovery'){adminDebtRequest('lock').catch(()=>{});return;}recoveryUnlocked=true;recoveryError='';recoveryTimer=setTimeout(()=>{lockRecovery();if(currentPage==='deletedRecovery')renderDeletedRecovery();},300000);await loadDeletedRecovery();}catch(error){if(button.isConnected){$('#recoveryUnlockError').textContent=error.message;button.disabled=false;}}};return;}
 const rows=recoveryRecords||[];
 $('#pageContent').innerHTML='<div class="page-head"><h2>กู้คืนข้อมูลที่ลบ</h2><button class="btn btn-ghost" id="lockRecovery">ล็อกหน้ากู้คืน</button></div><p class="help-text">กู้คืนด้วยรหัสรายการและสถานะเดิม ระบบไม่สร้างยอดซ้ำ · หน้านี้จะล็อกใน 5 นาที หรือเมื่อออกจากหน้า</p><p role="status">'+(recoveryLoading?'กำลังโหลดรายการที่ลบ…':esc(recoveryError))+'</p><div class="panel"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>ลูกค้า</th><th>วันที่ค้าง</th><th>สถานะเดิม</th><th>ยอดเงิน</th><th>วันที่ลบ / ผู้ลบ</th><th>เหตุผล</th><th>กู้คืน</th></tr></thead><tbody>'+rows.map(x=>'<tr><td>'+esc(x.record.customerName)+'</td><td>'+esc(thDate(x.record.debtDate))+'</td><td>'+(x.record.status==='paid'?'รับชำระแล้ว':'ค้างชำระ')+'</td><td>'+fmtN(x.record.total)+'</td><td>'+esc(thDateTime(x.deletedAt))+' · '+esc(x.deletedBy)+'</td><td>'+esc(x.reason)+'</td><td><button class="btn btn-primary btn-sm restoreDeletedDebt" data-id="'+esc(x.archiveId)+'">กู้คืนรายการ</button></td></tr>').join('')+'</tbody></table></div></div>'+(!rows.length&&!recoveryLoading?'<div class="empty-state">ไม่มีรายการที่ลบรอกู้คืน</div>':'');
 $('#lockRecovery').onclick=()=>{lockRecovery();renderDeletedRecovery();};
 $('#pageContent').querySelectorAll('.restoreDeletedDebt').forEach(button=>button.onclick=async()=>{if(!confirm('กู้คืนรายการนี้ด้วยยอดและสถานะเดิม?'))return;button.disabled=true;try{await adminDebtRequest('restore',{archiveId:button.dataset.id});await loadDeletedRecovery();toast('กู้คืนรายการแล้ว','success');}catch(e){recoveryError=e.message;button.disabled=false;if(/รหัสผ่าน|ยืนยัน/.test(e.message)){lockRecovery();renderDeletedRecovery();}else toast(e.message,'error');}});
}

function openMobileDebtActions(id){if(!isAdmin())return;const d=DB.debtors.find(x=>x.id===id);if(!d)return;openModal('<div class="modal-head"><h3>'+esc(d.customerName)+' · '+esc(thDate(d.debtDate))+'</h3><button class="x" onclick="closeModal()">×</button></div><div class="modal-body"><p>ยอดรวม '+fmtN(d.total)+' บาท</p><div class="mobile-debt-action-list">'+(FreshyPayments.canReceive(d,me())?'<button id="mobileReceiveDebt" class="btn btn-primary">รับชำระรายการนี้</button>':'')+(isAdmin()?'<button id="mobileEditDebt" class="btn btn-ghost">แก้ไขรายการ</button><button id="mobileDeleteDebt" class="btn btn-danger">ลบรายการ</button>':'')+'</div></div>');$('#mobileReceiveDebt')?.addEventListener('click',()=>{closeModal();markPaid(id);});$('#mobileEditDebt')?.addEventListener('click',()=>openEditAdminDebt(id));$('#mobileDeleteDebt')?.addEventListener('click',()=>openDeleteAdminDebt(id));}
function debtorRowsHtml(list){return list.map(d=>{
 const payment=FreshyPayments.canReceive(d,me())?`<button class="btn btn-success btn-sm payOne${isAdmin()?'':' staffDebtPayment'}" data-id="${esc(d.id)}"><i data-lucide="check"></i> ชำระแล้ว</button>`:'<span class="pill gray">ดูข้อมูล</span>';
 const actions=isAdmin()?`<button class="btn btn-ghost btn-sm mobileDebtActions" data-id="${esc(d.id)}" aria-label="จัดการรายการวันที่ ${esc(thDate(d.debtDate))}">จัดการ</button><span class="desktopDebtActions">${payment} ${adminDebtButtons(d)}</span>`:payment;
 return `<tr><td>${thDate(d.debtDate)}</td><td class="num">${d.jugs||0}</td><td class="num">${d.packs||0}</td><td class="num">${fmtN(d.jugAmount)}</td><td class="num">${fmtN(d.packAmount)}</td><td class="num"><b>${fmtN(d.total)}</b></td><td class="ce">${actions}</td></tr>`;
}).join('');}
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
  const pageSize=window.matchMedia('(max-width:768px)').matches?10:30;
  const ids=Object.keys(groups),pages=Math.max(1,Math.ceil(ids.length/pageSize));debtorPage[area]=Math.min(debtorPage[area],pages-1);const customerMap=new Map(DB.customers.map(c=>[c.id,c]));
  ids.slice(debtorPage[area]*pageSize,(debtorPage[area]+1)*pageSize).forEach(cid=>{
    idx++; const list=groups[cid].sort((a,b)=>a.debtDate<b.debtDate?-1:1);
    const c=customerMap.get(cid)||{};
    const tj=list.reduce((s,d)=>s+(d.jugs||0),0), tp=list.reduce((s,d)=>s+(d.packs||0),0), tt=list.reduce((s,d)=>s+d.total,0);
    const latest=list.reduce((a,b)=>String(a.createdAt)>String(b.createdAt)?a:b);
    const creator=recorderName(latest.createdBy);

    const rowPages=Math.ceil(list.length/DEBT_ROWS_PER_PAGE),rowPage=Math.min(debtorRowPages[cid]||0,rowPages-1);debtorRowPages[cid]=rowPage;
    const rowsHtml=debtorRowsHtml(list.slice(rowPage*DEBT_ROWS_PER_PAGE,(rowPage+1)*DEBT_ROWS_PER_PAGE));
    const rowPager=rowPages>1?`<div class="debtor-row-pager"><button class="btn btn-ghost btn-sm debtRowsPrev" data-cid="${esc(cid)}" ${rowPage===0?'disabled':''} aria-label="รายการก่อนหน้าของ ${esc(list[0].customerName)}">ก่อนหน้า</button><span class="debt-row-range">รายการ ${rowPage*DEBT_ROWS_PER_PAGE+1}–${Math.min((rowPage+1)*DEBT_ROWS_PER_PAGE,list.length)} / ${list.length}</span><button class="btn btn-ghost btn-sm debtRowsNext" data-cid="${esc(cid)}" ${rowPage===rowPages-1?'disabled':''} aria-label="รายการถัดไปของ ${esc(list[0].customerName)}">ถัดไป</button></div>`:'';
    const meta=area==='nai'?('หมู่ที่ '+(c.moo||list[0].moo||'-')):(c.village||list[0].village||'-');
    cardsHtml+=`<div class="debtor-card" data-cid="${esc(cid)}" data-name="${esc(list[0].customerName)}">
      <div class="dc-head"><div class="idx">${idx}</div><div><div class="cname">${esc(list[0].customerName)}</div><div class="cmeta">${esc(meta)} · เบอร์โทร: ${esc(customerPhone(c))} · ค้าง ${list.length} ครั้ง</div></div>
      ${list.every(d=>FreshyPayments.canReceive(d,me()))?`<button class="btn btn-gold btn-sm payAll" data-cid="${cid}"><i data-lucide="badge-check"></i> จ่ายทั้งหมด</button>`:''}
      ${canEditCustomerPhone(c)?`<button class="btn btn-ghost btn-sm customerPhoneEdit" data-cid="${esc(cid)}">เบอร์โทร</button>`:''}<button class="btn btn-ghost btn-sm debtorDocument" data-cid="${cid}" aria-label="เปิดเอกสารลูกหนี้ ${esc(list[0].customerName)}"><i data-lucide="file-text"></i> เอกสารลูกหนี้</button></div>
      <div class="tbl-scroll"><table><thead><tr><th>วันที่ค้าง</th><th class="num">ถัง</th><th class="num">แพ็ค</th><th class="num">เงินน้ำถัง</th><th class="num">เงินน้ำแพ็ค</th><th class="num">ยอดรวม</th><th class="ce">จัดการ</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
      ${rowPager}<div class="dc-foot"><span>รวม <b>${tj}</b> ถัง</span><span><b>${tp}</b> แพ็ค</span><span class="total">ค้างทั้งหมด ${fmtN(tt)} บาท</span><span style="width:100%;font-size:11px;color:var(--muted);margin-top:4px;border-top:1px dashed var(--border);padding-top:6px">บันทึกล่าสุดโดย <b>${esc(creator)}</b> · ${thDateTimeSec(latest.createdAt)}</span></div>
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
    <div class="debtor-cards">${cardsHtml}</div><div class="pager"><button class="btn btn-ghost btn-sm" id="debtPrev" ${debtorPage[area]===0?'disabled':''}>ก่อนหน้า</button><span>หน้า ${debtorPage[area]+1} / ${pages} · ${ids.length} ลูกหนี้</span><button class="btn btn-ghost btn-sm" id="debtNext" ${debtorPage[area]>=pages-1?'disabled':''}>ถัดไป</button></div>
  </div>`;
  // events
  $('#pageContent').querySelectorAll('.customerPhoneEdit').forEach(button=>button.onclick=()=>openCustomerPhone(button.dataset.cid));
  $('#pageContent').querySelectorAll('.chip').forEach(b=>b.addEventListener('click',()=>{debtorFilter[area]=b.dataset.f;debtorPage[area]=0;renderDebtors(area);}));
  const si=$('#debtorSearch'); const sug=$('#searchSuggest');
  bindSearch(si,value=>{debtorSearch=value;debtorPage[area]=0;},()=>renderDebtors(area));
  $('#pageContent').querySelectorAll('.debtorDocument').forEach(button=>button.onclick=()=>openPrintOptions(area,button.dataset.cid));
  $('#debtPrev').onclick=()=>{debtorPage[area]--;renderDebtors(area);attachCsv();};$('#debtNext').onclick=()=>{debtorPage[area]++;renderDebtors(area);attachCsv();};
  $('#addDebtorBtn').addEventListener('click',()=>openAddDebtor(area));
  $('#pageContent .debtor-cards').onclick=e=>{const b=e.target.closest('button');if(!b)return;if(b.classList.contains('mobileDebtActions')){openMobileDebtActions(b.dataset.id);return;}if(b.classList.contains('editAdminDebt')){openEditAdminDebt(b.dataset.id);return;}if(b.classList.contains('deleteAdminDebt')){openDeleteAdminDebt(b.dataset.id);return;}if(b.classList.contains('payOne')){markPaid(b.dataset.id);return;}if(!b.matches('.debtRowsPrev,.debtRowsNext')||b.disabled)return;const cid=b.dataset.cid,list=groups[cid],card=b.closest('.debtor-card'),pages=Math.ceil(list.length/DEBT_ROWS_PER_PAGE);const page=Math.max(0,Math.min(pages-1,debtorRowPages[cid]+(b.classList.contains('debtRowsNext')?1:-1)));debtorRowPages[cid]=page;card.querySelector('tbody').innerHTML=debtorRowsHtml(list.slice(page*DEBT_ROWS_PER_PAGE,(page+1)*DEBT_ROWS_PER_PAGE));card.querySelector('.debt-row-range').textContent='รายการ '+(page*DEBT_ROWS_PER_PAGE+1)+'–'+Math.min((page+1)*DEBT_ROWS_PER_PAGE,list.length)+' / '+list.length;card.querySelector('.debtRowsPrev').disabled=page===0;card.querySelector('.debtRowsNext').disabled=page===pages-1;renderIcons();};
  $('#pageContent').querySelectorAll('.payAll').forEach(b=>b.addEventListener('click',()=>markPaid(scopeRows(DB.debtors).filter(d=>d.customerId===b.dataset.cid&&d.status==='unpaid').map(d=>d.id))));
  if(printBtn)$('#printReportBtn').addEventListener('click',()=>openPrintOptions(area));
  if(emailBtn)$('#emailReportBtn').addEventListener('click',()=>openEmailReport(area));
  attachCsv();updateSyncNotice();
  renderIcons();
}
async function markPaid(value){
 const ids=Array.isArray(value)?value:[value];if(!ids.length)return;
 const rows=ids.map(id=>DB.debtors.find(d=>d.id===id));if(rows.some(d=>!FreshyPayments.canReceive(d,me()))){toast('รายการนี้รับชำระไปแล้ว กรุณาตรวจข้อมูลล่าสุด','info');return;}
 const buttons=[...document.querySelectorAll('.payOne,.payAll')];buttons.forEach(b=>b.disabled=true);
 try{await paymentAction('receive',ids);toast(isAdmin()?'บันทึกรับชำระและอนุมัติแล้ว':'รับชำระเรียบร้อยแล้ว รอแอดมินตรวจสอบหรืออนุมัติ','success');renderNav();renderPage();}
 catch(e){toast(e.message,'error');}finally{buttons.forEach(b=>b.disabled=false);}
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
        <div class="field"><label>${area==='nai'?'หมู่ที่ (พิมพ์ 7 หรือ 16 ได้)':'ชื่อบ้าน / หมู่บ้าน'}</label><input id="f_area" class="f-step" autocomplete="off" list="villageSuggestions" placeholder="${area==='nai'?'เช่น 7 หรือ 16':'เลือก/พิมพ์หมู่บ้าน'}"></div><datalist id="villageSuggestions">${(area==='nai'?['7','16']:villageList).map(v=>'<option value="'+esc(v)+'"></option>').join('')}</datalist><div class="field full"><label>รหัสหมู่บ้าน (อัตโนมัติ)</label><input id="f_villageCode" readonly></div>
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
  const villageName=()=>area==='nai'?'บ้านนาไฮ หมู่ '+areaI.value.trim():areaI.value.trim();
  const updateVillageCode=()=>{$('#f_villageCode').value=areaI.value.trim()?FreshyFeatures.villageCode(DB.villages,villageName()):'รอเลือกหมู่บ้าน';};areaI.addEventListener('input',updateVillageCode);
  function applyCustomer(c){
    if(c){selectedCustId=c.id;codeI.value=c.code;areaI.value=area==='nai'?(c.moo||''):(c.village||'');}
    else{selectedCustId=null;codeI.value=nextCustomerCode();}
    updateVillageCode();
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
  $('#saveDebtor').addEventListener('click',async()=>{
    const name=nameI.value.trim(); if(!name){toast('กรุณาพิมพ์ชื่อลูกหนี้','error');nameI.focus();return;}
    const jugs=+$('#f_jugs').value||0, packs=+$('#f_packs').value||0, ja=+$('#f_ja').value||0, pa=+$('#f_pa').value||0;
    if(![jugs,packs,ja,pa].every(x=>Number.isFinite(x)&&x>=0)||!Number.isInteger(jugs)||!Number.isInteger(packs)){toast('จำนวนต้องเป็นจำนวนเต็ม และยอดเงินต้องไม่ติดลบ','error');return;}
    if(jugs+packs===0){toast('กรุณาระบุจำนวนถังหรือแพ็ค','error');return;}
    if(!areaI.value.trim()||!/^\d{4}-\d{2}-\d{2}$/.test($('#f_date').value)){toast('กรุณาระบุหมู่บ้านและวันที่ค้าง','error');return;}
    const saveBtn=$('#saveDebtor');saveBtn.disabled=true;let villageRecord;try{villageRecord=await ensureVillage(villageName());}catch(e){saveBtn.disabled=false;toast(e.message,'error');return;}
    let c=selectedCustId?DB.customers.find(x=>x.id===selectedCustId):null;
    if(!c){
      let code;try{code=await reserveCustomerCode();}catch(error){saveBtn.disabled=false;toast(syncErrorText(error.message),'error');return;}
      c=dbAdd('customers',{code,name,area,villageId:villageRecord.id,villageCode:villageRecord.code,moo:area==='nai'?areaI.value.trim():'',village:area==='other'?areaI.value.trim():'',address:'',createdAt:todayStr(),createdBy:me().id,managedBy:me().id,responsibleBy:me().id});
      audit('เพิ่มลูกค้าใหม่',name+' ('+code+')');
      sendAlert('newcustomer','[แจ้งเตือน] พนักงานเพิ่มลูกหนี้ใหม่ รหัสใหม่ '+code,'<p>พนักงาน <b>'+esc(me().name)+'</b> ได้เพิ่มลูกหนี้ใหม่ในระบบ</p><ul><li>ชื่อ: '+esc(name)+'</li><li>รหัสลูกหนี้ใหม่: <b>'+code+'</b> (ระบบรันอัตโนมัติ ไม่ซ้ำกับคนอื่น)</li><li>หมวด: '+(area==='nai'?'บ้านนาไฮ':'บ้านอื่น ๆ')+'</li></ul>');
    }
    const moo=area==='nai'?(areaI.value.trim()||c.moo||''):(c.moo||'');
    const village=area==='other'?(areaI.value.trim()||c.village||''):(c.village||'');
    const d=dbAdd('debtors',{customerId:c.id,customerName:c.name,area,moo,village,villageId:villageRecord.id,villageCode:villageRecord.code,debtDate:$('#f_date').value,jugs,packs,jugAmount:ja,packAmount:pa,total:ja+pa,status:'unpaid',createdAt:new Date().toISOString(),createdBy:me().id});
    audit('เพิ่มลูกหนี้',c.name+' ค้าง '+fmtN(d.total)+' บาท');
    if(DB.settings.email.alerts.addDebtor)sendAlert('addDebtor','[แจ้งเตือน] พนักงานเพิ่มรายการลูกหนี้',
      `<p>พนักงาน <b>${esc(me().name)}</b> เพิ่มรายการลูกหนี้</p><ul><li>ชื่อลูกหนี้: ${esc(c.name)} (${esc(c.code)})</li><li>หมู่บ้าน/หมู่ที่: ${esc(area==='nai'?'บ้านนาไฮ หมู่ที่ '+moo:village)}</li><li>วันที่ค้าง: ${thDate(d.debtDate)}</li><li>จำนวนถังค้าง: ${jugs} ถัง</li><li>จำนวนแพ็คค้าง: ${packs} แพ็ค</li><li>เงินค้างน้ำแพ็ค: ${fmtN(pa)} บาท</li><li>ยอดค้างรวม: ${fmtN(d.total)} บาท</li></ul>`);
    const ok=authIdentity?await flushOnline():true,confirmed=!authIdentity||remoteBase?.debtors?.some(row=>row.id===d.id);closeModal();renderPage();if(!ok||!confirmed){toast(syncIssues.some(item=>item.change.id===d.id||item.change.id===c.id)?'เก็บรายการไว้ให้ตรวจสอบแล้ว · เปิดข้อมูลรอส่งเพื่อดูรายละเอียด':'เก็บรายการไว้ในเครื่องแล้ว · ระบบจะส่งต่อเมื่อเชื่อมต่อได้','info');return;}toast(authIdentity?'บันทึกลงฐานข้อมูลแล้ว (รหัส '+c.code+')':'บันทึกข้อมูลสาธิตแล้ว','success');askContinueDebtor(area);
  });
}

/* ---------- PAYMENTS (ประวัติรับชำระและการตรวจสอบ) ---------- */
let paySearch='',paymentReplayPromise=null;
function paymentQueueKey(){return authIdentity?'freshy-payment-commands:'+supaCfg().url+':'+authIdentity.id:null;}
function paymentQueue(){try{return JSON.parse(localStorage.getItem(paymentQueueKey())||'[]');}catch{return [];}}
function savePaymentQueue(queue){const key=paymentQueueKey();if(!key)return;if(queue.length)localStorage.setItem(key,JSON.stringify(queue));else localStorage.removeItem(key);updateSyncNotice();}
function paymentError(error){
 const message=error.message||'';
 if(/PAYMENT_STALE|ALREADY_RECEIVED|NOT_PENDING|NOT_RECEIVED|UNDO_NOT_PENDING/.test(message))return 'รายการเปลี่ยนไปแล้ว กรุณาตรวจข้อมูลล่าสุดก่อนทำรายการใหม่';
 if(/FORBIDDEN|ADMIN_ONLY/.test(message))return 'บัญชีนี้ไม่มีสิทธิ์ทำรายการที่เลือก';
 if(/REASON_REQUIRED/.test(message))return 'กรุณากรอกเหตุผลก่อนยกเลิก';
 if(/PGRST202|WORKFLOW_REQUIRED/.test(message))return 'ระบบรับชำระกำลังอัปเดต กรุณารีเฟรชแล้วลองใหม่';
 return 'ยังยืนยันการบันทึกไม่ได้ ระบบเก็บรายการไว้และจะตรวจสอบซ้ำเมื่อเชื่อมต่อได้';
}
async function retryPaymentCommands(){
 if(typeof operatingLocked!=='undefined'&&operatingLocked)return;
 if(!authIdentity||!remoteBase)return;
 if(paymentReplayPromise)return paymentReplayPromise;
 paymentReplayPromise=(async()=>{
  while(authIdentity){
   const command=paymentQueue().find(x=>!x.failed);if(!command)break;
   const before=FreshySync.shared(DB);
   try{
    const payload=await rpc('freshy_payment',command.body);
    acceptRemote(payload,FreshySync.diff(before,FreshySync.shared(DB)));
    savePaymentQueue(paymentQueue().filter(x=>x.body.request_id!==command.body.request_id));
    lastSyncAt=Date.now();broadcastOnlineChange();refreshSyncedView();
   }catch(error){
    const permanent=/^PT409$|^42501$/.test(error.code||'')||/REQUIRED|INVALID|REUSED|DUPLICATE|PGRST202/.test(error.message||'');
    if(permanent){savePaymentQueue(paymentQueue().map(x=>x.body.request_id===command.body.request_id?{...x,failed:paymentError(error)}:x));toast(paymentError(error),'error');}
    break;
   }
  }
 })();
 try{await paymentReplayPromise;}finally{paymentReplayPromise=null;updateSyncNotice();}
}
async function paymentAction(action,ids,reason=''){
 if(authIdentity){
  if(!(await flushOnline()))throw Error('กรุณารอให้ข้อมูลที่กำลังบันทึกส่งสำเร็จก่อนรับชำระ');
  const expected=Object.fromEntries(ids.map(id=>[id,FreshySync.clone(DB.debtors.find(d=>d.id===id)||null)]));
  const queued=paymentQueue().find(x=>!x.failed&&x.body.action===action&&FreshySync.equal(x.body.debtor_ids,ids)&&x.body.reason===reason);
  const command=queued||{body:{action,debtor_ids:ids,reason,expected,expected_revision:remoteBase.settings?._resetRevision||'',request_id:uid()},names:ids.map(id=>DB.debtors.find(d=>d.id===id)?.customerName||id),createdAt:new Date().toISOString()};
  if(!queued)savePaymentQueue([...paymentQueue(),command]);
  await retryPaymentCommands();
  const remaining=paymentQueue().find(x=>x.body.request_id===command.body.request_id);
  if(remaining)throw Error(remaining.failed||'ยังยืนยันการบันทึกไม่ได้ ระบบเก็บรายการไว้และจะตรวจสอบซ้ำเมื่อเชื่อมต่อได้');
  return;
 }
 // Design preview only: the production path always uses the authenticated RPC.
 const rows=ids.map(id=>DB.debtors.find(d=>d.id===id)),now=new Date().toISOString(),actor=me();
 if(rows.some(d=>!d))throw Error('ไม่พบรายการ');
 if(['approve','reject','approve_undo','reject_undo'].includes(action)&&!isAdmin())throw Error('เฉพาะแอดมินตรวจสอบได้');
 if(['cancel','reject','request_undo'].includes(action)&&!reason.trim())throw Error('กรุณากรอกเหตุผล');
 if(action==='receive'&&rows.some(d=>d.status!=='unpaid'))throw Error('รับชำระไปแล้ว');
 if(action==='cancel'&&rows.some(d=>!FreshyPayments.canCancel(d,actor)))throw Error('ไม่มีสิทธิ์ยกเลิกรายการนี้');
 const requestId=uid();
 for(const d of rows){
  if(action==='receive'){
   Object.assign(d,{status:'paid',paidAt:now,paidBy:actor.id,paidByName:actor.name,paymentReviewStatus:isAdmin()?'approved':'pending',paymentRequestId:requestId});
   if(isAdmin())Object.assign(d,{paymentApprovedBy:actor.id,paymentApprovedByName:actor.name,paymentApprovedAt:now});
   else DB.approvals.push({id:uid(),type:'payment',status:'pending',debtorId:d.id,debtorName:d.customerName,employeeId:actor.id,employeeName:actor.name,area:d.area,amount:d.total,ts:now,paymentRequestId:requestId,isDemo:true});
  }else if(action==='request_undo'){
   DB.approvals.push({id:uid(),type:'undo',status:'pending',debtorId:d.id,debtorName:d.customerName,employeeId:actor.id,employeeName:actor.name,area:d.area,amount:d.total,reason,ts:now,isDemo:true});
  }else{
   const a=DB.approvals.find(x=>x.debtorId===d.id&&x.status==='pending'&&(action.endsWith('_undo')?x.type!=='payment':x.type==='payment'));
   if(action==='approve')Object.assign(d,{paymentReviewStatus:'approved',paymentApprovedBy:actor.id,paymentApprovedByName:actor.name,paymentApprovedAt:now});
   if(['cancel','reject','approve_undo'].includes(action)){const why=reason||a?.reason||'';Object.assign(d,{status:'unpaid',paymentReviewStatus:'cancelled',paidAt:null,paidBy:null,paidByName:null,paymentCancellationReason:why,paymentCancelledBy:actor.id,paymentCancelledAt:now});}
   if(a)Object.assign(a,{status:['approve','approve_undo'].includes(action)?'approved':action==='cancel'?'cancelled':'rejected',decidedBy:actor.name,decidedById:actor.id,decidedAt:now,decisionReason:reason});
  }
 }
 audit('การรับชำระ · '+action,rows.map(d=>d.customerName).join(', ')+(reason?' · '+reason:''));dbSave();
}
function renderPayments(area){
 let rows=scopeRows(DB.debtors).filter(d=>d.area===area&&d.status==='paid'&&(!isAdmin()||FreshyPayments.confirmed(d)));
 if(paySearch)rows=rows.filter(d=>d.customerName.includes(paySearch));
 rows.sort((a,b)=>String(b.paidAt).localeCompare(String(a.paidAt)));
 let html='<div class="tbl-wrap payment-table"><table class="tbl"><thead><tr><th>ลำดับ</th><th>ชื่อลูกหนี้</th><th class="num">ยอดรับชำระ</th><th>วันที่ค้าง</th><th>วันที่รับชำระ</th><th>ผู้รับชำระ</th><th>สถานะตรวจสอบ</th><th class="ce">จัดการ</th></tr></thead><tbody>',mobile='<div class="payment-cards">';
 rows.forEach((d,i)=>{
  const pending=FreshyPayments.review(d)==='pending',undoPending=DB.approvals.some(a=>a.debtorId===d.id&&a.type!=='payment'&&a.status==='pending');
  const allowed=FreshyPayments.canCancel(d,me())||d.paidBy===me().id,disabled=undoPending||!allowed;
  const undoLabel=undoPending?'รอแอดมินอนุมัติยกเลิก':pending||isAdmin()?'ยกเลิก กลับไปค้างชำระ':'ขอยกเลิกการรับชำระ';
  const status=`<span class="pill ${pending?'gold':'green'}">${esc(FreshyPayments.label(d))}</span>${d.paymentApprovedAt?`<small class="payment-reviewer">ตรวจโดย ${esc(d.paymentApprovedByName||recorderName(d.paymentApprovedBy))} · ${thDateTimeSec(d.paymentApprovedAt)}</small>`:''}`;
  const button=adminDebtButtons(d)+`<button class="btn btn-danger btn-sm undoBtn" data-id="${d.id}" ${disabled?'disabled':''}><i data-lucide="rotate-ccw"></i> ${undoLabel}</button>`;
  html+=`<tr><td>${i+1}</td><td><b>${esc(d.customerName)}</b></td><td class="num"><b>${fmtN(d.total)} บาท</b></td><td>${thDate(d.debtDate)}</td><td>${thDateTimeSec(d.paidAt)}</td><td>${esc(d.paidByName||'-')}</td><td>${status}</td><td class="ce">${button}</td></tr>`;
  mobile+=`<article class="payment-card"><div class="payment-card-head"><span>รายการที่ ${i+1}</span><strong>${fmtN(d.total)} บาท</strong></div><h3>${esc(d.customerName)}</h3><div>${status}</div><dl><div><dt>วันที่ค้างชำระ</dt><dd>${thDate(d.debtDate)}</dd></div><div><dt>วันที่รับชำระ</dt><dd>${thDateTimeSec(d.paidAt)}</dd></div><div><dt>ผู้รับชำระ</dt><dd>${esc(d.paidByName||'-')}</dd></div></dl>${button}</article>`;
 });
 html+='</tbody></table></div>';mobile+='</div>';html+=mobile;if(!rows.length)html='<div class="empty-state"><i data-lucide="inbox"></i><p>ยังไม่มีประวัติรับชำระ'+(isAdmin()?'ที่อนุมัติแล้ว':'')+'</p></div>';
 $('#pageContent').innerHTML=`<div class="page-head"><h2>ประวัติรับชำระ ${area==='nai'?'บ้านนาไฮ':'บ้านอื่น ๆ'}</h2><span class="desc">${isAdmin()?'รายการที่ตรวจสอบและอนุมัติแล้ว · รายการรอตรวจอยู่ในเมนูตรวจสอบการรับชำระ':'แสดงประวัติทันทีหลังรับชำระ พร้อมสถานะการตรวจสอบจากแอดมิน'}</span></div><div class="toolbar"><div class="search-box"><i data-lucide="search"></i><input id="paySearch" placeholder="ค้นหาชื่อผู้ชำระ..." value="${esc(paySearch)}"></div><button class="btn btn-gold" id="openPaymentReviews">รอแอดมินตรวจสอบ ${DB.debtors.filter(d=>d.area===area&&FreshyPayments.review(d)==='pending').length} รายการ</button></div><div class="panel"><div class="panel-body">${html}</div></div>`;
 bindSearch($('#paySearch'),value=>{paySearch=value;},()=>renderPayments(area));
 bindAdminDebtButtons();$('#openPaymentReviews').onclick=()=>navigate('approvals');$('#pageContent').querySelectorAll('.undoBtn').forEach(b=>b.onclick=()=>requestUndo(b.dataset.id,area));attachCsv();updateSyncNotice();renderIcons();
}
function requestUndo(id,area){
 const d=DB.debtors.find(x=>x.id===id&&x.status==='paid');if(!d)return;
 const direct=isAdmin()||FreshyPayments.review(d)==='pending';
 if(direct&&!FreshyPayments.canCancel(d,me())||!direct&&d.paidBy!==me().id){toast('ยกเลิกได้เฉพาะผู้รับชำระรายการนี้หรือแอดมิน','error');return;}
 const action=direct?'cancel':'request_undo',buttonId=direct?'confirmUndo':'sendUndo';
 openModal(`<div class="modal-head"><h3> ${direct?'ยกเลิก กลับไปค้างชำระ':'ขอยกเลิกการรับชำระ'}</h3><button class="x" onclick="closeModal()">×</button></div><div class="modal-body"><p><b>${esc(d.customerName)}</b> · ${fmtN(d.total)} บาท</p><p>${direct?'กรอกเหตุผล รายการจะกลับไปหน้าลูกหนี้ค้างชำระ และเก็บประวัติการยกเลิกไว้':'รายการนี้อนุมัติแล้ว กรุณากรอกเหตุผลและรอแอดมินพิจารณาการยกเลิก'}</p><div class="field"><label for="undoReason">เหตุผลที่ยกเลิก</label><textarea id="undoReason" rows="3" maxlength="2000"></textarea></div></div><div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">ปิด</button><button class="btn btn-danger" id="${buttonId}">${direct?'ยืนยันยกเลิก กลับไปค้าง':'ส่งคำขอให้แอดมิน'}</button></div>`);
 $('#'+buttonId).onclick=async()=>{const reason=$('#undoReason').value.trim();if(!reason){toast('กรุณากรอกเหตุผล','error');return;}const b=$('#'+buttonId);b.disabled=true;try{await paymentAction(action,[id],reason);closeModal();toast(direct?'ยกเลิกแล้ว รายการกลับไปค้างชำระ':'ส่งคำขอยกเลิกแล้ว รอแอดมินอนุมัติ','success');renderNav();renderPage();}catch(e){toast(e.message,'error');b.disabled=false;}};
}
function rejectPayment(id){
 const d=DB.debtors.find(x=>x.id===id);if(!d||!isAdmin())return;
 openModal(`<div class="modal-head"><h3>ไม่อนุมัติการรับชำระ</h3><button class="x" onclick="closeModal()">×</button></div><div class="modal-body"><p>${esc(d.customerName)} · ${fmtN(d.total)} บาท จะกลับไปค้างชำระ</p><div class="field"><label for="decisionReason">เหตุผลที่ไม่อนุมัติ</label><textarea id="decisionReason" rows="3" maxlength="2000"></textarea></div></div><div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">ปิด</button><button class="btn btn-danger" id="confirmPaymentReject">ยืนยันไม่อนุมัติ กลับไปค้าง</button></div>`);
 $('#confirmPaymentReject').onclick=async()=>{const reason=$('#decisionReason').value.trim();if(!reason){toast('กรุณากรอกเหตุผล','error');return;}const b=$('#confirmPaymentReject');b.disabled=true;try{await paymentAction('reject',[id],reason);closeModal();toast('บันทึกการไม่อนุมัติแล้ว รายการกลับไปค้างชำระ','success');renderNav();renderPage();}catch(e){toast(e.message,'error');b.disabled=false;}};
}
function renderApprovals(){
 const pending=DB.debtors.filter(d=>FreshyPayments.review(d)==='pending').sort((a,b)=>String(b.paidAt).localeCompare(String(a.paidAt)));
 let html=`<div class="page-head"><h2>${isAdmin()?'ตรวจสอบและอนุมัติการรับชำระ':'รับชำระแล้ว รอแอดมินตรวจสอบ'}</h2><span class="desc">${pending.length} รายการ · ${fmtN(pending.reduce((n,d)=>n+Number(d.total||0),0))} บาท</span></div>`;
 const commands=paymentQueue();if(commands.length)html+='<div class="payment-command-notice" role="status"><b>รายการที่ยังยืนยันการบันทึกไม่ได้</b>'+commands.map(c=>'<p>'+esc(c.names.join(', '))+' · '+esc(c.failed||'กำลังตรวจสอบกับฐานข้อมูล')+'</p>').join('')+'<button class="btn btn-ghost" id="retryPaymentCommands">ตรวจสอบอีกครั้ง</button></div>';
 for(const d of pending){
  html+=`<article class="panel payment-review-card"><div class="panel-body"><div><h3>${esc(d.customerName)}</h3><strong>${fmtN(d.total)} บาท</strong><p>ผู้รับชำระ ${esc(d.paidByName||recorderName(d.paidBy))} · ${thDateTimeSec(d.paidAt)}</p><p>${d.area==='nai'?'บ้านนาไฮ · หมู่ที่ '+esc(d.moo||'-'):esc(d.village||'บ้านอื่น ๆ')}</p><span class="pill gold">รับชำระเรียบร้อยแล้ว รอแอดมินตรวจสอบหรืออนุมัติ</span></div><div class="payment-review-actions">${adminDebtButtons(d)}${isAdmin()?`<button class="btn btn-success reviewApprove" data-id="${d.id}">ตรวจสอบและอนุมัติ</button><button class="btn btn-danger reviewReject" data-id="${d.id}">ไม่อนุมัติ กลับไปค้าง</button>`:FreshyPayments.canCancel(d,me())?`<button class="btn btn-danger undoBtn" data-id="${d.id}">ยกเลิก กลับไปค้างชำระ</button>`:''}</div></div></article>`;
 }
 if(!pending.length)html+='<div class="empty-state"><i data-lucide="circle-check-big"></i><p>ไม่มีรายการรับชำระรอตรวจสอบ</p></div>';
 const requests=DB.approvals.filter(a=>DB.debtors.some(d=>d.id===a.debtorId)&&a.type!=='payment'&&(isAdmin()||a.employeeId===me().id)).sort((a,b)=>String(b.ts).localeCompare(String(a.ts)));
 if(requests.length)html+='<h3>คำขอยกเลิกรายการที่รับชำระแล้ว</h3>';
 for(const a of requests)html+=`<div class="panel"><div class="panel-body"><b>${esc(a.employeeName)} ขอยกเลิกรายการ ${esc(a.debtorName)} · ${fmtN(a.amount)} บาท</b><p>เหตุผล: ${esc(a.reason)} · ${thDateTime(a.ts)}</p><span class="pill ${a.status==='pending'?'gold':a.status==='approved'?'green':'gray'}">${a.status==='pending'?'รอแอดมินอนุมัติ':a.status==='approved'?'อนุมัติแล้ว':a.status==='cancelled'?'ยกเลิกแล้ว':'ไม่อนุมัติ'}</span>${isAdmin()&&a.status==='pending'?`<button class="btn btn-success appr" data-id="${a.id}" data-v="approve_undo">อนุมัติยกเลิก กลับไปค้าง</button><button class="btn btn-danger appr" data-id="${a.id}" data-v="reject_undo">ไม่อนุมัติยกเลิก</button>`:''}</div></div>`;
 $('#pageContent').innerHTML=html;
 $('#retryPaymentCommands')?.addEventListener('click',async()=>{await retryPaymentCommands();await supabaseFetch();renderApprovals();});
 $('#pageContent').querySelectorAll('.reviewApprove').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await paymentAction('approve',[b.dataset.id]);toast('รายการนี้ตรวจสอบและอนุมัติแล้ว','success');renderNav();renderPage();}catch(e){toast(e.message,'error');b.disabled=false;}});
 $('#pageContent').querySelectorAll('.reviewReject').forEach(b=>b.onclick=()=>rejectPayment(b.dataset.id));
 $('#pageContent').querySelectorAll('.undoBtn').forEach(b=>b.onclick=()=>requestUndo(b.dataset.id,DB.debtors.find(d=>d.id===b.dataset.id)?.area));
 $('#pageContent').querySelectorAll('.appr').forEach(b=>b.onclick=async()=>{b.disabled=true;const a=DB.approvals.find(x=>x.id===b.dataset.id);try{await paymentAction(b.dataset.v,[a.debtorId]);toast(b.dataset.v==='approve_undo'?'อนุมัติยกเลิกแล้ว รายการกลับไปค้างชำระ':'บันทึกการไม่อนุมัติยกเลิกแล้ว','success');renderNav();renderPage();}catch(e){toast(e.message,'error');b.disabled=false;}});
 bindAdminDebtButtons();renderIcons();updateSyncNotice();
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
function customerPhone(customer){return String(customer?.phone||customer?.phoneNumber||customer?.telephone||customer?.tel||customer?.mobile||'').trim()||'-';}
function canEditCustomerPhone(customer){return !!customer&&isAdmin();}
function openCustomerPhone(customerId){
 const customer=DB.customers.find(c=>c.id===customerId);if(!customer||!canEditCustomerPhone(customer)){toast('ไม่มีสิทธิ์แก้ไขข้อมูลลูกค้ารายนี้','error');return;}
 const phone=customerPhone(customer);
 openModal('<div class="modal-head"><h3>เบอร์โทรลูกหนี้รายบุคคล</h3><button class="x" onclick="closeModal()">×</button></div><div class="modal-body"><div class="form-grid"><div class="field"><label>รหัสลูกค้า</label><input readonly value="'+esc(customer.code||'-')+'"></div><div class="field"><label>ชื่อลูกค้า</label><input readonly value="'+esc(customer.name)+'"></div><div class="field full"><label for="customerPhoneInput">เบอร์โทร</label><input id="customerPhoneInput" type="tel" inputmode="tel" autocomplete="tel" maxlength="60" placeholder="เว้นว่างหากไม่มีเบอร์โทร" value="'+esc(phone==='-'?'':phone)+'"><p class="help-text">เอกสารใหม่จะแสดงเบอร์โทรนี้ข้างรหัสลูกค้าและหมู่ที่ หากไม่มีจะแสดง เบอร์โทร: -</p></div></div><p id="customerPhoneStatus" role="status"></p></div><div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">ยกเลิก</button><button id="saveCustomerPhone" class="btn btn-primary">บันทึกเบอร์โทร</button></div>');
 $('#saveCustomerPhone').onclick=async()=>{const button=$('#saveCustomerPhone'),status=$('#customerPhoneStatus'),value=$('#customerPhoneInput').value.trim();if(value.length>60){status.textContent='เบอร์โทรต้องไม่เกิน 60 ตัวอักษร';return;}button.disabled=true;
 try{const current=DB.customers.find(c=>c.id===customerId);if(!current||!canEditCustomerPhone(current))throw Error('ไม่พบข้อมูลลูกค้าหรือไม่มีสิทธิ์');const patch={phone:value};for(const key of ['phoneNumber','telephone','tel','mobile'])if(Object.hasOwn(current,key))patch[key]=value;dbUpdate('customers',customerId,patch);if(authIdentity&&!(await flushOnline()))throw Error('เบอร์โทรยังรอส่ง กรุณาตรวจการซิงก์แล้วลองอีกครั้ง');audit('แก้ไขเบอร์โทรลูกค้า',(current.code||'')+' · '+current.name);closeModal();renderPage();toast('บันทึกเบอร์โทรแล้ว','success');}catch(e){status.textContent=e.message;button.disabled=false;}};
 $('#customerPhoneInput').focus();
}

function renderCustomers(area){
  const oldestByCustomer=new Map();for(const d of DB.debtors){if(d.status==='unpaid')oldestByCustomer.set(d.customerId,Math.max(oldestByCustomer.get(d.customerId)||0,dayDiff(d.debtDate)));}const creditFor=id=>{const days=oldestByCustomer.get(id);return days===undefined||days<=10?{cls:'green',txt:'เครดิตดีเยี่ยม'}:days<=30?{cls:'orange',txt:'เครดิตดี'}:days<=100?{cls:'gray',txt:'เครดิตสีเทา'}:{cls:'red',txt:'เครดิตไม่ดี'};};
  let rows=DB.customers.filter(c=>c.area===area);
  const q=custSearch[area];
  if(q)rows=rows.filter(c=>c.name.includes(q)||String(c.code||'').toLowerCase().includes(q.toLowerCase()));
  if(custCredit[area]!=='all')rows=rows.filter(c=>creditFor(c.id).txt===custCredit[area]);
  let html='<div class="tbl-wrap"><table class="tbl"><thead><tr><th>ลำดับ</th><th>รหัสลูกค้า</th><th>ชื่อลูกค้า</th>'+(area==='nai'?'<th>หมู่ที่</th>':'<th>หมู่บ้านที่อยู่</th>')+'<th>เบอร์โทร</th><th>ที่อยู่</th><th>วันที่นำลงระบบ</th><th>ผู้นำลงระบบ</th><th>ผู้จัดการข้อมูล</th><th>ผู้รับผิดชอบ</th><th>ประวัติลูกหนี้</th></tr></thead><tbody>';
  rows.forEach((c,i)=>{
    const cs=creditFor(c.id);
    const byName=recorderName;
    html+=`<tr><td>${i+1}</td><td>${esc(c.code)}</td><td><b>${esc(c.name)}</b></td><td>${esc(area==='nai'?('หมู่ที่ '+c.moo):c.village)}</td><td><span>${esc(customerPhone(c))}</span>${canEditCustomerPhone(c)?'<button class="btn btn-ghost btn-sm customerPhoneEdit" data-cid="'+esc(c.id)+'">กรอก / แก้ไขเบอร์โทร</button>':''}</td><td>${esc(c.address||'-')}</td><td>${thDate(c.createdAt)}</td><td>${esc(byName(c.createdBy))}</td><td>${esc(byName(c.managedBy))}</td><td>${esc(byName(c.responsibleBy))}</td><td><span class="pill ${cs.cls}">${cs.txt}</span></td></tr>`;
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
  bindSearch($('#custSearch'),value=>{custSearch[area]=value;},()=>renderCustomers(area));
  $('#pageContent').querySelectorAll('[data-cr]').forEach(b=>b.addEventListener('click',()=>{custCredit[area]=b.dataset.cr;renderCustomers(area);}));
  $('#pageContent').querySelectorAll('.customerPhoneEdit').forEach(button=>button.onclick=()=>openCustomerPhone(button.dataset.cid));
  $('#addCustBtn').addEventListener('click',()=>openAddCustomer(area));
  attachCsv();
  if(printBtn)$('#custPrintBtn').addEventListener('click',()=>printCustomers(area));
  if(emailBtn)$('#custEmailBtn').addEventListener('click',()=>openEmailReport('customers-'+area));
  renderIcons();
}
function printCustomers(area){
  const rows=DB.customers.filter(c=>c.area===area);
  const docNo=nextDocNo(DB.settings.docPrefix.customer);
  let body=docHeader('รายงานข้อมูลลูกค้า '+(area==='nai'?'บ้านนาไฮ':'บ้านอื่น ๆ'),docNo);
  body+='<table class="doc-table"><thead><tr><th>ลำดับ</th><th>รหัส</th><th>ชื่อลูกค้า</th><th>'+(area==='nai'?'หมู่ที่':'หมู่บ้าน')+'</th><th>ที่อยู่</th><th>วันที่ลงระบบ</th><th>ผู้รับผิดชอบ</th><th>สถานะเครดิต</th></tr></thead><tbody>';
  rows.forEach((c,i)=>{const cs=creditStatus(c.id);const by=(DB.employees.find(e=>e.id===c.responsibleBy)||{}).name||'-';
    body+=`<tr><td>${i+1}</td><td>${esc(c.code)}</td><td class="l">${esc(c.name)}</td><td>${esc(area==='nai'?('หมู่ที่ '+c.moo):c.village)}</td><td class="l">${esc(c.address||'-')}</td><td>${thDate(c.createdAt)}</td><td>${esc(by)}</td><td>${esc(cs.txt)}</td></tr>`;});
  body+='</tbody></table>'+docFooter(docNo);
  preparePrint(body,docNo);
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
    <div class="field"><label>รหัสลูกค้า</label><input id="c_code" placeholder="ระบบออกรหัสอัตโนมัติเมื่อบันทึก"></div>
    <div class="field"><label>ชื่อลูกค้า</label><input id="c_name"></div>
    ${area==='nai'?'<div class="field"><label>หมู่ที่</label><select id="c_moo" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:10px"><option value="7">หมู่ที่ 7</option><option value="16">หมู่ที่ 16</option></select></div>':'<div class="field"><label>หมู่บ้าน</label><select id="c_village" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:10px">'+villageOpts+'</select></div>'}
    <div class="field"><label for="c_phone">เบอร์โทร</label><input id="c_phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="60" placeholder="ไม่มีเบอร์โทร เว้นว่างได้"></div><div class="field full"><label>ที่อยู่</label><input id="c_addr"></div>
  </div></div>
  <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">ยกเลิก</button><button class="btn btn-primary" id="saveCust"><i data-lucide="save"></i> บันทึก</button></div>`);
  $('#saveCust').addEventListener('click',async()=>{
    const name=$('#c_name').value.trim(); if(!name){toast('กรุณากรอกชื่อลูกค้า','error');return;}
    const saveButton=$('#saveCust');saveButton.disabled=true;let code;try{code=$('#c_code').value.trim()||await reserveCustomerCode();}catch(error){saveButton.disabled=false;toast(syncErrorText(error.message),'error');return;}
    dbAdd('customers',{code,name,area,
      moo:area==='nai'?$('#c_moo').value:'',village:area==='other'?$('#c_village').value:'',address:$('#c_addr').value.trim(),phone:$('#c_phone').value.trim(),
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
    const editable=isAdmin()||(canManageRecord(r)&&age<120000);
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
  attachCsv();updateSyncNotice();
  renderIcons();
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
    audit('เพิ่มลูกค้าจ่ายสด',c.name);sendAlert('cash','[แจ้งเตือน] บันทึกรายการเงินสด','<p>'+esc(c.name)+' · '+esc($('#cs_date').value)+'</p>');closeModal();toast('บันทึกรายการจ่ายสดแล้ว','success');renderPage();
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
      <div style="flex:1;min-width:200px"><div style="font-weight:700;color:var(--navy)">${esc(e.name)} <span class="pill ${e.role==='admin'?'gold':'blue'}">${e.role==='admin'?'แอดมิน':'พนักงาน'}</span> ${e.status==='pending'?'<span class="pill gray">ยังไม่ได้เปิดบัญชี</span>':['inactive','disabled'].includes(e.status)?'<span class="pill red">ปิดใช้งาน</span>':''}</div>
      <div style="font-size:12px;color:var(--muted);margin-top:2px">รหัส: ${esc(e.code)} · ${esc(e.contactEmail||(!String(e.email||'').includes('@employees.freshywater.in.th')?e.email:'')||'ไม่มีอีเมลติดต่อ')} · เห็นหน้า ${perms} หน้า · ปริ้น:${e.permissions.canPrint?'ได้':'ไม่ได้'} · ส่งอีเมล:${e.permissions.canEmail?'ได้':'ไม่ได้'}</div></div>
      <button class="btn btn-ghost btn-sm printEmp" data-id="${e.id}"><i data-lucide="printer"></i> ปริ้นประวัติ</button> <button class="btn btn-ghost btn-sm editEmp" data-id="${e.id}"><i data-lucide="pencil"></i> ${e.status==='pending'?'เปิดใช้งาน':'แก้ไข'}</button></div></div>`;
  });
  $('#pageContent').innerHTML='<div class="page-head"><h2>จัดการข้อมูลพนักงานและสิทธิ์</h2><span class="desc">ชื่อพนักงานที่แสดงในรายงานจะใช้ชื่อจริงที่ตั้งค่าไว้ ไม่ใช่ชื่อสิทธิ์ admin</span><div class="actions"><button class="btn btn-gold btn-sm" id="addEmpBtn"><i data-lucide="user-plus"></i> เพิ่มพนักงาน</button></div></div>'+html;
  $('#addEmpBtn').addEventListener('click',()=>openEditEmp(null));
  $('#pageContent').querySelectorAll('.editEmp').forEach(b=>b.addEventListener('click',()=>openEditEmp(b.dataset.id)));
  $('#pageContent').querySelectorAll('.printEmp').forEach(b=>b.addEventListener('click',()=>printEmployeeReport(b.dataset.id)));
  renderIcons();
}
function openEditEmp(id){
  if(!isAdmin())return;const draftEmployeeId=id||uid();
  const e=id?DB.employees.find(x=>x.id===id):{name:'',code:'',email:'',role:'staff',permissions:{pages:{dashboard:true,debtorsNai:true,debtorsOther:true,paymentsNai:true,paymentsOther:true,customersNai:true,customersOther:true,cashsales:true},canPrint:false,canEmail:false}};
  const pagePerms=PAGES.filter(p=>!p.admin).map(p=>{
    const on=e.permissions.pages&&e.permissions.pages[p.id];
    return `<label class="perm-item"><input type="checkbox" data-page="${p.id}" ${on?'checked':''}> ${esc(p.label)}</label>`;
  }).join('');
  openModal(`<div class="modal-head"><h3><i data-lucide="user-cog"></i> ${id?'แก้ไข':'เพิ่ม'}พนักงาน</h3><button class="x" onclick="closeModal()"><i data-lucide="x"></i></button></div>
  <div class="modal-body"><div class="form-grid">
    <div class="field"><label>ชื่อพนักงาน (จริง)</label><input id="e_name" value="${esc(e.name)}"></div>
    <div class="field"><label>รหัสพนักงาน (รหัสล็อกอิน)</label><input id="e_code" value="${esc(e.code)}"></div>
    <div class="field"><label>อีเมลติดต่อ (เว้นว่างได้)</label><input id="e_email" value="${esc(e.contactEmail||(String(e.email||'').includes('@employees.freshywater.in.th')?'':e.email)||'')}"></div>
    <div class="field"><label>บทบาท</label><select id="e_role" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:10px"><option value="staff" ${e.role==='staff'?'selected':''}>พนักงาน</option><option value="admin" ${e.role==='admin'?'selected':''}>แอดมิน</option></select></div>
    ${!id||e.status==='pending'||!e.email?'<div class="field full"><label>รหัสผ่านเข้าใช้งาน (อย่างน้อย 6 ตัวอักษร)</label><input id="e_password" type="password" autocomplete="new-password"><p class="help-text">บันทึกครั้งเดียว แล้วให้พนักงานเข้าสู่ระบบด้วยรหัสพนักงานและรหัสผ่านนี้ได้เลย ไม่ต้องยืนยันอีเมล</p></div>':'<div class="field full"><p class="help-text">พนักงานใช้รหัสผ่านเดิมเข้าสู่ระบบได้</p></div>'}
    <div class="field full"><label>สถานะบัญชี</label><select id="e_status"><option value="active" ${!['inactive','disabled'].includes(e.status)?'selected':''}>เปิดใช้งาน</option><option value="inactive" ${['inactive','disabled'].includes(e.status)?'selected':''}>ปิดใช้งาน</option></select></div>
    <div class="field full"><label>สิทธิ์การเข้าถึงแต่ละหน้า</label><div class="perm-grid">${pagePerms}</div></div>
    <label class="perm-item"><input type="checkbox" id="e_print" ${e.permissions.canPrint?'checked':''}> อนุญาตให้ปริ้นรายงาน</label>
    <label class="perm-item"><input type="checkbox" id="e_canEmail" ${e.permissions.canEmail?'checked':''}> อนุญาตให้ส่งรายงานทางอีเมล</label>
  </div></div>
  <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">ยกเลิก</button><button class="btn btn-primary" id="saveEmp"><i data-lucide="save"></i> บันทึก</button></div>`);
  $('#saveEmp').addEventListener('click',async()=>{
    if(!isAdmin())return;
    const name=$('#e_name').value.trim(),code=$('#e_code').value.trim();
    if(!name||!code){toast('กรุณากรอกชื่อและรหัสพนักงาน','error');return;}
    const email=$('#e_email').value.trim().toLowerCase();if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){toast('รูปแบบอีเมลไม่ถูกต้อง','error');return;}
    if(DB.employees.some(x=>x.id!==draftEmployeeId&&(x.code===code||(email&&String(x.email||'').toLowerCase()===email)))){toast('รหัสหรืออีเมลพนักงานซ้ำ','error');return;}
    const pages={};$('#modalBox').querySelectorAll('[data-page]').forEach(c=>pages[c.dataset.page]=c.checked);
    const patch={name,code,email,status:$('#e_status').value,role:$('#e_role').value,permissions:{pages,canPrint:$('#e_print').checked,canEmail:$('#e_canEmail').checked}};
    const password=$('#e_password')?.value||'';
    if($('#e_password')&&password.length<6){toast('กรุณาตั้งรหัสผ่านอย่างน้อย 6 ตัวอักษร','error');return;}
    const button=$('#saveEmp');button.disabled=true;button.textContent='กำลังบันทึกและเปิดบัญชี…';const employeeId=draftEmployeeId;
    try{
      if(authIdentity){
        syncBlocked=false;if(!(await flushOnline()))throw Error(flushOnline.lastError||'ยังมีข้อมูลรอส่ง กรุณาลองอีกครั้ง');
        const before=FreshySync.shared(DB),expectedEmployee=remoteBase.employees.find(x=>x.id===employeeId)||null;
        const result=await apiRequest('/api/employees',{method:'POST',body:JSON.stringify({employee:{...patch,id:employeeId,contactEmail:email},password:(!expectedEmployee||expectedEmployee.status==='pending'||!expectedEmployee.email)?password:undefined,expectedEmployee,expectedRevision:remoteBase.settings?._resetRevision||''})});
        installRemote(result.payload,FreshySync.diff(before,FreshySync.shared(DB)));broadcastOnlineChange();
      }else{
        const demoPatch={...patch,password:undefined};
        if(id){dbUpdate('employees',id,demoPatch);audit('แก้ไขพนักงาน',name);}else{const queued=DB.employees.find(x=>x.id===employeeId);if(queued)dbUpdate('employees',employeeId,demoPatch);else dbAdd('employees',{id:employeeId,...demoPatch});audit('เพิ่มพนักงาน',name);}
      }
      if($('#e_password'))$('#e_password').value='';closeModal();toast(authIdentity?(patch.status==='inactive'?'บันทึกแล้ว · ปิดบัญชีพนักงาน':'บันทึกแล้ว · พนักงานใช้รหัส '+code+' เข้าสู่ระบบได้ทันที'):'บันทึกข้อมูลพนักงานสาธิตแล้ว','success');renderPage();
    }catch(error){button.disabled=false;button.textContent='ลองบันทึกอีกครั้ง';toast(error.message,'error');}

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
  preparePrint(body,docNo);
}
async function openPublicQrReport(cid){
  document.body.innerHTML='<div style="min-height:100vh;display:grid;place-items:center;padding:24px;font:700 17px Sarabun,sans-serif;color:#17384e;background:#f3f7fa">กำลังเปิดข้อมูลเอกสาร…</div>';
  try{
    const cfg=supaCfg();let payload=null;
    if(cfg){
      const res=await fetch(cfg.url+'/rest/v1/rpc/freshy_public_qr',{method:'POST',headers:{apikey:cfg.key,'Content-Type':'application/json'},body:JSON.stringify({customer_id:cid}),signal:AbortSignal.timeout(20000)});
      if(!res.ok)throw Error('เปิดข้อมูล QR ไม่สำเร็จ');payload=await res.json();
    }
    renderPublicQrReport(cid,payload);
  }catch(e){document.body.innerHTML='<div style="min-height:100vh;display:grid;place-items:center;padding:24px;text-align:center;font-family:Sarabun,sans-serif;background:#f3f7fa;color:#17384e"><div><h2>ไม่สามารถเปิดข้อมูลเอกสารได้</h2><p>กรุณาสแกน QR Code ใหม่อีกครั้ง</p></div></div>';}
}
function renderPublicQrReport(cid,payload){
  const c=payload?.customer||DB.customers.find(x=>x.id===cid);if(!c){document.body.innerHTML='<main class="document-screen"><h1>ไม่พบข้อมูลลูกหนี้</h1></main>';return;}
  const debts=(payload?.debtors||DB.debtors.filter(d=>d.customerId===cid&&d.status==='unpaid')).sort((a,b)=>String(a.debtDate).localeCompare(String(b.debtDate))),first=debts[0]||{},emp=payload?.recorder||DB.employees.find(e=>e.id===first.createdBy)||{name:'-'},biz=payload?.business||DB.settings.business,docNo=new URLSearchParams(location.search).get('doc')||'QR-'+String(c.code||cid).toUpperCase();
  let html=docHeader('ทะเบียนติดตามลูกหนี้ค้างชำระ',docNo,{business:biz,author:emp});
  html+='<section class="doc-customer-block"><table class="doc-table"><caption>ลูกหนี้: '+esc(c.name)+' · รหัส '+esc(c.code||'-')+' · '+esc(c.village||'บ้านนาไฮ')+(c.moo?' · หมู่ที่ '+esc(c.moo):'')+' · เบอร์โทร: '+esc(customerPhone(c))+'</caption><thead><tr><th>ลำดับ</th><th>วันที่ค้าง</th><th>ถัง</th><th>แพ็ค</th><th>เงินน้ำถัง</th><th>เงินน้ำแพ็ค</th><th>ยอดรวม (บาท)</th></tr></thead><tbody>';
  html+=debts.map((d,i)=>'<tr><td>'+(i+1)+'</td><td>'+esc(thDate(d.debtDate))+'</td><td>'+Number(d.jugs||0)+'</td><td>'+Number(d.packs||0)+'</td><td class="r">'+fmtN(d.jugAmount)+'</td><td class="r">'+fmtN(d.packAmount)+'</td><td class="r">'+fmtN(d.total)+'</td></tr>').join('')||'<tr><td colspan="7">ไม่มีรายการค้างชำระ</td></tr>';
  html+='</tbody></table></section><div class="doc-summary">ยอดค้างชำระรวม '+fmtN(debts.reduce((sum,d)=>sum+Number(d.total||0),0))+' บาท · '+debts.length+' รายการ</div>'+docFooter(docNo,emp);
  document.body.innerHTML='<div class="document-toolbar"><p>เอกสารเลขที่ '+esc(docNo)+'</p><button id="printLegacyDocument" type="button">พิมพ์ / บันทึก PDF</button></div><main id="printArea" class="document-screen"><div class="doc-page">'+html+'</div></main>';
  document.title=docNo+' ทะเบียนติดตามลูกหนี้';$('#printLegacyDocument').onclick=async()=>{if(document.fonts)await document.fonts.ready;window.print();};
}
let auditEmployee='all',auditPage=1;
function renderAudit(){
  const people=new Map(DB.employees.map(e=>[e.id,e.name]));DB.audit.forEach(a=>{if(a.userId&&!people.has(a.userId))people.set(a.userId,a.userName||'ผู้ใช้เดิม');});
  const rows=DB.audit.filter(a=>auditEmployee==='all'||a.userId===auditEmployee).sort((a,b)=>String(b.ts).localeCompare(String(a.ts))),pages=Math.max(1,Math.ceil(rows.length/50));auditPage=Math.min(auditPage,pages);const shown=rows.slice((auditPage-1)*50,auditPage*50);
  $('#pageContent').innerHTML=`<div class="page-head"><h2>ประวัติการแก้ไข</h2><span class="desc">ประวัติการทำงานของทุกคนในโรงงาน</span></div><div class="audit-filters"><div class="field"><label for="auditEmployeeFilter">เลือกพนักงาน</label><select id="auditEmployeeFilter"><option value="all">ทุกคนในโรงงาน</option>${[...people].sort((a,b)=>a[1].localeCompare(b[1],'th')).map(([id,name])=>'<option value="'+esc(id)+'" '+(auditEmployee===id?'selected':'')+'>'+esc(name)+'</option>').join('')}</select></div><p class="help-text" role="status">พบ ${rows.length.toLocaleString('th-TH')} รายการ · แสดงครั้งละ 50 รายการ</p></div><div class="panel"><div class="tbl-scroll"><table class="tbl audit-table"><thead><tr><th>วันและเวลา</th><th>ผู้ดำเนินการ</th><th>กิจกรรม</th><th>รายละเอียด</th></tr></thead><tbody>${shown.map(a=>'<tr><td class="audit-time">'+esc(thDateTime(a.ts))+'</td><td>'+esc(a.userName||people.get(a.userId)||'ระบบ')+'</td><td>'+esc(a.action)+'</td><td>'+esc(a.detail||'-')+'</td></tr>').join('')||'<tr><td colspan="4">ไม่พบประวัติของพนักงานที่เลือก</td></tr>'}</tbody></table></div></div><div class="pager"><button id="auditPrev" class="btn btn-ghost" ${auditPage===1?'disabled':''}>ก่อนหน้า</button><span>หน้า ${auditPage} / ${pages}</span><button id="auditNext" class="btn btn-ghost" ${auditPage===pages?'disabled':''}>ถัดไป</button></div>`;
  $('#auditEmployeeFilter').onchange=e=>{auditEmployee=e.target.value;auditPage=1;renderAudit();};$('#auditPrev').onclick=()=>{auditPage--;renderAudit();};$('#auditNext').onclick=()=>{auditPage++;renderAudit();};
}

/* ---------- SETTINGS (tabs) ---------- */
let settingTab='profile';
function renderSettings(){
  const s=DB.settings; const u=me();
  if(!isAdmin()&&settingTab!=='profile')settingTab='profile';
  const tabs=isAdmin()?[['profile','ข้อมูลผู้ใช้'],['display','การแสดงผล'],['business','สถานประกอบการ'],['header','โลโก้/หัวกระดาษ'],['db','ฐานข้อมูล'],['products','สินค้า'],['invoice','ใบแจ้งหนี้'],['villages','หมู่บ้าน'],['email','อีเมลแจ้งเตือน'],['accessHours','เวลาเข้าใช้งาน'],['system','ระบบ/ข้อมูล']]:[['profile','ข้อมูลผู้ใช้']];
  const tabsHtml=tabs.map(t=>'<button class="tab'+(settingTab===t[0]?' active':'')+'" data-t="'+t[0]+'">'+t[1]+'</button>').join('');
  let body='';
  if(settingTab==='profile')body=`<div class="panel"><div class="panel-head"><h3><i data-lucide="user"></i> ข้อมูลผู้ใช้และโปรไฟล์</h3></div><div class="panel-body"><div class="form-grid">
    <div class="field"><label>ชื่อผู้ใช้ (ชื่อจริง แสดงในรายงาน)</label><input id="s_name" value="${esc(u.name)}"></div>
    <div class="field"><label>รหัสพนักงาน</label><input id="s_code" value="${esc(u.code)}"></div>
    <div class="field"><label>อีเมล</label><input id="s_email" ${!isAdmin()&&authIdentity?'readonly':''} value="${esc(u.email||'')}"></div>
    <div class="field full"><label>เลือกรูปโปรไฟล์จากเครื่อง (JPG / PNG / WebP ไม่เกิน 5 MB)</label><input id="profileFile" type="file" accept="image/jpeg,image/png,image/webp"><img id="profilePreview" class="profile-preview" alt="ตัวอย่างรูป" ${u.avatarUrl?'src="'+esc(u.avatarUrl)+'"':'hidden'}></div><div class="field full"><label>URL รูปโปรไฟล์ (ไม่จำเป็น)</label><input id="s_avatar" value="${esc(u.avatarUrl||'')}"></div>
  </div><button class="btn btn-primary" id="saveProfile"><i data-lucide="save"></i> บันทึกโปรไฟล์</button></div></div>`;
  else if(settingTab==='display')body=`<div class="panel"><div class="panel-head"><h3>การแสดงผลหน้าภาพรวม</h3></div><div class="panel-body"><label class="perm-item"><input id="quickMenuToggle" type="checkbox" ${quickMenuEnabled()?'checked':''}> แสดงเมนูทำงานด่วน</label><p class="help-text">เปิด–ปิดเมนูด่วนสำหรับทุกเครื่องที่ใช้ระบบ บันทึกเฉพาะการตั้งค่าการแสดงผล ไม่แก้ข้อมูลลูกหนี้</p><p id="quickMenuStatus" role="status"></p></div></div>`;
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
  else if(settingTab==='invoice')body=invoiceSettingsHtml();
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
    const vhtml=DB.villages.map(v=>`<div class="village-setting-row"><span>${esc(v.name)}</span><input class="v_code" data-id="${v.id}" aria-label="รหัสหมู่บ้าน ${esc(v.name)}" value="${esc(FreshyFeatures.villageCode(DB.villages,v.name))}" maxlength="30"><button class="btn btn-ghost btn-sm delV" data-id="${v.id}">ลบ</button></div>`).join('');
    body=`<div class="panel"><div class="panel-head"><h3><i data-lucide="map-pinned"></i> รายชื่อหมู่บ้าน (ลูกหนี้บ้านอื่น ๆ)</h3></div><div class="panel-body">
      <div style="margin-bottom:12px">${vhtml||'<span style="color:var(--muted);font-size:13px">ยังไม่มีหมู่บ้านเพิ่มเติม</span>'}</div>
      <button class="btn btn-primary" id="saveVillageCodes">บันทึกรหัสหมู่บ้าน</button><div class="field" style="margin-top:18px"><label>รหัสสำหรับหมู่บ้านใหม่ (เว้นว่างให้รันอัตโนมัติ)</label><input id="v_code_new" maxlength="30"></div><div style="display:flex;gap:8px"><input id="v_name" placeholder="ชื่อหมู่บ้าน เช่น บ้านโนนสูง" style="flex:1;padding:10px;border:1.5px solid var(--border);border-radius:10px"><button class="btn btn-gold" id="addVillage"><i data-lucide="plus"></i> เพิ่ม</button></div></div></div>`;
  }
  else if(settingTab==='email')body=`<div class="panel"><div class="panel-head"><h3><i data-lucide="mail"></i> การตั้งค่าอีเมลแจ้งเตือน</h3></div><div class="panel-body"><div class="form-grid">
    <label class="perm-item full"><input type="checkbox" id="em_en" ${s.email.enabled?'checked':''}> เปิดใช้งานการส่งอีเมลแจ้งเตือน</label>
    <div class="field full"><label>อีเมลแอดมินสำหรับรับการแจ้งเตือน</label><input id="em_to" value="${esc(s.email.adminEmail)}"></div>
    <div class="field"><label>ผู้ให้บริการ</label><select id="em_prov" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:10px"><option value="gmail" ${s.email.provider==='gmail'?'selected':''}>Google Gmail (App Password)</option><option value="resend" ${s.email.provider==='resend'?'selected':''}>Resend API</option><option value="smtp" ${s.email.provider==='smtp'?'selected':''}>SMTP</option></select></div>
    <div class="field"><label>รหัสส่งอีเมล (Gmail App Password / SMTP Password / API Key)</label><input type="password" id="em_key" value="${esc(['gmail','smtp'].includes(s.email.provider)?(s.email.smtpPass||s.email.apiKey||''):s.email.apiKey||'')}"></div>
    <div class="field full"><label>อีเมลผู้ส่ง (Gmail ที่ออก App Password)</label><input id="em_from" value="${esc(s.email.fromEmail||'')}"></div><div class="field"><label>SMTP Host (ใช้เมื่อเลือก SMTP)</label><input id="em_host" value="${esc(s.email.smtpHost)}"></div>
    <div class="field"><label>SMTP Port</label><input id="em_port" value="${esc(s.email.smtpPort)}"></div>
    <div class="field"><label>SMTP User</label><input id="em_user" value="${esc(s.email.smtpUser)}"></div>
    <div class="field full"><label>เวลาส่งรายงาน (เวลาประเทศไทย คั่นด้วยจุลภาค)</label><input id="em_times" value="${esc((s.email.reportTimes||['08:00','18:00']).join(','))}" placeholder="08:00,18:00"><label class="perm-item"><input type="checkbox" id="em_reports" ${s.email.reportsEnabled?'checked':''}> เปิดรายงานตามเวลา</label><p class="help-text">Gmail ใช้ App Password ของบัญชีที่เปิดการยืนยัน 2 ขั้นตอน ไม่ต้องใช้ API Key · การส่งขณะปิดระบบต้องตั้งค่าเซิร์ฟเวอร์งานอัตโนมัติ</p></div><div class="field full" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <label class="perm-item"><input type="checkbox" id="al_login" ${s.email.alerts.login?'checked':''}> แจ้งพนักงานล็อกอิน</label>
      <label class="perm-item"><input type="checkbox" id="al_logout" ${s.email.alerts.logout?'checked':''}> แจ้งพนักงานออกระบบ</label>
      <label class="perm-item"><input type="checkbox" id="al_add" ${s.email.alerts.addDebtor?'checked':''}> แจ้งเพิ่มรายการลูกหนี้</label>
      <label class="perm-item"><input type="checkbox" id="al_undo" ${s.email.alerts.undoRequest?'checked':''}> แจ้งคำขอกลับไปค้าง</label>
      <label class="perm-item"><input type="checkbox" id="al_new" ${s.email.alerts.newcustomer!==false?'checked':''}> แจ้งเพิ่มลูกค้าใหม่</label><label class="perm-item"><input type="checkbox" id="al_profile" ${s.email.alerts.profile!==false?'checked':''}> แจ้งแก้ไขโปรไฟล์</label><label class="perm-item"><input type="checkbox" id="al_payment" ${s.email.alerts.payment!==false?'checked':''}> แจ้งรับชำระ</label><label class="perm-item"><input type="checkbox" id="al_cash" ${s.email.alerts.cash!==false?'checked':''}> แจ้งรายการเงินสด</label></div>
  </div><button class="btn btn-primary" id="saveEmail" style="margin-top:6px"><i data-lucide="save"></i> บันทึก</button></div></div>`;
  else if(settingTab==='accessHours'){const h=FreshyFeatures.accessHours(s.accessHours);body=`<div class="panel"><div class="panel-head"><h3><i data-lucide="clock-3"></i> เวลาเข้าใช้งานของพนักงาน</h3></div><div class="panel-body"><p class="help-text">แอดมินกำหนดช่วงเวลาสำหรับพนักงานทุกคนได้ ใช้เวลาไทย (Asia/Bangkok) แอดมินเข้าใช้งานได้ตลอดเวลา</p><label class="perm-item"><input id="accessHoursEnabled" type="checkbox" ${h.enabled?'checked':''}> จำกัดเวลาเข้าใช้งานของพนักงาน</label><div class="form-grid access-hours-fields"><div class="field"><label for="accessHoursStart">เวลาเริ่มเข้าใช้งาน</label><input id="accessHoursStart" type="time" value="${h.start}" required></div><div class="field"><label for="accessHoursEnd">เวลาสิ้นสุดการใช้งาน</label><input id="accessHoursEnd" type="time" value="${h.end}" required></div></div><p class="help-text">มีผลทุกวัน เวลาเริ่มรวมในช่วงใช้งาน เวลาสิ้นสุดจะล็อกทันที หากเวลาสิ้นสุดน้อยกว่าเวลาเริ่ม หมายถึงสิ้นสุดในวันถัดไป เมื่อปิดข้อจำกัด พนักงานเข้าได้ตลอดเวลา</p><p class="help-text">รายการที่บันทึกแล้วและรายการรอส่งยังเก็บอยู่ เมื่อเข้าใช้งานได้อีกครั้งระบบจะตรวจสอบและส่งต่อ</p><button class="btn btn-primary" id="saveAccessHours"><i data-lucide="save"></i> บันทึกเวลาเข้าใช้งาน</button><p id="accessHoursSaveStatus" class="help-text" role="status"></p></div></div>`;}
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
      <button class="btn btn-danger" id="resetBtn"><i data-lucide="trash-2"></i> ล้างข้อมูลระบบ</button><button class="btn btn-ghost" id="clearDemoBtn">ล้างเฉพาะข้อมูลจำลอง</button>
    </div>
    <div style="margin-top:18px"><h4>นำเข้าและส่งออก CSV</h4><p class="help-text">ลูกค้าและลูกหนี้ค้างชำระ · นำเข้าได้สูงสุด 2,000 แถว โดยตรวจสอบก่อนบันทึกทั้งหมด</p><div class="toolbar"><select id="csvKind"><option value="all">ลูกค้าและลูกหนี้ค้างชำระ</option><option value="customers">ลูกค้า</option><option value="debtors">ลูกหนี้ค้างชำระ</option></select><button id="settingsExportCsv" class="btn btn-navy">ดาวน์โหลด CSV</button><button id="settingsImportCsv" class="btn btn-primary">นำเข้า CSV</button><button id="csvTemplate" class="btn btn-ghost">ดาวน์โหลดแบบฟอร์ม CSV</button><input id="settingsCsvFile" type="file" accept=".csv,text/csv" hidden></div><p class="help-text">ใช้หัวคอลัมน์จากแบบฟอร์ม: type = customers หรือ debtors, area = nai หรือ other, วันที่ YYYY-MM-DD หรือ DD/MM/พ.ศ. · ระบุ customerId เพื่อเชื่อมลูกหนี้กับลูกค้า · ไฟล์ส่งออกนำกลับเข้าได้</p></div><div style="margin-top:18px"><h4 style="font-size:13px;color:var(--navy);margin-bottom:8px">อีเมลแจ้งเตือนที่ส่งล่าสุด (${DB.sentEmails.filter(e=>!['document','deleted-debt'].includes(e.type)).length} รายการ)</h4>
    ${DB.sentEmails.filter(e=>!['document','deleted-debt'].includes(e.type)).slice(0,5).map(e=>'<div class="audit-item"><span class="ts">'+thDateTime(e.ts)+'</span><span><b>'+esc(e.subject)+'</b> — '+esc(e.status)+'</span></div>').join('')||'<span style="color:var(--muted);font-size:12.5px">ยังไม่มี</span>'}</div>
  </div></div>`;
  $('#pageContent').innerHTML='<div class="page-head"><h2>การตั้งค่าระบบ</h2><span class="desc">แยกเป็นหมวดหมู่ชัดเจน ไม่ต้องแก้ไขโค้ด</span></div><div class="tabs">'+tabsHtml+'</div>'+body;
  $('#pageContent').querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>{settingTab=t.dataset.t;renderSettings();}));
  // save handlers
  const bind=(id,fn)=>{const el=$(id);if(el)el.addEventListener('click',fn);};
  bind('#saveAccessHours',async()=>{
   if(!isAdmin())return;const button=$('#saveAccessHours'),status=$('#accessHoursSaveStatus');let value;
   try{value=FreshyFeatures.accessHours({enabled:$('#accessHoursEnabled').checked,start:$('#accessHoursStart').value,end:$('#accessHoursEnd').value,timeZone:'Asia/Bangkok'});}catch(e){status.textContent=e.message;toast(e.message,'error');return;}
   button.disabled=true;status.textContent='กำลังบันทึก…';
   try{if(authIdentity){await rpc('freshy_access_status');if(!(await flushOnline()))throw Error('กรุณาส่งข้อมูลรอส่งให้สำเร็จก่อนเปลี่ยนเวลา');const latest=await rpc('freshy_read');acceptRemote(latest,FreshySync.diff(remoteBase||{},FreshySync.shared(DB)));if(!(await flushOnline()))throw Error('กรุณาส่งข้อมูลรอส่งให้สำเร็จก่อนเปลี่ยนเวลา');const expected=FreshySync.clone(remoteSettings),next={...expected,accessHours:value},before=FreshySync.shared(DB);const saved=await rpc('freshy_apply',{changes:[{collection:'settings',id:'settings',expected,value:next}]});acceptRemote(saved,FreshySync.diff(before,FreshySync.shared(DB)));broadcastOnlineChange();}else{DB.settings.accessHours=value;dbSave();}operatingPolicy=DB.settings.accessHours;status.textContent='บันทึกเวลาเข้าใช้งานแล้ว'+(value.enabled?' · '+value.start+'–'+value.end+' น. (เวลาไทย)':' · พนักงานเข้าใช้งานได้ตลอดเวลา');toast('บันทึกเวลาเข้าใช้งานแล้ว','success');}catch(e){status.textContent=e.message;toast(e.message,'error');}finally{if(button.isConnected)button.disabled=false;}
  });
  bind('#saveProfile',()=>{const oldName=u.name;const newName=$('#s_name').value.trim();if(!newName||!$('#s_code').value.trim()){toast('กรุณากรอกชื่อและรหัส','error');return;}if(DB.employees.some(e=>e.id!==u.id&&e.code===$('#s_code').value.trim())){toast('รหัสพนักงานซ้ำ','error');return;}dbUpdate('employees',u.id,{name:newName,code:$('#s_code').value.trim(),email:$('#s_email').value.trim(),avatarUrl:$('#s_avatar').value.trim()});if(newName&&newName!==oldName)sendAlert('profile','[แจ้งเตือน] ผู้ใช้เปลี่ยนชื่อโปรไฟล์','<p>ผู้ใช้รหัส '+esc(u.code)+' ได้เปลี่ยนชื่อจาก <b>'+esc(oldName)+'</b> เป็น <b>'+esc(newName)+'</b></p>');toast('บันทึกโปรไฟล์แล้ว'+(newName!==oldName?' · ตรวจผลอีเมลในประวัติ':''),'success');refreshUserChip();});
  $('#quickMenuToggle')?.addEventListener('change',async()=>{const toggle=$('#quickMenuToggle'),status=$('#quickMenuStatus');if(!isAdmin())return;toggle.disabled=true;try{DB.settings.header=DB.settings.header||{};DB.settings.header.showQuickMenu=toggle.checked;try{localStorage.setItem('freshy_quick_menu',toggle.checked?'on':'off');}catch{}dbSave();status.textContent='กำลังบันทึกการแสดงผล…';const saved=!authIdentity||await flushOnline();status.textContent=saved?'บันทึกการแสดงผลแล้ว ทุกเครื่องจะใช้ค่าเดียวกัน':'ยังส่งการตั้งค่าไม่สำเร็จ กรุณาตรวจสถานะการซิงค์';}catch(e){status.textContent=e.message;}finally{toggle.disabled=false;}});
  bindInvoiceSettings();
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
  bind('#addVillage',()=>{const name=$('#v_name').value.trim();if(!name)return;if(DB.villages.some(v=>v.name===name)){toast('ชื่อหมู่บ้านนี้มีอยู่แล้ว','error');return;}const code=$('#v_code_new').value.trim()||FreshyFeatures.villageCode(DB.villages,name);if(DB.villages.some(v=>FreshyFeatures.villageCode(DB.villages,v.name).toLowerCase()===code.toLowerCase())){toast('รหัสหมู่บ้านซ้ำ','error');return;}dbAdd('villages',{name,code});toast('เพิ่มหมู่บ้านแล้ว','success');renderSettings();});
  bind('#saveVillageCodes',async()=>{const fields=[...document.querySelectorAll('.v_code')],codes=fields.map(f=>f.value.trim());if(codes.some(x=>!x)||new Set(codes.map(x=>x.toLowerCase())).size!==codes.length){toast('รหัสหมู่บ้านต้องไม่ว่างและไม่ซ้ำ','error');return;}fields.forEach((f,i)=>dbUpdate('villages',f.dataset.id,{code:codes[i]}));toast(authIdentity?(await flushOnline()?'บันทึกรหัสหมู่บ้านออนไลน์แล้ว':'รหัสหมู่บ้านยังรอส่ง'):'บันทึกรหัสหมู่บ้านสาธิตแล้ว','info');});
  $('#pageContent').querySelectorAll('.delV').forEach(b=>b.addEventListener('click',()=>{dbRemove('villages',b.dataset.id);renderSettings();}));
  bind('#saveEmail',async()=>{try{const provider=$('#em_prov').value;const reportTimes=FreshyFeatures.scheduleTimes($('#em_times').value);Object.assign(s.email,{enabled:$('#em_en').checked,adminEmail:$('#em_to').value.trim(),provider,fromEmail:$('#em_from').value.trim(),smtpHost:$('#em_host').value,smtpPort:$('#em_port').value,smtpUser:$('#em_user').value.trim(),reportTimes,reportsEnabled:$('#em_reports').checked,alerts:{login:$('#al_login').checked,logout:$('#al_logout').checked,addDebtor:$('#al_add').checked,undoRequest:$('#al_undo').checked,newcustomer:$('#al_new').checked,profile:$('#al_profile').checked,payment:$('#al_payment').checked,cash:$('#al_cash').checked}});s.email[['gmail','smtp'].includes(provider)?'smtpPass':'apiKey']=$('#em_key').value.trim().replace(provider==='gmail'?/\s/g:/$^/g,'');dbSave();toast(authIdentity?(await flushOnline()?'บันทึกการตั้งค่าลงฐานข้อมูลแล้ว':'ค่าตั้งค่ายังรอส่ง โปรดตรวจสถานะฐานข้อมูล'):'บันทึกในโหมดสาธิตแล้ว',authIdentity&&FreshySync.diff(remoteBase,FreshySync.shared(DB)).length?'info':'success');}catch(e){toast(e.message,'error');}});
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
      try{const parsed=JSON.parse(rd.result),data=parsed.data||parsed;
        if(!data||typeof data!=='object')throw new Error('ไฟล์ไม่ถูกต้อง');
        if(!confirm('จะกู้คืนข้อมูลจากไฟล์นี้หรือ? ข้อมูลที่มีอยู่จะถูกผสานทับ (คีย์เดียวกันจะถูกแทนที่)'))return;
        Object.keys(data).forEach(k=>{if(SUPA_COLS.includes(k)&&Array.isArray(data[k])&&DB[k]!==undefined){if(authIdentity){const rows=new Map(DB[k].map(x=>[x.id,x]));data[k].forEach(x=>{if(x&&typeof x==='object'){x.id=x.id||uid();if(k!=='audit'||!rows.has(x.id))rows.set(x.id,x);}});DB[k]=Array.from(rows.values());}else DB[k]=data[k];}});
        if(data.settings){const connection=DB.settings.db;const revision=DB.settings._resetRevision;Object.assign(DB.settings,data.settings);DB.settings.db=connection;if(revision)DB.settings._resetRevision=revision;else delete DB.settings._resetRevision;}
        dbSave();toast(authIdentity?'ผสานไฟล์ในเครื่องแล้ว · รอผลบันทึกออนไลน์':'กู้คืนในเครื่องแล้ว','success');renderPage();
      }catch(err){toast('ไฟล์สำรองไม่ถูกต้อง: '+err.message,'error');}
    };rd.readAsText(f);
  });
  bind('#resetBtn',openRealReset);bind('#clearDemoBtn',clearDemoData);
  bind('#settingsExportCsv',exportSettingsCsv);bind('#settingsImportCsv',()=>$('#settingsCsvFile').click());
  if($('#settingsCsvFile'))$('#settingsCsvFile').onchange=e=>{previewCsvImport(e.target.files[0]);e.target.value='';};
  bind('#csvTemplate',()=>{const url=URL.createObjectURL(new Blob([FreshyFeatures.csv(FreshyData.headers,[['customers','customer-001','','C001','ลูกค้าตัวอย่าง','other','','บ้านตัวอย่าง','','','','','','','','',''],['debtors','debt-001','customer-001','','ลูกค้าตัวอย่าง','other','','บ้านตัวอย่าง','','',todayStr(),1,0,20,0,20,'ตัวอย่าง']])],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='freshy-import-template.csv';a.click();URL.revokeObjectURL(url);});
  attachSettingsFeatures();
  renderIcons();
}
function refreshUserChip(){const u=me();if(!u)return;$('#userName').textContent=u.name;$('#userRole').textContent=u.role==='admin'?'แอดมินระบบ':'พนักงาน';$('#userAvatar').replaceChildren();if(u.avatarUrl){const img=document.createElement('img');img.src=u.avatarUrl;img.alt='รูปโปรไฟล์';$('#userAvatar').append(img);}else $('#userAvatar').textContent=u.name.charAt(0);}

/* ============================================================
   PRINT / PDF / EMAIL REPORT (A4, เลขที่เอกสารไม่ซ้ำ)
   ============================================================ */
function nextDocNo(prefix){if(prefix==='INV'){let candidate;do{candidate=FreshyInvoice.number(crypto);}while(DB.sentEmails.some(r=>r.invoice?.docNo===candidate||r.document?.docNo===candidate));return candidate;}return FreshyFeatures.shortDocumentNumber(prefix,crypto);}
function docHeader(reportTitle,docNo,options={}){
  const s=DB.settings,b=options.business||s.business,issued=FreshyFeatures.bangkokParts(options.issuedAt?new Date(options.issuedAt):new Date());
  const logo='<img src="'+esc(s.header.logoDataUrl||'/brand-icon.png')+'" alt="ตราสัญลักษณ์โรงน้ำดื่มเฟรชชี่ วอเตอร์">';
  return `<div class="doc-head"><div class="doc-logo">${logo}</div><div class="doc-title"><div class="factory">${esc(b.name)}</div><div class="factory-sub">ที่ตั้ง ${esc(b.address||'ยังไม่ได้ระบุที่อยู่โรงน้ำ กรุณาตั้งค่าข้อมูลสถานประกอบการ')}<br>โทรศัพท์ ${esc(b.phone||'-')}${b.taxId?' · เลข อย. '+esc(b.taxId):''}</div><div class="report-name">${esc(reportTitle)}</div></div><div class="doc-control"><span>เลขที่เอกสาร</span><strong>${esc(docNo)}</strong></div></div><div class="doc-meta"><span>วันที่ออกเอกสาร ${pad2(issued.day)}/${pad2(issued.month)}/${issued.year+543} เวลา ${issued.time} น.</span><span>ผู้จัดทำ ${esc(options.author?.name||me()?.name||'-')}</span></div>`;
}
function docFooter(docNo,author=me()||{name:''}){
  return `<div class="sign-row"><div class="sign-box"><div class="line">(${esc(author.name||'........................................')})</div><div class="role">ผู้จัดทำข้อมูล</div><div class="sign-date">วันที่ .... / .... / ........</div></div><div class="sign-box"><div class="line">(........................................)</div><div class="role">พนักงานส่งน้ำ</div><div class="sign-date">วันที่ .... / .... / ........</div></div><div class="sign-box"><div class="line">(........................................)</div><div class="role">ผู้ตรวจสอบ</div><div class="sign-date">วันที่ .... / .... / ........</div></div><div class="sign-box"><div class="line">(........................................)</div><div class="role">ผู้อนุมัติ</div><div class="sign-date">วันที่ .... / .... / ........</div></div></div><div class="doc-foot"><span>เลขที่เอกสาร ${esc(docNo)} ออกโดยระบบสารสนเทศจัดการลูกหนี้</span><span>โรงน้ำดื่ม เฟรชชี่ วอเตอร์</span></div>`;
}
function buildDebtorReportHtml(area,filter,mode,customerId){
  let rows=scopeRows(DB.debtors).filter(d=>d.area===area&&d.status==='unpaid'&&(!customerId||d.customerId===customerId));
  if(area==='nai'&&filter&&filter!=='all')rows=rows.filter(d=>d.moo===filter);
  if(area==='other'&&filter&&filter!=='all')rows=rows.filter(d=>d.village===filter);
  const groups={};rows.forEach(d=>{(groups[d.customerId]=groups[d.customerId]||[]).push(d);});
  const docNo=nextDocNo(DB.settings.docPrefix.debtor);
  let body=docHeader('รายงานลูกหนี้ค้างชำระ '+(area==='nai'?'บ้านนาไฮ':'บ้านอื่น ๆ')+(filter&&filter!=='all'?' ('+(area==='nai'?'หมู่ที่ '+filter:filter)+')':''),docNo);
  const renderGroup=(list,title)=>{
    const customerIds=Object.keys(list);if(!customerIds.length)return '';
    let h=title?'<div class="doc-section-title">'+esc(title)+'</div>':'';
    for(const cid of customerIds){
      const dl=[...list[cid]].sort((a,b)=>a.debtDate.localeCompare(b.debtDate));
      const customer=DB.customers.find(c=>c.id===cid)||{},first=dl[0],village=area==='nai'?'บ้านนาไฮ · หมู่ที่ '+first.moo:(first.village||'-');
      h+=`<section class="doc-customer-block${dl.length<=12?' doc-customer-compact':''}"><table class="doc-table debtor-report-table"><caption>ลูกหนี้: ${esc(first.customerName)} · รหัส ${esc(customer.code||'-')} · ${esc(village)} · เบอร์โทร: ${esc(customerPhone(customer))}</caption><colgroup><col style="width:7%"><col style="width:21%"><col style="width:8%"><col style="width:8%"><col style="width:18%"><col style="width:18%"><col style="width:20%"></colgroup><thead><tr class="doc-customer-heading"><th colspan="7"><div class="debtor-identity-name">ลูกหนี้: ${esc(first.customerName)}</div><div class="debtor-identity-details"><span>รหัส ${esc(customer.code||'-')}</span><span>${esc(village)}</span><span>เบอร์โทร: ${esc(customerPhone(customer))}</span></div></th></tr><tr><th>ลำดับ</th><th>วันที่ค้าง</th><th>ถัง</th><th>แพ็ค</th><th>เงินน้ำถัง</th><th>เงินน้ำแพ็ค</th><th>ยอดรวม (บาท)</th></tr></thead><tbody>`;
      dl.forEach((d,i)=>{h+=`<tr><td>${i+1}</td><td>${thDate(d.debtDate)}</td><td>${d.jugs||0}</td><td>${d.packs||0}</td><td class="r">${fmtN(d.jugAmount)}</td><td class="r">${fmtN(d.packAmount)}</td><td class="r">${fmtN(d.total)}</td></tr>`;});
      const sum=key=>dl.reduce((n,d)=>n+Number(d[key]||0),0);h+=`<tr class="doc-customer-total"><td colspan="2" class="l">รวม ${esc(first.customerName)}</td><td>${sum('jugs')}</td><td>${sum('packs')}</td><td class="r">${fmtN(sum('jugAmount'))}</td><td class="r">${fmtN(sum('packAmount'))}</td><td class="r">${fmtN(sum('total'))}</td></tr></tbody></table></section>`;
    }
    return h;
  };
  if(mode==='split'&&area==='nai'){
    const g7={},g16={};Object.keys(groups).forEach(cid=>{const m=groups[cid][0].moo==='7'?g7:g16;m[cid]=groups[cid];});
    body+=renderGroup(g7,'หมู่ที่ 7')+renderGroup(g16,'หมู่ที่ 16');
  }else if(mode==='split'&&area==='other'){
    const byV={};Object.keys(groups).forEach(cid=>{const v=groups[cid][0].village||'อื่น ๆ';(byV[v]=byV[v]||{})[cid]=groups[cid];});
    Object.keys(byV).forEach(v=>{body+=renderGroup(byV[v],v);});
  }else body+=renderGroup(groups,'');
  body+=`<div class="doc-summary report-total">ลูกหนี้ ${Object.keys(groups).length} ราย · ${rows.length} รายการ · ยอดค้างรวมทั้งหมด ${fmtN(rows.reduce((n,d)=>n+Number(d.total||0),0))} บาท</div>`;
  body+=docFooter(docNo);
  return {html:body,docNo};
}
function buildDebtorInvoiceHtml(area,customerId,options={}){
 if(!customerId)throw Error('กรุณาเลือกลูกค้าสำหรับใบแจ้งหนี้');
 const model=invoiceModel(area,customerId,options);return {html:invoiceHtml(model),docNo:model.docNo};
}
function openPrintOptions(area,customerId=''){
  if(!canPrint()){toast('ไม่มีสิทธิ์ออกเอกสาร','error');return;}
  const available=new Map();scopeRows(DB.debtors).filter(d=>d.area===area&&d.status==='unpaid').forEach(d=>available.set(d.customerId,d.customerName));
  openModal(`<div class="modal-head"><h3><i data-lucide="printer"></i> เลือกเอกสาร A4</h3><button class="x" onclick="closeModal()"><i data-lucide="x"></i></button></div>
  <div class="modal-body">
    <div class="field"><label for="po_type">ชนิดเอกสาร</label><select id="po_type"><option value="report">รายงานลูกหนี้ค้างชำระ (รูปแบบเดิม)</option><option value="invoice">ใบแจ้งหนี้รายบุคคล</option></select></div>
    <div class="field"><label for="po_customer">ลูกค้า</label><select id="po_customer"><option value="">ทั้งหมด (สำหรับรายงาน)</option>${[...available].map(([id,name])=>'<option value="'+esc(id)+'"'+(id===customerId?' selected':'')+'>'+esc(name)+'</option>').join('')}</select></div>
    <div id="po_report_fields"><div class="field"><label>รูปแบบรายงาน</label><select id="po_mode"><option value="combined">พิมพ์รวม</option><option value="split">แยกตามหมู่/หมู่บ้าน</option></select></div>
    <div class="field"><label>กรองข้อมูล</label><select id="po_filter"><option value="all">ทั้งหมด</option>${area==='nai'?'<option value="7">เฉพาะหมู่ที่ 7</option><option value="16">เฉพาะหมู่ที่ 16</option>':DB.villages.map(v=>'<option value="'+esc(v.name)+'">'+esc(v.name)+'</option>').join('')}</select></div></div>
    <div id="po_invoice_fields" hidden><div class="field"><label for="po_due">กำหนดชำระ (ถ้ามี)</label><input id="po_due" type="date"></div><div class="field"><label for="po_note">หมายเหตุในใบแจ้งหนี้</label><textarea id="po_note" maxlength="1000" rows="2" placeholder="เช่น ช่องทางติดต่อหรือรายละเอียดการชำระ"></textarea></div></div>
    <label class="perm-item"><input type="checkbox" id="po_qr" checked> แสดง QR เอกสารตรงมุมบนขวา</label><p class="help-text">ใบแจ้งหนี้ใช้ยอดค้างชำระที่มีอยู่ ข้อมูลชื่อ ที่อยู่ และเบอร์โทรโรงน้ำใช้จากการตั้งค่าสถานประกอบการ</p>
  </div><div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">ยกเลิก</button><button class="btn btn-primary" id="doPrint"><i data-lucide="printer"></i> พิมพ์ / บันทึก PDF</button></div>`);
  $('#po_type').onchange=()=>{const invoice=$('#po_type').value==='invoice';$('#po_report_fields').hidden=invoice;$('#po_invoice_fields').hidden=!invoice;$('#po_qr').closest('label').hidden=invoice;};
  $('#doPrint').onclick=()=>{try{const cid=$('#po_customer').value,r=$('#po_type').value==='invoice'?buildDebtorInvoiceHtml(area,cid,{dueDate:$('#po_due').value,note:$('#po_note').value.trim()}):buildDebtorReportHtml(area,cid?'all':$('#po_filter').value,$('#po_mode').value,cid||undefined);preparePrint(r.html,r.docNo,$('#po_qr').checked);}catch(e){toast(e.message,'error');}};
}
function buildCashReportHtml(date){
  const rows=scopeRows(DB.cashsales).filter(r=>!date||r.deliveryDate===date);
  const docNo=nextDocNo(DB.settings.docPrefix.cash);
  let body=docHeader('รายงานการส่งน้ำยอดเงินลูกค้าจ่ายสด วันที่ '+thDate(date),docNo);
  body+='<table class="doc-table"><thead><tr><th>ลำดับ</th><th>รหัส</th><th>ชื่อลูกค้า</th><th>หมู่บ้าน</th><th>หมู่ที่</th><th>ถัง</th><th>แพ็ค</th><th>เงินถัง</th><th>เงินแพ็ค</th><th>รวม</th></tr></thead><tbody>';
  rows.forEach((r,i)=>{body+=`<tr><td>${i+1}</td><td>${esc(r.customerCode)}</td><td class="l">${esc(r.customerName)}</td><td>${esc(r.village||'-')}</td><td>${esc(r.moo||'-')}</td><td>${r.jugs}</td><td>${r.packs}</td><td class="r">${fmtN(r.jugAmount)}</td><td class="r">${fmtN(r.packAmount)}</td><td class="r">${fmtN(r.jugAmount+r.packAmount)}</td></tr>`;});
  const tj=rows.reduce((s,r)=>s+r.jugs,0),tp=rows.reduce((s,r)=>s+r.packs,0),tt=rows.reduce((s,r)=>s+r.jugAmount+r.packAmount,0);
  body+=`<tr style="background:#eef2f7;font-weight:700"><td colspan="5">รวมทั้งหมด</td><td>${tj}</td><td>${tp}</td><td class="r">${fmtN(rows.reduce((s,r)=>s+r.jugAmount,0))}</td><td class="r">${fmtN(rows.reduce((s,r)=>s+r.packAmount,0))}</td><td class="r">${fmtN(tt)}</td></tr></tbody></table>`;
  body+=docFooter(docNo);
  return {html:body,docNo};
}
function printCashReport(date){const r=buildCashReportHtml(date);preparePrint(r.html,r.docNo);}
function openEmailReport(kind){
  openModal(`<div class="modal-head"><h3><i data-lucide="mail"></i> ส่งรายงานทางอีเมล</h3><button class="x" onclick="closeModal()"><i data-lucide="x"></i></button></div>
  <div class="modal-body"><div class="form-grid">
    <div class="field full"><label>อีเมลผู้รับ / กลุ่มผู้รับ (คั่นด้วยจุลภาค อัฒภาค หรือขึ้นบรรทัดใหม่)</label><textarea id="er_to" rows="3">${esc(DB.settings.email.adminEmail||'')}</textarea></div>
    <div class="field full"><label>รูปแบบอีเมล</label><select id="er_fmt" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:10px"><option value="simple">แบบเรียบง่าย</option><option value="formal" selected>แบบทางการ พร้อม PDF แนบ</option></select></div>
    <p style="font-size:12px;color:var(--muted);grid-column:1/-1">แบบทางการจะส่งอีเมลแจ้งนำส่งเอกสารและแนบ PDF อัตโนมัติ แบบเรียบง่ายส่งรายละเอียดในอีเมล รองรับผู้รับสูงสุด 10 อีเมล</p>${!DB.settings.email.enabled?'<div class="field full"><p>ยังไม่ได้เปิดใช้งานบัญชีผู้ส่ง กรุณาตั้งค่าครั้งแรกก่อนส่งรายงาน</p>'+(isAdmin()?'<button class="btn btn-ghost" id="setupReportEmail">ตั้งค่าบัญชีผู้ส่ง</button>':'<p>ให้ผู้ดูแลระบบบันทึกบัญชีผู้ส่งครั้งแรก</p>')+'</div>':''}<p id="emailReportStatus" role="status" class="help-text full"></p>
  </div></div>
  <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">ยกเลิก</button><button class="btn btn-gold" id="doSendEmail" ${!DB.settings.email.enabled?'disabled':''}><i data-lucide="send"></i> ส่งรายงาน</button></div>`);
  if($('#setupReportEmail'))$('#setupReportEmail').onclick=()=>{closeModal();settingTab='email';navigate('settings');};
  $('#doSendEmail').addEventListener('click',async()=>{
    const to=$('#er_to').value.trim();if(!to){toast('กรุณากรอกอีเมลผู้รับ','error');return;}
    const button=$('#doSendEmail'),status=$('#emailReportStatus');button.disabled=true;button.textContent='กำลังส่งรายงาน…';status.textContent='กำลังบันทึกข้อมูลและส่งรายงานไปยังผู้รับ';try{
    let r;
    if(kind==='cash')r=buildCashReportHtml(cashDateFilter);
    else if(kind&&kind.startsWith('customers-'))r=buildCustomerReportHtml(kind.split('-')[1]);
    else r=buildDebtorReportHtml(kind==='nai'?'nai':'other','all','combined');
    const format=$('#er_fmt').value,snapshot=format==='formal'?FreshyFeatures.documentSnapshot(r.html,r.docNo,DB.settings.business,me(),document):undefined;
    const sent=await sendAlert('report','[แจ้งนำส่งรายงาน] '+(snapshot?.title||(kind==='cash'?'รายงานลูกค้าจ่ายสด':'รายงานลูกหนี้'))+' · '+r.docNo,r.html,to,{format,snapshot});
    if(sent){closeModal();toast('ผู้ให้บริการรับรายงานแล้ว','success');}else if(status.isConnected){status.textContent=DB.sentEmails[0]?.status||'ยังไม่ส่งรายงาน กรุณาตรวจบัญชีผู้ส่งในหน้าตั้งค่าอีเมล';}
    }catch(e){if(status.isConnected)status.textContent=e.message;toast(e.message,'error');}finally{if(button.isConnected){button.disabled=false;button.innerHTML='<i data-lucide="send"></i> ส่งรายงาน';renderIcons();}}
  });
}

/* ============================================================
   PRIVACY PROTECTION (ป้องกันแคปหน้าจอ / เปิดซ้อนหน้าจอ)
   ============================================================ */
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
  if(u){pv.classList.remove('hidden');pv.classList.remove('err');pv.innerHTML='<i data-lucide="user-check" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px"></i>ยินดีต้อนรับ คุณ'+esc(u.name)+' · '+(u.role==='admin'?'แอดมินระบบ':'พนักงาน');renderIcons();}
  else{pv.classList.remove('hidden');pv.classList.add('err');pv.textContent='รหัสนี้ยังไม่ตรงกับผู้ใช้ใด ๆ';}
});
async function doLogin(){
  if(DB.settings.db.mode==='supabase'){const btn=$('#loginBtn');btn.disabled=true;try{await loginByCode();$('#loginPassword').value='';}catch(e){toast('เข้าสู่ระบบไม่สำเร็จ: '+e.message,'error');}finally{btn.disabled=false;}return;}
  const code=$('#loginCode').value.trim();
  const u=DB.employees.find(e=>e.code===code);
  if(!u){toast('รหัสผู้ใช้งานไม่ถูกต้อง','error');return;}
  session={empId:u.id,loginAt:new Date().toISOString()};
  localStorage.setItem(SESSKEY,JSON.stringify(session));
  if(DB.settings.email.alerts.login&&u.role!=='admin')sendAlert('login','[แจ้งเตือน] พนักงานล็อกอินเข้าระบบ','<p>พนักงาน <b>'+esc(u.name)+'</b> ล็อกอินเข้าระบบเมื่อ '+thDateTime(new Date().toISOString())+'</p>');
  enterApp();
}
function enterApp(){
  if(!enforceOperatingHours())return;
  $('#accessHoursLock')?.classList.add('hidden');
  const qrCustomer=new URLSearchParams(location.search).get('qr');
  if(qrCustomer){renderPublicQrReport(qrCustomer);return;}
  const documentId=new URLSearchParams(location.search).get('document');if(/^[a-f0-9]{64}$/.test(documentId||'')){location.replace('/document?id='+documentId+'&access=private');return;}
  $('#loginScreen').classList.add('hidden');
  $('#appShell').classList.remove('hidden');
  if(authIdentity)startRealtime();
  startAdminSchedule();
  refreshUserChip();
  const _m=DB.settings.db.mode;if(syncBlocked)setStatus('ข้อมูลรอส่ง · ต้องตรวจสอบก่อนบันทึก','err');else setStatus(_m==='supabase'?'พร้อมใช้งาน · ซิงก์เบื้องหลัง':'โหมดสาธิต','info');
  navigate(new URLSearchParams(location.search).has('approval')&&isAdmin()?'approvals':'dashboard');
}
$('#logoutBtn').addEventListener('click',()=>{lockRecovery();
  openModal(`<div class="modal-head"><h3><i data-lucide="log-out"></i> ยืนยันออกจากระบบ</h3><button class="x" onclick="closeModal()"><i data-lucide="x"></i></button></div>
  <div class="modal-body"><p>หากออกจากระบบแล้ว ระบบจะส่งอีเมลแจ้งเตือนไปหาแอดมิน และคุณจะต้องกรอกรหัสผู้ใช้งานอีกครั้งเพื่อเข้าใช้งาน ข้อมูลทั้งหมดที่บันทึกไว้จะยังคงอยู่ในระบบ</p></div>
  <div class="modal-foot"><button class="btn btn-ghost" onclick="closeModal()">ยกเลิก</button><button class="btn btn-danger" id="confirmLogout"><i data-lucide="log-out"></i> ยืนยันออกจากระบบ</button></div>`);
  $('#confirmLogout').addEventListener('click',async()=>{
    if(authIdentity){const pending=FreshySync.diff(remoteBase||{},FreshySync.shared(DB));if(pending.length&&!(await flushOnline())){toast('ยังมีข้อมูลรอส่ง กรุณาจัดการก่อนออกจากระบบ','error');return;}}
    if(authIdentity&&paymentQueue().some(c=>!c.failed)){toast('ยังมีรายการรับชำระรอยืนยัน กรุณารอการตรวจสอบก่อนออกจากระบบ','error');return;}
    const u=me();
    if(DB.settings.email.alerts.logout&&u&&u.role!=='admin')await sendAlert('logout','[แจ้งเตือน] พนักงานออกจากระบบ','<p>พนักงาน <b>'+esc(u.name)+'</b> ออกจากระบบเมื่อ '+thDateTime(new Date().toISOString())+'</p>');
    if(authIdentity){await flushOnline();if(realtimeChannel){try{await authFor(supaCfg()).removeChannel(realtimeChannel);}catch(e){}realtimeChannel=null;}await authFor(supaCfg()).auth.signOut();authIdentity=null;remoteBase=null;remoteRecorders=[];syncBlocked=false;}
    if(adminScheduleTimer)clearInterval(adminScheduleTimer);adminScheduleTimer=null;notificationHistory=[];syncIssues=[];session=null;localStorage.removeItem(SESSKEY);
    closeModal();$('#appShell').classList.add('hidden');$('#loginScreen').classList.remove('hidden');$('#loginCode').value='';
    toast('ออกจากระบบแล้ว','success');
  });
});
$('#menuToggle').addEventListener('click',()=>$('#sidebar').classList.toggle('open'));
$('#accessHoursRetry')?.addEventListener('click',async()=>{const b=$('#accessHoursRetry');b.disabled=true;try{await verifyOperatingAccess();}finally{b.disabled=false;}});
$('#accessHoursSwitch')?.addEventListener('click',()=>switchOperatingAccount().catch(e=>toast(e.message,'error')));
const mobileNavScrim=$('#mobileNavScrim');
if(mobileNavScrim)mobileNavScrim.addEventListener('click',()=>$('#sidebar').classList.remove('open'));

/* ============================================================
   REAL TIME SYNC (broadcast ทันที, polling สำรองทุก 15 วินาที)
   ============================================================ */
let lastDataHash='';
function dataHash(){return [DB.debtors.length,DB.cashsales.length,DB.audit.length,DB.customers.length].join('_');}
setInterval(()=>{
  if(!session)return;
  if(DB.settings.db.mode==='supabase')return;
  dbLoad();
  const h=dataHash();
  if(h!==lastDataHash){lastDataHash=h;renderPage();renderIcons();}
  // ถ้าโหมด Sheets จะดึงจาก /api/sheets ทุก 15 วินาที
},15000);
// Broadcast refreshes immediately; a visible-tab poll recovers missed events.
setInterval(()=>{if(authIdentity&&document.visibilityState==='visible')supabaseFetch();},15000);

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
  const btn=$('#themeToggle');if(btn){btn.innerHTML='<i data-lucide="'+(t==='dark'?'sun':'moon')+'"></i><span id="themeLabel" style="font-size:11px;margin-left:2px">'+(pref==='auto'?'อัตโนมัติ':t==='dark'?'มืด':'สว่าง')+'</span>';renderIcons();}
}
function cycleTheme(){localStorage.setItem(THEMEKEY,document.documentElement.dataset.theme==='dark'?'light':'dark');applyTheme();}
applyTheme();
if(window.matchMedia)window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change',applyTheme);
function setStatus(text,cls){const el=$('#modeTag');if(!el)return;el.className='status-tag '+(cls||'info');const t=$('#modeTagText');if(t)t.textContent=text;}
window.addEventListener('online',()=>{if(authIdentity)supabaseFetch();else setStatus(DB.settings.db.mode==='supabase'?'ออนไลน์ · กรุณาเข้าสู่ระบบ':'โหมดสาธิต','info');});
window.addEventListener('offline',()=>{safeCache();setStatus('ออฟไลน์ · เก็บรายการในเครื่องและส่งเมื่อเชื่อมต่อ','warn');});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){enforceOperatingHours();if(authIdentity)supabaseFetch();}});
window.addEventListener('pagehide',()=>{if(authIdentity)safeCache();});
if(!navigator.onLine)setStatus('ไม่มีการเชื่อมต่ออินเทอร์เน็ต','err');
if(DB.settings.db.mode==='supabase')setStatus('ออนไลน์ · กรุณาเข้าสู่ระบบ','info');
const notificationsBtn=$('#notificationsBtn');if(notificationsBtn)notificationsBtn.addEventListener('click',showNotifications);
const tbtn=$('#themeToggle');if(tbtn)tbtn.addEventListener('click',cycleTheme);
const syncBadge=$('#modeTag');if(syncBadge){syncBadge.title='แตะเพื่อซิงก์ฐานข้อมูล';syncBadge.style.cursor='pointer';syncBadge.addEventListener('click',()=>{if(!authIdentity){toast('กรุณาเข้าสู่ระบบออนไลน์ก่อน','error');return;}setStatus('กำลังซิงก์ฐานข้อมูล','warn');supabaseFetch().then(ok=>toast(ok?'อัปเดตข้อมูลจากฐานจริงแล้ว':'ฐานข้อมูลยังไม่ตอบสนอง',ok?'success':'error'));});}
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
if(_qr){openPublicQrReport(_qr);return;}
try{session=JSON.parse(localStorage.getItem(SESSKEY));}catch(e){session=null;}
if(window.FRESHY_PREVIEW)session={empId:'emp_admin',loginAt:new Date().toISOString()};
if(DB.settings.db.mode==='supabase'){session=null;configureLogin();resumeOnline();}else{configureLogin();if(session&&DB.employees.find(e=>e.id===session.empId))enterApp();}
renderIcons();
lastDataHash=dataHash();
bindCodeLogin();


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

