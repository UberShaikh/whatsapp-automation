import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app/app.ts';
import { normalizeWebhook,validSignature } from '../app/whatsapp.ts';
import { createSender,SendFailure } from '../app/sender.ts';
import type { Event } from '../app/whatsapp.ts';
import { config,payload,signature } from './whatsapp-fixtures.ts';
import { ConfigError,loadConfig } from '../app/config.ts';
import { processNextMessage } from '../app/transport-store.ts';
import { sendNextReply } from '../app/outbox.ts';
import type { Pool } from 'pg';
import { transaction } from '../app/db.ts';

async function serve(ingest:(events:Event[])=>Promise<number>,ready:()=>Promise<void>=async()=>{}) {
  const app=createApp(config,{ingest,ready,log:()=>{}});
  const server=app.listen(0,'127.0.0.1'); await once(server,'listening');
  return {url:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close:()=>new Promise<void>((resolve,reject)=>{server.closeAllConnections();server.close(e=>e?reject(e):resolve());})};
}
const message={id:randomUUID(),callbackKey:randomUUID(),addressType:'phone' as const,addressValue:'919000000001',body:'A safe demo reply'};

test('signature covers original Unicode bytes and rejects malformed/tampered signatures',()=>{
  const body=Buffer.from('{"text":"नमस्ते"}');
  assert.equal(validSignature(body,signature(body),config.appSecret),true);
  assert.equal(validSignature(Buffer.concat([body,Buffer.from(' ')]),signature(body),config.appSecret),false);
  for (const invalid of [undefined,'sha256=x','sha256='+'x'.repeat(64)]) assert.equal(validSignature(body,invalid,config.appSecret),false);
});

test('normalizer handles complete batches, optional phone numbers and unsupported event fields',()=>{
  const p=payload(config,{bsuid:'IN.USER1'});
  p.entry[0].changes[0].value.messages.push({...p.entry[0].changes[0].value.messages[0],id:'wamid.test-2'});
  const events=normalizeWebhook(p,config);
  assert.equal(events.length,2);
  assert.equal(events[0].kind,'message');
  if (events[0].kind==='message') { assert.equal(events[0].phoneNumber,null);assert.equal(events[0].addressType,'bsuid'); }
  assert.equal(normalizeWebhook({object:'whatsapp_business_account',entry:[{id:config.businessAccountId,changes:[{field:'unknown'}]}]},config).length,0);
});

test('Meta mode ignores inbound messages from recipients outside the test allowlist',()=>{
  assert.equal(normalizeWebhook(payload(config,{from:'919000000999'}),{...config,mode:'meta'}).length,0);
});

test('verification handshake checks mode and token',async t=>{
  const app=await serve(async()=>0);t.after(app.close);
  const query=new URLSearchParams({'hub.mode':'subscribe','hub.verify_token':config.verifyToken,'hub.challenge':'challenge-123'});
  const response=await fetch(`${app.url}/webhooks/whatsapp?${query}`);
  assert.equal(response.status,200);assert.equal(await response.text(),'challenge-123');
  query.set('hub.verify_token','wrong');
  assert.equal((await fetch(`${app.url}/webhooks/whatsapp?${query}`)).status,403);
  query.set('hub.verify_token',config.verifyToken);query.set('hub.mode','wrong');
  assert.equal((await fetch(`${app.url}/webhooks/whatsapp?${query}`)).status,403);
});

test('forged requests and wrong business/phone scope produce no storage calls',async t=>{
  let calls=0;const app=await serve(async()=>{calls++;return 1;});t.after(app.close);
  const body=JSON.stringify(payload());
  assert.equal((await fetch(`${app.url}/webhooks/whatsapp`,{method:'POST',headers:{'Content-Type':'application/json'},body})).status,401);
  const foreign=JSON.stringify(payload({...config,businessAccountId:'foreign'}));
  assert.equal((await fetch(`${app.url}/webhooks/whatsapp`,{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Signature-256':signature(foreign)},body:foreign})).status,403);
  const phone=JSON.stringify(payload({...config,phoneNumberId:'foreign'}));
  assert.equal((await fetch(`${app.url}/webhooks/whatsapp`,{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Signature-256':signature(phone)},body:phone})).status,403);
  assert.equal(calls,0);
});

test('valid webhook waits for durable storage and supplies no unnecessary raw payload',async t=>{
  let stored:Event[]=[];
  const app=await serve(async events=>{stored=events;return events.length;});t.after(app.close);
  const body=JSON.stringify(payload(config,{body:'hello'}));
  const response=await fetch(`${app.url}/webhooks/whatsapp`,{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Signature-256':signature(body)},body});
  assert.equal(response.status,200);assert.equal(stored.length,1);
  assert.equal('raw_payload' in stored[0],false);
  assert.ok(response.headers.get('x-request-id'));
  assert.equal(response.headers.get('x-powered-by'),null);
});

test('storage outage is retryable; liveness and readiness are distinct',async t=>{
  const app=await serve(async()=>{throw new Error('private database details');},async()=>{throw new Error('private details');});t.after(app.close);
  const body=JSON.stringify(payload());
  const response=await fetch(`${app.url}/webhooks/whatsapp`,{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Signature-256':signature(body)},body});
  assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/private/);
  assert.equal((await fetch(`${app.url}/health/live`)).status,200);
  assert.equal((await fetch(`${app.url}/health/ready`)).status,503);
});

test('malformed JSON, oversized bodies, bad shapes and wrong content types are rejected',async t=>{
  let calls=0;const app=await serve(async()=>{calls++;return 0;});t.after(app.close);
  for (const [body,type,expected] of [['{','application/json',400],['{}','application/json',400],['x'.repeat(270000),'application/json',413],['hello','text/plain',415]] as const) {
    const response=await fetch(`${app.url}/webhooks/whatsapp`,{method:'POST',headers:{'Content-Type':type,'X-Hub-Signature-256':signature(body)},body});
    assert.equal(response.status,expected);
  }
  assert.equal(calls,0);
});

test('fake sender performs no network request',async()=>{
  let calls=0;
  const sender=createSender(config,async()=>{calls++;throw new Error('Network must not run');});
  assert.match(await sender(message),/^fake\./);assert.equal(calls,0);
});

test('Meta sender uses text-only payload, exact recipient and per-attempt callback key',async()=>{
  let sent:Record<string,unknown>={};
  const request:typeof fetch=async (_url,init)=>{sent=JSON.parse(String(init?.body));return Response.json({messages:[{id:'wamid.outgoing'}]});};
  const sender=createSender({...config,mode:'meta'},request);
  assert.equal(await sender(message),'wamid.outgoing');
  assert.equal(sent.to,message.addressValue);assert.equal(sent.biz_opaque_callback_data,message.callbackKey);
  assert.deepEqual(sent.text,{body:message.body,preview_url:false});
  assert.equal('source_url' in sent,false);
  await sender({...message,addressType:'bsuid',addressValue:'IN.USER1'});
  assert.equal(sent.recipient,'IN.USER1');assert.equal('to' in sent,false);
});

test('Meta sender refuses recipients outside the configured allowlist',async()=>{
  let called=false;
  const sender=createSender({...config,mode:'meta'},async()=>{called=true;return Response.json({});});
  await assert.rejects(sender({...message,addressValue:'919000000999'}),e=>e instanceof SendFailure && e.code==='recipient_not_allowed');
  assert.equal(called,false);
});

test('definite rate limits retry, while timeouts/5xx/invalid successful responses remain uncertain',async()=>{
  for (const [status,outcome] of [[429,'retry'],[400,'failed'],[503,'uncertain']] as const) {
    const sender=createSender({...config,mode:'meta'},async()=>new Response('',{status}));
    await assert.rejects(sender(message),e=>e instanceof SendFailure && e.outcome===outcome);
  }
  const timeout=createSender({...config,mode:'meta'},async()=>{throw new Error('timeout');});
  await assert.rejects(timeout(message),e=>e instanceof SendFailure && e.outcome==='uncertain');
  const malformed=createSender({...config,mode:'meta'},async()=>Response.json({}));
  await assert.rejects(malformed(message),e=>e instanceof SendFailure && e.outcome==='uncertain');
});

test('pause switch prevents work before any database or sender access',async()=>{
  const unavailable=undefined as unknown as Pool;
  const paused={...config,paused:true};
  assert.equal(await processNextMessage(unavailable,paused),false);
  assert.equal(await sendNextReply(unavailable,paused,async()=>{throw new Error('must not send');}),false);
});

test('configuration fails closed for production, malformed pause flags and missing Meta allowlist',()=>{
  const original={...process.env};
  try {
    Object.assign(process.env,{APP_ENV:'development',DATABASE_URL:'postgresql://unused',WHATSAPP_MODE:'fake',
      WHATSAPP_APP_SECRET:config.appSecret,WHATSAPP_VERIFY_TOKEN:config.verifyToken,
      WHATSAPP_BUSINESS_ACCOUNT_ID:'100',WHATSAPP_PHONE_NUMBER_ID:'200',WHATSAPP_API_VERSION:'v99.0',
      WHATSAPP_ACCESS_TOKEN:'test-only-token',WHATSAPP_TEST_RECIPIENTS:'',SUPPORT_CONTACT:'Test operator',
      STORE_NAME:'Test Grocery',AUTOMATION_PAUSED:'false',PORT:'3000'});
    assert.equal(loadConfig().mode,'fake');
    process.env.AUTOMATION_PAUSED='True';assert.throws(loadConfig,ConfigError);
    process.env.AUTOMATION_PAUSED='false';process.env.APP_ENV='production';assert.throws(loadConfig,ConfigError);
    process.env.APP_ENV='development';process.env.WHATSAPP_MODE='meta';assert.throws(loadConfig,/TEST_RECIPIENTS/);
    process.env.WHATSAPP_TEST_RECIPIENTS='919000000001';assert.equal(loadConfig().mode,'meta');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env,original);
  }
});

test('a failed rollback destroys the connection instead of returning it to the pool',async()=>{
  let destroyed=false;
  const pool={connect:async()=>({query:async(text:string)=>{
    if (text==='ROLLBACK') throw new Error('connection lost');return {rows:[]};
  },release:(broken:boolean)=>{destroyed=broken;}})} as unknown as Pool;
  await assert.rejects(transaction(pool,async()=>{throw new Error('original failure');}),/original failure/);
  assert.equal(destroyed,true);
});
