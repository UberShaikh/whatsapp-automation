import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { after,before,test } from 'node:test';
import type { TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import { loadConfig as databaseUrl } from '../scripts/seed-groceries.ts';
import { createApp } from '../app/app.ts';
import { assertSchema,createPool } from '../app/db.ts';
import { ingestEvents,processNextMessage } from '../app/transport-store.ts';
import { sendNextReply } from '../app/outbox.ts';
import { createSender,SendFailure } from '../app/sender.ts';
import { normalizeWebhook } from '../app/whatsapp.ts';
import { config,payload,signature } from './whatsapp-fixtures.ts';

const integration={skip:process.env.WHATSAPP_INTEGRATION_TEST!=='1'};
let sharedPool:ReturnType<typeof createPool>;
before(async()=>{
  if (integration.skip) return;
  sharedPool=createPool(databaseUrl());
  await assertSchema(sharedPool);
});
after(async()=>{if (sharedPool) await sharedPool.end();});
async function harness(t: TestContext) {
  const cfg={...config,databaseUrl:databaseUrl(),businessAccountId:`test-${randomUUID()}`};
  const pool=sharedPool;
  t.after(async()=>{
    await pool.query('DELETE FROM grocery_dev.wa_status_events WHERE business_account_id=$1',[cfg.businessAccountId]);
    await pool.query('DELETE FROM grocery_dev.wa_identities WHERE business_account_id=$1',[cfg.businessAccountId]);
  });
  const receive=(body='hi',id=randomUUID(),timestamp?:number)=>ingestEvents(pool,normalizeWebhook(payload(cfg,{id,body,timestamp}),cfg));
  const jobs=async()=> (await pool.query(`SELECT o.* FROM grocery_dev.wa_outbox o JOIN grocery_dev.wa_identities i ON i.id=o.identity_id
    WHERE i.business_account_id=$1 ORDER BY o.sequence`,[cfg.businessAccountId])).rows;
  return {cfg,pool,receive,jobs};
}

test('signed HTTP receipt, duplicate delivery and a separate worker connection produce one reply',integration,async t=>{
  const h=await harness(t);
  const app=createApp(h.cfg,{ingest:e=>ingestEvents(h.pool,e),ready:()=>assertSchema(h.pool),log:()=>{}});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
  const body=JSON.stringify(payload(h.cfg));
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/whatsapp`;
  for (let i=0;i<2;i++) assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Signature-256':signature(body)},body})).status,200);
  const worker=createPool(h.cfg.databaseUrl);
  try {
    assert.equal(await processNextMessage(worker,h.cfg),true);
    assert.equal(await processNextMessage(worker,h.cfg),false);
    assert.equal(await sendNextReply(worker,h.cfg,createSender(h.cfg)),true);
    assert.equal(await sendNextReply(worker,h.cfg,createSender(h.cfg)),false);
  } finally { await worker.end(); }
  const jobs=await h.jobs();assert.equal(jobs.length,1);assert.equal(jobs[0].state,'accepted');
  assert.match(jobs[0].body,/Welcome to Test Grocery/);
  assert.doesNotMatch(jobs[0].body,/https?:|bigbasket|bbassets|source_url/i);
  assert.match(jobs[0].provider_message_id,/^fake\./);
});

test('duplicates arriving concurrently are processed once',integration,async t=>{
  const h=await harness(t);const events=normalizeWebhook(payload(h.cfg),h.cfg);
  const result=await Promise.all([ingestEvents(h.pool,events),ingestEvents(h.pool,events)]);
  assert.equal(result.reduce((a,b)=>a+b,0),1);
  const processed=await Promise.all([processNextMessage(h.pool,h.cfg),processNextMessage(h.pool,h.cfg)]);
  assert.equal(processed.filter(Boolean).length,1);assert.equal((await h.jobs()).length,1);
});

test('expired customer-service window suppresses a reply without sending',integration,async t=>{
  const h=await harness(t);await h.receive('hi',randomUUID(),Math.floor(Date.now()/1000)-172800);
  await processNextMessage(h.pool,h.cfg);
  let calls=0;await sendNextReply(h.pool,h.cfg,async()=>{calls++;return 'must-not-send';});
  assert.equal(calls,0);const [job]=await h.jobs();
  assert.equal(job.state,'suppressed');assert.equal(job.last_error_code,'service_window_closed');
});

test('ambiguous send stays uncertain and a correlated read callback reconciles it without another send',integration,async t=>{
  const h=await harness(t);await h.receive();await processNextMessage(h.pool,h.cfg);
  await sendNextReply(h.pool,h.cfg,async()=>{throw new SendFailure('uncertain','test_timeout');});
  let [job]=await h.jobs();assert.equal(job.state,'uncertain');assert.ok(job.callback_key);
  let calls=0;assert.equal(await sendNextReply(h.pool,h.cfg,async()=>{calls++;return 'never';}),false);assert.equal(calls,0);
  const statusTime=String(Math.floor(Date.now()/1000));
  const status=(state:string)=>({object:'whatsapp_business_account',entry:[{id:h.cfg.businessAccountId,changes:[{field:'messages',value:{
    metadata:{phone_number_id:h.cfg.phoneNumberId},statuses:[{id:'wamid.after-timeout',status:state,
      timestamp:statusTime,biz_opaque_callback_data:job.callback_key}],
  }}]}]});
  await ingestEvents(h.pool,normalizeWebhook(status('read'),h.cfg));
  await ingestEvents(h.pool,normalizeWebhook(status('sent'),h.cfg));
  await ingestEvents(h.pool,normalizeWebhook(status('read'),h.cfg));
  [job]=await h.jobs();assert.equal(job.state,'read');assert.equal(job.provider_message_id,'wamid.after-timeout');
  assert.equal(await processNextMessage(h.pool,h.cfg),false);
  assert.equal((await h.pool.query('SELECT count(*)::int AS n FROM grocery_dev.wa_status_events WHERE business_account_id=$1',[h.cfg.businessAccountId])).rows[0].n,2);
});

test('expired send lease is not reclaimed; stale ownership cannot complete the job',integration,async t=>{
  const h=await harness(t);await h.receive();await processNextMessage(h.pool,h.cfg);
  const [before]=await h.jobs();const token=randomUUID();
  await h.pool.query("UPDATE grocery_dev.wa_outbox SET state='sending',lease_token=$2,callback_key=$2,lease_until=now()-interval '1 second' WHERE id=$1",[before.id,token]);
  let calls=0;await sendNextReply(h.pool,h.cfg,async()=>{calls++;return 'never';});assert.equal(calls,0);
  const [after]=await h.jobs();assert.equal(after.state,'uncertain');assert.equal(after.lease_token,null);
  const stale=await h.pool.query("UPDATE grocery_dev.wa_outbox SET state='accepted' WHERE id=$1 AND lease_token=$2 AND state='sending'",[before.id,token]);
  assert.equal(stale.rowCount,0);
});

test('stop, help and handoff persist; normal messages do not resume a paused conversation',integration,async t=>{
  const h=await harness(t);
  await h.receive('hi');await processNextMessage(h.pool,h.cfg);
  await h.receive('stop');await processNextMessage(h.pool,h.cfg);
  let jobs=await h.jobs();assert.equal(jobs[0].state,'suppressed');assert.match(jobs[1].body,/stopped/);
  const identity=await h.pool.query('SELECT opted_out FROM grocery_dev.wa_identities WHERE business_account_id=$1',[h.cfg.businessAccountId]);assert.equal(identity.rows[0].opted_out,true);
  await h.receive('agent');await processNextMessage(h.pool,h.cfg);
  await h.receive('hi again');await processNextMessage(h.pool,h.cfg);
  jobs=await h.jobs();assert.equal(jobs.length,3);assert.equal(jobs[2].state,'pending');assert.match(jobs[2].body,/human assistance/i);
  await h.receive('help');await processNextMessage(h.pool,h.cfg);
  assert.match((await h.jobs()).at(-1).body,/Human assistance/);
});

test('fake traffic cannot turn into a real Meta send after mode changes',integration,async t=>{
  const h=await harness(t);await h.receive();await processNextMessage(h.pool,h.cfg);
  const meta={...h.cfg,mode:'meta' as const};let calls=0;
  assert.equal(await processNextMessage(h.pool,meta),false);
  assert.equal(await sendNextReply(h.pool,meta,async()=>{calls++;return 'never';}),false);
  assert.equal(calls,0);assert.equal((await h.jobs())[0].state,'pending');
});

test('a delayed older RESUME cannot undo a newer STOP preference',integration,async t=>{
  const h=await harness(t);const now=Math.floor(Date.now()/1000);
  await h.receive('stop',randomUUID(),now-10);await processNextMessage(h.pool,h.cfg);
  await h.receive('resume',randomUUID(),now-20);await processNextMessage(h.pool,h.cfg);
  const identity=await h.pool.query('SELECT opted_out FROM grocery_dev.wa_identities WHERE business_account_id=$1',[h.cfg.businessAccountId]);
  assert.equal(identity.rows[0].opted_out,true);assert.equal((await h.jobs()).length,1);
});

test('definite rate-limit rejection retries with backoff and stops after the bounded budget',integration,async t=>{
  const h=await harness(t);await h.receive();await processNextMessage(h.pool,h.cfg);
  const reject=async()=>{throw new SendFailure('retry','http_429');};
  await sendNextReply(h.pool,h.cfg,reject);
  let [job]=await h.jobs();assert.equal(job.state,'pending');assert.equal(job.attempts,1);
  assert.equal(new Date(job.available_at).getTime()-new Date(job.updated_at).getTime(),5000);
  await h.pool.query('UPDATE grocery_dev.wa_outbox SET available_at=now(),attempts=4 WHERE id=$1',[job.id]);
  await sendNextReply(h.pool,h.cfg,reject);
  [job]=await h.jobs();assert.equal(job.state,'failed');assert.equal(job.attempts,5);
});

test('a storage error rolls back the entire multi-message webhook batch',integration,async t=>{
  const h=await harness(t);const events=normalizeWebhook(payload(h.cfg),h.cfg);
  if (events[0].kind!=='message') throw new Error('Expected message fixture');
  const bad={...events[0],id:'invalid-second',body:null as unknown as string};
  await assert.rejects(ingestEvents(h.pool,[events[0],bad]),error=>error instanceof Error && 'code' in error && error.code==='23502');
  const count=await h.pool.query('SELECT count(*)::int AS n FROM grocery_dev.wa_inbox WHERE business_account_id=$1',[h.cfg.businessAccountId]);
  assert.equal(count.rows[0].n,0);
});
