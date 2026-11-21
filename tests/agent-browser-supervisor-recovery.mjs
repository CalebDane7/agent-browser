// R48 guard: recovery uses process birth, never numeric PID presence.
// Only disposable /tmp processes/endpoints are exercised; no Chrome state.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const option=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const candidate=await import(pathToFileURL(option('--candidate')||path.join(repoRoot,'scripts','agent-browser-extension-supervisor.js')));
const baselinePath=option('--baseline');
const original=baselinePath?await import(pathToFileURL(baselinePath)):null;
const {requestExtensionControl}=await import(pathToFileURL(path.join(repoRoot,'scripts','agent-browser-extension-control.js')));

const base=fs.mkdtempSync(path.join(os.tmpdir(),'agent-browser-supervisor-guard-'));
const broker=path.join(repoRoot,'scripts','agent-browser-extension-broker.js');
const hash=b=>createHash('sha256').update(b).digest('hex');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const birth=pid=>{const s=fs.readFileSync(`/proc/${pid}/stat`,'utf8');return s.slice(s.lastIndexOf(')')+2).trim().split(/\s+/)[19];};
const report={at:new Date().toISOString(),scope:'Genuine disposable broker, kernel process births and endpoint servers. Constructed orphan receipt combines prior broker birth with unrelated live PID; actual kernel PID recycling is not induced. No Chrome/native extension/profile path exercised.',cases:[],cleanup:[]};
const children=[];const servers=[];const roots=[];
const names=['broker.json','broker.lock','native.sock','control.sock'];
let index=0;
function snapshot(root){return Object.fromEntries(names.map(name=>{const p=path.join(root,name);try{const s=fs.lstatSync(p);return [name,{ino:s.ino,dev:s.dev,mode:s.mode,hash:s.isFile()?hash(fs.readFileSync(p)):null}];}catch(e){if(e.code==='ENOENT')return [name,null];throw e;}}));}
function track(pid){const item={pid,birth:birth(pid)};children.push(item);return item;}
async function stop(item,signal='SIGTERM'){
  try{assert.equal(birth(item.pid),item.birth);process.kill(item.pid,signal);}catch(e){if(e.code==='ENOENT'||e.code==='ESRCH')return;throw e;}
  for(let i=0;i<150;i++){try{birth(item.pid);}catch(e){if(e.code==='ENOENT')return;throw e;}await delay(10);}
  throw new Error(`fixture process ${item.pid} did not exit`);
}
async function ready(root,config,child){
 for(let i=0;i<150;i++){
  try{const r=await candidate.requireExtensionBroker({stateRoot:root,profileConfig:config});assert.equal(r.pid,child.pid);assert.equal(r.startTicks,birth(child.pid));return r;}catch{}await delay(10);
 }throw new Error('disposable broker did not become ready');
}
async function fixture(){
 const root=path.join(base,`r${index++}`);fs.mkdirSync(root,{mode:0o700});roots.push(root);
 const config=path.join(root,'profiles.json');
 fs.writeFileSync(config,JSON.stringify({schema:'agent-browser.extension-profiles.v1',extensionOrigin:'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/',profiles:[]}),{mode:0o600});
 const child=spawn(process.execPath,[broker,'--state-root',root,'--profile-config',config],{stdio:['ignore','ignore','pipe']});
 child.stderr.on('data',()=>{});await delay(5);const item=track(child.pid);
 const r=await ready(root,config,child);
 return {root,config,r,item};
}
async function orphan(){
 const f=await fixture();await stop(f.item,'SIGKILL');await delay(30);
 const sleeper=spawn('/usr/bin/sleep',['60'],{stdio:'ignore'});await delay(5);f.other=track(sleeper.pid);
 assert.notEqual(f.other.birth,f.r.startTicks);
 f.r={...f.r,pid:f.other.pid};
 fs.writeFileSync(path.join(f.root,'broker.json'),JSON.stringify(f.r)+'\n');
 fs.writeFileSync(path.join(f.root,'broker.lock'),`${f.other.pid}\n`);
 return f;
}
async function listen(options){const server=net.createServer(socket=>socket.destroy());servers.push(server);server.listen(options);await once(server,'listening');return server;}
async function veto(name,change){
 const f=await orphan();await change(f);const before=snapshot(f.root);
 let error;try{await candidate.ensureExtensionBroker({stateRoot:f.root,profileConfig:f.config});}catch(e){error=e.message;}
 assert.ok(error,`${name}: expected veto`);assert.deepEqual(snapshot(f.root),before);
 assert.equal(birth(f.other.pid),f.other.birth);
 report.cases.push({name,result:'PASS',error,stateUnchanged:true,unrelatedOwnerPreserved:true});
}
try{
 const freshRoot=path.join(base,'fresh-root'),freshConfig=path.join(base,'fresh-profiles.json');
 assert.equal(fs.existsSync(freshRoot),false);roots.push(freshRoot);
 fs.writeFileSync(freshConfig,JSON.stringify({schema:'agent-browser.extension-profiles.v1',extensionOrigin:'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/',profiles:[]}),{mode:0o600});
 const fresh=await candidate.ensureExtensionBroker({stateRoot:freshRoot,profileConfig:freshConfig});track(fresh.pid);
 assert.equal(fresh.startTicks,birth(fresh.pid));assert.equal(fs.lstatSync(freshRoot).mode&0o777,0o700);assert.equal(fs.lstatSync(path.join(freshRoot,'admission.lock')).mode&0o777,0o600);
 const freshHealth=await requestExtensionControl(fresh.controlSocket,{op:'health'});assert.equal(freshHealth.pid,fresh.pid);
 report.cases.push({name:'absent fresh root bootstraps real broker with private admission lock',result:'PASS',pid:fresh.pid});
 if(!process.argv.includes('--fresh-only')){
 const f=await orphan(),before=snapshot(f.root);
 if(original){
 await assert.rejects(original.ensureExtensionBroker({stateRoot:f.root,profileConfig:f.config}));
 assert.deepEqual(snapshot(f.root),before);assert.equal(birth(f.other.pid),f.other.birth);
 report.cases.push({name:'old supervisor rejects genuine-process orphan mismatch',result:'OLD_RED',originalBrokerBirth:f.r.startTicks,unrelatedPID:f.other.pid,observedUnrelatedBirth:f.other.birth,stateUnchanged:true});
 }
 const [newReceipt,concurrentReceipt]=await Promise.all([candidate.ensureExtensionBroker({stateRoot:f.root,profileConfig:f.config}),candidate.ensureExtensionBroker({stateRoot:f.root,profileConfig:f.config})]);
 track(newReceipt.pid);assert.equal(newReceipt.pid,concurrentReceipt.pid);assert.notEqual(newReceipt.pid,f.other.pid);
 assert.equal(newReceipt.startTicks,birth(newReceipt.pid));assert.equal(newReceipt.sourceSha256,hash(fs.readFileSync(broker)));
 assert.equal(newReceipt.profileConfigSha256,hash(fs.readFileSync(f.config)));
 const health=await requestExtensionControl(newReceipt.controlSocket,{op:'health'});
 assert.equal(health.pid,newReceipt.pid);assert.deepEqual(health.connectedProfiles,[]);assert.equal(birth(f.other.pid),f.other.birth);
 report.cases.push({name:'candidate recovers orphan and concurrent supervisor adopts same real broker',result:'NEW_GREEN',pid:newReceipt.pid,birth:newReceipt.startTicks,ordinaryHealth:true,unrelatedOwnerPreserved:true});
 const warm=snapshot(f.root);const retained=await candidate.ensureExtensionBroker({stateRoot:f.root,profileConfig:f.config});assert.equal(retained.pid,newReceipt.pid);assert.deepEqual(snapshot(f.root),warm);
 report.cases.push({name:'serving valid broker retains exact state',result:'PASS'});
 await veto('broker-shaped reused PID is ambiguous',f=>{f.r.pid=newReceipt.pid;f.other=children.find(child=>child.pid===newReceipt.pid);fs.writeFileSync(path.join(f.root,'broker.lock'),`${newReceipt.pid}\n`);fs.writeFileSync(path.join(f.root,'broker.json'),JSON.stringify(f.r));});
 await veto('matching birth with unavailable endpoints',f=>{f.r.startTicks=f.other.birth;fs.writeFileSync(path.join(f.root,'broker.json'),JSON.stringify(f.r));});
 await veto('malformed receipt',f=>fs.writeFileSync(path.join(f.root,'broker.json'),JSON.stringify({...f.r,unexpected:true})));
 await veto('missing receipt is ambiguous',f=>fs.unlinkSync(path.join(f.root,'broker.json')));
 await veto('receipt lock PID mismatch',f=>fs.writeFileSync(path.join(f.root,'broker.lock'),`${process.pid}\n`));
 await veto('source identity mismatch',f=>fs.writeFileSync(path.join(f.root,'broker.json'),JSON.stringify({...f.r,sourceSha256:'0'.repeat(64)})));
 await veto('config identity mismatch',f=>fs.appendFileSync(f.config,' '));
 await veto('unsafe socket member blocks all retirement',f=>{fs.unlinkSync(path.join(f.root,'control.sock'));fs.writeFileSync(path.join(f.root,'control.sock'),'retain',{mode:0o600});});
 await veto('genuine serving Unix endpoint',async f=>{fs.unlinkSync(path.join(f.root,'control.sock'));await listen({path:path.join(f.root,'control.sock')});});
 await veto('genuine serving recorded TCP endpoint',async f=>{const s=await listen({host:'127.0.0.1',port:0});f.r.webSocketPort=s.address().port;fs.writeFileSync(path.join(f.root,'broker.json'),JSON.stringify(f.r));});
 await veto('missing lock cannot authorize serving socket cleanup',async f=>{fs.unlinkSync(path.join(f.root,'broker.lock'));fs.unlinkSync(path.join(f.root,'native.sock'));await listen({path:path.join(f.root,'native.sock')});});
 const departed=await fixture();await stop(departed.item,'SIGKILL');
 const recoveredDeparted=await candidate.ensureExtensionBroker({stateRoot:departed.root,profileConfig:departed.config});track(recoveredDeparted.pid);
 assert.equal(recoveredDeparted.startTicks,birth(recoveredDeparted.pid));
 report.cases.push({name:'genuinely departed original owner recovers',result:'PASS',pid:recoveredDeparted.pid});
 }
 report.result='PASS';
}catch(e){report.result='FAIL';report.error={message:e.message,stack:e.stack};process.exitCode=1;}
finally{
 for(const server of servers){await new Promise(resolve=>server.close(resolve));}
 for(const child of children){try{await stop(child);report.cleanup.push({...child,absent:true});}catch(e){report.cleanup.push({...child,absent:false,error:e.message});report.result='FAIL';process.exitCode=1;}}
 fs.rmSync(path.join(base,'fresh-profiles.json'),{force:true});
 const allGone=report.cleanup.every(child=>child.absent);
 if(allGone)fs.rmSync(base,{recursive:true,force:true});
 report.cleanupRootsRemoved=allGone&&!fs.existsSync(base);
 if(!report.cleanupRootsRemoved){report.result='FAIL';report.retainedRuntimeRoot=base;process.exitCode=1;}
 console.log(JSON.stringify(report,null,2));
}
