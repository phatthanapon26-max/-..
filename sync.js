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
const api={collections,clone,equal,shared,diff,overlay};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.FreshySync=api;
})(typeof window!=='undefined'?window:globalThis);
