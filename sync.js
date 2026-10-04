/* Shared reconciliation logic: deterministic per-row diffs, no collection replacement. */
(function(root){
'use strict';
const collections=['settings','employees','products','villages','customers','debtors','cashsales','audit','approvals','sentEmails'];
function clone(v){return JSON.parse(JSON.stringify(v));}
function canonical(v){if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';return JSON.stringify(v);}
function equal(a,b){return canonical(a)===canonical(b);}
function shared(db){const out={};for(const k of collections){out[k]=clone(k==='settings'?db.settings||{}:db[k]||[]);}delete out.settings.db;return out;}
function diff(base,current){const result=[];for(const k of collections){if(k==='settings'){if(!equal(base[k]||{},current[k]||{}))result.push({collection:k,id:'settings',expected:base[k]||{},value:current[k]||{}});continue;}const before=new Map((base[k]||[]).map(v=>[v.id,v]));const after=new Map((current[k]||[]).map(v=>[v.id,v]));for(const [id,value] of after){if(!id)throw Error('รายการ '+k+' ไม่มีรหัส');const expected=before.get(id)||null;if(!equal(expected,value))result.push({collection:k,id,expected,value});}for(const [id,value] of before){if(!after.has(id))result.push({collection:k,id,expected:value,value:null});}}return clone(result);}
function overlay(remote,changes){const out=clone(remote);for(const c of changes){if(c.collection==='settings'){out.settings=clone(c.value);continue;}out[c.collection]=(out[c.collection]||[]).filter(x=>x.id!==c.id);if(c.value)out[c.collection].push(clone(c.value));}return out;}
function mergeSettings(old,wanted,latest,path){
 if(equal(old,wanted))return latest;
 if(equal(old,latest)||equal(wanted,latest))return wanted;
 if(path.startsWith('doccounters.')&&[old,wanted,latest].every(v=>v===undefined||typeof v==='number'))return Math.max(old||0,wanted||0,latest||0);
 if([old,wanted,latest].every(v=>v&&typeof v==='object'&&!Array.isArray(v))){const out=clone(latest);for(const key of new Set([...Object.keys(old),...Object.keys(wanted)])){if(key==='db')continue;const value=mergeSettings(old[key],wanted[key],latest[key],path?path+'.'+key:key);if(value===undefined)delete out[key];else out[key]=value;}return out;}
 throw Error('CONFLICT:settings:'+path);
}
function committed(c,current){
 if(equal(c.value,current))return true;
 if(!current||!c.value||c.expected!==null)return false;
 if(c.collection==='audit')return current.id===c.id;
 if(!['debtors','cashsales'].includes(c.collection))return false;
 const a=clone(c.value),b=clone(current);delete a.createdAt;delete b.createdAt;return equal(a,b);
}
function rebase(remote,changes){const out=[];for(const c of changes){const latest=c.collection==='settings'?remote.settings||{}:(remote[c.collection]||[]).find(x=>x.id===c.id)||null;
 if(c.collection==='settings'){const old=clone(c.expected||{}),wanted=clone(c.value||{}),current=clone(latest);delete old.db;delete wanted.db;delete current.db;const value=mergeSettings(old,wanted,current,'');if(!equal(value,current))out.push({...c,expected:current,value});continue;}
 if(committed(c,latest))continue;
 if(!equal(c.expected,latest))throw Error('CONFLICT:'+c.collection+':'+c.id);
 out.push({...c,expected:latest});
 }return out;}
const api={collections,clone,equal,shared,diff,overlay,rebase};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.FreshySync=api;
})(typeof window!=='undefined'?window:globalThis);
