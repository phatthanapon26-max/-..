'use strict';
const crypto=require('node:crypto'),C=require('./core'),I=require('../../invoice'),S=require('../../sync');
module.exports=async(req,res)=>{C.noStore(res);try{
 const p=await C.authenticate(req,true);if(req.method!=='POST')throw new C.HttpError(405,'ใช้ POST');
 const body=req.body||{};if(Buffer.byteLength(JSON.stringify(body.invoice||{}),'utf8')>2000000)throw new C.HttpError(400,'ฉบับร่างมีขนาดใหญ่เกินไป');if(String(body.expectedRevision||'')!==String(p.data.settings?._resetRevision||''))throw new C.HttpError(409,'ข้อมูลเปลี่ยน กรุณาโหลดใหม่');
 if(body.operationId&&!/^[a-f0-9-]{36}$/.test(body.operationId))throw new C.HttpError(400,'รหัสคำขอไม่ถูกต้อง');
 const requestedId=body.id||(body.operationId?'invoice-draft:'+body.operationId:null);
 const old=requestedId?(p.data.sentEmails||[]).find(x=>x.id===requestedId&&x.type==='invoice-draft'):null;if(body.id&&!old)throw new C.HttpError(404,'ไม่พบฉบับร่าง');
 let invoice;try{invoice=I.normalize(body.invoice);}catch(e){throw new C.HttpError(400,e.message);}if(!invoice.customerName.trim()||!invoice.docNo.trim()||!invoice.items.length)throw new C.HttpError(400,'กรอกชื่อลูกค้า เลขที่เอกสาร และรายการสินค้า');
 const row={id:old?.id||requestedId||'invoice-draft:'+crypto.randomUUID(),type:'invoice-draft',createdBy:old?.createdBy||p.actor.id,createdAt:old?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString(),invoice};
 if(old&&!body.id&&body.operationId&&S.equal(old.invoice,invoice))return res.json({ok:true,payload:p,id:old.id});
 const expected=body.expected||null;if(old&&!S.equal(expected,old))throw new C.HttpError(409,'มีการแก้ไขฉบับร่างจากอุปกรณ์อื่น กรุณาเปิดใหม่');
 const payload=await C.json('/rest/v1/rpc/freshy_apply',{method:'POST',headers:{apikey:C.anon,Authorization:req.headers.authorization,'Content-Type':'application/json','x-freshy-revision':p.data.settings?._resetRevision||''},body:JSON.stringify({changes:[{collection:'sentEmails',id:row.id,expected:old,value:row}]})});
 return res.json({ok:true,payload,id:row.id});
 }catch(e){return C.fail(res,e);}};
