'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{JSDOM}=require('jsdom');
(async()=>{
 const d=new JSDOM(fs.readFileSync('index.html','utf8'),{url:'https://fixture.test/design-preview',runScripts:'outside-only'}),w=d.window;
 w.FRESHY_PREVIEW=true;w.FRESHY_CONFIG={mode:'demo'};w.structuredClone=structuredClone;w.setInterval=()=>0;w.scrollTo=()=>{};w.print=()=>{};w.matchMedia=()=>({matches:false,addEventListener(){}});
 for(const f of ['sync.js','features.js','payments.js','data-tools.js','vendor/qrcode.js','dashboard.js'])w.eval(fs.readFileSync(f,'utf8'));
 let src=fs.readFileSync('app.js','utf8'),end=src.lastIndexOf('})();');src=src.slice(0,end)+'window.reportTest={db:()=>DB,build:buildDebtorReportHtml};'+src.slice(end);w.eval(src);
 const db=w.reportTest.db();db.customers=[];db.debtors=[];db.settings.business={name:'โรงน้ำดื่ม เฟรชชี่ วอเตอร์',address:'เอกสารตัวอย่าง ข้อมูลจำลองสำหรับตรวจรูปแบบ',phone:'-',taxId:''};
 for(let i=0;i<90;i++){db.debtors.push({id:'r'+i,customerId:'long',customerName:'ลูกค้าทดสอบรายการครบ',area:'nai',moo:'7',status:'unpaid',debtDate:'2026-10-01',jugs:1,packs:0,jugAmount:20,packAmount:0,total:20});}db.customers.push({id:'long',code:'TEST001'});
 const report=w.reportTest.build('nai','all','combined'),snapshot=w.FreshyFeatures.documentSnapshot(report.html,report.docNo,db.settings.business,{name:'ผู้จัดทำตัวอย่าง',role:'admin'},w.document);
 assert.equal(snapshot.tables.length,1);assert.equal(snapshot.tables[0].headers.length,7,'Repeating customer heading must not enter the stored columns');assert.equal(snapshot.tables[0].rows.length,91);assert.equal(snapshot.tables[0].rows[90][6],'1,800');assert(snapshot.tables[0].title.includes('ลูกค้าทดสอบรายการครบ'));assert.equal(snapshot.signatures.length,4);
 const out=process.env.REPORT_LAYOUT_OUTPUT_DIR;if(out){fs.mkdirSync(out,{recursive:true});const css=[...w.document.querySelectorAll('style')].map(e=>e.textContent).join('\n')+'\n'+['ui.css','modern.css','report.css'].map(f=>fs.readFileSync(f,'utf8')).join('\n');
 const full=html=>'<!doctype html><html lang="th"><head><meta charset="utf-8"><style>'+css+'</style></head><body><div id="appShell"><p>APP CHROME MUST NOT PRINT</p></div><main id="printArea" class="print-area"><div class="doc-page">'+html+'</div></main></body></html>';
 fs.writeFileSync(path.join(out,'long-customer.html'),full(report.html));
 db.customers=[];db.debtors=[];for(let c=1;c<=12;c++){db.customers.push({id:'c'+c,code:'TEST'+String(c).padStart(3,'0')});for(let i=0;i<5;i++)db.debtors.push({id:c+'-'+i,customerId:'c'+c,customerName:'ลูกค้าตัวอย่าง '+String(c).padStart(2,'0'),area:'nai',moo:c<=6?'7':'16',status:'unpaid',debtDate:'2026-10-01',jugs:1,packs:0,jugAmount:20,packAmount:0,total:20});}
 const grouped=w.reportTest.build('nai','all','combined');fs.writeFileSync(path.join(out,'grouped-customers.html'),full(grouped.html));
 fs.writeFileSync(path.join(out,'server-customer.pdf'),await require('./api/_lib/document-report').pdfDocument(snapshot));
 }
 d.window.close();console.log('Passed: full 90-row customer report, repeated heading, exact stored columns/subtotal, and four signatures.');
})().catch(e=>{console.error(e);process.exitCode=1;});
