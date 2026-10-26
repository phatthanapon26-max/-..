'use strict';
const PDFDocument=require('pdfkit'),path=require('node:path'),I=require('../../invoice');
const mm=n=>n*72/25.4;
function pdfInvoice(snapshot){return new Promise((resolve,reject)=>{
 const m=I.normalize({...snapshot.invoice,docNo:snapshot.docNo,issuedAt:snapshot.issuedAt}),t=m.template,o=I.overview(m),font=t.fontSize*.75,L=mm(12.6),W=mm(184.4),top=mm(12),contextY=top+mm(69.8),tableY=contextY+mm(7),headH=mm(14.2),bodyH=t.bodyHeight*.75,tableEnd=tableY+headH+bodyH,summaryY=tableEnd+mm(7),settleY=summaryY+mm(29),doc=new PDFDocument({size:'A4',margins:{top:0,left:0,right:0,bottom:0},bufferPages:true,info:{Title:'ใบแจ้งหนี้',Subject:m.docNo,Author:m.issuer.name}}),chunks=[];
 doc.on('data',v=>chunks.push(v));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);
 try{
 doc.registerFont('Thai',path.join(process.cwd(),'vendor/fonts/Sarabun-Regular.ttf')).registerFont('ThaiBold',path.join(process.cwd(),'vendor/fonts/Sarabun-Bold.ttf'));
 const text=(value,x,y,width,size=font,align='left')=>doc.font('Thai').fontSize(size).fillColor('#333').text(String(value??''),x,y,{width,align,lineGap:0,features:['kern'],lineBreak:true});
 const height=(value,width,size=font)=>doc.font('Thai').fontSize(size).heightOfString(String(value??''),{width,lineGap:0});
 const line=(y,x=L,width=W)=>doc.strokeColor('#999').lineWidth(.4).moveTo(x,y).lineTo(x+width,y).stroke();
 const fields=(rows,x,y,labelW,width,step=mm(5.7))=>rows.forEach(([label,value],i)=>{text(label,x,y+i*step,labelW,font*.9);text(value||'-',x+labelW,y+i*step,width-labelW,font);});
 const header=()=>{
  const logo=t.logoSize*.75;doc.image(path.join(process.cwd(),'brand-icon.png'),L-mm(3.5),top-mm(4),{fit:[logo,logo]});text('ใบแจ้งหนี้',L+W*.65,top+mm(2),W*.35,t.titleSize*.75,'right');text('Invoice',L+W*.65,top+mm(10.7),W*.35,t.titleSize*.75*.78,'right');
  const iy=top+mm(25.6);fields([['ผู้ออก / Issuer',m.issuer.name],['ที่อยู่ / Address',m.issuer.address],['เลขผู้เสียภาษี/ Tax ID',m.issuer.taxId],['โทรศัพท์ / Tel.',m.issuer.phone]],L,iy,mm(28.9),mm(123.8));
  const rx=L+mm(132.8),rw=mm(51.6);for(const [i,label,value] of [[0,'เลขที่ / No.',m.docNo],[1,'วันที่ / Issue',I.date(m.issuedAt)],[2,'ครบกำหนด / Due Date',I.date(m.dueDate)],[3,'อ้างอิง / Ref.',m.reference||'-']]){text(label,rx,iy+i*mm(5.7),mm(24.6),i===2?font*.8:font);text(value,rx+mm(24.6),iy+i*mm(5.7),rw-mm(24.6),font*.96);}
  const cy=top+mm(48.7);line(cy);text('ลูกค้า\nCustomer',L,cy+mm(4),mm(21.7));text('รหัสลูกค้า\n'+m.customerCode,L,cy+mm(12.2),mm(20),font*.82);text(m.customerName,L+mm(21.7),cy+mm(4),mm(78.5));text(m.address,L+mm(21.7),cy+mm(10.8),mm(78.5));fields([['เลขผู้เสียภาษี / Tax ID','-'],['ผู้ติดต่อ / Tel.',m.phone]],L+mm(105.2),cy+mm(4),mm(41.1),mm(79.2),mm(6.8));
 };
 const cols=t.columns,weights=cols.reduce((n,c)=>n+c.width,0),widths=cols.map(c=>W*c.width/weights),english={code:'ID no.',description:'Description',quantity:'Quantity',unit:'Unit',unitPrice:'Unit Price',amount:'Amount'},data=I.tableData(m),rowH=row=>Math.max(t.rowHeight*.75,...row.map((v,i)=>height(v,widths[i]-mm(4.4))+mm(2)));
 const pages=[];let rows=[],used=0;for(const row of data.rows){const h=rowH(row);if(rows.length&&used+h>bodyH){pages.push(rows);rows=[];used=0;}rows.push(row);used+=h;}if(rows.length||!pages.length)pages.push(rows);
 pages.forEach((rows,pageIndex)=>{
  if(pageIndex)doc.addPage();header();text('รายละเอียดการเรียกเก็บเงิน'+(o.period?' · วันที่ค้าง '+o.period:''),L,contextY+mm(1),W*.72,font*.92);text((o.entries?'บันทึกค้าง '+o.entries+' ครั้ง · ':'')+o.lines+' รายการ',L+W*.72,contextY+mm(1),W*.28,font*.92,'right');let x=L;line(tableY);for(let i=0;i<cols.length;i++){text(cols[i].label,x+mm(2.2),tableY+mm(2),widths[i]-mm(4.4));text(english[cols[i].key],x+mm(2.2),tableY+mm(8),widths[i]-mm(4.4));x+=widths[i];if(i<cols.length-1)doc.strokeColor('#999').lineWidth(.4).moveTo(x,tableY).lineTo(x,tableEnd).stroke();}line(tableY+headH);let y=tableY+headH;for(const row of rows){const h=rowH(row);x=L;row.forEach((value,i)=>{text(value,x+mm(2.2),y+mm(1),widths[i]-mm(4.4),font,cols[i].align);x+=widths[i];});y+=h;}line(tableEnd);text('สรุปจำนวนสินค้า'+(o.quantities?' · '+o.quantities:' -'),L,tableEnd+mm(1.5),W*.78,font*.92);text('รวม '+o.lines+' รายการ',L+W*.78,tableEnd+mm(1.5),W*.22,font*.92,'right');line(summaryY);
  if(pageIndex===pages.length-1){
   text('หมายเหตุ / Remarks',L,summaryY+mm(2),W*.38);text((m.note?m.note+'\n':'')+'เอกสารนี้เป็นใบแจ้งหนี้\nไม่ใช่ใบเสร็จรับเงิน และไม่ใช่ใบกำกับภาษี\nเมื่อชำระเงิน กรุณาแจ้งเลขที่ใบแจ้งหนี้ '+m.docNo,L,summaryY+mm(8),W*.38,font*.92);
   const sx=L+W*.399,sw=W*.601,divider=L+W*(1-cols[cols.length-1].width/weights),step=mm(29/3);doc.strokeColor('#999').lineWidth(.4).moveTo(divider,summaryY).lineTo(divider,settleY).stroke();
   const totalRow=(label,value,slot,shade=false)=>{const yy=summaryY+slot*step;if(shade){doc.save().rect(sx,yy,sw,step).fill('#dedede').restore();text(label,sx+mm(2.5),yy+mm(2),sw*.36-mm(2.5));text(value,sx+sw*.36,yy+mm(2),sw*.64-mm(2.3),font,'right');}else{text(label,sx,yy+mm(2),divider-sx-mm(3),font,'right');text(value,divider+mm(1),yy+mm(2),L+W-divider-mm(3.3),font,'right');}line(yy+step,sx,sw);};
   totalRow('จำนวนเงินรวมทั้งสิ้น (บาท) / Grand Total',I.money(m.total),0);totalRow('จำนวนเงินรวมทั้งสิ้น',I.bahtText(m.total),1,true);totalRow('จำนวนเงินที่ต้องชำระ (บาท) / Net to Pay',I.money(m.total),2);
   line(settleY);line(settleY+mm(.8));const py=settleY+mm(4.4),pw=mm(92.2);text('การชำระเงิน / Payment',L,py,pw);const cw=[pw*.22,pw*.51,pw*.27],labels=['ธนาคาร','ชื่อบัญชี','เลขที่บัญชี'],values=[m.payment.bank,m.payment.accountName,m.payment.accountNo];let px=L;for(let i=0;i<3;i++){text(labels[i],px+mm(1),py+mm(6),cw[i]-mm(2));text(values[i],px+mm(1),py+mm(13),cw[i]-mm(2),font*.92);px+=cw[i];}line(py+mm(11.3),L,pw);line(py+mm(19.7),L,pw);text('เมื่อชำระเงิน กรุณาแจ้งเลขที่ใบแจ้งหนี้',L,py+mm(23.5),pw,font*.9);text('ติดต่อสอบถาม / แจ้งชำระ\n'+m.issuer.phone,L,py+mm(30.5),pw,font*.9);
   const signX=L+mm(100.2),signW=mm(84.2),gap=mm(4),one=(signW-gap)/2;for(const [i,name,role] of [[0,t.signerName,t.signerRole],[1,t.receiverName,t.receiverRole]]){const xx=signX+i*(one+gap),sy=py+mm(4)+t.signatureGap*.75;text(role,xx,py,one);doc.strokeColor('#777').lineWidth(.4).dash(.6,{space:1.5}).moveTo(xx,sy).lineTo(xx+one,sy).stroke().undash();if(name)text('('+name+')',xx,sy+mm(2.5),one,font*.9,'center');text('วันที่ ........ / ........ / ................',xx,sy+mm(name?9:3.7),one,font*.92);}
   text('เลขที่เอกสาร '+m.docNo+'\nวันที่ออกเอกสาร '+I.date(m.issuedAt),L,settleY+mm(52.5),W*.44,font*.88);text('ออกเอกสารโดย ระบบสารสนเทศจัดการลูกหนี้\nโรงน้ำดื่ม เฟรชชี่ วอเตอร์',L+W*.48,settleY+mm(52.5),W*.52,font*.88,'right');
  }else text('รายการต่อหน้าถัดไป',L+W*.5,summaryY+mm(5),W*.5,font,'right');
  text('หน้า '+(pageIndex+1)+'/'+pages.length,L,mm(273),W,8,'center');
 });doc.end();
 }catch(e){reject(e);doc.destroy();}
 });}
module.exports={pdfInvoice};
