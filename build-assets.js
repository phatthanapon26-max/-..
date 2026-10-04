// Generate shipped copies from the current app and database sources.
const fs=require('node:fs');
const path=require('node:path');
const root=__dirname;
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
fs.writeFileSync(path.join(root,'database-config.js'),'window.FRESHY_SQL='+JSON.stringify(read('database.sql'))+';\n');
let html=read('index.html');
html=html.replace(/<script\s+src="([^"]+)"\s*><\/script>/g,(_,src)=>'<script>\n'+read(src.split('?')[0]).replace(/<\/script/gi,'<\\/script')+'\n</script>');
html=html.replace(/url\(['"]?(vendor\/fonts\/[^)'"\s]+)['"]?\)/g,(_,src)=>'url(data:font/woff2;base64,'+fs.readFileSync(path.join(root,src)).toString('base64')+')');
fs.writeFileSync(path.join(root,'freshy-water-standalone.html'),html);
console.log('Generated database-config.js and standalone HTML from current sources.');
