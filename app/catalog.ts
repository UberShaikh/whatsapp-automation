import type { PoolClient } from 'pg';
import { baseQuantity,cleanText,family,normalize } from './shopping-parser.ts';
import type { ItemRequest,Unit } from './shopping-parser.ts';

export type Variant={id:string;sku:string;name:string;brand:string;aliases:string[];active:boolean;
  quantity:string;unit:Unit;count:number;price:string|null;available:number|null};
export type Offer={variant:Variant;packs:number;exact:boolean;reason:string};
export const paise=(price:string)=>BigInt(price.replace('.',''));
export const money=(value:bigint)=>`INR ${value/100n}.${String(value%100n).padStart(2,'0')}`;
export const title=(v:Variant)=>`${v.brand} ${v.name}`;
export function packLabel(v:Variant) {
  const quantity=v.quantity.replace(/\.0+$/,'').replace(/(\.\d*?)0+$/,'$1');
  return `${v.count>1?`${v.count} x `:''}${quantity} ${v.unit}`;
}
export const label=(v:Variant)=>`${cleanText(title(v),60)} [${packLabel(v)}]`;

export async function loadCatalog(db:PoolClient):Promise<Variant[]> {
  // shortcut: scan at most 500 variants for this seeded demo; use indexed SQL search before expanding it.
  const {rows}=await db.query(`SELECT v.id,v.sku,p.name,b.name AS brand,v.aliases,v.is_active,
    v.pack_quantity::text AS quantity,v.pack_unit AS unit,v.pack_count AS count,
    pr.amount::text AS price,(s.on_hand_qty-s.reserved_qty) AS available
    FROM grocery_dev.product_variants v JOIN grocery_dev.products p ON p.id=v.product_id
    JOIN grocery_dev.brands b ON b.id=p.brand_id
    LEFT JOIN grocery_dev.prices pr ON pr.variant_id=v.id AND pr.valid_to IS NULL
    LEFT JOIN grocery_dev.stock_balances s ON s.variant_id=v.id AND s.location_code='DEMO-STORE'
    ORDER BY v.sku LIMIT 501`);
  return rows.map(r=>({id:r.id,sku:r.sku,name:r.name,brand:r.brand,aliases:r.aliases,
    active:r.is_active && /^\d{1,9}(?:\.\d{1,3})?$/.test(r.quantity) && Number(r.quantity)>0,
    quantity:r.quantity,unit:r.unit,count:r.count,available:r.available,
    price:typeof r.price==='string' && /^\d+\.\d{2}$/.test(r.price) && paise(r.price)>0n?r.price:null}));
}

export function matchVariants(query:string,catalog:Variant[]) {
  const words=normalize(query).split(' ');
  return catalog.filter(v=>{
    const tokens=new Set(normalize([v.name,v.brand,v.sku,...v.aliases].join(' ')).split(' '));
    return v.active && v.price!==null && words.every(w=>tokens.has(w));
  })
    .sort((a,b)=>a.sku.localeCompare(b.sku));
}

export function planOffer(request:ItemRequest,variant:Variant,alreadyInCart=0):Offer {
  let packs=BigInt(request.count);let exact=true;let reason='';
  if (request.pieces) {
    packs=(BigInt(request.count)+BigInt(variant.count)-1n)/BigInt(variant.count);
    exact=request.count%variant.count===0;
    if (!exact) reason=`Sold as ${variant.count} items per pack`;
    if (request.size && (family(request.size.unit)!==family(variant.unit) || baseQuantity(request.size.quantity,request.size.unit)!==baseQuantity(variant.quantity,variant.unit))) {
      exact=false;reason='The stocked size differs from your request';
    }
  } else if (request.size) {
    if (family(request.size.unit)!==family(variant.unit)) { exact=false;reason='Weight and volume cannot be equated'; }
    else {
      const requested=baseQuantity(request.size.quantity,request.size.unit)*(request.total?1n:BigInt(request.count));
      const perPack=baseQuantity(variant.quantity,variant.unit)*BigInt(variant.count);
      packs=(requested+perPack-1n)/perPack;
      exact=request.total?requested%perPack===0n:baseQuantity(request.size.quantity,request.size.unit)===perPack;
      if (!exact) reason='The stocked pack differs from your request';
    }
  } else if (variant.count>1 && !request.explicitPacks) { exact=false;reason=`Multipack: ${variant.count} items per pack`; }
  const remaining=Math.max(0,(variant.available??0)-alreadyInCart);
  const cap=Math.min(99-alreadyInCart,remaining);
  if (packs>BigInt(cap)) { exact=false;reason=`Only ${cap} more pack(s) can be added`; }
  const proposed=packs>BigInt(cap)?cap:Number(packs);
  return {variant,packs:Math.max(0,proposed),exact,reason};
}
