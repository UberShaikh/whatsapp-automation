/** Explicit development import only; importing this module changes no data. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from 'pg';
import type { QueryResult } from 'pg';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_FILE = fileURLToPath(new URL('../data/seed/indian-household-groceries.json', import.meta.url));
const MIGRATION = new URL('../migrations/001_grocery_dev.sql', import.meta.url);
export const LOCK_ID = 731408629;
type Database = { query(text: string, values?: unknown[]): Promise<QueryResult> };
export type Product = {
  sku: string; name: string; brand: string; category_path: string[]; aliases: string[];
  pack_quantity: number; pack_unit: string; pack_count: number; sell_unit: string;
  currency: string; demo_selling_price: string; demo_opening_stock_packs: number;
  image_url: string; source_url: string; image_source_url: string; source_price_status: string;
  [key: string]: unknown;
};
export type Dataset = {
  schema_version: number; usage: string; import_policy: string; currency: string;
  stock_location_code: string; dataset_id: string; products: Product[];
};
class SeedInputError extends Error {}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SeedInputError(message);
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const hash = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');

export function validate(data: unknown): asserts data is Dataset {
  check(object(data), 'Dataset must be an object');
  check(data.schema_version === 1, 'Unsupported dataset version');
  check(data.usage === 'development_and_staging_only', 'Only development seed data is supported');
  check(data.import_policy === 'manual_preview_then_explicit_apply_never_on_startup', 'Manual import policy required');
  check(data.currency === 'INR', 'Only INR is supported');
  check(data.stock_location_code === 'DEMO-STORE', 'Only DEMO-STORE is supported');
  check(typeof data.dataset_id === 'string' && data.dataset_id.trim(), 'Dataset ID required');
  check(Array.isArray(data.products) && data.products.length > 0 && data.products.length <= 10000, 'Expected 1-10000 products');
  const seen = new Set<string>();
  for (const row of data.products) {
    check(object(row), 'Each product must be an object');
    const sku = row.sku;
    check(typeof sku === 'string' && /^[A-Z0-9-]{1,100}$/.test(sku), 'Invalid SKU');
    check(!seen.has(sku), `Duplicate SKU: ${sku}`);
    seen.add(sku);
    for (const field of ['name', 'brand']) {
      const v = row[field];
      check(typeof v === 'string' && v.trim().length > 0 && v.length <= 200, `${sku}: invalid ${field}`);
    }
    for (const field of ['category_path', 'aliases']) {
      const v = row[field];
      check(Array.isArray(v) && v.length > 0 && v.length <= 20, `${sku}: invalid ${field}`);
      check(v.every(x => typeof x === 'string' && x.trim().length > 0 && x.length <= 200), `${sku}: invalid ${field} values`);
    }
    check(row.currency === 'INR' && row.sell_unit === 'pack', `${sku}: invalid currency/sell unit`);
    check(['g', 'kg', 'ml', 'l'].includes(String(row.pack_unit)), `${sku}: invalid pack unit`);
    check(Number.isInteger(row.pack_count) && Number(row.pack_count) > 0 && Number(row.pack_count) <= 10000, `${sku}: invalid pack count`);
    check(Number.isInteger(row.demo_opening_stock_packs) && Number(row.demo_opening_stock_packs) >= 0 && Number(row.demo_opening_stock_packs) <= 2147483647, `${sku}: invalid stock`);
    const quantity = row.pack_quantity;
    check(typeof quantity === 'number' && Number.isFinite(quantity) && quantity > 0 && quantity < 1e9 && /^\d+(\.\d{1,3})?$/.test(String(quantity)), `${sku}: invalid pack precision`);
    const price = row.demo_selling_price;
    check(typeof price === 'string' && /^\d{1,10}\.\d{2}$/.test(price) && BigInt(price.replace('.', '')) > 0n, `${sku}: price must be a positive decimal string`);
    for (const [field, host] of [['source_url','www.bigbasket.com'], ['image_source_url','www.bigbasket.com'], ['image_url','www.bbassets.com']]) {
      const v = row[field];
      check(typeof v === 'string', `${sku}: missing ${field}`);
      let url: URL;
      try { url = new URL(v); } catch { throw new SeedInputError(`${sku}: invalid ${field}`); }
      check(url.protocol === 'https:' && url.host === host && !url.username && !url.password && !url.hash, `${sku}: invalid ${field}`);
    }
    check(['reference_only','not_available','rejected_anomaly'].includes(String(row.source_price_status)), `${sku}: invalid source price status`);
  }
}

export function readDataset(path = DEFAULT_FILE) {
  const content = readFileSync(path);
  const data: unknown = JSON.parse(content.toString('utf8'));
  validate(data);
  return { data, digest: hash(content) };
}

export function loadConfig() {
  const env = new URL('../.env', import.meta.url);
  if (existsSync(env)) process.loadEnvFile(fileURLToPath(env));
  check(['local','development','dev','test','staging'].includes((process.env.APP_ENV ?? 'development').toLowerCase()), 'Demo seeding is forbidden in production');
  check(process.env.DATABASE_URL, 'DATABASE_URL must be configured privately in .env');
  return process.env.DATABASE_URL;
}

export function createClient() {
  return new Client({ connectionString: loadConfig(), connectionTimeoutMillis: 10000,
    statement_timeout: 30000, lock_timeout: 10000 });
}

async function migrationReady(db: Database) {
  return (await db.query("SELECT to_regclass('grocery_dev.schema_migrations') IS NOT NULL AS ready")).rows[0].ready;
}

export async function initSchema(db: Database) {
  // Preserve the checksum produced by the previous importer, including on Windows.
  const sql = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n');
  const checksum = hash(sql);
  await db.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
  if (await migrationReady(db)) {
    const { rows } = await db.query("SELECT checksum FROM grocery_dev.schema_migrations WHERE version='001'");
    check(rows[0]?.checksum === checksum, 'Existing migration checksum differs; inspect before continuing');
    return 'Schema already initialized';
  }
  const { rows } = await db.query("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='grocery_dev') AS present");
  check(!rows[0].present, 'Existing unmanaged grocery_dev schema; inspect before continuing');
  await db.query(sql);
  await db.query("INSERT INTO grocery_dev.schema_migrations(version,checksum) VALUES ('001',$1)", [checksum]);
  return 'Initialized grocery_dev schema (no products imported)';
}

export async function preview(db: Database, data: Dataset) {
  if (!(await migrationReady(db))) return { insert_products: data.products.length, existing_skus: 0, schema_required: true };
  const { rows } = await db.query('SELECT sku FROM grocery_dev.product_variants WHERE sku=ANY($1::text[])', [data.products.map(p => p.sku)]);
  return { insert_products: data.products.length - rows.length, existing_skus: rows.length, schema_required: false };
}

// shortcut: demo imports remain confined to grocery_dev; production needs reviewed store data/migrations.
export async function applySeed(db: Database, data: Dataset, digest: string) {
  validate(data);
  check(await migrationReady(db), 'Run --init-schema explicitly first');
  await db.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
  const prior = await db.query('SELECT product_count FROM grocery_dev.seed_imports WHERE file_sha256=$1', [digest]);
  if (prior.rows.length) return { already_imported: true, products: prior.rows[0].product_count, new_opening_balances: 0 };
  for (const p of data.products) {
    const { rows } = await db.query('SELECT pack_quantity,pack_unit,pack_count FROM grocery_dev.product_variants WHERE sku=$1', [p.sku]);
    if (rows.length) check(Number(rows[0].pack_quantity) === p.pack_quantity && rows[0].pack_unit === p.pack_unit && rows[0].pack_count === p.pack_count, `${p.sku}: pack identity changed; use a new SKU`);
  }
  const batch = await db.query('INSERT INTO grocery_dev.seed_imports(file_sha256,dataset_id,product_count) VALUES ($1,$2,$3) RETURNING id', [digest,data.dataset_id,data.products.length]);
  const importId = batch.rows[0].id;
  let openings = 0;
  for (const p of data.products) {
    let parent: string | null = null;
    for (let depth = 1; depth <= p.category_path.length; depth++) {
      const { rows } = await db.query('INSERT INTO grocery_dev.categories(name,path,parent_id) VALUES ($1,$2,$3) ON CONFLICT (path) DO UPDATE SET name=EXCLUDED.name RETURNING id', [p.category_path[depth-1],p.category_path.slice(0,depth),parent]);
      parent = rows[0].id;
    }
    const brand = await db.query('INSERT INTO grocery_dev.brands(name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id', [p.brand]);
    const product = await db.query('INSERT INTO grocery_dev.products(name,brand_id,category_id) VALUES ($1,$2,$3) ON CONFLICT (name,brand_id,category_id) DO UPDATE SET name=EXCLUDED.name RETURNING id', [p.name,brand.rows[0].id,parent]);
    const variant = await db.query(`INSERT INTO grocery_dev.product_variants
      (product_id,sku,pack_quantity,pack_unit,pack_count,sell_unit,aliases,image_url,source_metadata,last_import_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (sku) DO UPDATE SET product_id=EXCLUDED.product_id,aliases=EXCLUDED.aliases,
        image_url=EXCLUDED.image_url,source_metadata=EXCLUDED.source_metadata,
        last_import_id=EXCLUDED.last_import_id,updated_at=now() RETURNING id`,
      [product.rows[0].id,p.sku,p.pack_quantity,p.pack_unit,p.pack_count,p.sell_unit,p.aliases,p.image_url,JSON.stringify(p),importId]);
    const id = variant.rows[0].id;
    const current = await db.query('SELECT amount FROM grocery_dev.prices WHERE variant_id=$1 AND valid_to IS NULL', [id]);
    // PostgreSQL numeric values and input prices stay decimal strings, never JS money arithmetic.
    if (!current.rows.length || BigInt(current.rows[0].amount.replace('.','')) !== BigInt(p.demo_selling_price.replace('.',''))) {
      await db.query('UPDATE grocery_dev.prices SET valid_to=now() WHERE variant_id=$1 AND valid_to IS NULL', [id]);
      await db.query('INSERT INTO grocery_dev.prices(variant_id,amount,currency,import_id) VALUES ($1,$2,$3,$4)', [id,p.demo_selling_price,'INR',importId]);
    }
    const balance = await db.query(`INSERT INTO grocery_dev.stock_balances(variant_id,location_code,on_hand_qty)
      VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING variant_id`, [id,data.stock_location_code,p.demo_opening_stock_packs]);
    // Existing balances can reflect sales; imports must never reset them.
    if (balance.rows.length) {
      await db.query("INSERT INTO grocery_dev.stock_movements(variant_id,location_code,kind,quantity,import_id) VALUES ($1,$2,'opening_stock',$3,$4)", [id,data.stock_location_code,p.demo_opening_stock_packs,importId]);
      openings++;
    }
  }
  return { already_imported: false, products: data.products.length, new_opening_balances: openings };
}

export async function main() {
  const { values } = parseArgs({ options: {
    preview: { type: 'boolean' }, 'init-schema': { type: 'boolean' }, apply: { type: 'boolean' },
    file: { type: 'string' }, 'expected-sha256': { type: 'string' },
  }});
  check([values.preview,values['init-schema'],values.apply].filter(Boolean).length === 1, 'Choose exactly one: --preview, --init-schema, --apply');
  const { data, digest } = readDataset(values.file ?? DEFAULT_FILE);
  if (values.apply) check(values['expected-sha256'] === digest, 'Apply requires --expected-sha256 matching the reviewed preview');
  const db = createClient();
  try {
    await db.connect();
    await db.query(values.preview ? 'BEGIN READ ONLY' : 'BEGIN');
    const result = values['init-schema'] ? await initSchema(db)
      : values.preview ? { file_sha256: digest, schema: 'grocery_dev', ...await preview(db,data) }
      : await applySeed(db,data,digest);
    await db.query('COMMIT');
    console.log(JSON.stringify(result,null,2));
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await db.end();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    // Driver errors can expose credentials/hostnames; print only their error type.
    console.error(`Seed failed: ${error instanceof SeedInputError ? error.message : error instanceof Error ? error.name : 'Unknown error'}`);
    process.exitCode = 1;
  });
}
