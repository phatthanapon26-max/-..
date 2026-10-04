'use strict';
const PDFDocument=require('pdfkit');
const path=require('path');const C=require('./_lib/core'),mail=require('./_lib/mail'),F=require('../features');

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
function emailHtml(business,period,date,s){
 const title='รายงานสรุปทะเบียนลูกหนี้ รอบ '+period+' น.';
 const card=(label,value,color)=>`<td style="width:50%;padding:8px"><div style="border:1px solid #dbe6f3;border-top:4px solid ${color};border-radius:12px;padding:16px;background:#fff"><div style="font-size:13px;color:#64748b">${label}</div><div style="font-size:24px;font-weight:800;color:#242820;margin-top:5px">${value}</div></div></td>`;
 return `<div style="font-family:Arial,'Noto Sans Thai',sans-serif;background:#f6f7f3;padding:24px;color:#242820"><div style="max-width:680px;margin:auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #d8e4f0"><div style="background:#187a43;color:#fff;padding:24px"><div style="font-size:22px;font-weight:800">${esc(business.name||'โรงน้ำดื่ม เฟรชชี่ วอเตอร์')}</div><div style="opacity:.88;margin-top:6px">${title} · วันที่ ${esc(date)}</div></div><div style="padding:16px"><p>เรียน ผู้บริหารและผู้เกี่ยวข้อง</p><p>ระบบได้จัดทำสรุปข้อมูลล่าสุดโดยอัตโนมัติ สามารถอ่านยอดสำคัญได้จากอีเมลนี้ทันที และมีรายงานฉบับ PDF แนบมาด้วย</p><table style="width:100%;border-collapse:collapse"><tr>${card('ยอดขายเงินสดวันนี้',money(s.cashTotal)+' บาท','#16a34a')}${card('ยอดลูกหนี้ใหม่วันนี้',money(s.debtTotal)+' บาท','#dc2626')}</tr><tr>${card('รับชำระวันนี้',money(s.paidTotal)+' บาท','#b76a00')}${card('ยอดค้างทั้งหมด',money(s.unpaidTotal)+' บาท','#bc3434')}</tr><tr>${card('จำนวนถังวันนี้',s.jugs+' ถัง','#c05a20')}${card('จำนวนแพ็ควันนี้',s.packs+' แพ็ค','#d97706')}</tr></table><div style="margin:16px 8px;padding:14px;background:#f8fafc;border-radius:10px;border-left:4px solid #187a43">รายการเงินสด ${s.cashCount} รายการ · ลูกหนี้ใหม่ ${s.debtCount} รายการ · รับชำระ ${s.paidCount} รายการ · ลูกหนี้คงค้าง ${s.unpaidCount} ราย</div><p style="font-size:12px;color:#64748b;border-top:1px solid #e2e8f0;padding-top:14px">รายงานนี้ส่งโดยระบบอัตโนมัติ Freshy Water กรุณาตรวจสอบรายละเอียดในระบบหากพบยอดผิดปกติ</p></div></div></div>`;
}
function pdfReport(business,period,date,s){return new Promise((resolve,reject)=>{
 const doc=new PDFDocument({size:'A4',margin:42,info:{Title:'Freshy Water Daily Report'}}),parts=[];
 doc.on('data',x=>parts.push(x));doc.on('end',()=>resolve(Buffer.concat(parts)));doc.on('error',reject);
 doc.registerFont('Thai',path.join(process.cwd(),'vendor/fonts/Sarabun-Regular.ttf')).registerFont('ThaiBold',path.join(process.cwd(),'vendor/fonts/Sarabun-Bold.ttf'));
 const title=business.name||'โรงน้ำดื่ม เฟรชชี่ วอเตอร์',ref='SUM'+date.replaceAll('-','')+'-'+period.replace(':','');
 const bits=date.split('-'),printedDate=bits.length===3?bits[2]+'/'+bits[1]+'/'+(Number(bits[0])+543):date;
 doc.fillColor('#000').font('ThaiBold').fontSize(19).text(title,42,34,{width:511,height:35,align:'center',ellipsis:true});
 doc.fontSize(14).text('รายงานสรุปทะเบียนลูกหนี้ รอบ '+period+' น.',42,74,{width:511,align:'center'});
 doc.font('Thai').fontSize(9).text([business.address,business.phone?'โทร. '+business.phone:''].filter(Boolean).join(' · '),42,101,{width:511,height:17,align:'center',ellipsis:true});
 doc.moveTo(42,126).lineTo(553,126).strokeColor('#111').stroke();
 doc.fontSize(10).text('วันที่รายงาน '+printedDate,42,139,{width:255}).text('เลขอ้างอิง '+ref,297,139,{width:256,align:'right'});
 const rows=[['ยอดขายเงินสดวันนี้',money(s.cashTotal)+' บาท'],['ยอดลูกหนี้ใหม่วันนี้',money(s.debtTotal)+' บาท'],['รับชำระวันนี้',money(s.paidTotal)+' บาท'],['ยอดค้างชำระทั้งหมด',money(s.unpaidTotal)+' บาท'],['ลูกหนี้คงค้าง',s.unpaidCount+' ราย'],['จำนวนถังวันนี้',s.jugs+' ถัง'],['จำนวนแพ็ควันนี้',s.packs+' แพ็ค']];
 let y=178;doc.rect(42,y,511,30).stroke();doc.moveTo(385,y).lineTo(385,y+30).stroke();
 doc.font('ThaiBold').fontSize(11).text('รายการ',55,y+7,{width:315}).text('จำนวน / ยอดรวม',398,y+7,{width:141,align:'right'});y+=30;
 for(const r of rows){doc.rect(42,y,511,39).stroke();doc.moveTo(385,y).lineTo(385,y+39).stroke();doc.font('Thai').fontSize(11).text(r[0],55,y+11,{width:315});doc.font('ThaiBold').text(r[1],398,y+11,{width:141,align:'right'});y+=39;}
 doc.font('Thai').fontSize(9).text('สรุปจากข้อมูลในฐานข้อมูล ณ รอบเวลารายงาน กรุณาตรวจสอบก่อนรับรองเอกสาร',42,500,{width:511});
 const roles=['ผู้จัดทำรายงาน','ผู้ตรวจสอบ','ผู้บริหาร'];roles.forEach((role,i)=>{const x=42+i*174;doc.moveTo(x,625).lineTo(x+163,625).stroke();doc.fontSize(10).text(role,x,637,{width:163,align:'center'});doc.fontSize(9).text('วันที่ ____ / ____ / ______',x,663,{width:163,align:'center'});});
 doc.moveTo(42,733).lineTo(553,733).stroke();doc.fontSize(8).text('เอกสารออกโดยระบบจัดการลูกหนี้ · '+title,42,743,{width:420,height:25,ellipsis:true}).text('หน้า 1 / 1',477,743,{width:76,align:'right'});
 doc.end();
});}

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
