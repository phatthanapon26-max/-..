'use strict';
const C=require('./_lib/core');
const PAGE=25;
function summary(key,document,access){return {id:key.slice(9),docNo:document.docNo||'',title:document.title||'',issuedAt:document.issuedAt||'',author:document.author?.name||'',access};}
function compare(a,b){return b.issuedAt.localeCompare(a.issuedAt)||b.id.localeCompare(a.id);}
module.exports=async(req,res)=>{C.noStore(res);try{
 if(req.method!=='GET')throw new C.HttpError(405,'ใช้ GET');
 const payload=await C.authenticate(req,true),q=String(req.query?.q||'').trim().slice(0,150);
 let cursor=null;
 if(req.query?.cursor){try{cursor=JSON.parse(Buffer.from(String(req.query.cursor),'base64url').toString());}catch{throw new C.HttpError(400,'หน้าประวัติไม่ถูกต้อง');}if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(cursor?.issuedAt||'')||!/^[a-f0-9]{64}$/.test(cursor?.id||''))throw new C.HttpError(400,'หน้าประวัติไม่ถูกต้อง');}
 const legacy=(payload.data.sentEmails||[]).filter(r=>r.type==='document'&&/^document:[a-f0-9]{64}$/.test(r.id)&&r.document).map(r=>summary(r.id,r.document,'private'));
 let rows=[];
 if(process.env.SUPABASE_SERVICE_ROLE_KEY){
  const params=new URLSearchParams({select:'key,docNo:value->>docNo,title:value->>title,issuedAt:value->>issuedAt,author:value->author',key:'like.document:*',order:'value->>issuedAt.desc,key.desc',limit:String(PAGE+1)}),conditions=[];
  if(cursor)conditions.push('or(value->>issuedAt.lt.'+cursor.issuedAt+',and(value->>issuedAt.eq.'+cursor.issuedAt+',key.lt.document:'+cursor.id+'))');
  // Restrict PostgREST filter punctuation; all user text remains a literal search term.
  const term=q.replace(/[*,%()"\\.]/g,' ').trim();
  if(term)conditions.push('or(value->>docNo.ilike.*'+term+'*,value->>title.ilike.*'+term+'*,value->author->>name.ilike.*'+term+'*)');
  if(conditions.length)params.set('and','('+conditions.join(',')+')');
  const saved=await C.json('/rest/v1/freshy_store?'+params,{headers:C.serviceHeaders()});
  rows=saved.filter(r=>/^document:[a-f0-9]{64}$/.test(r.key)).map(r=>summary(r.key,r,'public'));
 }
 const query=q.toLocaleLowerCase('th');
 const privateRows=legacy.filter(r=>(!query||[r.docNo,r.title,r.author].join(' ').toLocaleLowerCase('th').includes(query))&&(!cursor||compare(r,cursor)>0));
 const combined=[...new Map([...rows,...privateRows].map(r=>[r.id,r])).values()].sort(compare),records=combined.slice(0,PAGE),last=records.at(-1);
 return res.json({ok:true,records,nextCursor:combined.length>PAGE?Buffer.from(JSON.stringify({issuedAt:last.issuedAt,id:last.id})).toString('base64url'):null});
 }catch(e){return C.fail(res,e);}};
