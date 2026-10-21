'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),{JSDOM}=require('jsdom');
const C=require('./api/_lib/core'),history=require('./api/document-history');
let role='admin',legacy=[],service=[];
C.authenticate=async(req,admin)=>{if(!req.headers.authorization)throw new C.HttpError(401,'login');if(admin&&role!=='admin')throw new C.HttpError(403,'admin');return {actor:{id:'admin',role},data:{sentEmails:legacy}};};
C.serviceHeaders=()=>({});
C.json=async path=>{const u=new URL('https://test'+path);assert.equal(u.searchParams.get('select').includes('tables'),false);let rows=service;const clause=u.searchParams.get('and')||'';const cur=clause.match(/value->>issuedAt.lt.([^,]+)/);if(cur){const time=cur[1],id=clause.match(/key.lt.document:([a-f0-9]+)/)[1];rows=rows.filter(r=>r.issuedAt<time||(r.issuedAt===time&&r.key<'document:'+id));}if(clause.includes('ilike'))rows=rows.filter(r=>r.docNo.includes('FWD'));return rows.slice(0,26);};
async function call(query={},auth=true){const res={statusCode:200,setHeader(){},status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};await history({method:'GET',headers:{authorization:auth?'Bearer fixture':''},query},res);return res;}
(async()=>{
 process.env.SUPABASE_SERVICE_ROLE_KEY='fixture-only';
 service=Array.from({length:30},(_,i)=>({key:'document:'+(30-i).toString(16).padStart(64,'0'),docNo:'FWD-'+i,title:'รายงานลูกหนี้',issuedAt:'2026-10-21T10:00:00.000Z',author:{name:'แอดมิน'}}));
 legacy=[{id:'document:'+'f'.repeat(64),type:'document',document:{docNo:'OLD-1',title:'รายงานเก่า',issuedAt:'2026-10-21T11:00:00.000Z',author:{name:'ผู้ดูแล'}}}];
 assert.equal((await call({},false)).statusCode,401);role='staff';assert.equal((await call()).statusCode,403);role='admin';
 let r=await call();assert.equal(r.body.records.length,25);assert.equal(r.body.records[0].docNo,'OLD-1');assert(r.body.nextCursor);assert(!JSON.stringify(r.body).includes('tables'));const first=r.body.records.map(x=>x.id);r=await call({cursor:r.body.nextCursor});assert.equal(r.body.records.length,6);assert(r.body.records.every(x=>!first.includes(x.id)));assert.equal(r.body.nextCursor,null);
 assert.equal((await call({cursor:'invalid'})).statusCode,400);r=await call({q:'FWD'});assert(r.body.records.every(x=>x.docNo.startsWith('FWD')));
 delete process.env.SUPABASE_SERVICE_ROLE_KEY;r=await call();assert.equal(r.body.records[0].docNo,'OLD-1');assert.equal(r.body.records.length,1);
 const dom=new JSDOM(fs.readFileSync('index.html','utf8'),{url:'https://fixture.test/design-preview',runScripts:'outside-only'}),w=dom.window;
 w.FRESHY_PREVIEW=true;w.FRESHY_CONFIG={mode:'demo'};w.structuredClone=structuredClone;w.setInterval=()=>0;w.scrollTo=()=>{};w.matchMedia=()=>({matches:false,addEventListener(){}});let prints=0;w.print=()=>prints++;
 for(const f of ['sync.js','features.js','payments.js','data-tools.js','vendor/qrcode.js','dashboard.js','app.js'])w.eval(fs.readFileSync(f,'utf8'));
 const $=s=>w.document.querySelector(s);$('#loginCode').value='7716';$('#loginBtn').click();assert($('#quickDocumentHistory'));
 $('[data-page="debtorsNai"]').click();$('#printReportBtn').click();$('#po_qr').checked=false;$('#doPrint').click();await new Promise(r=>setTimeout(r,40));assert.equal(prints,1);assert(!$('#printArea img.document-qr'));
 const db=JSON.parse(w.localStorage.getItem('freshywater_demo_v8')),saved=db.sentEmails.find(r=>r.type==='document');assert(saved);const original=saved.document.tables[0].rows[0][0];
 $('[data-page="documentHistory"]').click();await new Promise(r=>setTimeout(r,40));assert($('#pageContent').textContent.includes(saved.document.docNo));$('[data-demo-document]').click();assert($('#modalBox').textContent.includes(saved.document.docNo));assert($('#modalBox').textContent.includes(original));
 w.closeModal();$('#documentHistorySearch').value='does-not-exist';$('#documentHistorySearchForm').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,20));assert($('#pageContent').textContent.includes('ไม่พบเอกสาร'));dom.window.close();
 console.log('Passed: admin-only history, merged legacy/current snapshots, equal-time pagination, search, invalid cursors, printing without QR saves history, dashboard shortcut and saved-document opening.');
})().catch(e=>{console.error(e);process.exitCode=1;});
