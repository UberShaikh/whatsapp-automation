import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after,before,test } from 'node:test';
import type { PoolClient } from 'pg';
import { createPool,assertSchema,transaction } from '../app/db.ts';
import { loadConfig } from '../scripts/seed-groceries.ts';
import { checkoutReply,transitionOrder } from '../app/checkout.ts';
import { config } from './whatsapp-fixtures.ts';

const integration={skip:process.env.WHATSAPP_INTEGRATION_TEST!=='1'};
let pool:ReturnType<typeof createPool>;
let baseline:unknown;
const catalogSnapshot=async()=> (await pool.query(`SELECT v.sku,v.image_url,pr.amount::text,s.on_hand_qty,s.reserved_qty,
  (SELECT count(*) FROM grocery_dev.seed_imports) AS imports,(SELECT count(*) FROM grocery_dev.stock_movements) AS movements
  FROM grocery_dev.product_variants v JOIN grocery_dev.prices pr ON pr.variant_id=v.id AND pr.valid_to IS NULL
  JOIN grocery_dev.stock_balances s ON s.variant_id=v.id ORDER BY v.sku,s.location_code`)).rows;
before(async()=>{if (!integration.skip) {pool=createPool(loadConfig());await assertSchema(pool);baseline=await catalogSnapshot();}});
after(async()=>{if (pool) try {assert.deepEqual(await catalogSnapshot(),baseline);} finally {await pool.end();}});
async function customer(db:PoolClient,account:string,variant:string,packs=1) {
  const {rows}=await db.query(`INSERT INTO grocery_dev.wa_identities(business_account_id,phone_number_id,transport_mode,sender_key,address_type,address_value,last_customer_message_at)
    VALUES ($1,'test-number','fake',$2,'phone','919000000001',now()) RETURNING id`,[account,randomUUID()]);
  const cart=await db.query('INSERT INTO grocery_dev.wa_carts(identity_id) VALUES ($1) RETURNING id',[rows[0].id]);
  await db.query('INSERT INTO grocery_dev.wa_cart_items(cart_id,variant_id,line_no,packs) VALUES ($1,$2,1,$3)',[cart.rows[0].id,variant,packs]);
  return {id:rows[0].id as string,cart:cart.rows[0].id as string};
}
const token=(body:string|undefined)=>{assert.ok(body);assert.ok(body.length<=4096);const match=body.match(/CONFIRM ([a-f0-9]{16})/);assert.ok(match,body);return match[1];};
async function stock(db:PoolClient) {return (await db.query(`SELECT v.id,s.on_hand_qty,s.reserved_qty FROM grocery_dev.product_variants v
  JOIN grocery_dev.stock_balances s ON s.variant_id=v.id AND s.location_code='DEMO-STORE' WHERE v.sku='MILK-AMUL-TAAZA-UHT-1L'`)).rows[0];}

test('checkout rechecks all lines together, rejects changed cart revisions and keeps a full review within WhatsApp limits',integration,async()=>{
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    const v=await stock(db);const a=await customer(db,`test-checkout-lines-${randomUUID()}`,v.id);
    await db.query(`INSERT INTO grocery_dev.wa_cart_items(cart_id,variant_id,line_no,packs)
      SELECT $1,v.id,(row_number() OVER(ORDER BY v.id)+1)::int,1 FROM grocery_dev.product_variants v
      JOIN grocery_dev.stock_balances s ON s.variant_id=v.id AND s.location_code='DEMO-STORE'
      WHERE v.id<>$2 AND v.is_active AND s.on_hand_qty>s.reserved_qty ORDER BY v.id LIMIT 19`,[a.cart,v.id]);
    const reply=(text:string)=>checkoutReply(db,a.id,text,new Date(),config);
    let code=token(await reply('CHECKOUT'));
    await db.query('UPDATE grocery_dev.wa_carts SET revision=revision+1 WHERE id=$1',[a.cart]);
    assert.match((await reply(`CONFIRM ${code}`))!,/cart changed/);
    code=token(await reply('CHECKOUT'));
    await db.query("UPDATE grocery_dev.stock_balances SET reserved_qty=on_hand_qty WHERE variant_id=$1 AND location_code='DEMO-STORE'",[v.id]);
    assert.match((await reply(`CONFIRM ${code}`))!,/availability changed/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM grocery_dev.wa_orders WHERE identity_id=$1',[a.id])).rows[0].n,0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM grocery_dev.wa_inventory_reservations r JOIN grocery_dev.wa_orders o ON o.id=r.order_id WHERE o.identity_id=$1',[a.id])).rows[0].n,0);
    await db.query("UPDATE grocery_dev.stock_balances SET reserved_qty=$2 WHERE variant_id=$1 AND location_code='DEMO-STORE'",[v.id,v.reserved_qty]);
    const review=await reply('CHECKOUT');code=token(review);assert.doesNotMatch(review!,/https?:|bigbasket|source_url/i);
    assert.match((await reply(`CONFIRM ${code}`))!,/Stock held/);
    assert.equal((await db.query('SELECT jsonb_array_length(items) AS n FROM grocery_dev.wa_orders WHERE identity_id=$1',[a.id])).rows[0].n,20);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM grocery_dev.wa_inventory_reservations r JOIN grocery_dev.wa_orders o ON o.id=r.order_id WHERE o.identity_id=$1`,[a.id])).rows[0].n,20);
  } finally {await db.query('ROLLBACK');db.release();}
});

test('demo checkout enforces ownership, quote freshness, idempotency and exact reservation lifecycle',integration,async()=>{
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    const v=await stock(db);const account=`test-checkout-${randomUUID()}`;
    const a=await customer(db,account,v.id,2),b=await customer(db,account,v.id);
    const reply=(id:string,text:string)=>checkoutReply(db,id,text,new Date(),config);
    let code=token(await reply(a.id,'CHECKOUT'));
    assert.match((await reply(b.id,`CONFIRM ${code}`))!,/does not belong/);
    assert.equal((await stock(db)).reserved_qty,v.reserved_qty);
    await db.query("UPDATE grocery_dev.wa_checkout_quotes SET expires_at=now()-interval '1 second' WHERE token=$1",[code]);
    assert.match((await reply(a.id,`CONFIRM ${code}`))!,/expired/);
    code=token(await reply(a.id,'CHECKOUT'));
    await db.query('UPDATE grocery_dev.prices SET amount=amount+1 WHERE variant_id=$1 AND valid_to IS NULL',[v.id]);
    assert.match((await reply(a.id,`CONFIRM ${code}`))!,/changed/);
    assert.equal((await stock(db)).reserved_qty,v.reserved_qty);
    code=token(await reply(a.id,'CHECKOUT'));
    const confirmed=await reply(a.id,`CONFIRM ${code}`);assert.match(confirmed!,/UNPAID/);
    assert.equal((await stock(db)).reserved_qty,v.reserved_qty+2);
    const order=(await db.query('SELECT * FROM grocery_dev.wa_orders WHERE identity_id=$1',[a.id])).rows[0];
    assert.match((await reply(a.id,`CONFIRM ${code}`))!,new RegExp(order.reference));
    assert.equal((await stock(db)).reserved_qty,v.reserved_qty+2);
    assert.match((await reply(b.id,`STATUS ${order.reference}`))!,/No matching/);
    assert.match((await reply(b.id,`CANCEL ORDER ${order.reference}`))!,/No matching/);
    await transitionOrder(db,order,'accept','operator');
    order.state='ACCEPTED';await transitionOrder(db,order,'pick','operator');order.state='PICKING';
    assert.match((await reply(a.id,`CANCEL ORDER ${order.reference}`))!,/Cannot cancel/);
    assert.match(await transitionOrder(db,order,'collect','operator',true),/Cannot collect/);
    await transitionOrder(db,order,'ready','operator');order.state='READY';
    assert.match(await transitionOrder(db,order,'collect','operator'),/--cash-received/);
    assert.equal((await stock(db)).on_hand_qty,v.on_hand_qty);
    await transitionOrder(db,order,'collect','operator',true);
    const collected=(await db.query('SELECT * FROM grocery_dev.wa_orders WHERE id=$1',[order.id])).rows[0];
    assert.equal(collected.payment_status,'DEMO_CASH_RECORDED');
    assert.equal((await stock(db)).on_hand_qty,v.on_hand_qty-2);assert.equal((await stock(db)).reserved_qty,v.reserved_qty);
    await transitionOrder(db,collected,'collect','operator',true);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM grocery_dev.stock_movements WHERE order_id=$1',[order.id])).rows[0].n,1);
    assert.match((await reply(a.id,`CANCEL ORDER ${order.reference}`))!,/Cannot cancel/);
    await db.query('INSERT INTO grocery_dev.wa_cart_items(cart_id,variant_id,line_no,packs) VALUES ($1,$2,2,1)',[a.cart,v.id]);
    code=token(await reply(a.id,'CHECKOUT'));await reply(a.id,`CONFIRM ${code}`);
    const second=(await db.query('SELECT * FROM grocery_dev.wa_orders WHERE identity_id=$1 AND id<>$2',[a.id,order.id])).rows[0];
    await reply(a.id,`CANCEL ORDER ${second.reference}`);await reply(a.id,`CANCEL ORDER ${second.reference}`);
    assert.equal((await stock(db)).reserved_qty,v.reserved_qty);
    assert.equal((await db.query('SELECT state FROM grocery_dev.wa_inventory_reservations WHERE order_id=$1',[second.id])).rows[0].state,'RELEASED');
    await assert.rejects(db.query('DELETE FROM grocery_dev.wa_identities WHERE id=$1',[a.id]),/foreign key/);
  } finally {await db.query('ROLLBACK');db.release();}
});

test('two concurrent customers cannot reserve the same last available packs',integration,async()=>{
  const account=`test-checkout-race-${randomUUID()}`;
  const v=(await pool.query(`SELECT v.id,s.on_hand_qty,s.reserved_qty FROM grocery_dev.product_variants v JOIN grocery_dev.stock_balances s ON s.variant_id=v.id
    WHERE v.sku='MILK-AMUL-TAAZA-UHT-1L' AND s.location_code='DEMO-STORE'`)).rows[0];
  const packs=v.on_hand_qty-v.reserved_qty;assert.ok(packs>0 && packs<=99);
  const people=await transaction(pool,async db=>{
    const a=await customer(db,account,v.id,packs),b=await customer(db,account,v.id,packs);
    return Promise.all([a,b].map(async person=>({...person,code:token(await checkoutReply(db,person.id,'CHECKOUT',new Date(),config))})));
  });
  try {
    const results=await Promise.all(people.map(person=>transaction(pool,async db=>{
      await db.query('SELECT id FROM grocery_dev.wa_identities WHERE id=$1 FOR UPDATE',[person.id]);
      return checkoutReply(db,person.id,`CONFIRM ${person.code}`,new Date(),config);
    })));
    assert.equal(results.filter(body=>body?.includes('Stock held')).length,1);
    assert.equal(results.filter(body=>body?.includes('availability changed')).length,1);
    assert.equal((await pool.query("SELECT reserved_qty FROM grocery_dev.stock_balances WHERE variant_id=$1 AND location_code='DEMO-STORE'",[v.id])).rows[0].reserved_qty,v.on_hand_qty);
  } finally {
    await transaction(pool,async db=>{
      const orders=await db.query(`SELECT o.* FROM grocery_dev.wa_orders o JOIN grocery_dev.wa_identities i ON i.id=o.identity_id WHERE i.business_account_id=$1`,[account]);
      for (const order of orders.rows) {
        await db.query('SELECT id FROM grocery_dev.wa_identities WHERE id=$1 FOR UPDATE',[order.identity_id]);
        await transitionOrder(db,order,'cancel','operator');
        await db.query('DELETE FROM grocery_dev.wa_order_events WHERE order_id=$1',[order.id]);
        await db.query('DELETE FROM grocery_dev.wa_inventory_reservations WHERE order_id=$1',[order.id]);
        await db.query('DELETE FROM grocery_dev.wa_orders WHERE id=$1',[order.id]);
      }
      await db.query('DELETE FROM grocery_dev.wa_identities WHERE business_account_id=$1',[account]);
    });
  }
  const after=(await pool.query("SELECT on_hand_qty,reserved_qty FROM grocery_dev.stock_balances WHERE variant_id=$1 AND location_code='DEMO-STORE'",[v.id])).rows[0];
  assert.equal(after.on_hand_qty,v.on_hand_qty);assert.equal(after.reserved_qty,v.reserved_qty);
});
