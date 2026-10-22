/** Curate actual benchmark artifacts; never infer performance from configuration. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root=fileURLToPath(new URL('..',import.meta.url))
const directory=resolve(root,'output/benchmarks')
const inputs={}
function load(name){const bytes=readFileSync(resolve(directory,name+'.json'));inputs[name]=createHash('sha256').update(bytes).digest('hex');return JSON.parse(bytes.toString())}
const transport=load('transport'),polling=load('polling'),session=load('session')
const gain=(before,after)=>before===0?null:(1-after/before)*100
const normalize=row=>({requests:row.requests/transport.rounds,bodyBytes:row.bodyBytes/transport.rounds,responseHttpBytes:row.responseHttpBytes/transport.rounds,requestHttpBytes:row.requestHttpBytes/transport.rounds,
  upstreamRequests:row.upstreamRequests/transport.rounds,upstreamBodyBytes:row.upstreamBodyBytes/transport.rounds,networkMs:row.pairedNetworkMs,wallMs:row.pairedRoundMs})
const http={}
for(const phase of ['cold','warm','conditional','dynamic']){
  const baseline=normalize(transport.aggregates['baseline-browser'][phase]),current=normalize(transport.aggregates['current-browser'][phase]),gzipControl=normalize(transport.aggregates['current-gzip'][phase])
  http[phase]={baseline,current,gzipControl,improvementPct:{body:gain(baseline.bodyBytes,current.bodyBytes),downstreamHttp:gain(baseline.responseHttpBytes,current.responseHttpBytes),networkMedian:gain(baseline.networkMs.median,current.networkMs.median),wallMedian:gain(baseline.wallMs.median,current.wallMs.median)}}
}
const pollingSummary=Object.fromEntries(Object.entries(polling.scenarios).map(([key,scenario])=>[key,{baseline:scenario.baseline.total,current:scenario.current.total,requestReductionPct:gain(scenario.baseline.total.count,scenario.current.total.count),baselinePerMethod:{status:scenario.baseline.status,sessions:scenario.baseline.sessions},currentPerMethod:{status:scenario.current.status,sessions:scenario.current.sessions}}]))
const sessionSummary={}
for(const sample of session.samples){const key=sample.scenario+'/'+sample.variant;const{round:_round,...data}=sample;if(!sessionSummary[key])sessionSummary[key]={repetitions:0,result:data};sessionSummary[key].repetitions++}
const result={schemaVersion:1,baselineRevision:transport.baselineRevision,node:transport.node,environment:transport.os,measuredRounds:transport.rounds,assetRepeatsPerRound:transport.repeats,artifactSha256:inputs,
  httpMeasurement:'per paired round; networkMs sums sequential request issue-to-response-end times; excludes decode/assert, browser rendering and TCP/IP/TLS framing',http,
  compression:transport.compression,pollingMeasurement:polling.kind,polling:pollingSummary,sessionMeasurement:session.methodology,session:sessionSummary,
  limitations:['Loopback HTTP/1.1, not mobile or tunnel LCP.','Browser cache intentionally bypassed: both versions already support immutable browser caching.','Old version already supports gzip, ETag 304 and Node-default keep-alive.','Sample p95 from only 15 rounds equals sample maximum.','API JSON is synthetic; per-file coding time uses sync quality-4 Brotli versus level-6 gzip.','Polling and session clocks are simulated; no battery or wall-clock endurance claim.']}
writeFileSync(resolve(directory,'summary.json'),JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify(result,null,2))
