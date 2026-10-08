(function(root){'use strict';
function review(row){return row?.status==='paid'?(row.paymentReviewStatus||'approved'):'unpaid';}
function label(row){return review(row)==='pending'?'รับชำระแล้ว รอแอดมินตรวจสอบหรืออนุมัติ':review(row)==='approved'?(row.paymentReviewStatus?'ตรวจสอบและอนุมัติแล้ว':'รับชำระแล้ว (ข้อมูลเดิม)'):'ค้างชำระ';}
function confirmed(row){return row?.status==='paid'&&review(row)==='approved';}
function canReceive(row,actor){return !!actor&&row?.status==='unpaid';}
function canCancel(row,actor){return !!actor&&row?.status==='paid'&&(actor.role==='admin'||(review(row)==='pending'&&row.paidBy===actor.id));}
const api={review,label,confirmed,canReceive,canCancel};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.FreshyPayments=api;
})(typeof window!=='undefined'?window:globalThis);
