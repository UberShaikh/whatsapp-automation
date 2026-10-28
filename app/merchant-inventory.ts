import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

export class MerchantError extends Error {
  status:number;
  constructor(status:number,message:string) {super(message);this.status=status;}
}
export const uuid=(value:unknown):value is string=>typeof value==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
export type Adjustment={requestId:string;variantId:string;action:'receive'|'remove'|'recount';quantity:number;reason:string;expectedOnHand:number;expectedReserved:number};
export function parseAdjustment(value:unknown):Adjustment {
  const v=value as Record<string,unknown>|null;
  const whole=(n:unknown):n is number=>typeof n==='number' && Number.isSafeInteger(n) && n>=0 && n<=1000000;
  if (!v || !uuid(v.requestId) || !uuid(v.variantId) || !['receive','remove','recount'].includes(v.action as string) || !whole(v.quantity) ||
    (v.action!=='recount' && v.quantity===0) || typeof v.reason!=='string' || v.reason.trim().length<3 || v.reason.trim().length>200 ||
    !whole(v.expectedOnHand) || !whole(v.expectedReserved)) throw new MerchantError(400,'Choose a product, whole pack quantity and a reason of 3–200 characters.');
  return {requestId:v.requestId,variantId:v.variantId,action:v.action as Adjustment['action'],quantity:v.quantity,reason:v.reason.trim(),expectedOnHand:v.expectedOnHand,expectedReserved:v.expectedReserved};
}
export async function requireMerchant(db:PoolClient,userId:string,lock=false) {
  const {rows}=await db.query(`SELECT location_code FROM grocery_dev.merchant_access WHERE user_id=$1 AND is_active ${lock?'FOR SHARE':''}`,[userId]);
  if (!rows.length) throw new MerchantError(403,'Your account is waiting for merchant access. Ask the store owner to approve it.');
  return rows[0].location_code as string;
}
export async function inventory(db:PoolClient,location:string) {
  const {rows}=await db.query(`SELECT v.id,v.sku,p.name,b.name AS brand,c.name AS category,v.pack_quantity::text AS pack_quantity,
    v.pack_unit,v.pack_count,v.is_active,pr.amount::text AS price,s.on_hand_qty AS on_hand,s.reserved_qty AS reserved,
    s.on_hand_qty-s.reserved_qty AS available FROM grocery_dev.stock_balances s
    JOIN grocery_dev.product_variants v ON v.id=s.variant_id JOIN grocery_dev.products p ON p.id=v.product_id
    JOIN grocery_dev.brands b ON b.id=p.brand_id JOIN grocery_dev.categories c ON c.id=p.category_id
    LEFT JOIN grocery_dev.prices pr ON pr.variant_id=v.id AND pr.valid_to IS NULL
    WHERE s.location_code=$1 ORDER BY p.name,b.name,v.sku LIMIT 5001`,[location]);
  // shortcut: this store has 33 variants; add server pagination before exceeding 5,000 stocked variants.
  if (rows.length>5000) throw new MerchantError(503,'This catalog needs server pagination before it can be loaded.');
  return rows;
}
export async function stockHistory(db:PoolClient,location:string) {
  return (await db.query(`SELECT m.id,m.created_at,m.kind,m.quantity,v.sku,p.name,b.name AS brand,
    a.action,a.reason,a.before_qty,a.after_qty,a.reserved_qty,a.user_id,
    o.reference AS order_reference FROM grocery_dev.stock_movements m
    JOIN grocery_dev.product_variants v ON v.id=m.variant_id JOIN grocery_dev.products p ON p.id=v.product_id
    JOIN grocery_dev.brands b ON b.id=p.brand_id LEFT JOIN grocery_dev.merchant_stock_adjustments a ON a.movement_id=m.id
    LEFT JOIN grocery_dev.wa_orders o ON o.id=m.order_id
    WHERE m.location_code=$1 ORDER BY m.created_at DESC,m.id LIMIT 100`,[location])).rows;
}
// Called inside a transaction; membership and stock locks serialize revocation and checkout reservations.
export async function adjustStock(db:PoolClient,userId:string,input:Adjustment) {
  const location=await requireMerchant(db,userId,true);
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`merchant-adjustment:${input.requestId}`]);
  const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const prior=await db.query('SELECT * FROM grocery_dev.merchant_stock_adjustments WHERE request_id=$1',[input.requestId]);
  if (prior.rows.length) {
    if (prior.rows[0].user_id!==userId || prior.rows[0].request_hash!==hash) throw new MerchantError(409,'This save reference has already been used. Refresh and try again.');
    return {onHand:prior.rows[0].after_qty,reserved:prior.rows[0].reserved_qty,repeated:true};
  }
  const {rows}=await db.query('SELECT * FROM grocery_dev.stock_balances WHERE variant_id=$1 AND location_code=$2 FOR UPDATE',[input.variantId,location]);
  const stock=rows[0];
  if (!stock) throw new MerchantError(404,'This product is not stocked at your store.');
  if (stock.on_hand_qty!==input.expectedOnHand || stock.reserved_qty!==input.expectedReserved) throw new MerchantError(409,'Stock changed since you opened this form. Refresh and review the new quantities.');
  const next=input.action==='recount'?input.quantity:stock.on_hand_qty+(input.action==='receive'?input.quantity:-input.quantity);
  if (next<stock.reserved_qty) throw new MerchantError(409,`Keep at least ${stock.reserved_qty} reserved pack(s) on hand. Resolve the order holds before reducing this stock.`);
  if (next>1000000) throw new MerchantError(400,'On-hand stock cannot exceed 1,000,000 packs.');
  if (next===stock.on_hand_qty) throw new MerchantError(400,'The stock count is unchanged. Enter a different quantity.');
  await db.query('UPDATE grocery_dev.stock_balances SET on_hand_qty=$3 WHERE variant_id=$1 AND location_code=$2',[input.variantId,location,next]);
  const movement=await db.query(`INSERT INTO grocery_dev.stock_movements(variant_id,location_code,kind,quantity) VALUES ($1,$2,'adjustment',$3) RETURNING id`,[input.variantId,location,next-stock.on_hand_qty]);
  await db.query(`INSERT INTO grocery_dev.merchant_stock_adjustments(request_id,user_id,variant_id,location_code,movement_id,action,quantity,reason,before_qty,after_qty,reserved_qty,request_hash)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[input.requestId,userId,input.variantId,location,movement.rows[0].id,input.action,input.quantity,input.reason,stock.on_hand_qty,next,stock.reserved_qty,hash]);
  return {onHand:next,reserved:stock.reserved_qty,repeated:false};
}
