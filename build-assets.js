// Generate shipped copies from the current app and database sources.
const fs=require('node:fs');
const path=require('node:path');
const root=__dirname;
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
fs.writeFileSync(path.join(root,'database-config.js'),'window.FRESHY_SQL='+JSON.stringify(read('database.sql'))+';\n');
let html=read('index.html');
html=html.replace(/<link\s+rel="stylesheet"\s+href="([^\"]+)"\s*>/g,(_,src)=>'<style>'+read(src.split('?')[0])+'</style>');
html=html.replace(/<script\s+src="([^"]+)"\s*><\/script>/g,(_,src)=>'<script>\n'+read(src.split('?')[0]).replace(/<\/script/gi,'<\\/script')+'\n</script>');
html=html.replace(/url\(['"]?(vendor\/fonts\/[^)'"\s]+)['"]?\)/g,(_,src)=>'url(data:font/woff2;base64,'+fs.readFileSync(path.join(root,src)).toString('base64')+')');
fs.writeFileSync(path.join(root,'freshy-water-standalone.html'),html);
const output=path.join(root,'dist');
fs.mkdirSync(output,{recursive:true});
for(const name of ['index.html','app.js','sync.js','features.js','ui.css','report.css','document.html','document.css','document-view.js','deploy-config.js','database-config.js','freshy-water-standalone.html','database.sql'])fs.copyFileSync(path.join(root,name),path.join(output,name));
fs.cpSync(path.join(root,'vendor'),path.join(output,'vendor'),{recursive:true});
const preview=read('index.html').replace('<script src="deploy-config.js"></script>', '<script>window.FRESHY_PREVIEW=true;window.FRESHY_CONFIG={mode:"demo"};</script>').replace('type="password" id="loginCode"','type="text" id="loginCode"').replace('<p class="sub">โรงน้ำดื่ม เฟรชชี่ วอเตอร์</p>','<p class="sub">ตัวอย่างการออกแบบ · ข้อมูลจำลองเท่านั้น</p>');
fs.writeFileSync(path.join(output,'design-preview.html'),preview);
fs.writeFileSync(path.join(output,'mobile-preview.html'),`<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ตัวอย่างระบบบนมือถือ</title><style>body{margin:0;background:#f2f3ef;font:14px system-ui;color:#242820}header{padding:12px;display:flex;justify-content:center;align-items:center;gap:16px;flex-wrap:wrap}select{font:inherit;padding:8px;border:1px solid #cbd3c5;border-radius:8px}main{display:flex;justify-content:center}iframe{height:844px;border:1px solid #dce2d5;background:white;max-width:100%}</style></head><body><header><span>ตัวอย่างหน้ามือถือ · ข้อมูลจำลอง</span><label>ความกว้างหน้าจอ <select id="previewWidth"><option value="360">360 px</option><option value="390" selected>390 px</option><option value="430">430 px</option></select></label></header><main><iframe id="mobilePreview" title="ตัวอย่างระบบบนมือถือ · ข้อมูลจำลอง" src="/design-preview" style="width:390px"></iframe></main><script>document.getElementById('previewWidth').addEventListener('change',e=>document.getElementById('mobilePreview').style.width=e.target.value+'px');</script></body></html>`);
console.log('Generated current setup SQL, standalone HTML, and static deployment files in dist.');

