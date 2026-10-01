'use strict';
const nodemailer=require('nodemailer');
const attempts=new Map();
const allowedTypes=new Set(['login','logout','addDebtor','undo','newcustomer','profile','report']);
async function jsonFetch(url,options){const r=await fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(10000)});let j;try{j=await r.json();}catch{throw Error('ผู้ให้บริการตอบกลับไม่ถูกต้อง');}if(!r.ok)throw Error(j.message||j.error_description||j.error||'HTTP '+r.status);return j;}
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='POST'){res.setHeader('Allow','POST');return res.status(405).json({ok:false,error:'ใช้ POST เท่านั้น'});}
 try{
  const {type,to,subject,html,project}=req.body||{};
  if(!project||!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(project.url)||typeof project.key!=='string')return res.status(400).json({ok:false,error:'ข้อมูลโครงการไม่ถูกต้อง'});
  if(process.env.SUPABASE_URL&&project.url!==process.env.SUPABASE_URL.replace(/\/$/,''))return res.status(403).json({ok:false,error:'โครงการไม่ตรงกับเซิร์ฟเวอร์'});
  const auth=req.headers.authorization;
  if(!auth||!auth.startsWith('Bearer '))return res.status(401).json({ok:false,error:'ต้องเข้าสู่ระบบก่อนส่งอีเมล'});
  const headers={apikey:project.key,Authorization:auth,'Content-Type':'application/json'};
  const user=await jsonFetch(project.url+'/auth/v1/user',{headers});
  if(!user.id||!user.email_confirmed_at)return res.status(401).json({ok:false,error:'บัญชียังไม่ได้ยืนยัน'});
  const payload=await jsonFetch(project.url+'/rest/v1/rpc/freshy_read',{method:'POST',headers,body:'{}'});
  const actor=payload.actor,em=payload.data?.settings?.email||{};
  if(!actor||!em.enabled)return res.status(403).json({ok:false,error:'ยังไม่เปิดส่งอีเมล'});
  if(!allowedTypes.has(type)||typeof subject!=='string'||subject.length>250||typeof html!=='string'||html.length>350000)return res.status(400).json({ok:false,error:'ข้อมูลอีเมลไม่ถูกต้อง'});
  const recipients=String(to||'').split(',').map(x=>x.trim()).filter(Boolean);
  if(!recipients.length||recipients.length>10||recipients.some(x=>!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(x)))return res.status(400).json({ok:false,error:'อีเมลผู้รับไม่ถูกต้อง'});
  if(actor.role!=='admin'&&(type==='report'||recipients.join(',').toLowerCase()!==String(em.adminEmail||'').toLowerCase()))return res.status(403).json({ok:false,error:'พนักงานส่งได้เฉพาะแจ้งเตือนถึงแอดมิน'});
  const now=Date.now(),key=project.url+':'+user.id;
  for(const [k,v] of attempts)if(now-v.start>60000)attempts.delete(k);
  const limit=attempts.get(key)||{start:now,count:0};if(++limit.count>20)return res.status(429).json({ok:false,error:'ส่งถี่เกินไป กรุณารอสักครู่'});attempts.set(key,limit);
  // Shared environment credentials are used only for a pinned server project.
  const pinned=!!process.env.SUPABASE_URL;
  const apiKey=em.apiKey||(pinned?process.env.RESEND_API_KEY:'');
  const from=em.fromEmail||(pinned?process.env.MAIL_FROM:'');
  if(em.provider==='resend'&&apiKey){
   if(!from)return res.status(400).json({ok:false,error:'ตั้งค่าอีเมลผู้ส่งบนโดเมนที่ยืนยันใน Resend ก่อน'});
   const data=await jsonFetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},body:JSON.stringify({from,to:recipients,subject,html})});
   if(!data.id)throw Error('ผู้ให้บริการไม่ได้ยืนยันการรับอีเมล');
   return res.json({ok:true,id:data.id});
  }
  if(em.provider==='smtp'){
   // SMTP configuration comes from trusted server environment, never arbitrary request hosts.
   const host=pinned?process.env.SMTP_HOST:null,userName=pinned?process.env.SMTP_USER:null,pass=pinned?process.env.SMTP_PASSWORD:null;
   if(!host||!userName||!pass)return res.status(400).json({ok:false,error:'SMTP ต้องตั้งค่า SUPABASE_URL, SMTP_HOST, SMTP_USER, SMTP_PASSWORD บนเซิร์ฟเวอร์'});
   const port=Number(process.env.SMTP_PORT||587);
   const transporter=nodemailer.createTransport({host,port,secure:port===465,requireTLS:port!==465,auth:{user:userName,pass},connectionTimeout:10000,socketTimeout:15000});
   const sent=await transporter.sendMail({from:from||userName,to:recipients,subject,html});
   if(!sent.accepted?.length)throw Error('SMTP ไม่รับผู้รับอีเมล');
   return res.json({ok:true,id:sent.messageId});
  }
  return res.status(400).json({ok:false,error:'ยังไม่มี API Key ที่ใช้ส่งได้ สำหรับพนักงานให้ตั้งค่า RESEND_API_KEY, MAIL_FROM และ SUPABASE_URL บนเซิร์ฟเวอร์'});
 }catch(e){return res.status(502).json({ok:false,error:String(e.message||e)});}
};
