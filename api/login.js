'use strict';
const C=require('./_lib/core');const attempts=new Map();
module.exports=async(req,res)=>{C.noStore(res);try{
 if(req.method!=='POST')throw new C.HttpError(405,'ใช้ POST');const {code,password}=req.body||{};if(typeof code!=='string'||code.length>80||typeof password!=='string'||password.length>1024)throw new C.HttpError(400,'กรอกรหัสพนักงานและรหัสผ่าน');
 const key=String(req.headers['x-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0],now=Date.now();for(const [k,v]of attempts)if(now-v.start>600000)attempts.delete(k);const limit=attempts.get(key)||{start:now,count:0};attempts.set(key,limit);if(++limit.count>15)throw new C.HttpError(429,'กรุณารอสักครู่ก่อนลองใหม่');
 let email;if(code==='7716')email=C.config.adminEmail;else{const employees=(await C.storeRead('employees'))?.value||[];const matched=employees.filter(x=>x.code===code);if(matched.length===1)email=matched[0].email;}
 // Do not expose the account's email before a valid password proves ownership.
 if(!email)throw new C.HttpError(401,'รหัสพนักงานหรือรหัสผ่านไม่ถูกต้อง');let data;try{data=await C.json('/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:C.anon,'Content-Type':'application/json'},body:JSON.stringify({email,password})});}catch(e){if(e.status===400||e.status===401)throw new C.HttpError(401,'รหัสพนักงานหรือรหัสผ่านไม่ถูกต้อง');throw e;}return res.json({ok:true,access_token:data.access_token,refresh_token:data.refresh_token,email:data.user?.email});
 }catch(e){return C.fail(res,e);}};
