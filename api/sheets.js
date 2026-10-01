module.exports=(req,res)=>{res.setHeader('Cache-Control','no-store');return res.status(410).json({ok:false,error:'ชุดนี้ใช้ Supabase ที่ตรวจสิทธิ์บัญชีจริง ไม่ได้เชื่อม Google Sheets'});};
