import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after,before,test } from 'node:test';
import type { TestContext } from 'node:test';
import { loadConfig as databaseUrl } from '../scripts/seed-groceries.ts';
import { assertSchema,createPool } from '../app/db.ts';
import { ingestEvents,processNextMessage } from '../app/transport-store.ts';
import { normalizeWebhook } from '../app/whatsapp.ts';
import { config,payload } from './whatsapp-fixtures.ts';

const integration={skip:process.env.WHATSAPP_INTEGRATION_TEST!=='1'};
let pool:ReturnType<typeof createPool>;
before(async()=>{if (!integration.skip) {pool=createPool(databaseUrl());await assertSchema(pool);}});
after(async()=>{if (pool) await pool.end();});

async function harness(t:TestContext) {
  const cfg={...config,businessAccountId:`test-shopping-${randomUUID()}`};
  t.after(async()=>{
    await pool.query('DELETE FROM grocery_dev.wa_status_events WHERE business_account_id=$1',[cfg.businessAccountId]);
    await pool.query('DELETE FROM grocery_dev.wa_identities WHERE business_account_id=$1',[cfg.businessAccountId]);
  });
  const receive=async(body:string,options:{id?:string;from?:string;timestamp?:number}={})=>{
    const events=normalizeWebhook(payload(cfg,{body,id:options.id??randomUUID(),from:options.from,timestamp:options.timestamp}),cfg);
    await ingestEvents(pool,events);await processNextMessage(pool,cfg);
    const {rows}=await pool.query(`SELECT o.body FROM grocery_dev.wa_outbox o JOIN grocery_dev.wa_identities i ON i.id=o.identity_id
      WHERE i.business_account_id=$1 AND i.address_value=$2 ORDER BY o.sequence DESC LIMIT 1`,[cfg.businessAccountId,options.from??'919000000001']);
    assert.ok(rows[0]);assert.ok(rows[0].body.length<=4096);assert.doesNotMatch(rows[0].body,/https?:|bigbasket|bbassets|source_url/i);
    return rows[0].body as string;
  };
  const cart=async(from='919000000001')=>(await pool.query(`SELECT c.id,c.revision,c.next_line_no,v.sku,l.line_no,l.packs
    FROM grocery_dev.wa_carts c JOIN grocery_dev.wa_identities i ON i.id=c.identity_id
    JOIN grocery_dev.wa_cart_items l ON l.cart_id=c.id JOIN grocery_dev.product_variants v ON v.id=l.variant_id
    WHERE i.business_account_id=$1 AND i.address_value=$2 ORDER BY l.line_no`,[cfg.businessAccountId,from])).rows;
  const prompt=async(from='919000000001')=> (await pool.query(`SELECT p.* FROM grocery_dev.wa_shopping_prompts p
    JOIN grocery_dev.wa_carts c ON c.id=p.cart_id JOIN grocery_dev.wa_identities i ON i.id=c.identity_id
    WHERE i.business_account_id=$1 AND i.address_value=$2`,[cfg.businessAccountId,from])).rows[0];
  return {cfg,receive,cart,prompt};
}

test('shopping list builds a persistent cart once and never reserves or deducts inventory',integration,async t=>{
  const h=await harness(t);
  const before=(await pool.query('SELECT sum(on_hand_qty)::int AS stock,sum(reserved_qty)::int AS reserved FROM grocery_dev.stock_balances')).rows[0];
  const body=await h.receive('2 milk 1 l, 1 kg rice',{id:'shopping-list-1'});
  assert.match(body,/INR 397.00/);assert.match(body,/stock is not reserved/);
  let rows=await h.cart();assert.equal(rows.length,2);assert.equal(rows[0].packs,2);assert.equal(rows[1].packs,1);
  await h.receive('2 milk 1 l, 1 kg rice',{id:'shopping-list-1'});
  rows=await h.cart();assert.equal(rows[0].packs,2);
  const second=createPool(databaseUrl());
  try {const persisted=await second.query('SELECT packs FROM grocery_dev.wa_cart_items WHERE cart_id=$1 ORDER BY line_no',[rows[0].id]);assert.deepEqual(persisted.rows.map(r=>r.packs),[2,1]);}
  finally {await second.end();}
  assert.deepEqual((await pool.query('SELECT sum(on_hand_qty)::int AS stock,sum(reserved_qty)::int AS reserved FROM grocery_dev.stock_balances')).rows[0],before);
  const checkout=await h.receive('checkout');assert.match(checkout,/no order or stock reservation/i);assert.equal((await h.cart()).length,2);
});

test('Vim bar mismatch requires a scoped code and selection resumes the remainder of the list',integration,async t=>{
  const h=await harness(t);
  const body=await h.receive('2 Vim bars, 1 kg rice');
  assert.match(body,/Add 1 pack/);assert.match(body,/4 x 190/);assert.equal((await h.cart()).length,0);
  const p=await h.prompt();
  await h.receive(`choose ${p.token} 1`,{from:'919000000002'});
  assert.equal((await h.cart()).length,0);assert.equal((await h.cart('919000000002')).length,0);
  await h.receive(`choose ${p.token} 1`);
  const rows=await h.cart();assert.deepEqual(rows.map(r=>[r.sku,r.packs]),[['DISHWASH-VIM-LEMON-4X190G',1],['RICE-IG-CLASSIC-1KG',1]]);
  await h.receive(`choose ${p.token} 1`);assert.equal((await h.cart())[0].packs,1);
});

test('ambiguous soap is not guessed, and unknown/out-of-stock items can be skipped or replaced',integration,async t=>{
  const h=await harness(t);
  assert.match(await h.receive('soap'),/CHOOSE/);assert.equal((await h.cart()).length,0);
  let p=await h.prompt();
  await h.receive(`replace ${p.token} banana`);
  p=await h.prompt();assert.equal(p.request_text,'banana');assert.match(await h.receive('choices'),/No matching available/);
  p=await h.prompt();await h.receive(`replace ${p.token} unknown-brand milk`);
  p=await h.prompt();assert.equal((await h.cart()).length,0);
  await h.receive(`replace ${p.token} doodh`);assert.equal((await h.cart())[0].sku,'MILK-AMUL-TAAZA-UHT-1L');
});

test('cart edits preserve line numbers, reject unavailable quantities and invalidate earlier choice codes',integration,async t=>{
  const h=await harness(t);await h.receive('milk, 1 kg rice, 1 kg atta');
  const old=await h.prompt();
  await h.receive('change 1 3');let rows=await h.cart();assert.equal(rows[0].packs,3);
  const current=await h.prompt();assert.notEqual(current.token,old.token);
  await h.receive(`choose ${old.token} 1`);assert.equal((await h.cart()).length,2);
  assert.match(await h.receive('change 1 99'),/not currently available/);assert.equal((await h.cart())[0].packs,3);
  await h.receive('remove 1');rows=await h.cart();assert.equal(rows[0].line_no,2);
  const p=await h.prompt();await h.receive(`skip ${p.token}`);await h.receive('milk');
  rows=await h.cart();assert.equal(rows[0].line_no,2);assert.equal(rows[1].line_no,3);
  await h.receive('remove 1');assert.equal((await h.cart()).length,2);
});

test('expired choices refresh and do not apply; cancel clears both cart and pending list',integration,async t=>{
  const h=await harness(t);await h.receive('milk, 1 kg atta, 1 kg rice');
  const p=await h.prompt();await pool.query("UPDATE grocery_dev.wa_shopping_prompts SET expires_at=now()-interval '1 second' WHERE id=$1",[p.id]);
  assert.match(await h.receive(`choose ${p.token} 1`),/expired/);
  assert.equal((await h.cart()).length,1);assert.notEqual((await h.prompt()).token,p.token);
  await h.receive('cancel');assert.equal((await h.cart()).length,0);assert.equal(await h.prompt(),undefined);
  await h.receive(`choose ${p.token} 1`);assert.equal((await h.cart()).length,0);
});

test('price/pack changes invalidate offered terms instead of silently changing a selected item',integration,async t=>{
  const h=await harness(t);await h.receive('1 kg atta');const p=await h.prompt();
  // Change only this test prompt's snapshot, never the shared catalog or live price.
  await pool.query("UPDATE grocery_dev.wa_shopping_choices SET unit_price=unit_price+1 WHERE prompt_id=$1",[p.id]);
  assert.match(await h.receive(`choose ${p.token} 1`),/Price, pack or availability changed/);
  assert.equal((await h.cart()).length,0);const fresh=await h.prompt();assert.notEqual(fresh.token,p.token);
  await h.receive(`choose ${fresh.token} 1`);assert.equal((await h.cart())[0].sku,'ATTA-AASHIRVAAD-5KG');
});

test('partial-stock proposals cannot be exceeded by repeated additions, and failed choices pause safely',integration,async t=>{
  const h=await harness(t);assert.match(await h.receive('1 kg moong dal'),/Only 1 more pack/);
  let p=await h.prompt();await h.receive(`choose ${p.token} 1`);assert.equal((await h.cart())[0].packs,1);
  await h.receive('moong dal');p=await h.prompt();assert.match(await h.receive('choices'),/No matching available/);
  p=await h.prompt();for(let i=0;i<3;i++) await h.receive(`choose ${p.token} 3`);
  const identity=(await pool.query('SELECT mode FROM grocery_dev.wa_identities WHERE business_account_id=$1',[h.cfg.businessAccountId])).rows[0];
  assert.equal(identity.mode,'HUMAN_HANDOFF');assert.equal((await h.cart())[0].packs,1);assert.ok(await h.prompt());
});

test('invalid lists are atomic and delayed cart changes cannot undo more recent actions',integration,async t=>{
  const h=await harness(t);assert.match(await h.receive('milk, -1 rice'),/Cart unchanged/);assert.equal((await h.cart()).length,0);
  const now=Math.floor(Date.now()/1000);
  await h.receive('milk',{timestamp:now-10});await h.receive('change 1 2',{timestamp:now-5});
  assert.match(await h.receive('remove 1',{timestamp:now-8}),/predates/);assert.equal((await h.cart())[0].packs,2);
});

test('cart line limits are enforced, full cart replies fit WhatsApp text and removed numbers are not reused',integration,async t=>{
  const h=await harness(t);
  const {rows}=await pool.query(`SELECT v.sku FROM grocery_dev.product_variants v
    JOIN grocery_dev.prices p ON p.variant_id=v.id AND p.valid_to IS NULL
    JOIN grocery_dev.stock_balances s ON s.variant_id=v.id AND s.location_code='DEMO-STORE'
    WHERE v.is_active AND s.on_hand_qty-s.reserved_qty>0 ORDER BY v.sku LIMIT 21`);
  const requests=rows.map(r=>`1 pack ${r.sku}`);
  await h.receive(requests.slice(0,10).join(', '));await h.receive(requests.slice(10,20).join(', '));
  assert.equal((await h.cart()).length,20);
  const body=await h.receive('cart');assert.match(body,/20\./);assert.ok(body.length<=4096);
  await h.receive(requests[20]);assert.equal((await h.cart()).length,20);assert.ok(await h.prompt());
  await h.receive('remove 1');const p=await h.prompt();await h.receive(`choose ${p.token} 1`);
  const final=await h.cart();assert.equal(final.length,20);assert.equal(final.at(-1).line_no,21);
});
