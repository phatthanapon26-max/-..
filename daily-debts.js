(function(root){
'use strict';
const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'});
function recordedDate(value){if(typeof value!=='string'||!value)return '';if(/^\d{4}-\d{2}-\d{2}$/.test(value))return Number.isFinite(Date.parse(value))?value:'';if(!/^\d{4}-\d{2}-\d{2}T/.test(value))return '';const stamp=/(Z|[+-]\d{2}:\d{2})$/i.test(value)?value:value+'+07:00';const date=new Date(stamp);if(!Number.isFinite(date.getTime()))return '';const p=Object.fromEntries(formatter.formatToParts(date).map(x=>[x.type,x.value]));return p.year+'-'+p.month+'-'+p.day;}
function select(records,date){if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return [];return records.filter(r=>recordedDate(r.createdAt)===date).slice().sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt))||String(a.id).localeCompare(String(b.id)));}
function displayTime(value){if(!recordedDate(value))return '-';if(value.length===10)return value+' (ไม่ระบุเวลา)';const stamp=/(Z|[+-]\d{2}:\d{2})$/i.test(value)?value:value+'+07:00';return new Intl.DateTimeFormat('th-TH',{timeZone:'Asia/Bangkok',dateStyle:'short',timeStyle:'medium'}).format(new Date(stamp))+' น.';}
const api={recordedDate,select,displayTime};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.FreshyDailyDebts=api;
})(typeof window!=='undefined'?window:globalThis);
