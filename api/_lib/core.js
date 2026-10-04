'use strict';
const fs=require('node:fs'),vm=require('node:vm');
const context={window:{}};vm.runInNewContext(fs.readFileSync(require.resolve('../../deploy-config.js'),'utf8'),context);
const config=context.window.FRESHY_CONFIG;
const url=String(process.env.SUPABASE_URL||config.supabaseUrl).replace(/\/$/,'');
const anon=process.env.SUPABASE_ANON_KEY||config.supabaseKey;
class HttpError extends Error{constructor(status,message){super(message);this.status=status;}}
async function json(path,options={}){const r=await fetch(url+path,{...options,redirect:'error',signal:AbortSignal.timeout(16000)});let data;try{data=await r.json();}catch{throw new HttpError(502,'ฐานข้อมูลตอบกลับไม่ถูกต้อง');}if(!r.ok)throw new HttpError(r.status>=500?502:r.status,data.message||data.error_description||data.error||'ฐานข้อมูลปฏิเสธคำขอ');return data;}
function serviceHeaders(){const key=process.env.SUPABASE_SERVICE_ROLE_KEY;if(!key)throw new HttpError(503,'ต้องตั้งค่า SUPABASE_SERVICE_ROLE_KEY ที่เซิร์ฟเวอร์เพื่อใช้เอกสาร QR และงานอัตโนมัติ');return {apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'};}
async function authenticate(req,admin=false){const authorization=req.headers.authorization;if(!/^Bearer [A-Za-z0-9._-]+$/.test(authorization||''))throw new HttpError(401,'กรุณาเข้าสู่ระบบ');const headers={apikey:anon,Authorization:authorization,'Content-Type':'application/json'};const payload=await json('/rest/v1/rpc/freshy_read',{method:'POST',headers,body:'{}'});if(!payload?.actor||!payload.data)throw new HttpError(403,'ไม่พบสิทธิ์ผู้ใช้');if(admin&&payload.actor.role!=='admin')throw new HttpError(403,'เฉพาะแอดมินเท่านั้น');return payload;}
async function storeRead(key){const rows=await json('/rest/v1/freshy_store?select=key,value,updated_at&key=eq.'+encodeURIComponent(key),{headers:serviceHeaders()});return rows[0]||null;}
async function storeInsert(key,value){return json('/rest/v1/freshy_store',{method:'POST',headers:{...serviceHeaders(),Prefer:'return=representation'},body:JSON.stringify({key,value})});}
async function storeCAS(row,value){const result=await json('/rest/v1/freshy_store?key=eq.'+encodeURIComponent(row.key)+'&updated_at=eq.'+encodeURIComponent(row.updated_at),{method:'PATCH',headers:{...serviceHeaders(),Prefer:'return=representation'},body:JSON.stringify({value,updated_at:new Date().toISOString()})});return result.length>0;}
function fail(res,error){return res.status(error.status||502).json({ok:false,error:error.message||'ดำเนินการไม่สำเร็จ'});}
function noStore(res){res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');}
module.exports={config,url,anon,json,HttpError,serviceHeaders,authenticate,storeRead,storeInsert,storeCAS,fail,noStore};
