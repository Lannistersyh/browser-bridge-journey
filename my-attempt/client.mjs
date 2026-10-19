#!/usr/bin/env node
// EdgeBridge Agent 侧客户端 v2.0
// 用法：
//   node client.mjs eval '<js>' [--match xxx]
//   node client.mjs cdp <method> <json> [--match xxx]
//   node client.mjs tabs | open <url> | activate <tabId> | close <tabId> | detach
//   node client.mjs shot [file] [--match xxx]        # 视口截图存 PNG
//   node client.mjs watch                             # 事件流（__tabs_event 等）
import net from 'node:net';
import fs from 'node:fs';

const SOCK = '/tmp/edgebridge.sock';
const [cmd, ...rest] = process.argv.slice(2);

function usage(){ console.error('usage: client.mjs eval "<js>" | cdp <m> <json> | tabs | open <url> | activate <id> | close <id> | detach | shot [file] | watch  [--match x]'); process.exit(1); }
if (!cmd) usage();
if (!fs.existsSync(SOCK)) { console.error(JSON.stringify({ ok:false, error:'bridge not running（扩展未加载或未连接）'})); process.exit(2); }

let match = null;
const mi = rest.indexOf('--match');
if (mi >= 0) { match = { urlIncludes: rest[mi+1] }; rest.splice(mi,2); }

function connect(){
  return net.createConnection(SOCK);
}
function rpc(payload){
  return new Promise((resolve,reject)=>{
    const c=connect();
    let buf='';
    c.on('connect',()=>c.write(JSON.stringify(payload)+'\n'));
    c.on('data',d=>{ buf+=d.toString(); const i=buf.indexOf('\n');
      if(i>=0){ c.end(); try{resolve(JSON.parse(buf.slice(0,i)))}catch(e){reject(e)} } });
    c.on('error',reject);
    setTimeout(()=>{c.destroy();reject(new Error('timeout'))},32000);
  });
}

let method, params;
switch(cmd){
  case 'eval':
    method='Runtime.evaluate';
    params={expression:rest[0],returnByValue:true,awaitPromise:true}; break;
  case 'cdp':
    method=rest[0]; params=rest[1]?JSON.parse(rest[1]):{}; break;
  case 'tabs':     method='__tabs'; params={}; break;
  case 'open':     method='__open'; params={url:rest[0],wait:rest[1]?+rest[1]:6000}; break;
  case 'activate': method='__activate'; params={tabId:+rest[0]}; break;
  case 'close':    method='__close'; params={tabId:+rest[0]}; break;
  case 'detach':   method='__detach'; params={}; break;
  case 'shot':     method='__screenshot'; params={}; break;
  case 'watch': {
    // 事件流：保持连接，打印所有下行帧
    const c=connect();
    c.on('data',d=>process.stdout.write(d));
    c.on('error',e=>{console.error(String(e));process.exit(1)});
    // 发一个空请求触发 host 关联？事件是主动推送——host 侧对事件帧广播到所有连接
    c.write(JSON.stringify({method:'__tabs',params:{},match:null})+'\n');
    process.on('SIGINT',()=>{c.end();process.exit(0)});
    break;
  }
  default: usage();
}
if(cmd!=='watch'){
  const r=await rpc({method,params,match});
  if(cmd==='shot' && r.ok && r.result && r.result.data){
    const f=rest[0]&&!rest[0].startsWith('--')?rest[0]:'/tmp/edgebridge_shot.png';
    fs.writeFileSync(f,Buffer.from(r.result.data,'base64'));
    console.log(JSON.stringify({ok:true,file:f,bytes:r.result.data.length*0.75|0}));
  } else console.log(JSON.stringify(r,null,1));
}
