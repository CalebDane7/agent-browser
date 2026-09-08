import assert from 'node:assert/strict';
import test from 'node:test';
import {constants,readFileSync} from 'node:fs';
import * as fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname,join,resolve,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {canonicalJson,isAccount,isSession} from '../scripts/agent-browser-extension-protocol.js';

const source=readFileSync(new URL('../scripts/agent-browser-private-cws-wrapper.js',import.meta.url),'utf8');
// Load the production function bodies, with only module imports/entrypoint
// removed. No broker, Chrome, child process, user configuration, or real engine
// is contacted. The real protocol validators remain in this focused seam.
function load(env={},file=null,realFixtureHome=null) {
  let ownerCalls=0,brokerCalls=0;
  const io={opens:0,reads:0,closes:0};
  const bytes=Buffer.from(file?.contents??'enrolled-primary\n');
  const context={
    process:{env,getuid:()=>1000,argv:[]},
    os:{homedir:()=>'/fixture/home',userInfo:()=>({username:'os-owner',homedir:'/fixture/os-home'})},
    dirname,join,resolve,isAbsolute,fileURLToPath,
    Buffer,constants,
    openSync:(path,flags)=>{
      io.opens++;
      assert.equal(path,'/fixture/os-home/.config/agent-browser/default-account');
      assert.equal(flags,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      if(!file||file.openError)throw Error(file?.openError??'ENOENT');
      return 7;
    },
    fstatSync:fd=>{
      assert.equal(fd,7);
      return {isFile:()=>!file.directory,uid:file.uid??1000n,mode:file.mode??0o100600n,size:file.size??BigInt(bytes.length)};
    },
    readSync:(fd,buffer,offset,length,position)=>{
      assert.equal(fd,7);assert.equal(offset,0);assert.equal(position,0);assert.equal(length,131);
      io.reads++;
      return bytes.copy(buffer,offset,0,file.readCount??length);
    },
    closeSync:fd=>{assert.equal(fd,7);io.closes++;},
    realpathSync:path=>path,
    readFileSync:path=>{
      assert.equal(path,'/fixture/scripts/pinned-agent-browser-engine.json');
      return '{}';
    },
    canonicalJson,isAccount,isSession,
    resolveInvokingOwner:()=>{ownerCalls++;throw Error('Unexpected owner contact');},
    ensureExtensionBroker:()=>{brokerCalls++;throw Error('Unexpected broker contact');},
  };
  if(realFixtureHome){
    context.process.getuid=()=>process.getuid();
    context.os.userInfo=()=>({username:'fixture-owner',homedir:realFixtureHome});
    for(const name of ['openSync','fstatSync','readSync','closeSync'])context[name]=fs[name];
  }
  const runnable=source
    .replace(/^#![^\n]*\n/,'')
    .replace(/^import[\s\S]*?from ["'][^"']+["'];\n/gm,'')
    .replaceAll('import.meta.url','"file:///fixture/scripts/agent-browser-private-cws-wrapper.js"')
    .replace(/^export (?=(?:async )?function)/gm,'')
    .replace(/^if \(resolve\(process\.argv\[1\][^\n]*await main\(\);$/m,'');
  vm.runInNewContext(runnable+'\nthis.hooks={parseWrapperArgs,engineEnvironment,run,ENGINE_PATH,RUNTIME_HOME};',context);
  return {...context.hooks,contacts:()=>({ownerCalls,brokerCalls}),fileIo:()=>({...io})};
}
const plain=value=>JSON.parse(JSON.stringify(value));
const argv=['--session','fixture-task','open','https://example.com/'];

test('owner-only file preserves omitted-account mapping; explicit account never reads it',()=>{
  const configured=load({AGENT_BROWSER_PRIVATE_CWS_DEFAULT_ACCOUNT:'ignored-ambient'},{});
  assert.deepEqual(plain(configured.parseWrapperArgs(argv)),{
    account:'enrolled-primary',session:'fixture-task',currentTab:false,
    forwarded:['open','https://example.com/'],
  });
  assert.deepEqual(configured.fileIo(),{opens:1,reads:1,closes:1});
  for(const file of [null,{mode:0o100644n},{openError:'ELOOP'}]){
    const explicit=load({},file);
    assert.equal(explicit.parseWrapperArgs(['--account=enrolled-secondary',...argv]).account,'enrolled-secondary');
    assert.deepEqual(explicit.fileIo(),{opens:0,reads:0,closes:0});
  }
});

test('missing, unsafe, changed or malformed default files reject before owner or broker contact',async()=>{
  for(const file of [null,{openError:'ELOOP'},{uid:999n},{mode:0o100640n},{directory:true},{contents:''},{contents:'x'.repeat(131)},{contents:'INVALID DEFAULT'},{contents:'first\nsecond\n'},{contents:'value ',size:6n},{size:3n},{readCount:1}]){
    const hooks=load({},file);
    await assert.rejects(hooks.run(argv),error=>error.exitCode===69);
    assert.deepEqual(hooks.contacts(),{ownerCalls:0,brokerCalls:0});
    assert.equal(hooks.fileIo().closes,file&&!file.openError?1:0);
  }
});

test('bounded default file accepts the existing account grammar and one optional line ending',()=>{
  for(const contents of ['primary','primary\n','primary\r\n','x'.repeat(128)+'\r\n']){
    const hooks=load({}, {contents,mode:0o100400n});
    assert.equal(hooks.parseWrapperArgs(argv).account,contents.replace(/\r?\n$/,''));
    assert.deepEqual(hooks.fileIo(),{opens:1,reads:1,closes:1});
  }
});

test('production default reader enforces real owner-only file modes and O_NOFOLLOW on a task-owned fixture',()=>{
  const root=fs.mkdtempSync(join(dirname(fileURLToPath(import.meta.url)),'.default-account-fixture-'));
  const config=join(root,'.config'),directory=join(config,'agent-browser');
  const path=join(directory,'default-account'),target=join(directory,'synthetic-account');
  try{
    fs.mkdirSync(config,{mode:0o700});fs.mkdirSync(directory,{mode:0o700});
    fs.writeFileSync(path,'fixture-account\n',{flag:'wx',mode:0o600});
    const hooks=load({},null,root);
    assert.equal(hooks.parseWrapperArgs(argv).account,'fixture-account');
    fs.chmodSync(path,0o640);
    assert.throws(()=>hooks.parseWrapperArgs(argv),error=>error.exitCode===69&&/unsafe/.test(error.message));
    fs.chmodSync(path,0o600);fs.renameSync(path,target);fs.symlinkSync(target,path);
    assert.throws(()=>hooks.parseWrapperArgs(argv),error=>error.exitCode===69&&/unavailable/.test(error.message));
    assert.deepEqual(hooks.contacts(),{ownerCalls:0,brokerCalls:0});
  }finally{
    for(const file of [path,target]){try{fs.unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}}
    for(const dir of [directory,config,root]){try{fs.rmdirSync(dir);}catch(error){if(error.code!=='ENOENT')throw error;}}
  }
});

test('derived paths and actual OS username replace literals without forwarding mismatched ambient identity',()=>{
  const hooks=load({USER:'ambient-other',LOGNAME:'another-ambient-user',UNRELATED_VALUE:'must-not-forward'});
  assert.equal(hooks.ENGINE_PATH,'/fixture/home/.local/lib/agent-browser/agent-browser-v0.36.0-linux-x64');
  assert.equal(hooks.RUNTIME_HOME,'/fixture/home');
  const env=plain(hooks.engineEnvironment({controlSocket:'/fixture/control.sock'},'/fixture/grant','/fixture/diagnostic'));
  assert.equal(env.HOME,'/fixture/home');assert.equal(env.USER,'os-owner');assert.equal(env.LOGNAME,'os-owner');
  assert.equal(env.PATH,'/usr/bin:/bin');assert.equal(env.LANG,'C.UTF-8');assert.equal(env.LC_ALL,'C.UTF-8');
  assert.equal(env.AGENT_BROWSER_PROVIDER_GRANT_PATH,'/fixture/grant');
  assert.equal(env.AGENT_BROWSER_PROVIDER_DIAGNOSTIC_PATH,'/fixture/diagnostic');
  assert.equal(env.AGENT_BROWSER_CONFIG,'/fixture/scripts/canonical-wrapper-config.json');
  assert.equal(env.AGENT_BROWSER_EXTENSION_CONTROL_SOCKET,'/fixture/control.sock');
  assert.equal(env.AGENT_BROWSER_NO_WEBMCP,'1');assert.equal(env.AGENT_BROWSER_PIN_TAB,'1');
  assert.equal(env.AGENT_BROWSER_MAX_OUTPUT,'20000');
  assert.equal(Object.hasOwn(env,'UNRELATED_VALUE'),false);
  assert.equal(Object.hasOwn(env,'AGENT_BROWSER_PRIVATE_CWS_DEFAULT_ACCOUNT'),false);
});

test('existing isolated engine and runtime-home overrides remain exact',()=>{
  const hooks=load({AGENT_BROWSER_PRIVATE_CWS_ENGINE_PATH:'/fixture/isolated/engine',AGENT_BROWSER_PRIVATE_CWS_RUNTIME_HOME:'/fixture/isolated/home'});
  assert.equal(hooks.ENGINE_PATH,'/fixture/isolated/engine');
  assert.equal(hooks.RUNTIME_HOME,'/fixture/isolated/home');
  assert.equal(hooks.engineEnvironment({controlSocket:'/fixture/control.sock'},'/fixture/grant','/fixture/diagnostic').HOME,'/fixture/isolated/home');
});

test('publication repair leaves capability rejection and invoking-cwd inheritance in place',()=>{
  const hooks=load({},{});
  for(const args of [
    ['--account','enrolled-primary','--account','enrolled-secondary',...argv],
    ['--cdp','9222',...argv],['--session','fixture-task','close','--all'],
  ])assert.throws(()=>hooks.parseWrapperArgs(args),error=>error.exitCode===64);
  const spawn=source.match(/const child = spawn\(\n        ENGINE_PATH,[\s\S]*?\n      \);/);
  assert.ok(spawn,'production engine spawn is still explicit');
  // WHY: shared-command execution adds a scoped flag around engineEnvironment.
  // Its object-spread syntax changed, not cwd/environment custody. Execute the
  // actual spawn expression and judge those behaviors instead of its spelling.
  for(const closesSession of [false,true]){
    const calls=[],base={HOME:'/fixture/runtime',PATH:'/usr/bin:/bin'};
    const scope={ENGINE_PATH:'/fixture/engine',engineSession:'fixture-task',NAMESPACE:'fixture',
      providerArgs:[],options:{forwarded:[closesSession?'close':'snapshot']},closesSession,
      receipt:{controlSocket:'/fixture/control.sock'},grantPath:'/fixture/grant',diagnosticPath:'/fixture/diagnostic',
      engineEnvironment:(receipt,grant,diagnostic)=>{
        assert.equal(receipt.controlSocket,'/fixture/control.sock');
        assert.equal(grant,'/fixture/grant');assert.equal(diagnostic,'/fixture/diagnostic');return base;
      },spawn:(...args)=>{calls.push(args);return {};}};
    vm.runInNewContext(spawn[0],scope);
    assert.equal(calls.length,1);assert.equal(calls[0][0],'/fixture/engine');
    const childOptions=calls[0][2];
    assert.deepEqual({...childOptions.env},{...base,...(!closesSession?{AGENT_BROWSER_PRIVATE_CWS_TRANSACTION:'1'}:{})});
    assert.equal(childOptions.stdio,'inherit');
    assert.equal(Object.hasOwn(childOptions,'cwd'),false,'relative upload must retain invoking cwd');
  }
  assert.doesNotMatch(source,/process\.chdir\s*\(/);
  assert.match(source,/sha256\(readFileSync\(ENGINE_PATH\)\) !== ENGINE_PIN\.engine\.sha256/);
});

test('public launcher preserves namespace filtering, env-i, arguments and cwd without private identity constants',()=>{
  const launcher=fileURLToPath(new URL('../scripts/agent-browser-real-chrome',import.meta.url));
  // Execute the production shell, intercepting only its final exec. Node, the
  // wrapper and browser are not run; this judges the actual forwarding branch.
  const driver='exec() { /usr/bin/printf "%s\\0" "$PWD" "$@"; }; source "$1" "${@:2}"';
  const namespace='11111111-1111-4111-8111-111111111111';
  const inherited={PATH:'/usr/bin:/bin',HOME:'/fixture/ignored-home',USER:'ignored-user',LOGNAME:'ignored-user',NODE_OPTIONS:'ignored-options',AGENT_BROWSER_PRIVATE_CWS_ENGINE_PATH:'/fixture/ignored-engine',CODEX_THREAD_ID:namespace};
  const invoked=spawnSync('/usr/bin/bash',['-c',driver,'fixture',launcher,'--account','enrolled-primary',...argv],{env:inherited,cwd:'/tmp',encoding:'utf8',timeout:2000});
  assert.equal(invoked.status,0);
  assert.deepEqual(invoked.stdout.split('\0').slice(0,-1),[
    '/tmp','/usr/bin/env','-i','CODEX_THREAD_ID='+namespace,
    'PATH=/usr/bin:/bin','LANG=C.UTF-8','LC_ALL=C.UTF-8',
    // Admission now imports wrapper main in this same Node process. The public
    // forwarding contract remains scrubbed environment, original argv and cwd.
    '/usr/bin/node',join(dirname(launcher),'agent-browser-admission.mjs'),
    '--account','enrolled-primary',...argv,
  ]);
  const rejected=spawnSync('/usr/bin/bash',['-c',driver,'fixture',launcher,...argv],{env:{...inherited,CODEX_THREAD_ID:'invalid-namespace'},cwd:'/tmp',encoding:'utf8',timeout:2000});
  assert.equal(rejected.status,70);assert.equal(rejected.stdout,'');
  assert.match(rejected.stderr,/owner namespace metadata is invalid/);
});
