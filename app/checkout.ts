import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Config } from './config.ts';
import { label,loadCatalog,money,paise } from './catalog.ts';
import { cleanText } from './shopping-parser.ts';

type Item={id:string;sku:string;name:string;brand:string;quantity:string;unit:string;count:number;price:string;packs:number;label:string};
type Order={id:string;reference:string;state:string;payment_status:string;total:string};
const decimal=(n:bigint)=>`${n/100n}.${String(n%100n).padStart(2,'0')}`;
export const orderSummary=(o:Order)=>`Demo pickup ${o.reference}: ${o.state}. Total ${money(paise(o.total))}. Payment: ${o.payment_status}. No real purchase or payment. Reply STATUS ${o.reference} to check progress.`;

async function cartItems(db:PoolClient,cartId:string):Promise<Item[]|null> {
  const catalog=await loadCatalog(db);
  const lines=await db.query('SELECT variant_id,packs FROM grocery_dev.wa_cart_items WHERE cart_id=$1 ORDER BY variant_id',[cartId]);
  const result:Item[]=[];
  for (const line of lines.rows) {
    const v=catalog.find(v=>v.id===line.variant_id);
    if (!v?.active || !v.price || v.available===null || v.available<line.packs) return null;
    result.push({id:v.id,sku:v.sku,name:v.name,brand:v.brand,quantity:v.quantity,unit:v.unit,count:v.count,price:v.price,packs:line.packs,label:label(v)});
  }
  return result;
}

// The caller owns a transaction and the identity row lock, including for operator changes.
export async function transitionOrder(db:PoolClient,order:Order,action:string,actor:'customer'|'operator',cashReceived=false) {
  const target:Record<string,string>={accept:'ACCEPTED',pick:'PICKING',ready:'READY',collect:'COLLECTED',cancel:'CANCELLED',reject:'REJECTED'};
  const next=target[action];
  if (!next) throw new Error('Unknown order action');
  if (order.state===next) return orderSummary(order);
  const allowed:Record<string,string[]>={accept:['PLACED'],pick:['ACCEPTED'],ready:['PICKING'],collect:['READY'],reject:['PLACED'],
    cancel:actor==='customer'?['PLACED','ACCEPTED']:['PLACED','ACCEPTED','PICKING','READY']};
  if ((actor==='customer' && action!=='cancel') || !allowed[action].includes(order.state)) return `Cannot ${action} demo pickup ${order.reference} while ${order.state}. Contact the store operator.`;
  if (action==='collect' && !cashReceived) return 'Collection requires the operator to explicitly record demo cash received with --cash-received.';
  if (['cancel','reject','collect'].includes(action)) {
    const reservations=await db.query(`SELECT r.*,s.reserved_qty,s.on_hand_qty FROM grocery_dev.wa_inventory_reservations r
      JOIN grocery_dev.stock_balances s USING(variant_id,location_code) WHERE r.order_id=$1
      ORDER BY r.variant_id,r.location_code FOR UPDATE OF r,s`,[order.id]);
    if (!reservations.rows.length || reservations.rows.some(r=>r.state!=='ACTIVE' || r.reserved_qty<r.packs || r.on_hand_qty<r.packs)) throw new Error('Reservation invariant failed');
    for (const r of reservations.rows) {
      await db.query(`UPDATE grocery_dev.stock_balances SET reserved_qty=reserved_qty-$3,
        on_hand_qty=on_hand_qty-$4 WHERE variant_id=$1 AND location_code=$2`,[r.variant_id,r.location_code,r.packs,action==='collect'?r.packs:0]);
      if (action==='collect') await db.query(`INSERT INTO grocery_dev.stock_movements(variant_id,location_code,kind,quantity,order_id)
        VALUES ($1,$2,'sale',$3,$4)`,[r.variant_id,r.location_code,-r.packs,order.id]);
    }
    await db.query(`UPDATE grocery_dev.wa_inventory_reservations SET state=$2,resolved_at=now() WHERE order_id=$1`,[order.id,action==='collect'?'CONSUMED':'RELEASED']);
  }
  await db.query(`INSERT INTO grocery_dev.wa_order_events(order_id,from_state,to_state,actor) VALUES ($1,$2,$3,$4)`,[order.id,order.state,next,actor]);
  const {rows}=await db.query(`UPDATE grocery_dev.wa_orders SET state=$2,payment_status=$3,updated_at=now() WHERE id=$1 RETURNING *`,
    [order.id,next,action==='collect'?'DEMO_CASH_RECORDED':'UNPAID']);
  return orderSummary(rows[0]);
}

export async function checkoutReply(db:PoolClient,identityId:string,text:string,occurredAt:Date,config:Config,mode='IDLE'):Promise<string|undefined> {
  const command=text.trim();
  if (!/^(checkout|confirm|pay|place order|status|cancel order)\b/i.test(command)) return undefined;
  const status=command.match(/^status(?:\s+(D-[A-F0-9]{12}))?$/i);
  const cancel=command.match(/^cancel order\s+(D-[A-F0-9]{12})$/i);
  if (status || cancel) {
    const {rows}=await db.query(`SELECT * FROM grocery_dev.wa_orders WHERE identity_id=$1
      AND ($2::text IS NULL OR reference=$2) ORDER BY created_at DESC LIMIT 3 FOR UPDATE`,[identityId,(status?.[1]??cancel?.[1])?.toUpperCase()??null]);
    if (!rows.length) return 'No matching demo pickup order for this conversation. Reply CART or CHECKOUT.';
    return cancel?transitionOrder(db,rows[0],'cancel','customer'):rows.map(orderSummary).join('\n');
  }
  if (mode==='HUMAN_HANDOFF') return 'Automated checkout is paused for this conversation. Your cart is saved. Contact the store operator.';
  const carts=await db.query('SELECT * FROM grocery_dev.wa_carts WHERE identity_id=$1 FOR UPDATE',[identityId]);
  const cart=carts.rows[0];
  const confirm=command.match(/^confirm\s+([a-f0-9]{16})$/i);
  if (confirm) {
    const quotes=await db.query(`SELECT q.*,q.expires_at<=now() AS expired FROM grocery_dev.wa_checkout_quotes q
      JOIN grocery_dev.wa_carts c ON c.id=q.cart_id WHERE c.identity_id=$1 AND q.token=$2 FOR UPDATE OF q`,[identityId,confirm[1].toLowerCase()]);
    const quote=quotes.rows[0];
    if (!quote) return 'That checkout code does not belong to this cart. Reply CHECKOUT for a fresh summary.';
    const prior=await db.query('SELECT * FROM grocery_dev.wa_orders WHERE quote_id=$1',[quote.id]);
    if (prior.rows.length) return orderSummary(prior.rows[0]);
    if (quote.expired || quote.state!=='pending' || quote.cart_revision!==cart.revision || quote.store_name!==config.storeName ||
      (cart.last_action_at && occurredAt<cart.last_action_at)) return 'Checkout expired or the cart changed. No order was created. Reply CHECKOUT to review again.';
    // Lock shared inventory and current terms in a fixed order before comparing or reserving any line.
    await db.query(`SELECT v.id FROM grocery_dev.product_variants v JOIN grocery_dev.products p ON p.id=v.product_id
      JOIN grocery_dev.brands b ON b.id=p.brand_id JOIN grocery_dev.prices pr ON pr.variant_id=v.id AND pr.valid_to IS NULL
      JOIN grocery_dev.stock_balances s ON s.variant_id=v.id AND s.location_code='DEMO-STORE'
      WHERE v.id=ANY($1::uuid[]) ORDER BY v.id FOR UPDATE OF v,p,b,pr,s`,[quote.items.map((i:Item)=>i.id)]);
    const live=await cartItems(db,cart.id);
    if (!live || live.length!==quote.items.length || live.some((item,index)=>Object.entries(item).some(([key,value])=>quote.items[index][key]!==value)) || (await db.query('SELECT 1 FROM grocery_dev.wa_shopping_prompts WHERE cart_id=$1',[cart.id])).rowCount) {
      await db.query("UPDATE grocery_dev.wa_checkout_quotes SET state='invalidated' WHERE id=$1",[quote.id]);
      return 'Price, pack, cart or availability changed. No order or stock reservation was created. Reply CHECKOUT to review fresh terms.';
    }
    const {rows}=await db.query(`INSERT INTO grocery_dev.wa_orders(reference,quote_id,identity_id,items,store_name,total)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,['D-'+randomBytes(6).toString('hex').toUpperCase(),quote.id,identityId,JSON.stringify(quote.items),quote.store_name,quote.total]);
    for (const item of live) {
      const reserved=await db.query(`UPDATE grocery_dev.stock_balances SET reserved_qty=reserved_qty+$2
        WHERE variant_id=$1 AND location_code='DEMO-STORE' AND on_hand_qty-reserved_qty >= $2 RETURNING variant_id`,[item.id,item.packs]);
      if (reserved.rowCount!==1) throw new Error('Stock changed during reservation');
      await db.query('INSERT INTO grocery_dev.wa_inventory_reservations(order_id,variant_id,packs) VALUES ($1,$2,$3)',[rows[0].id,item.id,item.packs]);
    }
    await db.query("UPDATE grocery_dev.wa_checkout_quotes SET state='confirmed' WHERE id=$1",[quote.id]);
    await db.query("INSERT INTO grocery_dev.wa_order_events(order_id,to_state,actor) VALUES ($1,'PLACED','customer')",[rows[0].id]);
    await db.query('DELETE FROM grocery_dev.wa_cart_items WHERE cart_id=$1',[cart.id]);
    await db.query('UPDATE grocery_dev.wa_carts SET revision=revision+1,last_action_at=GREATEST(last_action_at,$2::timestamptz),updated_at=now() WHERE id=$1',[cart.id,occurredAt]);
    return orderSummary(rows[0])+` Stock held pending operator acceptance. CANCEL ORDER ${rows[0].reference} releases the hold before picking.`;
  }
  if (!/^checkout(?:\s+pickup)?$/i.test(command)) return 'Use CHECKOUT to review demo pickup, CONFIRM <checkout code>, STATUS [order reference], or CANCEL ORDER <reference>. No online payments are enabled.';
  if (!cart) return 'Your demo cart is empty. Send a shopping list first.';
  if (cart.last_action_at && occurredAt<cart.last_action_at) return 'That message predates the current cart. Reply CHECKOUT again.';
  if ((await db.query('SELECT 1 FROM grocery_dev.wa_shopping_prompts WHERE cart_id=$1',[cart.id])).rowCount) return 'Resolve the pending item first: reply CHOICES, then choose, replace or skip it.';
  const items=await cartItems(db,cart.id);
  if (!items) return 'An item is inactive, unpriced or unavailable. No order or stock reservation was created. Reply CART and adjust the items.';
  if (!items.length) return 'Your demo cart is empty. Send a shopping list first.';
  if (items.length>20) throw new Error('Cart limit exceeded');
  const total=items.reduce((sum,i)=>sum+paise(i.price)*BigInt(i.packs),0n);
  const token=randomBytes(8).toString('hex');
  await db.query("UPDATE grocery_dev.wa_checkout_quotes SET state='invalidated' WHERE cart_id=$1 AND state='pending'",[cart.id]);
  await db.query(`INSERT INTO grocery_dev.wa_checkout_quotes(cart_id,token,cart_revision,items,store_name,total)
    VALUES ($1,$2,$3,$4,$5,$6)`,[cart.id,token,cart.revision,JSON.stringify(items),config.storeName,decimal(total)]);
  return [`Demo pickup review — ${cleanText(config.storeName,100)}`,...items.map(i=>`${i.packs} x ${i.label} @ ${money(paise(i.price))} = ${money(paise(i.price)*BigInt(i.packs))}`),
    `Total: ${money(total)}. Demo fees/taxes: INR 0.00 (not configured; not a tax invoice).`,
    'Pay at pickup: UNPAID. Demo only: no real purchase, payment or pickup location is arranged.',
    `No order or stock reservation yet. Reply CONFIRM ${token} within 10 minutes to place this demo pickup, subject to stock recheck.`].join('\n');
}
