'use strict';
const crypto=require('node:crypto'),C=require('./_lib/core');
const COOKIE='freshy_debt_recovery',attempts=new Map();
function key(){if(!process.env.FRESHY_RECOVERY_SECRET)throw new C.HttpError(503,'ระบบกู้คืนยังไม่พร้อม กรุณาติดต่อผู้ดูแล');return crypto.createHash('sha256').update(process.env.FRESHY_RECOVERY_SECRET).digest();}
const hash=value=>crypto.createHash('sha256').update(value||'').digest('hex');
function signature(value){return crypto.createHmac('sha256',key()).update(value).digest('base64url');}
function cookie(res,value,age=300){res.setHeader('Set-Cookie',COOKIE+'='+value+'; HttpOnly; Secure; SameSite=Strict; Path=/api/debt-admin; Max-Age='+age);}
function sign(req,actor){const value=Buffer.from(JSON.stringify({id:actor.id,session:hash(req.headers.authorization),exp:Date.now()+300000})).toString('base64url');return value+'.'+signature(value);}
function requireUnlock(req,actor){try{const raw=String(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(COOKIE+'='))?.slice(COOKIE.length+1),[value,sig]=String(raw||'').split('.'),expected=signature(value),a=Buffer.from(sig||''),b=Buffer.from(expected);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))throw Error();const p=JSON.parse(Buffer.from(value,'base64url').toString());if(p.id!==actor.id||p.session!==hash(req.headers.authorization)||p.exp<=Date.now())throw Error();}catch{throw new C.HttpError(401,'กรุณายืนยันรหัสผ่านก่อนเข้าหน้ากู้คืน');}}
function seal(value,id){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key(),iv);cipher.setAAD(Buffer.from(id));const data=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return {v:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')};}
function unseal(value,id){try{const cipher=crypto.createDecipheriv('aes-256-gcm',key(),Buffer.from(value.iv,'base64'));cipher.setAAD(Buffer.from(id));cipher.setAuthTag(Buffer.from(value.tag,'base64'));return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.data,'base64')),cipher.final()]).toString());}catch{throw new C.HttpError(503,'อ่านข้อมูลสำรองไม่สำเร็จ ยังไม่มีการกู้คืนหรือเปลี่ยนยอด');}}
const equal=(a,b)=>{const sorted=v=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;return JSON.stringify(sorted(a))===JSON.stringify(sorted(b));};
async function apply(req,p,changes){return C.json('/rest/v1/rpc/freshy_apply',{method:'POST',headers:{apikey:C.anon,Authorization:req.headers.authorization,'Content-Type':'application/json','x-freshy-revision':p.data.settings?._resetRevision||''},body:JSON.stringify({changes})});}
function audit(p,action,detail){const row={id:crypto.randomUUID(),ts:new Date().toISOString(),userId:p.actor.id,userName:p.actor.name,action,detail};return {collection:'audit',id:row.id,expected:null,value:row};}
module.exports=async(req,res)=>{C.noStore(res);try{
 if(!['GET','POST'].includes(req.method))throw new C.HttpError(405,'ใช้ GET หรือ POST');
 if(req.method==='POST'&&req.headers.origin&&new URL(req.headers.origin).host!==(req.headers['x-forwarded-host']||req.headers.host))throw new C.HttpError(403,'คำขอข้ามเว็บไซต์ถูกปฏิเสธ');
 const p=await C.authenticate(req,true),body=req.body||{};
 if(req.method==='GET'){
  requireUnlock(req,p.actor);const records=(p.data.sentEmails||[]).filter(x=>x.type==='deleted-debt'&&x.status==='deleted').map(x=>{const d=unseal(x.encrypted,x.id);return {archiveId:x.id,record:d.record,deletedAt:x.ts,deletedBy:d.deletedBy,reason:d.reason};}).sort((a,b)=>b.deletedAt.localeCompare(a.deletedAt));return res.json({ok:true,records});
 }
 if(body.action==='lock'){cookie(res,'',0);return res.json({ok:true});}
 if(body.action==='unlock'){
  const id=p.actor.id,now=Date.now(),old=attempts.get(id);if(old?.until>now&&old.count>=5)throw new C.HttpError(429,'ลองรหัสผ่านหลายครั้ง กรุณารอ 5 นาที');
  if(typeof body.password!=='string'||!body.password||body.password.length>1024)throw new C.HttpError(400,'กรอกรหัสผ่านบัญชีแอดมิน');
  attempts.set(id,{count:old?.until>now?old.count+1:1,until:now+300000});
  let verified;try{const token=await C.json('/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:C.anon,'Content-Type':'application/json'},body:JSON.stringify({email:p.actor.email,password:body.password})});verified=await C.authenticate({headers:{authorization:'Bearer '+token.access_token}},true);}catch{throw new C.HttpError(401,'รหัสผ่านบัญชีแอดมินไม่ถูกต้อง');}
  if(verified.actor.id!==p.actor.id)throw new C.HttpError(403,'กรุณาใช้รหัสผ่านของบัญชีที่เข้าสู่ระบบ');
  attempts.delete(id);cookie(res,sign(req,p.actor));return res.json({ok:true,expiresIn:300});
 }
 if(String(body.expectedRevision||'')!==String(p.data.settings?._resetRevision||''))throw new C.HttpError(409,'ข้อมูลเปลี่ยนหลังล้างระบบ กรุณาโหลดใหม่');
 if(body.action==='restore'){
  requireUnlock(req,p.actor);const archive=(p.data.sentEmails||[]).find(x=>x.id===body.archiveId&&x.type==='deleted-debt');if(!archive)throw new C.HttpError(404,'ไม่พบรายการที่ลบ');
  if(archive.status==='restored')return res.json({ok:true,payload:p});
  const snapshot=unseal(archive.encrypted,archive.id),record=snapshot.record;
  if((p.data.debtors||[]).some(x=>x.id===record.id))throw new C.HttpError(409,'มีรายการรหัสนี้อยู่แล้ว ระบบไม่ได้เขียนทับ');
  const restored={...archive,status:'restored',restoredAt:new Date().toISOString(),restoredBy:p.actor.id};
  const payload=await apply(req,p,[{collection:'debtors',id:record.id,expected:null,value:record},{collection:'sentEmails',id:archive.id,expected:archive,value:restored},audit(p,'กู้คืนรายการลูกหนี้',record.id)]);return res.json({ok:true,payload});
 }
 if(!['edit','delete'].includes(body.action))throw new C.HttpError(400,'คำขอไม่ถูกต้อง');
 const record=(p.data.debtors||[]).find(x=>x.id===body.id);
 if(body.action==='delete'){
  if(!/^[a-zA-Z0-9-]{20,80}$/.test(body.operationId||''))throw new C.HttpError(400,'รหัสคำขอไม่ถูกต้อง');
  const archiveId='deleted-debt:'+body.operationId,existing=(p.data.sentEmails||[]).find(x=>x.id===archiveId);
  if(existing){if(existing.originalId!==body.id||existing.createdBy!==p.actor.id)throw new C.HttpError(409,'รหัสคำขอซ้ำ');return res.json({ok:true,payload:p});}
  if(!record)throw new C.HttpError(404,'ไม่พบรายการลูกหนี้');
  if(!equal(body.expected,record))throw new C.HttpError(409,'รายการถูกแก้ไขจากอุปกรณ์อื่น กรุณาเปิดใหม่');
  const reason=String(body.reason||'').trim().slice(0,2000);if(!reason)throw new C.HttpError(400,'กรอกเหตุผลที่ลบ');
  const archive={id:archiveId,type:'deleted-debt',createdBy:p.actor.id,ts:new Date().toISOString(),status:'deleted',originalId:record.id,encrypted:seal({record,reason,deletedBy:p.actor.name},archiveId)};
  const payload=await apply(req,p,[{collection:'sentEmails',id:archive.id,expected:null,value:archive},{collection:'debtors',id:record.id,expected:record,value:null},audit(p,'ลบรายการลูกหนี้',record.id)]);return res.json({ok:true,payload});
 }
 if(!record)throw new C.HttpError(404,'ไม่พบรายการลูกหนี้');if(!equal(body.expected,record))throw new C.HttpError(409,'รายการถูกแก้ไขจากอุปกรณ์อื่น กรุณาเปิดใหม่');
 const patch=body.patch||{},date=String(patch.debtDate||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw new C.HttpError(400,'วันที่ค้างไม่ถูกต้อง');
 for(const k of ['jugs','packs','jugAmount','packAmount'])if(typeof patch[k]!=='number'||!Number.isFinite(patch[k])||patch[k]<0||patch[k]>1e9||(['jugs','packs'].includes(k)&&!Number.isInteger(patch[k])))throw new C.HttpError(400,'จำนวนและยอดเงินต้องไม่ติดลบ ถังและแพ็คต้องเป็นจำนวนเต็ม');
 if(patch.jugs+patch.packs===0)throw new C.HttpError(400,'กรอกจำนวนถังหรือแพ็ค');
 const next={...record,debtDate:date,jugs:patch.jugs,packs:patch.packs,jugAmount:patch.jugAmount,packAmount:patch.packAmount,total:Math.round((patch.jugAmount+patch.packAmount)*100)/100};
 if(patch.customerId&&patch.customerId!==record.customerId){const customer=(p.data.customers||[]).find(x=>x.id===patch.customerId);if(!customer)throw new C.HttpError(400,'ไม่พบลูกค้าที่เลือก');Object.assign(next,{customerId:customer.id,customerName:customer.name,area:customer.area,moo:customer.moo||'',village:customer.village||'',villageId:customer.villageId||'',villageCode:customer.villageCode||''});}
 const payload=await apply(req,p,[{collection:'debtors',id:record.id,expected:record,value:next},audit(p,'แก้ไขรายการลูกหนี้',record.id)]);return res.json({ok:true,payload});
 }catch(e){return C.fail(res,e);}};
module.exports.seal=seal;module.exports.unseal=unseal;
