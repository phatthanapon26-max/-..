'use strict';
const PDFDocument=require('pdfkit');
const path=require('path');

function thaiNow(){return new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Bangkok'}));}
function isoDate(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function money(v){return Number(v||0).toLocaleString('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2});}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function getJson(url,options){const r=await fetch(url,{...options,signal:AbortSignal.timeout(20000)});let j;try{j=await r.json();}catch{throw Error('ฐานข้อมูลตอบกลับไม่ถูกต้อง');}if(!r.ok)throw Error(j.message||j.error||'HTTP '+r.status);return j;}
function summarize(data,date){
 const cash=(data.cashsales||[]).filter(x=>x.deliveryDate===date);
 const debts=(data.debtors||[]).filter(x=>x.debtDate===date);
 const unpaid=(data.debtors||[]).filter(x=>x.status==='unpaid');
 const paidToday=(data.debtors||[]).filter(x=>x.status==='paid'&&String(x.paidAt||'').slice(0,10)===date);
 const total=a=>a.reduce((s,x)=>s+Number(x.total??Number(x.jugAmount||0)+Number(x.packAmount||0)),0);
 return {cashCount:cash.length,cashTotal:total(cash),debtCount:debts.length,debtTotal:total(debts),paidCount:paidToday.length,paidTotal:total(paidToday),unpaidCount:new Set(unpaid.map(x=>x.customerId||x.customerName)).size,unpaidTotal:total(unpaid),jugs:cash.concat(debts).reduce((s,x)=>s+Number(x.jugs||0),0),packs:cash.concat(debts).reduce((s,x)=>s+Number(x.packs||0),0),cash,debts};
}
function emailHtml(business,period,date,s){
 const title=period==='morning'?'รายงานสรุปรอบเช้า 08:00 น.':'รายงานสรุปประจำวันรอบเย็น 18:00 น.';
 const card=(label,value,color)=>`<td style="width:50%;padding:8px"><div style="border:1px solid #dbe6f3;border-top:4px solid ${color};border-radius:12px;padding:16px;background:#fff"><div style="font-size:13px;color:#64748b">${label}</div><div style="font-size:24px;font-weight:800;color:#102a43;margin-top:5px">${value}</div></div></td>`;
 return `<div style="font-family:Arial,'Noto Sans Thai',sans-serif;background:#f2f7fc;padding:24px;color:#18324c"><div style="max-width:680px;margin:auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #d8e4f0"><div style="background:linear-gradient(135deg,#0b315c,#1469a8);color:#fff;padding:24px"><div style="font-size:22px;font-weight:800">${esc(business.name||'โรงน้ำดื่ม เฟรชชี่ วอเตอร์')}</div><div style="opacity:.88;margin-top:6px">${title} · วันที่ ${esc(date)}</div></div><div style="padding:16px"><p>เรียน ผู้บริหารและผู้เกี่ยวข้อง</p><p>ระบบได้จัดทำสรุปข้อมูลล่าสุดโดยอัตโนมัติ สามารถอ่านยอดสำคัญได้จากอีเมลนี้ทันที และมีรายงานฉบับ PDF แนบมาด้วย</p><table style="width:100%;border-collapse:collapse"><tr>${card('ยอดขายเงินสดวันนี้',money(s.cashTotal)+' บาท','#16a34a')}${card('ยอดลูกหนี้ใหม่วันนี้',money(s.debtTotal)+' บาท','#dc2626')}</tr><tr>${card('รับชำระวันนี้',money(s.paidTotal)+' บาท','#2563eb')}${card('ยอดค้างทั้งหมด',money(s.unpaidTotal)+' บาท','#7c3aed')}</tr><tr>${card('จำนวนถังวันนี้',s.jugs+' ถัง','#0891b2')}${card('จำนวนแพ็ควันนี้',s.packs+' แพ็ค','#d97706')}</tr></table><div style="margin:16px 8px;padding:14px;background:#f8fafc;border-radius:10px;border-left:4px solid #0b5c97">รายการเงินสด ${s.cashCount} รายการ · ลูกหนี้ใหม่ ${s.debtCount} รายการ · รับชำระ ${s.paidCount} รายการ · ลูกหนี้คงค้าง ${s.unpaidCount} ราย</div><p style="font-size:12px;color:#64748b;border-top:1px solid #e2e8f0;padding-top:14px">รายงานนี้ส่งโดยระบบอัตโนมัติ Freshy Water กรุณาตรวจสอบรายละเอียดในระบบหากพบยอดผิดปกติ</p></div></div></div>`;
}
function pdfReport(business,period,date,s){return new Promise((resolve,reject)=>{
 const doc=new PDFDocument({size:'A4',margin:42,info:{Title:'Freshy Water Daily Report'}}),parts=[];
 doc.on('data',x=>parts.push(x));doc.on('end',()=>resolve(Buffer.concat(parts)));doc.on('error',reject);
 const thai=path.join(process.cwd(),'vendor/fonts/Sarabun-Regular.ttf');
 const thaiBold=path.join(process.cwd(),'vendor/fonts/Sarabun-Bold.ttf');
 doc.registerFont('Thai',thai).registerFont('ThaiBold',thaiBold);
 doc.rect(0,0,595,115).fill('#0b315c');doc.fillColor('#fff').font('ThaiBold').fontSize(21).text(business.name||'โรงน้ำดื่ม เฟรชชี่ วอเตอร์',42,34,{align:'center'});
 doc.fontSize(15).text(period==='morning'?'รายงานสรุปรอบเช้า':'รายงานสรุปประจำวันรอบเย็น',42,68,{align:'center'});
 doc.fillColor('#18324c').font('Thai').fontSize(12).text('วันที่รายงาน '+date,42,136);
 const rows=[['ยอดขายเงินสดวันนี้',money(s.cashTotal)+' บาท'],['ยอดลูกหนี้ใหม่วันนี้',money(s.debtTotal)+' บาท'],['รับชำระวันนี้',money(s.paidTotal)+' บาท'],['ยอดค้างชำระทั้งหมด',money(s.unpaidTotal)+' บาท'],['ลูกหนี้คงค้าง',s.unpaidCount+' ราย'],['จำนวนถังวันนี้',s.jugs+' ถัง'],['จำนวนแพ็ควันนี้',s.packs+' แพ็ค']];
 let y=180;rows.forEach((r,i)=>{doc.roundedRect(42,y,511,42,6).fill(i%2?'#f7fafc':'#edf5fb');doc.fillColor('#18324c').font('ThaiBold').fontSize(12).text(r[0],58,y+13);doc.fontSize(13).text(r[1],330,y+12,{width:205,align:'right'});y+=48;});
 doc.moveTo(42,545).lineTo(553,545).strokeColor('#9fb3c8').stroke();doc.fillColor('#52667a').font('Thai').fontSize(10).text('เอกสารออกโดยระบบจัดการลูกหนี้โรงน้ำดื่ม เฟรชชี่ วอเตอร์',42,560,{align:'center'});
 doc.end();
});}

module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 try{
  if(req.method!=='GET'&&req.method!=='POST')return res.status(405).json({ok:false,error:'Method not allowed'});
  if(!process.env.CRON_SECRET||req.headers.authorization!=='Bearer '+process.env.CRON_SECRET)return res.status(401).json({ok:false,error:'Unauthorized'});
  const base=String(process.env.SUPABASE_URL||'').replace(/\/$/,'');const service=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!base||!service||!process.env.RESEND_API_KEY||!process.env.MAIL_FROM)return res.status(503).json({ok:false,error:'Missing server report configuration'});
  const headers={apikey:service,Authorization:'Bearer '+service};
  const rows=await getJson(base+'/rest/v1/freshy_store?select=key,value&key=in.(settings,cashsales,debtors)',{headers});
  const data=Object.fromEntries(rows.map(x=>[x.key,x.value]));const settings=data.settings||{},recipient=process.env.REPORT_TO||settings.email?.adminEmail;
  if(!recipient)return res.status(503).json({ok:false,error:'Missing report recipient'});
  const now=thaiNow(),date=isoDate(now),period=now.getHours()<12?'morning':'evening',summary=summarize(data,date),html=emailHtml(settings.business||{},period,date,summary),pdf=await pdfReport(settings.business||{},period,date,summary);
  const subject=(period==='morning'?'[สรุปรอบเช้า] ':'[สรุปประจำวัน] ')+(settings.business?.name||'Freshy Water')+' '+date;
  const sent=await getJson('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.MAIL_FROM,to:[recipient],subject,html,attachments:[{filename:'freshy-water-report-'+date+'.pdf',content:pdf.toString('base64')} ]})});
  return res.json({ok:true,id:sent.id,period,date,recipient});
 }catch(e){return res.status(502).json({ok:false,error:String(e.message||e)});}
};
