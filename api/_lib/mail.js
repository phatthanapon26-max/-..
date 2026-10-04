'use strict';
const nodemailer=require('nodemailer'),C=require('./core');
function recipientList(value){const list=[...new Set((Array.isArray(value)?value.join(','):String(value||'')).split(/[,;\n\r\uFF0C\uFF1B]+/).map(x=>x.trim().toLowerCase()).filter(Boolean))];if(!list.length||list.length>10||list.some(x=>!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(x)))throw new C.HttpError(400,'กรอกอีเมลผู้รับให้ถูกต้อง คั่นด้วยจุลภาค อัฒภาค หรือขึ้นบรรทัดใหม่ (ไม่เกิน 10 อีเมล)');return list;}
async function send(em,{to,subject,html,attachments=[],idempotencyKey}){
 const recipients=recipientList(Array.isArray(to)?to.join(','):to);
 if(em.provider==='gmail'||em.provider==='smtp'){
  const gmail=em.provider==='gmail',user=String(em.smtpUser||em.fromEmail||process.env.SMTP_USER||'').trim(),pass=gmail?String(em.smtpPass||process.env.GMAIL_APP_PASSWORD||'').replace(/\s/g,''):(em.smtpPass||em.apiKey||process.env.SMTP_PASSWORD);
  if(gmail&&(!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(user)||!/^[A-Za-z0-9]{16}$/.test(pass)))throw new C.HttpError(400,'กำหนดอีเมล Gmail ผู้ส่ง และ App Password 16 ตัวก่อน');
  const host=gmail?'smtp.gmail.com':(em.smtpHost||process.env.SMTP_HOST),port=gmail?465:Number(em.smtpPort||process.env.SMTP_PORT||587);if(!host||!user||!pass)throw new C.HttpError(503,'กรอก SMTP Host บัญชีผู้ส่ง และรหัสผ่านในหน้าตั้งค่าอีเมลก่อน');if(!Number.isInteger(port)||port<1||port>65535)throw new C.HttpError(400,'SMTP Port ไม่ถูกต้อง');
  const transport=nodemailer.createTransport({host,port,secure:port===465,requireTLS:port!==465,auth:{user,pass},connectionTimeout:7000,greetingTimeout:7000,socketTimeout:15000});
  try{const result=await transport.sendMail({from:gmail?user:em.fromEmail||user,to:recipients,subject,html,attachments});if(result.rejected?.length||result.accepted?.length!==recipients.length)throw new C.HttpError(502,'ผู้ให้บริการไม่รับอีเมลครบทุกผู้รับ');return {id:result.messageId};}finally{transport.close();}
 }
 const key=em.apiKey||process.env.RESEND_API_KEY,from=em.fromEmail||process.env.MAIL_FROM;if(!key||!from)throw new C.HttpError(400,'กำหนดผู้ให้บริการและบัญชีผู้ส่งก่อน');
 const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json',...(idempotencyKey?{'Idempotency-Key':idempotencyKey}:{})},body:JSON.stringify({from,to:recipients,subject,html,attachments:attachments.map(a=>({filename:a.filename,content:a.content.toString('base64')}))}),signal:AbortSignal.timeout(18000)}),data=await r.json();if(!r.ok||!data.id)throw new C.HttpError(502,data.message||'ผู้ให้บริการไม่ยืนยันรับอีเมล');return {id:data.id};
}
module.exports={send,recipientList};
