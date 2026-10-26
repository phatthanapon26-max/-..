'use strict';
const PDFDocument=require('pdfkit'),path=require('node:path'),I=require('../../invoice');
function pdfInvoice(snapshot){return new Promise((resolve,reject)=>{
 const model=I.normalize({...snapshot.invoice,docNo:snapshot.docNo,issuedAt:snapshot.issuedAt}),t=model.template,doc=new PDFDocument({size:'A4',margins:{top:38,left:38,right:38,bottom:35},bufferPages:true,info:{Title:'ใบแจ้งหนี้',Subject:model.docNo,Author:model.issuer.name}}),chunks=[];
 doc.on('data',x=>chunks.push(x));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
 try{
 doc.registerFont('Thai',path.join(process.cwd(),'vendor/fonts/Sarabun-Regular.ttf')).registerFont('ThaiBold',path.join(process.cwd(),'vendor/fonts/Sarabun-Bold.ttf'));
 const left=38,width=doc.page.width-76,bottom=doc.page.height-55,font=t.fontSize*.75;let y=38;
 const text=(value,x,top,w,size=font,bold=false,align='left')=>doc.font(bold?'ThaiBold':'Thai').fontSize(size).fillColor('#111').text(String(value??''),x,top,{width:w,align,lineGap:1});
 const height=(value,w,size=font,bold=false)=>doc.font(bold?'ThaiBold':'Thai').fontSize(size).heightOfString(String(value??''),{width:w,lineGap:1});
 const line=(top,x=left,w=width)=>doc.strokeColor('#777').lineWidth(.5).moveTo(x,top).lineTo(x+w,top).stroke();
 const nextPage=()=>{doc.addPage();y=38;text('ใบแจ้งหนี้ · '+model.docNo,left,y,width,9,true,'right');y+=22;};const ensure=h=>{if(y+h>bottom)nextPage();};
 const fieldRows=(fields,x,top,w,labelW)=>{let yy=top;for(const [label,value] of fields){const h=Math.max(height(label,labelW,font-1),height(value||'-',w-labelW-7,font-1));text(label,x,yy,labelW,font-1);text(value||'-',x+labelW+7,yy,w-labelW-7,font-1);yy+=h+4;}return yy;};
 const heading=()=>{const logo=t.logoSize*.75;ensure(logo+14);doc.image(path.join(process.cwd(),'brand-icon.png'),left,y,{fit:[logo,logo]});text('ใบแจ้งหนี้',left+width*.52,y+2,width*.48,t.titleSize*.75,false,'right');text('Invoice',left+width*.52,y+35,width*.48,18,false,'right');y+=logo+14;};
 const issuer=()=>{const top=y,w=width*.61;ensure(84);const a=fieldRows([['ผู้ออก / Issuer',model.issuer.name],['ที่อยู่ / Address',model.issuer.address],['เลขผู้เสียภาษี / Tax ID',model.issuer.taxId],['โทรศัพท์ / Tel.',model.issuer.phone]],left,top,w,90);const b=fieldRows([['เลขที่ / No.',model.docNo],['วันที่ / Issue',I.date(model.issuedAt)],['ครบกำหนด / Due Date',I.date(model.dueDate)],['อ้างอิง / Ref.',model.reference]],left+w+20,top,width-w-20,80);y=Math.max(a,b)+6;};
 const customer=()=>{const fields=[['ลูกค้า / Customer',model.customerName],['ที่อยู่ / Address',model.address],['เลขผู้เสียภาษี / Tax ID','-'],['ผู้ติดต่อ / Attention',model.phone]];const h=fields.reduce((n,[label,value])=>n+Math.max(height(label,112,font-1),height(value,width-120,font-1))+4,0)+18;ensure(h);line(y);y+=9;y=fieldRows(fields,left,y,width,112)+9;};
 const items=()=>{
 const data=I.tableData(model),sum=t.columns.reduce((n,c)=>n+c.width,0),widths=t.columns.map(c=>width*c.width/sum),english={code:'ID no.',description:'Item',quantity:'Quantity',unit:'Unit',unitPrice:'Unit Price',amount:'Amount'};
 const rowHeight=row=>Math.max(t.rowHeight*.75,...row.map((cell,i)=>height(cell,widths[i]-10)+10));
 const draw=(row,forcedHeight=null)=>{const h=forcedHeight??rowHeight(row);let x=left;row.forEach((value,i)=>{if(i)doc.strokeColor('#999').lineWidth(.4).moveTo(x,y).lineTo(x,y+h).stroke();text(value,x+5,y+5,widths[i]-10,font,false,t.columns[i].align);x+=widths[i];});y+=h;};
 const header=()=>{line(y);const row=t.columns.map(c=>c.label+'\n'+english[c.key]);draw(row);line(y);};
 ensure(80);header();const bodyStart=y;let pageBodyStart=y;
 for(const row of data.rows){const h=rowHeight(row);if(y+h>bottom){line(y);nextPage();header();pageBodyStart=y;}draw(row);}
 const filler=Math.max(0,t.bodyHeight*.75-(y-(pageBodyStart===bodyStart?bodyStart:pageBodyStart)));if(filler&&y+filler<bottom){let x=left;for(let i=1;i<widths.length;i++){x+=widths[i-1];doc.strokeColor('#999').lineWidth(.4).moveTo(x,y).lineTo(x,y+filler).stroke();}y+=filler;}line(y);
 };
 const summary=()=>{const leftW=width*.38,rightX=left+width*.43,rightW=width*.57,remarks='หมายเหตุ / Remarks\n'+(model.note||'-'),h=Math.max(height(remarks,leftW),78);ensure(h+6);const top=y;text(remarks,left,y+7,leftW,font);const rows=[['จำนวนเงินรวมทั้งสิ้น / Grand Total',I.money(model.total)],['จำนวนเงินรวมทั้งสิ้น',I.bahtText(model.total)],['จำนวนเงินที่ต้องชำระ / Net to Pay',I.money(model.total)]];for(let i=0;i<rows.length;i++){const [label,value]=rows[i],h=Math.max(25,height(value,rightW*.48,font-1)+10);if(i===1)doc.save().rect(rightX,y,rightW,h).fill('#e8e8e8').restore();text(label,rightX+4,y+7,rightW*.52-8,font-1);text(value,rightX+rightW*.52,y+7,rightW*.48-4,font-1,false,'right');y+=h;line(y,rightX,rightW);}y=Math.max(y,top+h);};
 const signatures=()=>{
 const gap=t.signatureGap*.75,h=gap+65;ensure(h+24);y+=15;line(y);line(y+2);y+=12;const top=y,payW=width*.46,signX=left+width*.51,signW=width*.49,w=(signW-20)/2;
 text('ข้อมูลการชำระเงิน / Payment',left,top,payW,font);const widths=[payW*.24,payW*.4,payW*.36],headers=['ธนาคาร','ชื่อบัญชี','เลขที่บัญชี'],values=[model.payment.bank,model.payment.accountName,model.payment.accountNo];let x=left;for(let i=0;i<3;i++){text(headers[i],x,top+22,widths[i]-5,font-1);text(values[i],x,top+43,widths[i]-5,font-1);x+=widths[i];}line(top+39,left,payW);line(top+65,left,payW);
 for(const [index,name,role] of [[0,t.signerName,t.signerRole],[1,t.receiverName,t.receiverRole]]){const x=signX+index*(w+20);text(role,x,top,w,font-1,false,'center');doc.strokeColor('#777').dash(1,{space:2}).moveTo(x,top+gap+15).lineTo(x+w,top+gap+15).stroke().undash();text('('+(name||'................................')+')',x,top+gap+26,w,font-1,false,'center');text('วันที่ .... / .... / ........',x,top+gap+45,w,font-2,false,'center');}y=top+h;
 };
 const footer=()=>{ensure(34);y+=14;text('เลขที่เอกสาร '+model.docNo,left,y,width*.38,7);text('ออกเอกสารโดย ระบบสารสนเทศจัดการลูกหนี้\nโรงน้ำดื่ม เฟรชชี่ วอเตอร์',left+width*.4,y,width*.6,7,false,'right');y+=20;};
 const blocks={heading,issuer,customer,items,summary,signatures,footer};for(const id of t.sections)blocks[id]();const range=doc.bufferedPageRange();for(let i=0;i<range.count;i++){doc.switchToPage(i);text('หน้า '+(i+1)+' / '+range.count,left,doc.page.height-65,width,8,false,'center');}doc.end();
 }catch(e){reject(e);doc.destroy();}
 });}
module.exports={pdfInvoice};
