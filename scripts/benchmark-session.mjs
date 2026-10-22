/** Real HTTP/SSE, deterministic store clock: activity retention, not throughput. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
const root=resolve(fileURLToPath(new URL('..',import.meta.url)))
const output=join(root,'output/benchmarks')
mkdirSync(output,{recursive:true})
const dir=mkdtempSync(join(output,'session-'))
const baseline=join(dir,'baseline'); mkdirSync(baseline)
const revision=execFileSync('git',['rev-parse',process.env.BENCH_BASE??'0d4b48c883'],{cwd:root,encoding:'utf8'}).trim()
execFileSync('tar',['-x','-C',baseline],{input:execFileSync('git',['archive',revision,'src'],{cwd:root})})
const variants=[]
for(const [name,source]of [['baseline',join(baseline,'src')],['current',join(root,'src')]]) {
  variants.push({name,proxy:await import(pathToFileURL(join(source,'proxy.ts')).href),sessions:await import(pathToFileURL(join(source,'sessions.ts')).href)})
}
async function run(variant,maxAgeSeconds,steps) {
  let now=0,writer,reader,delivered=0,closed=false
  const changes=new EventEmitter()
  const idleSeconds=maxAgeSeconds===2?0:1
  const store=variant.sessions.createSessionStore({maxAgeSeconds,idleSeconds,now:()=>now})
  const session=store.login({userAgent:'isolated-benchmark'})
  const value=variant.sessions.encodeSessionCookie(session.id,session.secret)
  const cookie='bench='+value
  const backend=createServer((req,res)=>{
    if(req.url==='/probe'){res.end('ok');return}
    writer=res
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'})
    res.write('data: 0\n\n')
  })
  await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve))
  const proxy=await variant.proxy.listenProxy({listenHost:'127.0.0.1',listenPort:0,backendHost:'127.0.0.1',backendPort:backend.address().port,
    accessToken:'session-benchmark',cookieName:'bench',controlPrefix:'/control',maxRequestBytes:1048576,upstreamTimeoutMs:2000,sessionStore:store,compressResponses:false,cacheHashedAssets:false})
  const wait=predicate=>new Promise((resolve,reject)=>{
    const check=()=>{if(predicate()){clearTimeout(timer);changes.off('update',check);resolve()}}
    const timer=setTimeout(()=>{changes.off('update',check);reject(new Error('SSE benchmark timeout'))},2000)
    changes.on('update',check);check()
  })
  let pending=''
  const req=request({host:'127.0.0.1',port:proxy.port,path:'/events',headers:{cookie},agent:false},res=>{
    reader=res
    res.on('data',chunk=>{pending+=chunk.toString();let index;while((index=pending.indexOf('\n\n'))>=0){delivered++;pending=pending.slice(index+2)}changes.emit('update')})
    res.on('error',()=>{})
    res.on('close',()=>{closed=true;changes.emit('update')})
  });req.on('error',()=>{});req.end()
  try{
    await wait(()=>delivered===1)
    let firstMissingAtMs=null,firstClosedAtMs=null
    for(let i=1;i<=steps;i++){
      now=i*800
      const before=delivered
      if(!writer.destroyed)writer.write('data: '+i+'\n\n')
      await wait(()=>delivered>before||closed)
      const count=store.serialize().length
      if(count===0&&firstMissingAtMs===null)firstMissingAtMs=now
      if(closed){firstClosedAtMs=now;break}
    }
    const probe=await new Promise((resolve,reject)=>{
      const p=request({host:'127.0.0.1',port:proxy.port,path:'/probe',headers:{cookie},agent:false},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))})
      p.on('error',reject);p.end()
    })
    return{variant:variant.name,maxAgeSeconds,idleSeconds,stepsRequested:steps,eventIntervalMs:800,simulatedDurationMs:now,deliveredEvents:delivered,firstMissingAtMs,firstClosedAtMs,probeStatus:probe,sessionRetained:store.serialize().length===1,streamStillOpen:!closed}
  }finally{reader?.destroy();req.destroy();writer?.destroy();await proxy.close();backend.closeAllConnections();await new Promise(resolve=>backend.close(resolve))}
}
const samples=[]
for(let round=0;round<5;round++)for(const variant of (round%2===0?variants:[...variants].reverse())){
  samples.push({round,scenario:'continuous-80s',...await run(variant,600,100)})
  samples.push({round,scenario:'absolute-ttl-2s',...await run(variant,2,5)})
}
for(const sample of samples){if(sample.variant==='current'&&sample.scenario==='continuous-80s'){assert.equal(sample.probeStatus,200);assert.equal(sample.sessionRetained,true)}if(sample.variant==='current'&&sample.scenario==='absolute-ttl-2s'){assert.equal(sample.firstClosedAtMs,2400);assert.equal(sample.deliveredEvents,3)}}
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex')
const result={schemaVersion:1,baselineRevision:revision,node:process.version,methodology:'Real loopback HTTP/SSE bytes, deterministic store clock advanced by 800ms only after preceding event received. serialize after each event models persistence sweep. Five paired repetitions. Not wall-clock endurance, mobile reconnect or event-resume benchmark.',sourceHashes:{baselineProxy:hash(join(baseline,'src/proxy.ts')),currentProxy:hash(join(root,'src/proxy.ts')),baselineSessions:hash(join(baseline,'src/sessions.ts')),currentSessions:hash(join(root,'src/sessions.ts'))},samples}
writeFileSync(join(output,'session.json'),JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify(result,null,2))
