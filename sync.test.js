const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const S=require('./sync.js');
const blank=()=>Object.fromEntries(S.collections.map(k=>[k,k==='settings'?{business:{name:'Freshy'},doccounters:{}}:[]]));
const base=blank();base.settings.db={mode:'supabase'};
const current=S.shared(base);
assert.equal(S.diff(S.shared(base),current).length,0);
const queued=Array.from({length:10},(_,i)=>({collection:'customers',id:'test-'+i,expected:null,value:{id:'test-'+i,name:'Test '+i}}));
const server=blank();server.customers=[{id:'other-device',name:'Existing'}];
const recovered=S.overlay(server,S.rebase(server,queued));
assert.equal(recovered.customers.length,11);
assert.equal(S.rebase(recovered,queued).length,0,'A committed response lost to timeout must not duplicate writes');
assert.throws(()=>S.rebase({customers:[{id:'test-0',name:'Other change'}]},[queued[0]]),/CONFLICT:customers/);
const settings={collection:'settings',id:'settings',expected:{business:{name:'Old',phone:'1'},doccounters:{FWD:1},db:{mode:'supabase'}},value:{business:{name:'New',phone:'1'},doccounters:{FWD:2}}};
const rebased=S.rebase({settings:{business:{name:'Old',phone:'2'},doccounters:{FWD:3}}},[settings])[0];
assert.deepEqual(rebased.value,{business:{name:'New',phone:'2'},doccounters:{FWD:3}});
assert.throws(()=>S.rebase({settings:{business:{name:'Different',phone:'1'},doccounters:{FWD:1}}},[settings]),/CONFLICT:settings/);
const app=fs.readFileSync(__dirname+'/app.js','utf8');
const install=app.slice(app.indexOf('function installRemote('),app.indexOf('async function rpc('));
const raw={business:{name:'Live'},doccounters:{},db:{old:true}};
const context={FreshySync:S,SUPA_COLS:S.collections,DB:{settings:{db:{mode:'supabase'}}},defaultSettings:()=>({business:{name:'Default'},email:{enabled:false},db:{mode:'demo'}}),safeCache:()=>{},remoteBase:null,remoteSettings:null};
vm.createContext(context);vm.runInContext(install,context);
context.installRemote({actor:{id:'admin'},data:{settings:raw,employees:[{id:'admin'}]}},[]);
assert.equal(S.diff(context.remoteBase,S.shared(context.DB)).length,0,'UI defaults must not create phantom pending settings');
assert.equal(context.remoteSettings.business.name,'Live');
assert.equal(context.remoteSettings.db.old,true,'Expected settings must match the exact server JSON, including legacy keys');
assert.equal(context.remoteBase.settings.db,undefined,'Device connection settings must stay out of the shared baseline');
context.installRemote({actor:{id:'admin'},data:{settings:{_resetRevision:'after-reset'},employees:[{id:'admin'}]}},queued);assert.equal(context.DB.customers.length,0,'Old draft edits must be dropped after a reset revision changes');
assert.match(fs.readFileSync(__dirname+'/database.sql','utf8'),/errcode='PT409'/);
assert.doesNotMatch(fs.readFileSync(__dirname+'/database.sql','utf8'),/errcode='40001'/);
const setup={window:{}};vm.createContext(setup);vm.runInContext(fs.readFileSync(__dirname+'/database-config.js','utf8'),setup);
assert.equal(setup.window.FRESHY_SQL,fs.readFileSync(__dirname+'/database.sql','utf8'),'The setup SQL copied from the app must match the tested database source');
async function verifyFlush(){
 let database=blank(),applies=0,loseResponse=true;
 database.settings.db={legacy:true};
 const client={rpc:async(name,body)=>{
  if(name==='freshy_read')return {data:{actor:{id:'admin'},data:S.clone(database)}};
  applies++;
  for(const c of body.changes){const existing=c.collection==='settings'?database.settings:(database[c.collection]||[]).find(x=>x.id===c.id)||null;if(!S.equal(existing,c.expected))return {error:{code:'PT409',message:'CONFLICT:'+c.collection+':'+c.id}};}
  database=S.overlay(database,body.changes);delete database.settings.db;
  if(loseResponse){loseResponse=false;return {error:{message:'TimeoutError: signal timed out'}};}
  return {data:{actor:{id:'admin'},data:S.clone(database)}};
 }};
 const env={...context,DB:{settings:{db:{mode:'supabase'}}},remoteBase:null,remoteSettings:null,authIdentity:{id:'user'},syncPromise:null,syncBusy:false,syncBlocked:false,syncRetryCount:0,syncRetryTimer:null,supaCfg:()=>({url:'test'}),authFor:()=>client,setStatus:()=>{},toast:()=>{},broadcastOnlineChange:()=>{},clearTimeout:()=>{},setTimeout:()=>0};
 vm.createContext(env);vm.runInContext(install,env);
 vm.runInContext(app.slice(app.indexOf('async function rpc('),app.indexOf('async function supabaseFetch(')),env);
 vm.runInContext(app.slice(app.indexOf('async function flushOnline('),app.indexOf('function supabasePush(')),env);
 env.installRemote({actor:{id:'admin'},data:S.clone(database)},[]);
 env.DB.customers=queued.map(c=>S.clone(c.value));env.DB.settings.business.name='Updated';
 assert.equal(await env.flushOnline(),false,'Lost response must leave the draft pending');
 assert.equal(await env.flushOnline(),true,'Retry must recognize the first committed batch and send the remaining row');
 assert.equal(database.customers.length,10);
 assert.equal(database.settings.business.name,'Updated');
 assert.equal(S.diff(env.remoteBase,S.shared(env.DB)).length,0);
 assert.equal(applies,3);
 console.log('Passed: real flush loop, 10 queued records, committed response lost, retry without duplicates, exact legacy settings, and PT409.');
}
verifyFlush().catch(e=>{console.error(e);process.exitCode=1;});

