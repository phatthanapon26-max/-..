'use strict';
const crypto=require('node:crypto');
const C=require('./_lib/core');
function validate(snapshot){
 if(!snapshot||snapshot.schema!==1||typeof snapshot.docNo!=='string'||snapshot.docNo.length>100||typeof snapshot.title!=='string'||snapshot.title.length>500||!Array.isArray(snapshot.tables)||snapshot.tables.length>2000||Buffer.byteLength(JSON.stringify(snapshot),'utf8')>2000000)throw new C.HttpError(400,'ข้อมูลเอกสารไม่ถูกต้อง');
 const text=v=>typeof v==='string'&&v.length<=12000;
 if(snapshot.tables.some(t=>!Array.isArray(t.headers)||t.headers.length>30||!t.headers.every(text)||!Array.isArray(t.rows)||t.rows.length>12000||t.rows.some(r=>!Array.isArray(r)||r.length>30||!r.every(text))))throw new C.HttpError(400,'ข้อมูลตารางไม่ถูกต้อง');
 // Accept plain document fields only. Never publish system settings, HTML, or credentials.
 const clean={schema:1,docNo:snapshot.docNo,title:snapshot.title,issuedAt:new Date().toISOString(),business:{},author:{},tables:snapshot.tables.map(t=>({title:String(t.title||'').slice(0,2000),headers:t.headers,rows:t.rows})),metadata:String(snapshot.metadata||'').slice(0,12000),summaries:[]};
 for(const k of ['name','address','phone','taxId'])clean.business[k]=String(snapshot.business?.[k]||'').slice(0,2000);
 for(const k of ['name','role'])clean.author[k]=String(snapshot.author?.[k]||'').slice(0,300);
 clean.summaries=(Array.isArray(snapshot.summaries)?snapshot.summaries:[]).slice(0,2000).map(v=>String(v).slice(0,12000));return clean;
}
module.exports=async(req,res)=>{C.noStore(res);res.setHeader('Referrer-Policy','no-referrer');try{
 if(req.method==='GET'){const id=String(req.query?.id||'');if(!/^[a-f0-9]{64}$/.test(id))throw new C.HttpError(404,'ไม่พบเอกสาร');let document;if(req.query?.access==='private'||!process.env.SUPABASE_SERVICE_ROLE_KEY){const payload=await C.authenticate(req);const row=(payload.data.sentEmails||[]).find(x=>x.id==='document:'+id&&x.type==='document'&&(payload.actor.role==='admin'||x.createdBy===payload.actor.id));document=row?.document;}else{document=(await C.storeRead('document:'+id))?.value;}if(!document)throw new C.HttpError(404,'ไม่พบเอกสารหรือไม่มีสิทธิ์อ่านเอกสารฉบับนี้');return res.json({ok:true,document});}
 if(req.method!=='POST')throw new C.HttpError(405,'ใช้ GET หรือ POST');const payload=await C.authenticate(req);if(payload.actor.role!=='admin'&&!payload.actor.permissions?.canPrint)throw new C.HttpError(403,'ไม่มีสิทธิ์ออกเอกสาร');
 const snapshot=validate(req.body?.snapshot);snapshot.author={name:payload.actor.name,role:payload.actor.role};
  const id=crypto.randomBytes(32).toString('hex');let access='public';if(process.env.SUPABASE_SERVICE_ROLE_KEY){await C.storeInsert('document:'+id,snapshot);}else{access='private';const row={id:'document:'+id,type:'document',createdBy:payload.actor.id,ts:snapshot.issuedAt,subject:snapshot.title,status:'ออกเอกสาร',document:snapshot};await C.json('/rest/v1/rpc/freshy_apply',{method:'POST',headers:{apikey:C.anon,Authorization:req.headers.authorization,'Content-Type':'application/json'},body:JSON.stringify({changes:[{collection:'sentEmails',id:row.id,expected:null,value:row}]})});}return res.json({ok:true,id,access});
 }catch(e){return C.fail(res,e);}};
module.exports.validate=validate;
