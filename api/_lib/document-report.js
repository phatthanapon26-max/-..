'use strict';
const PDFDocument=require('pdfkit'),path=require('node:path');
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=v=>new Date(v).toLocaleString('th-TH',{timeZone:'Asia/Bangkok',dateStyle:'long',timeStyle:'short'});
function notificationHtml(d){
 const line=(label,value)=>`<tr><td style="padding:8px 12px;border-bottom:1px solid #d6dbe1;width:120px;color:#425063">${label}</td><td style="padding:8px 12px;border-bottom:1px solid #d6dbe1">${escape(value)}</td></tr>`;
 return `<div style="background:#edf1f5;padding:24px 12px;font-family:Sarabun,Arial,sans-serif;color:#172332;line-height:1.7"><div style="max-width:720px;margin:auto;background:#fff;border:1px solid #c6ced8"><div style="border-top:4px solid #18354f;padding:24px 28px;border-bottom:1px solid #c6ced8"><p style="margin:0;font-weight:bold;font-size:20px">${escape(d.business.name)}</p><p style="margin:8px 0 0;font-size:16px">แจ้งนำส่งเอกสารรายงาน</p></div><div style="padding:24px 28px"><p>เรียน ผู้บริหารและผู้เกี่ยวข้อง</p><p>ขอนำส่ง${escape(d.title)} เพื่อทราบและตรวจสอบรายละเอียด โดยแนบเอกสารฉบับ PDF พร้อมอีเมลนี้</p><table style="width:100%;border-collapse:collapse;font-size:14px">${line('เลขที่เอกสาร',d.docNo)}${line('วันที่ออก',date(d.issuedAt)+' น.')}${line('ผู้จัดทำ',d.author.name)}${line('เอกสารแนบ',d.docNo+'.pdf')}</table>${d.summaries.map(s=>'<p style="border:1px solid #c6ced8;padding:12px;font-weight:bold">'+escape(s)+'</p>').join('')}<p>จึงเรียนมาเพื่อทราบและดำเนินการในส่วนที่เกี่ยวข้อง</p><p>ระบบสารสนเทศจัดการลูกหนี้<br>${escape(d.business.name)}</p></div><div style="padding:14px 28px;border-top:1px solid #c6ced8;font-size:12px;color:#425063">อีเมลแจ้งเตือนจากระบบอัตโนมัติ · ใช้เลขที่เอกสารข้างต้นสำหรับตรวจสอบอ้างอิง</div></div></div>`;
}
function pdfDocument(snapshot){return new Promise((resolve,reject)=>{
 const doc=new PDFDocument({size:'A4',margins:{top:42,bottom:30,left:42,right:42},bufferPages:true,info:{Title:snapshot.title,Author:snapshot.author.name,Subject:snapshot.docNo}}),parts=[];
 doc.on('data',x=>parts.push(x));doc.on('end',()=>resolve(Buffer.concat(parts)));doc.on('error',reject);
 try{
 doc.registerFont('Thai',path.join(process.cwd(),'vendor/fonts/Sarabun-Regular.ttf')).registerFont('ThaiBold',path.join(process.cwd(),'vendor/fonts/Sarabun-Bold.ttf'));
 const left=42,width=doc.page.width-84,bottom=doc.page.height-75;let y=42;
 const height=(text,w,size=11,bold=false)=>doc.font(bold?'ThaiBold':'Thai').fontSize(size).heightOfString(String(text??''),{width:w,lineGap:2});
 const text=(value,x,top,w,size=11,bold=false,align='left')=>doc.font(bold?'ThaiBold':'Thai').fontSize(size).fillColor('#111').text(String(value??''),x,top,{width:w,align,lineGap:2});
 const line=(top)=>doc.strokeColor('#333').lineWidth(.6).moveTo(left,top).lineTo(left+width,top).stroke();
 const nextPage=()=>{doc.addPage();y=42;text(snapshot.title,left,y,width-150,10,true);text(snapshot.docNo,left+width-150,y,150,9,false,'right');y+=Math.max(height(snapshot.title,width-150,10,true),18)+8;line(y);y+=12;};
 const ensure=h=>{if(y+h>bottom)nextPage();};
 const paragraph=(value,size=11,bold=false,align='left')=>{const h=height(value,width,size,bold);ensure(h+6);text(value,left,y,width,size,bold,align);y+=h+6;};
 paragraph(snapshot.business.name||'โรงน้ำดื่ม เฟรชชี่ วอเตอร์',19,true,'center');
 const contact=[snapshot.business.address,snapshot.business.phone?'โทรศัพท์ '+snapshot.business.phone:'',snapshot.business.taxId?'เลข อย. '+snapshot.business.taxId:''].filter(Boolean).join(' · ');
 if(contact)paragraph(contact,10,false,'center');y+=5;paragraph(snapshot.title,15,true,'center');line(y);y+=10;
 paragraph('เลขที่เอกสาร '+snapshot.docNo+'    วันที่ออก '+date(snapshot.issuedAt)+' น.',10);
 if(snapshot.metadata)paragraph(snapshot.metadata,10);y+=6;
 for(const table of snapshot.tables){
  const count=Math.max(1,table.headers.length),size=count>9?9:count>6?10:11;
  let weights=table.widths?.length===count?table.widths:table.headers.map((h,i)=>{const cells=table.rows.slice(0,100).map(r=>r[i]||'');return Math.max(5,Math.min(24,Math.max(String(h).length,...cells.map(s=>s.length))));});
  const sum=weights.reduce((a,b)=>a+b,0),widths=weights.map(n=>width*n/sum);
  const alignments=table.alignments||[],caption=table.title||'';
  const layout=cells=>{const result=[];for(let i=0;i<count;i++){const start=i;let w=widths[i];if(i===0&&/^รวม/.test(cells[0]||''))while(i+1<count&&cells[i+1]==='')w+=widths[++i];result.push({index:start,width:w,value:cells[start]||''});}return result;};
  const rowHeight=(cells,bold)=>Math.max(25,...layout(cells).map(c=>height(c.value,c.width-10,size,bold)+10));
  const drawRow=(cells,bold,isHeader=false)=>{const h=rowHeight(cells,bold);let x=left;doc.strokeColor('#333').lineWidth(.5);for(const c of layout(cells)){doc.rect(x,y,c.width,h).stroke();text(c.value,x+5,y+5,c.width-10,size,bold,isHeader?'center':c.index===0&&/^รวม/.test(c.value)?'left':alignments[c.index]||'left');x+=c.width;}y+=h;};
  const header=()=>{if(caption){const h=height(caption,width,11,true);text(caption,left,y,width,11,true);y+=h+6;}drawRow(table.headers,true,true);};
  const headHeight=(caption?height(caption,width,11,true)+6:0)+rowHeight(table.headers,true);
  ensure(headHeight+(table.rows.length?rowHeight(table.rows[0],false):0));header();
  for(const cells of table.rows){const h=rowHeight(cells,false);if(y+h>bottom){nextPage();header();}
   // Long notes can span pages; never truncate customer data to fit a cell.
   if(h>bottom-y){const top=y;let end=top;for(let i=0,x=left;i<count;x+=widths[i++]){text(cells[i]||'',x+5,top+5,widths[i]-10,size,false,alignments[i]||'left');end=Math.max(end,doc.y);}y=end+10;}else drawRow(cells,/^รวม/.test(cells[0]||''));
  }y+=12;
 }
 for(const summary of snapshot.summaries)paragraph(summary,12,true);
 const signatures=snapshot.signatures?.length?snapshot.signatures:[{name:snapshot.author.name,role:'ผู้จัดทำข้อมูล'},{name:'',role:'พนักงานส่งน้ำ'},{name:'',role:'ผู้ตรวจสอบ'},{name:'',role:'ผู้อนุมัติ'}];
 ensure(112);y+=36;const sw=width/signatures.length;
 signatures.forEach((s,i)=>{const x=left+i*sw;doc.moveTo(x+8,y).lineTo(x+sw-8,y).stroke();text(s.name?'('+s.name+')':'(........................................)',x+3,y+7,sw-6,10,false,'center');text(s.role,x+3,y+28,sw-6,10,false,'center');text('วันที่ .... / .... / ........',x+3,y+49,sw-6,9,false,'center');});
 const range=doc.bufferedPageRange();for(let i=range.start;i<range.start+range.count;i++){doc.switchToPage(i);const fy=doc.page.height-44;line(fy-7);text('เลขที่เอกสาร '+snapshot.docNo+' · '+snapshot.business.name,left,fy,width-70,8);text('หน้า '+(i+1)+' / '+range.count,left+width-65,fy,65,8,false,'right');}
 doc.end();
 }catch(e){reject(e);doc.destroy();}
});}
module.exports={pdfDocument,notificationHtml};
