'use strict';
const report=require('./_lib/document-report');const C=require('./_lib/core'),mail=require('./_lib/mail'),F=require('../features');

function thaiNow(){return new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Bangkok'}));}
function isoDate(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function money(v){return Number(v||0).toLocaleString('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2});}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function getJson(url,options){const r=await fetch(url,{...options,signal:AbortSignal.timeout(20000)});let j;try{j=await r.json();}catch{throw Error('ฐานข้อมูลตอบกลับไม่ถูกต้อง');}if(!r.ok)throw Error(j.message||j.error||'HTTP '+r.status);return j;}
function summarize(data,date){
 const cash=(data.cashsales||[]).filter(x=>x.deliveryDate===date);
 const debts=(data.debtors||[]).filter(x=>x.debtDate===date);
 const unpaid=(data.debtors||[]).filter(x=>x.status==='unpaid');
 const paidToday=(data.debtors||[]).filter(x=>x.status==='paid'&&x.paidAt&&F.bangkokParts(new Date(x.paidAt)).date===date);
 const total=a=>a.reduce((s,x)=>s+Number(x.total??Number(x.jugAmount||0)+Number(x.packAmount||0)),0);
 return {cashCount:cash.length,cashTotal:total(cash),debtCount:debts.length,debtTotal:total(debts),paidCount:paidToday.length,paidTotal:total(paidToday),unpaidCount:new Set(unpaid.map(x=>x.customerId||x.customerName)).size,unpaidTotal:total(unpaid),jugs:cash.concat(debts).reduce((s,x)=>s+Number(x.jugs||0),0),packs:cash.concat(debts).reduce((s,x)=>s+Number(x.packs||0),0),cash,debts};
}
function reportSnapshot(business,period,date,s){
 const bits=date.split('-'),printed=bits[2]+'/'+bits[1]+'/'+(Number(bits[0])+543),ref='SUM'+date.replaceAll('-','')+'-'+period.replace(':','');
 return {schema:1,docNo:ref,title:'รายงานสรุปลูกหนี้และการส่งน้ำประจำวัน',business,author:{name:'ระบบรายงานอัตโนมัติ',role:'system'},issuedAt:new Date().toISOString(),metadata:'วันที่รายงาน '+printed+' · รอบเวลา '+period+' น.',tables:[{title:'สรุปผลการดำเนินงาน',headers:['รายการ','จำนวน / ยอดรวม'],widths:[67,33],alignments:['left','right'],rows:[['ยอดขายเงินสดประจำวัน',money(s.cashTotal)+' บาท'],['ยอดลูกหนี้ใหม่ประจำวัน',money(s.debtTotal)+' บาท'],['ยอดรับชำระประจำวัน',money(s.paidTotal)+' บาท'],['ยอดค้างชำระทั้งหมด',money(s.unpaidTotal)+' บาท'],['ลูกหนี้คงค้าง',s.unpaidCount+' ราย'],['จำนวนถังที่ส่งประจำวัน',s.jugs+' ถัง'],['จำนวนแพ็คที่ส่งประจำวัน',s.packs+' แพ็ค']]}],summaries:['รายการเงินสด '+s.cashCount+' รายการ · ลูกหนี้ใหม่ '+s.debtCount+' รายการ · รับชำระ '+s.paidCount+' รายการ'],signatures:[{name:'',role:'ผู้จัดทำรายงาน'},{name:'',role:'ผู้ตรวจสอบ'},{name:'',role:'ผู้บริหาร'}]};
}
function emailHtml(business,period,date,s){const d=reportSnapshot(business,period,date,s);return report.notificationHtml(d).replace('<p>จึงเรียนมา', '<table style="width:100%;border-collapse:collapse">'+d.tables[0].rows.map(r=>'<tr><td style="border:1px solid #333;padding:8px">'+esc(r[0])+'</td><td style="border:1px solid #333;padding:8px;text-align:right">'+esc(r[1])+'</td></tr>').join('')+'</table><p>จึงเรียนมา');}
function pdfReport(business,period,date,s){return report.pdfDocument(reportSnapshot(business,period,date,s));}

module.exports=async(req,res)=>{
 C.noStore(res);try{
  if(!['GET','POST'].includes(req.method))throw new C.HttpError(405,'ใช้ GET หรือ POST');
  const cron=!!process.env.CRON_SECRET&&req.headers.authorization==='Bearer '+process.env.CRON_SECRET;
  if(req.method==='GET'&&!cron)throw new C.HttpError(401,'Unauthorized');
  let data;if(cron){const rows=await C.json('/rest/v1/freshy_store?select=key,value&key=in.(settings,cashsales,debtors)',{headers:C.serviceHeaders()});data=Object.fromEntries(rows.map(x=>[x.key,x.value]));}else data=(await C.authenticate(req,true)).data;
  const settings=data.settings||{},em=settings.email||{};if(!em.enabled||!em.reportsEnabled)return res.json({ok:true,skipped:'disabled'});
  const now=F.bangkokParts(),current=Number(now.time.slice(0,2))*60+Number(now.time.slice(3)),times=F.scheduleTimes(em.reportTimes||['08:00','18:00']);
  const due=times.filter(time=>{const minutes=Number(time.slice(0,2))*60+Number(time.slice(3));return current>=minutes&&current-minutes<=119;});if(!due.length)return res.json({ok:true,skipped:'not-due'});
  C.serviceHeaders();let sentCount=0;const summary=summarize(data,now.date);
  for(const time of due){
   const key='mailjob:'+now.date+':'+time,lease={status:'sending',startedAt:new Date().toISOString(),leaseUntil:Date.now()+600000};let row=await C.storeRead(key);
   if(row){if(row.value.status==='sent'||row.value.leaseUntil>Date.now())continue;if(!(await C.storeCAS(row,lease)))continue;}
   else{try{await C.storeInsert(key,lease);}catch(e){if(e.status===409)continue;throw e;}}
   try{const html=emailHtml(settings.business||{},time,now.date,summary),pdf=await pdfReport(settings.business||{},time,now.date,summary);const result=await mail.send(em,{to:em.adminEmail||process.env.REPORT_TO,subject:'[รายงานทะเบียนลูกหนี้] '+(settings.business?.name||'Freshy Water')+' '+now.date+' '+time,html,attachments:[{filename:'freshy-report-'+now.date+'-'+time.replace(':','')+'.pdf',content:pdf}],idempotencyKey:key});row=await C.storeRead(key);if(!row||!(await C.storeCAS(row,{status:'sent',sentAt:new Date().toISOString(),providerId:result.id})))throw new C.HttpError(502,'ส่งแล้วแต่บันทึกสถานะไม่ได้ โปรดตรวจผู้รับ');sentCount++;}
   catch(e){row=await C.storeRead(key);if(row&&row.value.status!=='sent')await C.storeCAS(row,{...row.value,status:'failed',error:e.message});throw e;}
  }
  return res.json({ok:true,sentCount,date:now.date});
 }catch(e){return C.fail(res,e);}
};
module.exports.summarize=summarize;
module.exports.pdfReport=pdfReport;

