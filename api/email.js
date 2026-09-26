// api/email.js — Vercel Serverless Function ส่งอีเมลแจ้งเตือนและรายงาน
// รองรับ Resend API (เริ่มต้น) และ SMTP (nodemailer)
const nodemailer = require('nodemailer');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { to, subject, html, config } = req.body || {};
  if (!to || !subject) return res.status(400).json({ ok: false, error: 'missing to/subject' });

  try {
    if (config && config.provider === 'resend' && config.apiKey) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + config.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Freshy Water System <system@freshywater.app>', to: to.split(','), subject, html })
      });
      const data = await r.json();
      return res.json({ ok: !!data.id, data });
    }
    if (config && config.smtpHost) {
      const transporter = nodemailer.createTransport({
        host: config.smtpHost, port: Number(config.smtpPort || 587), secure: Number(config.smtpPort) === 465,
        auth: { user: config.smtpUser, pass: config.apiKey || config.smtpPass }
      });
      await transporter.sendMail({ from: config.smtpUser, to, subject, html });
      return res.json({ ok: true });
    }
    return res.status(400).json({ ok: false, error: 'ยังไม่ได้ตั้งค่าผู้ให้บริการอีเมลในหน้าการตั้งค่า' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
