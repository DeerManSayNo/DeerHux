import fs from 'node:fs';
import sharp from 'sharp';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const css=fs.readFileSync(path.resolve(__dirname,'../../../../app/globals.css'),'utf8');
const colors=[...css.matchAll(/--accent:\s*([^;]+);/g)].map(x=>x[1].trim());
const opts=[
['01','开环','一段圆弧，一个开口。','<path d="M177.5 78.5A70 70 0 1 0 177.5 177.5" fill="none" stroke="currentColor" stroke-width="36" stroke-linecap="round"/>'],
['02','斜面','一个形体，一个倾角。','<path d="M114 53H176Q194 53 188 72L150 190Q146 203 132 203H80Q62 203 68 184L106 66Q110 53 124 53Z" fill="currentColor"/>'],
['03','半圆','一条直边，一条弧线。','<path d="M75 48H124A80 80 0 0 1 124 208H75Q67 208 67 200V56Q67 48 75 48Z" fill="currentColor"/>']];
const mark=(o,x,y,s,c)=>`<g transform="translate(${x} ${y}) scale(${s/256})" color="${c}">${o[3]}</g>`;
const tile=(o,x,y,s,d=false)=>`<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${s*.225}" fill="${d?'#191a1b':'#fff'}" stroke="${d?'#333436':'#e3e3e5'}"/>${mark(o,x+s*.09,y+s*.09,s*.82,d?colors[1]:colors[0])}`;
const txt=(x,y,t,s=18,c='#202022',w=400)=>`<text x="${x}" y="${y}" font-family="PingFang SC,Helvetica Neue,Arial,sans-serif" font-size="${s}" fill="${c}" font-weight="${w}">${t}</text>`;
const svg=(b,w,h)=>`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${b}</svg>`;
(async()=>{
let b='<rect width="1440" height="960" fill="#f5f5f6"/>';
b+=txt(64,65,'DeerHux / 极简轮廓',27,'#202022',600)+txt(64,114,'先看形状，不附加故事。',19,'#77777b');
for(let i=0;i<opts.length;i++){
const o=opts[i],x=64+i*456;
if(i)b+=`<path d="M${x-28} 185V865" stroke="#dddde0"/>`;
b+=txt(x,207,o[0],16,colors[0],600)+txt(x+38,207,o[1],24,'#202022',600)+mark(o,x+54,243,300,'#202022')+txt(x,580,o[2],17,'#77777b');
b+=tile(o,x+8,623,144)+tile(o,x+176,623,144,true)+tile(o,x+15,812,32)+mark(o,x+96,816,24,'#202022')+mark(o,x+173,820,16,'#202022')+txt(x+241,835,'32 / 24 / 16 px',12,'#77777b');
fs.writeFileSync(path.join(__dirname,o[0]+'-mark.svg'),svg(mark(o,0,0,256,'#202022'),256,256));
for(const d of [false,true]){const s=svg(tile(o,32,32,960,d),1024,1024),f=path.join(__dirname,o[0]+(d?'-dark':'-light'));fs.writeFileSync(f+'.svg',s);await sharp(Buffer.from(s)).png().toFile(f+'.png');}
}
b+=txt(64,919,'第二轮 / 纯几何探索 / 未替换正式图标',14,'#858589');
fs.writeFileSync(path.join(__dirname,'comparison.svg'),svg(b,1440,960));await sharp(Buffer.from(svg(b,1440,960))).png().toFile(path.join(__dirname,'comparison.png'));
})().catch(e=>{console.error(e);process.exit(1)});
