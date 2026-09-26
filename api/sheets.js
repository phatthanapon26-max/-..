// api/sheets.js — Vercel Serverless Function
// เชื่อมต่อ Google Sheets เป็นฐานข้อมูล (อ่าน/เขียน) โดยไม่ใช้ Google Apps Script
// ใช้ Service Account จาก Google Cloud Console (แชร์ชีตให้ service account email เป็น Editor)
const { google } = require('googleapis');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const body = req.method === 'POST' ? req.body : req.query;
  const { action, tab, rows, config } = body || {};
  const { sheetId, serviceEmail, serviceKey } = config || {};

  if (!sheetId || !serviceEmail || !serviceKey) {
    return res.status(400).json({ ok: false, error: 'กรุณาตั้งค่า Sheet ID, Service Account Email และ Private Key ในหน้าการตั้งค่า' });
  }
  try {
    const auth = new google.auth.JWT(serviceEmail, null, String(serviceKey).replace(/\\n/g, '\n'), ['https://www.googleapis.com/auth/spreadsheets']);
    const sheets = google.sheets({ version: 'v4', auth });

    if (action === 'test') {
      const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId, fields: 'properties.title' });
      return res.json({ ok: true, title: meta.data.properties.title || 'OK' });
    }
    if (action === 'read') {
      const r = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: `${tab}!A:Z` });
      return res.json({ ok: true, values: r.data.values || [] });
    }
    if (action === 'append') {
      await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId, range: `${tab}!A:Z`, valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS', resource: { values: rows || [] }
      });
      return res.json({ ok: true });
    }
    if (action === 'update') {
      const { rowIndex, values } = body;
      await sheets.spreadsheets.values.update({
        spreadsheetId: sheetId, range: `${tab}!A${rowIndex}:Z${rowIndex}`,
        valueInputOption: 'RAW', resource: { values: [values] }
      });
      return res.json({ ok: true });
    }
    return res.status(400).json({ ok: false, error: 'action ไม่รองรับ' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
