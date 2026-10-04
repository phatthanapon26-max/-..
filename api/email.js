'use strict';
const C=require('./_lib/core'),mail=require('./_lib/mail');const attempts=new Map();const types=new Set(['login','logout','addDebtor','undo','newcustomer','profile','report','payment','cash']);
module.exports=async(req,res)=>{C.noStore(res);try{if(req.method!=='POST')throw new C.HttpError(405,'ใช้ POST');const payload=await C.authenticate(req),actor=payload.actor;let em=payload.data.settings?.email||{};if(!em.enabled)throw new C.HttpError(403,'ยังไม่เปิดส่งอีเมล');const {type,to,subject,html}=req.body||{};
 if(!types.has(type)||typeof subject!=='string'||subject.length>250||typeof html!=='string'||html.length>1800000)throw new C.HttpError(400,'ข้อมูลอีเมลไม่ถูกต้อง');const recipients=mail.recipientList(to);const alertKey={undo:'undoRequest'}[type]||type;if(type!=='report'&&em.alerts?.[alertKey]===false)throw new C.HttpError(403,'ปิดแจ้งเตือนประเภทนี้อยู่');
 if(actor.role!=='admin'){if(type==='report'&&!actor.permissions?.canEmail)throw new C.HttpError(403,'ไม่มีสิทธิ์ส่งรายงาน');if(type!=='report'&&recipients.map(x=>x.toLowerCase()).join(',')!==mail.recipientList(em.adminEmail).map(x=>x.toLowerCase()).join(','))throw new C.HttpError(403,'แจ้งเตือนได้เฉพาะอีเมลแอดมิน');em=(await C.storeRead('settings'))?.value?.email||em;}
 const now=Date.now();for(const [key,v]of attempts)if(now-v.start>60000)attempts.delete(key);const limit=attempts.get(actor.id)||{start:now,count:0};attempts.set(actor.id,limit);if(++limit.count>30)throw new C.HttpError(429,'ส่งถี่เกินไป กรุณารอสักครู่');let body=html,attachments=[];
 if(req.body.format==='formal'){
  if(type!=='report')throw new C.HttpError(400,'รูปแบบ PDF ใช้กับรายงานเท่านั้น');
  const d=require('./document').validate(req.body.snapshot);d.business={...payload.data.settings.business};d.author={name:actor.name,role:actor.role};if(d.signatures.length)d.signatures[0].name=actor.name;
  const report=require('./_lib/document-report');const pdf=await report.pdfDocument(d);if(pdf.length>15000000)throw new C.HttpError(413,'ไฟล์รายงานใหญ่เกินไป กรุณาแยกส่งเป็นรายงานย่อย');body=report.notificationHtml(d);attachments=[{filename:d.docNo.replace(/[^A-Za-z0-9_-]/g,'_')+'.pdf',content:pdf,contentType:'application/pdf'}];
 }
 const sent=await mail.send(em,{to:recipients,subject,html:body,attachments});return res.json({ok:true,id:sent.id,attachedPdf:attachments.length>0});
 }catch(e){return C.fail(res,e);}};
