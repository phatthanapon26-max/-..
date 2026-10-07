// Server-only account setup. Supabase injects its privileged key; never return it.
const attempts=new Map();
export async function handler(req,env,net=fetch){
 const headers={'Content-Type':'application/json','Cache-Control':'no-store'};
 const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers});
 try{
  if(req.method!=='POST')return reply(405,{ok:false,error:'ใช้ POST'});
  const body=await req.json(),url=env('SUPABASE_URL'),anon=env('SUPABASE_ANON_KEY'),secret=env('SUPABASE_SERVICE_ROLE_KEY');
  const authorization=req.headers.get('x-freshy-authorization')||req.headers.get('authorization')||'';
  const call=async(path,data,privileged=false,method='POST')=>{
   const key=privileged?secret:anon;
   const r=await net(url+path,{method,headers:{apikey:key,Authorization:privileged?'Bearer '+key:authorization,'Content-Type':'application/json'},body:method==='GET'?undefined:JSON.stringify(data),signal:AbortSignal.timeout(16000)});
   const j=await r.json();if(!r.ok){const e=new Error(j.message||j.error_description||j.msg||j.error||'ดำเนินการไม่สำเร็จ');e.status=r.status;throw e;}return j;
  };
  if(body.action==='login'){
   const code=typeof body.code==='string'?body.code.trim():'',password=body.password;
   if(!code||code.length>80||typeof password!=='string'||password.length>1024)return reply(401,{ok:false,error:'รหัสพนักงานหรือรหัสผ่านไม่ถูกต้อง'});
   const ip=(req.headers.get('x-forwarded-for')||'unknown')+'|'+code,now=Date.now();for(const[k,v]of attempts)if(now-v.start>600000)attempts.delete(k);const count=attempts.get(ip)||{start:now,count:0};attempts.set(ip,count);if(++count.count>15)return reply(429,{ok:false,error:'กรุณารอสักครู่ก่อนลองใหม่'});
   const rows=await call('/rest/v1/freshy_store?select=value&key=eq.employees',null,true,'GET');
   const found=(rows[0]?.value||[]).filter(e=>e.code===code&&!['pending','inactive','disabled'].includes(e.status));
   if(found.length!==1||!found[0].email)return reply(401,{ok:false,error:'รหัสพนักงานหรือรหัสผ่านไม่ถูกต้อง'});
   let token;try{token=await call('/auth/v1/token?grant_type=password',{email:found[0].email,password});}catch{return reply(401,{ok:false,error:'รหัสพนักงานหรือรหัสผ่านไม่ถูกต้อง'});}
   const check=await net(url+'/rest/v1/rpc/freshy_read',{method:'POST',headers:{apikey:anon,Authorization:'Bearer '+token.access_token,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(16000)});
   if(!check.ok)return reply(401,{ok:false,error:'บัญชีถูกปิดใช้งาน กรุณาติดต่อแอดมิน'});
   return reply(200,{ok:true,access_token:token.access_token,refresh_token:token.refresh_token,email:token.user?.email});
  }
  // This RPC verifies the actual user, confirmed identity and current factory membership.
  const p=await call('/rest/v1/rpc/freshy_read',{});
  if(!p.actor||!p.data)return reply(403,{ok:false,error:'ไม่พบสิทธิ์ผู้ใช้'});
  if(body.action==='village'){
   const name=typeof body.name==='string'?body.name.trim():'';
   if(!name||name.length>160)return reply(400,{ok:false,error:'ชื่อหมู่บ้านไม่ถูกต้อง'});
   const pages=p.actor.permissions?.pages||{};
   if(p.actor.role!=='admin'&&!['debtorsNai','debtorsOther','customersNai','customersOther','cashsales'].some(k=>pages[k]))return reply(403,{ok:false,error:'ไม่มีสิทธิ์เพิ่มข้อมูล'});
   for(let i=0;i<5;i++){
    const settingsRows=await call('/rest/v1/freshy_store?select=value&key=eq.settings',null,true,'GET');
    if(String(settingsRows[0]?.value?._resetRevision||'')!==String(p.data.settings?._resetRevision||''))return reply(409,{ok:false,error:'แอดมินล้างข้อมูลแล้ว กรุณาโหลดข้อมูลใหม่'});
    const rows=await call('/rest/v1/freshy_store?select=key,value,updated_at&key=eq.villages',null,true,'GET'),row=rows[0];
    if(!row){try{await call('/rest/v1/freshy_store',{key:'villages',value:[]},true);}catch(e){if(e.status!==409)throw e;}continue;}
    const list=row.value||[],old=list.find(v=>v.name?.trim()===name);
    if(old?.code)return reply(200,{ok:true,village:old});
    let code=1;const used=new Set(list.map(v=>v.code));while(used.has('V'+String(code).padStart(3,'0')))code++;
    const village={...(old||{id:crypto.randomUUID(),name,createdBy:p.actor.id}),code:'V'+String(code).padStart(3,'0')};
    const next=old?list.map(v=>v.id===old.id?village:v):[...list,village];
    const r=await net(url+'/rest/v1/freshy_store?key=eq.villages&updated_at=eq.'+encodeURIComponent(row.updated_at),{method:'PATCH',headers:{apikey:secret,Authorization:'Bearer '+secret,'Content-Type':'application/json',Prefer:'return=representation'},body:JSON.stringify({value:next,updated_at:new Date().toISOString()}),signal:AbortSignal.timeout(16000)});
    const updated=await r.json();if(!r.ok)throw Error('บันทึกหมู่บ้านไม่สำเร็จ');if(updated.length)return reply(200,{ok:true,village});
   }
   return reply(409,{ok:false,error:'มีการเพิ่มพร้อมกัน กรุณาลองอีกครั้ง'});
  }
  if(body.action!=='employee')return reply(400,{ok:false,error:'คำขอไม่ถูกต้อง'});
  if(p.actor.role!=='admin')return reply(403,{ok:false,error:'เฉพาะแอดมินเท่านั้น'});
  if(String(body.expectedRevision||'')!==String(p.data.settings?._resetRevision||''))return reply(409,{ok:false,error:'ข้อมูลเปลี่ยนหลังล้างระบบ กรุณาโหลดข้อมูลใหม่'});
  const id=body.employee?.id,name=String(body.employee?.name||'').trim(),code=String(body.employee?.code||'').trim(),role=body.employee?.role;
  if(typeof id!=='string'||!id||id.length>160||!name||name.length>200||!code||code.length>80||!['staff','admin'].includes(role))return reply(400,{ok:false,error:'กรุณากรอกชื่อและรหัสพนักงานให้ครบ'});
  const list=p.data.employees||[],old=list.find(e=>e.id===id)||null;
  const canonical=v=>JSON.stringify(v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v);
  if(canonical(old)!==canonical(body.expectedEmployee||null)){
   const wanted={name,code,role,contactEmail:String(body.employee.contactEmail||'').trim().toLowerCase(),status:body.employee.status==='inactive'?'inactive':'active',permissions:body.employee.permissions||{pages:{},canPrint:false,canEmail:false}};
   const actual=old?Object.fromEntries(Object.keys(wanted).map(k=>[k,old[k]])):null;
   if(old?.authUserId&&old.email?.endsWith('@employees.freshywater.in.th')&&canonical(actual)===canonical(wanted))return reply(200,{ok:true,payload:p});
   return reply(409,{ok:false,error:'ข้อมูลพนักงานเปลี่ยนจากเครื่องอื่น กรุณาเปิดแก้ไขใหม่'});
  }
  if(list.some(e=>e.id!==id&&e.code===code))return reply(409,{ok:false,error:'รหัสพนักงานซ้ำ'});
  const contactEmail=String(body.employee.contactEmail||'').trim().toLowerCase();
  if(contactEmail&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail))return reply(400,{ok:false,error:'อีเมลไม่ถูกต้อง'});
  const status=body.employee.status==='inactive'?'inactive':'active',password=body.password;
  const needsAccount=!old||old.status==='pending'||!old.email;
  if(needsAccount&&(typeof password!=='string'||password.length<6||password.length>1024))return reply(400,{ok:false,error:'ตั้งรหัสผ่านอย่างน้อย 6 ตัวอักษร'});
  if(password&&(!needsAccount||status==='inactive'))return reply(400,{ok:false,error:'บัญชีเดิมใช้รหัสผ่านเดิม หากต้องการเปลี่ยนให้ใช้หน้าบัญชี'});
  let email=old?.email||'',authUserId=old?.authUserId;
  if(needsAccount){
   const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(id)))).map(x=>x.toString(16).padStart(2,'0')).join('');
   email='employee.'+hash+'@employees.freshywater.in.th';
   let user;
   try{user=await call('/auth/v1/admin/users',{email,password,email_confirm:true,app_metadata:{freshy_employee_id:id}},true);}catch(e){
    // A lost response may already have created this account. Locate only our own synthetic identity.
    if(![400,422].includes(e.status))throw e;
    for(let page=1;page<=20;page++){const result=await call('/auth/v1/admin/users?page='+page+'&per_page=1000',null,true,'GET'),users=result.users||[];user=users.find(u=>u.email===email&&u.app_metadata?.freshy_employee_id===id);if(user||users.length<1000)break;}
    if(!user)throw e;
    user=await call('/auth/v1/admin/users/'+encodeURIComponent(user.id),{password,email_confirm:true},true,'PUT');
   }
   authUserId=user.id;
  }
  const employee={...(old||{}),id,name,code,role,email,contactEmail,authUserId,status,permissions:body.employee.permissions||{pages:{},canPrint:false,canEmail:false}};
  // Never cache or log passwords, and never attach one to the employee registry.
  const event={id:crypto.randomUUID(),ts:new Date().toISOString(),userId:p.actor.id,userName:p.actor.name,action:old?'แก้ไขพนักงาน':'เพิ่มพนักงาน',detail:name};
  const applied=await net(url+'/rest/v1/rpc/freshy_apply',{method:'POST',headers:{apikey:anon,Authorization:authorization,'Content-Type':'application/json','x-freshy-revision':p.data.settings?._resetRevision||''},body:JSON.stringify({changes:[{collection:'employees',id,expected:old,value:employee},{collection:'audit',id:event.id,expected:null,value:event}]}),signal:AbortSignal.timeout(16000)});
  const payload=await applied.json();if(!applied.ok)return reply(applied.status,{ok:false,error:payload.message||'บันทึกพนักงานไม่สำเร็จ กรุณาลองอีกครั้ง'});
  return reply(200,{ok:true,payload});
 }catch(e){return reply(e.status===401||e.status===403?e.status:502,{ok:false,error:e.status===401||e.status===403?'กรุณาเข้าสู่ระบบด้วยบัญชีที่ได้รับสิทธิ์':'ดำเนินการไม่สำเร็จ กรุณาลองอีกครั้ง'});}
}
if(typeof Deno!=='undefined')Deno.serve(req=>handler(req,key=>Deno.env.get(key)));
