import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
const CHROME = ['C://Program Files\\Google\\Chrome\\Application\\chrome.exe','C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
const b = await puppeteer.launch({executablePath:CHROME,headless:'new',args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
const p = await b.newPage();
p.on('pageerror',e=>console.log('[pageerror]',e.message));
await p.goto('http://127.0.0.1:8140/index.html?capture=1&ped=40',{waitUntil:'domcontentloaded',timeout:120000});
await p.waitForFunction(()=>window.__ready===true,{timeout:300000,polling:300});
const r = await p.evaluate(async()=>{
  const F=window.__flood;
  await F.load('u_p80_s0');
  await new Promise(r=>setTimeout(r,800));
  const m=F.manifest;
  const fr = m.frames[3];
  let fetched='';
  try { const res=await fetch(m.root+fr.vel,{cache:'no-cache'}); const ab=await res.arrayBuffer(); fetched=res.status+' bytes='+ab.byteLength+' first='+new Uint8Array(ab)[0]+','+new Uint8Array(ab)[1]; } catch(e){ fetched='ERR '+e.message; }
  F.showMinute(1125);
  await new Promise(r=>setTimeout(r,2000));
  const x=-1277+300*8+4, z=-4189+300*8+4;
  return {keys:Object.keys(fr), root:m.root, velocity:m.velocity, velFile:fr.vel, fetched, d:+F.depthAt(x,z,1125).toFixed(3), sp:+F.speedAt(x,z,1125).toFixed(3)};
});
console.log(JSON.stringify(r,null,1));
await b.close();
