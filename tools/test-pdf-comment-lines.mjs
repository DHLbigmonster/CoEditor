// Isolated browser smoke test; no user vault writes. Requires test server + CDP.
import WebSocket from 'ws';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const base = process.env.COEDITOR_TEST_BASE || 'http://127.0.0.1:4484';
const target = await (await fetch('http://127.0.0.1:9347/json/new?about:blank', {method:'PUT'})).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.once('open', r));
let seq=0; const pending=new Map();
ws.on('message', raw => { const m=JSON.parse(raw); if(pending.has(m.id)){ const p=pending.get(m.id); pending.delete(m.id); m.error?p.reject(m.error):p.resolve(m.result); } });
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
try {
  await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:2,mobile:false});
  await send('Page.navigate',{url:base+'/?doc='+encodeURIComponent('研究设计-英文摘要.pdf')});
  for(let n=0;n<100;n++){if(await evaluate('!!document.querySelector(".pdf-text span") && state.mode === "pdf"'))break;await new Promise(r=>setTimeout(r,100));}
  const check=await evaluate(`(async()=>{
    await window.setPdfZoom(document.getElementById('doc'),1);
    const spans=[...document.querySelectorAll('.pdf-text > span')].filter(n=>n.textContent.trim().length>15);
    if(spans.length<3)throw Error('PDF fixture needs three text runs');
    state.annotations=spans.slice(0,3).map((n,i)=>({id:'test-'+i,quote:n.textContent,body:'PDF underline verification',status:['active','addressed','deprecated'][i],kind:'comment'}));
    await anchorAll();
    return [...document.querySelectorAll('.pdf-text .anchor')].map(n=>{const s=getComputedStyle(n);return {status:n.dataset.status,line:s.textDecorationLine,style:s.textDecorationStyle,color:s.textDecorationColor,text:s.color,width:n.getBoundingClientRect().width};});
  })()`);
  assert(check.some(n=>n.status==='active'&&n.line==='underline'&&n.style==='dashed'&&n.color==='rgb(57, 128, 90)'&&n.width>0));
  assert(check.some(n=>n.status==='addressed'&&n.color==='rgb(139, 143, 139)'));
  assert(check.some(n=>n.status==='deprecated'&&n.line==='none'));
  assert(check.every(n=>n.text==='rgba(0, 0, 0, 0)'));
  const before=await evaluate(`document.querySelector('.pdf-text .anchor').getBoundingClientRect().width`);
  await evaluate(`(async()=>{await window.setPdfZoom(document.getElementById('doc'),1.5);await anchorAll();})()`);
  const after=await evaluate(`document.querySelector('.pdf-text .anchor').getBoundingClientRect().width`);
  assert(Math.abs(after/before-1.5)<0.05,'underline must follow PDF text zoom: '+after/before);
  await evaluate(`(async()=>{await window.setPdfZoom(document.getElementById('doc'),1);await anchorAll();})()`);
  await new Promise(r=>setTimeout(r,500));
  const shot=await send('Page.captureScreenshot',{format:'png'});
  await writeFile('/tmp/coeditor-pdf-comment-lines.png',Buffer.from(shot.data,'base64'));
  console.log(JSON.stringify({passed:true,checks:check,zoomRatio:after/before,screenshot:'/tmp/coeditor-pdf-comment-lines.png'}));
} finally {await send('Page.close');ws.close();}
