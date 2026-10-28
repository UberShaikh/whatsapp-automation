import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { applySeed, createClient, LOCK_ID, readDataset, validate } from '../scripts/seed-groceries.ts';

test('catalog contains 33 validated products and a content hash', () => {
  const { data, digest } = readDataset();
  validate(data);
  assert.equal(data.products.length,33);
  assert.match(digest,/^[a-f0-9]{64}$/);
});

test('duplicate SKUs are rejected', () => {
  const { data } = readDataset();
  data.products.push(structuredClone(data.products[0]));
  assert.throws(() => validate(data),/Duplicate SKU/);
});

test('invalid prices are rejected', () => {
  for (const price of ['0.00','-1.00','1.001','NaN',99]) {
    const data: unknown = { ...readDataset().data, products: [{ ...readDataset().data.products[0], demo_selling_price: price }] };
    assert.throws(() => validate(data),/price/);
  }
});

test('invalid stock is rejected', () => {
  for (const stock of [-1,true,2.5]) {
    const data: unknown = { ...readDataset().data, products: [{ ...readDataset().data.products[0], demo_opening_stock_packs: stock }] };
    assert.throws(() => validate(data),/stock/);
  }
});

test('lookalike image domains are rejected', () => {
  const { data } = readDataset();
  data.products[0].image_url = 'https://www.bbassets.com.attacker.invalid/image.jpg';
  assert.throws(() => validate(data),/image_url/);
});

test('production datasets are rejected', () => {
  const { data } = readDataset();
  data.usage = 'production';
  assert.throws(() => validate(data),/development/);
});

const integration = { skip: process.env.SEED_INTEGRATION_TEST !== '1' };

test('new SKU inserts once and cannot change physical pack', integration, async () => {
  const db = createClient();
  try {
    await db.connect();
    await db.query('BEGIN');
    const { data } = readDataset();
    data.products = data.products.slice(0,1);
    const p = data.products[0];
    p.sku = `TEST-${randomUUID().toUpperCase()}`;
    p.name = 'Integration Test Rice';
    const digest = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    assert.deepEqual(await applySeed(db,data,digest), { already_imported: false, products: 1, new_opening_balances: 1 });
    const { rows } = await db.query(`SELECT p.amount,b.on_hand_qty FROM grocery_dev.product_variants v
      JOIN grocery_dev.prices p ON p.variant_id=v.id AND p.valid_to IS NULL
      JOIN grocery_dev.stock_balances b ON b.variant_id=v.id WHERE v.sku=$1`, [p.sku]);
    assert.equal(rows[0].amount,p.demo_selling_price);
    assert.equal(rows[0].on_hand_qty,p.demo_opening_stock_packs);
    p.pack_quantity = 2;
    await assert.rejects(applySeed(db,data,`${digest}-changed`),/pack identity changed/);
  } finally {
    await db.query('ROLLBACK').catch(() => {});
    await db.end();
  }
});

test('reimport preserves stock, versions prices and deduplicates the batch', integration, async () => {
  const db = createClient();
  try {
    await db.connect();
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    const { data } = readDataset();
    data.products = data.products.slice(0,2);
    const p = data.products[0];
    const { rows } = await db.query(`SELECT v.id,b.on_hand_qty FROM grocery_dev.product_variants v
      JOIN grocery_dev.stock_balances b ON b.variant_id=v.id
      WHERE v.sku=$1 AND b.location_code='DEMO-STORE' FOR UPDATE OF b`, [p.sku]);
    const { id, on_hand_qty: before } = rows[0];
    assert.ok(before > 0);
    const oldPrices = await db.query('SELECT count(*)::int AS n FROM grocery_dev.prices WHERE variant_id=$1', [id]);
    await db.query("UPDATE grocery_dev.stock_balances SET on_hand_qty=on_hand_qty-1 WHERE variant_id=$1 AND location_code='DEMO-STORE'", [id]);
    await db.query("INSERT INTO grocery_dev.stock_movements(variant_id,location_code,kind,quantity) VALUES ($1,'DEMO-STORE','adjustment',-1)", [id]);
    p.demo_opening_stock_packs = 999;
    p.demo_selling_price = '252.00';
    const digest = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    assert.deepEqual(await applySeed(db,data,digest), { already_imported: false, products: 2, new_opening_balances: 0 });
    assert.equal((await applySeed(db,data,digest)).already_imported,true);
    const balance = await db.query("SELECT on_hand_qty FROM grocery_dev.stock_balances WHERE variant_id=$1 AND location_code='DEMO-STORE'", [id]);
    assert.equal(balance.rows[0].on_hand_qty,before-1);
    const movements = await db.query("SELECT count(*)::int AS n FROM grocery_dev.stock_movements WHERE variant_id=$1 AND kind='opening_stock'", [id]);
    assert.equal(movements.rows[0].n,1);
    const prices = await db.query('SELECT count(*)::int AS total,count(*) FILTER (WHERE valid_to IS NULL)::int AS current FROM grocery_dev.prices WHERE variant_id=$1', [id]);
    assert.deepEqual(prices.rows[0],{ total: oldPrices.rows[0].n+1, current: 1 });
  } finally {
    await db.query('ROLLBACK').catch(() => {});
    await db.end();
  }
});

test('interrupted import rolls back the entire batch', integration, async () => {
  const db = createClient();
  try {
    await db.connect();
    const before = await db.query('SELECT count(*) AS n FROM grocery_dev.seed_imports');
    await db.query('BEGIN');
    const { data } = readDataset();
    data.products = data.products.slice(0,2);
    let variants = 0;
    const interrupted = {
      async query(text: string, values?: unknown[]) {
        if (text.includes('INSERT INTO grocery_dev.product_variants') && ++variants === 2) throw new Error('Simulated interruption');
        return db.query(text,values);
      },
    };
    await assert.rejects(applySeed(interrupted,data,'typescript-rollback-test'),/Simulated interruption/);
    await db.query('ROLLBACK');
    const after = await db.query('SELECT count(*) AS n FROM grocery_dev.seed_imports');
    assert.equal(after.rows[0].n,before.rows[0].n);
  } finally {
    await db.query('ROLLBACK').catch(() => {});
    await db.end();
  }
});
