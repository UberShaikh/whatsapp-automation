import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { cleanText,parseItem,parseList,ShoppingInputError } from './shopping-parser.ts';
import { label,loadCatalog,matchVariants,money,paise,packLabel,planOffer,title } from './catalog.ts';
import type { Variant,Offer } from './catalog.ts';

type Cart={id:string;revision:string;next_line_no:number;last_action_at:Date|null};
type Line={variant_id:string;line_no:number;packs:number};
type Choice={position:number;variant_id:string;packs:number;unit_price:string;pack_quantity:string;pack_unit:string;pack_count:number;display_name:string;reason:string};
type Prompt={id:string;token:string;cart_revision:string;request_text:string;remaining_requests:string[];attempts:number;expired:boolean;choices:Choice[]};
type ShoppingReply={body:string;handoff?:boolean};

function renderCart(lines:Line[],catalog:Variant[],limit=20) {
  if (!lines.length) return 'Demo cart is empty. Send a list such as: 2 milk 1 l, 1 kg rice.';
  const map=new Map(catalog.map(v=>[v.id,v]));let total=0n;let priced=true;
  const result=['Demo cart (sellable packs):'];
  for (const [index,line] of lines.entries()) {
    const v=map.get(line.variant_id);
    if (!v || !v.price) priced=false;
    else total+=paise(v.price)*BigInt(line.packs);
    if (index>=limit) continue;
    if (!v) { result.push(`${line.line_no}. Unavailable product; REMOVE ${line.line_no} to remove it.`);continue; }
    const warning=!v.active?' [inactive]':v.available===null?' [stock unverified]':v.available<line.packs?` [only ${v.available} available now]`:'';
    result.push(`${line.line_no}. ${line.packs} x ${label(v)} @ ${v.price?money(paise(v.price)):'price unavailable'}${warning}`);
  }
  if (lines.length>limit) result.push(`+ ${lines.length-limit} more line(s); reply CART to view all.`);
  result.push(priced?`Items subtotal: ${money(total)}`:'Subtotal unavailable until every item has a current price.');
  result.push('Demo prices; stock is not reserved. Reply CHECKOUT to review demo pickup.');
  result.push('CHANGE <line> <packs>, REMOVE <line>, or CANCEL to clear the cart.');
  return result.join('\n');
}

function renderPrompt(prompt:Prompt) {
  const result=[`Please resolve: "${cleanText(prompt.request_text,70)}".`];
  if (!prompt.choices.length) result.push('No matching available pack can be added. Check the product/brand, available stock, or cart limit (20 lines / 99 packs per item).');
  else {
    result.push('Confirm the exact brand, pack and quantity below; these may differ from your request:');
    for (const c of prompt.choices) result.push(`${c.position}. Add ${c.packs} pack(s): ${cleanText(c.display_name,60)} [${c.pack_count>1?`${c.pack_count} x `:''}${c.pack_quantity.replace(/\.0+$/,'')} ${c.pack_unit}] @ ${money(paise(c.unit_price))} per pack.${c.reason?` ${c.reason}.`:''}`);
    result.push(`Reply CHOOSE ${prompt.token} <number>.`);
  }
  result.push(`REPLACE ${prompt.token} <one item> or SKIP ${prompt.token}. Choices expire in 10 minutes.`);
  result.push('Only available choices are shown (up to 3); use REPLACE to refine the brand or product.');
  return result.join('\n');
}

async function readPrompt(db:PoolClient,cartId:string):Promise<Prompt|null> {
  const {rows}=await db.query('SELECT *,expires_at<=now() AS expired FROM grocery_dev.wa_shopping_prompts WHERE cart_id=$1',[cartId]);
  if (!rows.length) return null;
  const choices=await db.query(`SELECT position,variant_id,packs,unit_price::text,pack_quantity::text,pack_unit,pack_count,display_name,reason
    FROM grocery_dev.wa_shopping_choices WHERE prompt_id=$1 ORDER BY position`,[rows[0].id]);
  return {...rows[0],choices:choices.rows};
}

async function saveCart(db:PoolClient,cart:Cart,lines:Line[],occurredAt:Date) {
  await db.query('DELETE FROM grocery_dev.wa_cart_items WHERE cart_id=$1 AND NOT (variant_id=ANY($2::uuid[]))',[cart.id,lines.map(l=>l.variant_id)]);
  if (lines.length) {
    const values=lines.flatMap(l=>[cart.id,l.variant_id,l.line_no,l.packs]);
    const placeholders=lines.map((_,i)=>`(${[1,2,3,4].map(n=>`$${i*4+n}`).join(',')})`).join(',');
    await db.query(`INSERT INTO grocery_dev.wa_cart_items(cart_id,variant_id,line_no,packs) VALUES ${placeholders}
      ON CONFLICT (cart_id,variant_id) DO UPDATE SET packs=EXCLUDED.packs`,values);
  }
  const {rows}=await db.query(`UPDATE grocery_dev.wa_carts SET revision=revision+1,next_line_no=$2,
    last_action_at=GREATEST(last_action_at,$3::timestamptz),updated_at=now() WHERE id=$1 RETURNING revision,last_action_at`,[cart.id,cart.next_line_no,occurredAt]);
  cart.revision=rows[0].revision;cart.last_action_at=rows[0].last_action_at;
}

function offersFor(raw:string,lines:Line[],catalog:Variant[]) {
  const request=parseItem(raw);
  return matchVariants(request.query,catalog).map(v=>planOffer(request,v,lines.find(l=>l.variant_id===v.id)?.packs??0));
}

async function writePrompt(db:PoolClient,cart:Cart,lines:Line[],catalog:Variant[],raw:string,remaining:string[]):Promise<Prompt> {
  const offers=offersFor(raw,lines,catalog).filter(o=>o.packs>0 && (lines.length<20 || lines.some(l=>l.variant_id===o.variant.id)))
    .sort((a,b)=>Number(b.exact)-Number(a.exact)||a.variant.sku.localeCompare(b.variant.sku)).slice(0,3);
  await db.query('DELETE FROM grocery_dev.wa_shopping_prompts WHERE cart_id=$1',[cart.id]);
  const token=randomBytes(8).toString('hex');
  const {rows}=await db.query(`INSERT INTO grocery_dev.wa_shopping_prompts(cart_id,token,cart_revision,request_text,remaining_requests)
    VALUES ($1,$2,$3,$4,$5) RETURNING id`,[cart.id,token,cart.revision,raw,remaining]);
  const choices:Choice[]=offers.map((o,i)=>({position:i+1,variant_id:o.variant.id,packs:o.packs,unit_price:o.variant.price!,
    pack_quantity:o.variant.quantity,pack_unit:o.variant.unit,pack_count:o.variant.count,display_name:title(o.variant),reason:o.reason}));
  if (choices.length) {
    const values=choices.flatMap(c=>[rows[0].id,c.position,c.variant_id,c.packs,c.unit_price,c.pack_quantity,c.pack_unit,c.pack_count,c.display_name,c.reason]);
    const placeholders=choices.map((_,i)=>`(${Array.from({length:10},(_,n)=>`$${i*10+n+1}`).join(',')})`).join(',');
    await db.query(`INSERT INTO grocery_dev.wa_shopping_choices
      (prompt_id,position,variant_id,packs,unit_price,pack_quantity,pack_unit,pack_count,display_name,reason) VALUES ${placeholders}`,values);
  }
  return {id:rows[0].id,token,cart_revision:cart.revision,request_text:raw,remaining_requests:remaining,attempts:0,expired:false,choices};
}

function addOffer(cart:Cart,lines:Line[],offer:Offer) {
  const existing=lines.find(l=>l.variant_id===offer.variant.id);
  if (existing) existing.packs+=offer.packs;
  else lines.push({variant_id:offer.variant.id,line_no:cart.next_line_no++,packs:offer.packs});
}

async function advance(db:PoolClient,cart:Cart,lines:Line[],catalog:Variant[],requests:string[],occurredAt:Date,prefix=''):Promise<string> {
  let unresolved=-1;
  for (const [index,raw] of requests.entries()) {
    const offers=offersFor(raw,lines,catalog);const exact=offers.filter(o=>o.exact);
    if (offers.length!==1 || exact.length!==1 || exact[0].packs<1 || (lines.length>=20 && !lines.some(l=>l.variant_id===exact[0].variant.id))) {unresolved=index;break;}
    addOffer(cart,lines,exact[0]);
  }
  await saveCart(db,cart,lines,occurredAt);
  await db.query('DELETE FROM grocery_dev.wa_shopping_prompts WHERE cart_id=$1',[cart.id]);
  if (unresolved>=0) {
    const prompt=await writePrompt(db,cart,lines,catalog,requests[unresolved],requests.slice(unresolved+1));
    return [prefix,renderCart(lines,catalog,10),renderPrompt(prompt)].filter(Boolean).join('\n\n');
  }
  return [prefix,renderCart(lines,catalog)].filter(Boolean).join('\n\n');
}

async function failedChoice(db:PoolClient,prompt:Prompt):Promise<ShoppingReply> {
  const {rows}=await db.query('UPDATE grocery_dev.wa_shopping_prompts SET attempts=attempts+1 WHERE id=$1 RETURNING attempts',[prompt.id]);
  if (rows[0].attempts>=3) return {handoff:true,body:'The choice is still unclear, so automated shopping is paused. Your saved cart and unfinished items are retained.'};
  return {body:`Use the current choice code and option number, or REPLACE/SKIP the item.\n${renderPrompt(prompt)}`};
}

// The caller holds the identity row lock and commits cart changes with the processed inbox/outbox event.
export async function shoppingReply(db:PoolClient,identityId:string,text:string,occurredAt:Date):Promise<ShoppingReply> {
  const command=text.trim();
  const {rows}=await db.query(`INSERT INTO grocery_dev.wa_carts(identity_id) VALUES ($1)
    ON CONFLICT (identity_id) DO UPDATE SET identity_id=EXCLUDED.identity_id RETURNING id,revision,next_line_no,last_action_at`,[identityId]);
  const cart:Cart=rows[0];
  const lines:Line[]=(await db.query('SELECT variant_id,line_no,packs FROM grocery_dev.wa_cart_items WHERE cart_id=$1 ORDER BY line_no',[cart.id])).rows;
  const catalog=await loadCatalog(db);
  if (catalog.length>500) return {handoff:true,body:'Catalog search needs staff assistance for this larger catalog. Your saved cart is retained.'};
  let prompt=await readPrompt(db,cart.id);
  if (/^cart$/i.test(command)) return {body:renderCart(lines,catalog)+(prompt?'\nA choice is pending; reply CHOICES to see it.':'')};
  if (!prompt && /^yes$/i.test(command)) return {body:'Reply CHECKOUT to review the exact items, then CONFIRM with the checkout code. A bare yes does not place an order.'};
  if (cart.last_action_at && occurredAt<cart.last_action_at) return {body:'That message predates the current cart. Reply CART and send the intended change again.'};
  if (/^cancel$/i.test(command)) {
    await saveCart(db,cart,[],occurredAt);await db.query('DELETE FROM grocery_dev.wa_shopping_prompts WHERE cart_id=$1',[cart.id]);
    return {body:'Cart and pending choices cleared. Existing orders are unchanged; use CANCEL ORDER <reference> to cancel a pickup before picking. Send a new shopping list whenever you are ready.'};
  }
  if (/^choices$/i.test(command)) {
    if (!prompt) return {body:'There is no active choice. Send a shopping list or reply CART.'};
    prompt=await writePrompt(db,cart,lines,catalog,prompt.request_text,prompt.remaining_requests);
    return {body:renderPrompt(prompt)};
  }
  const edit=command.match(/^(remove|change)\s+(\d+)(?:\s+(\d+))?$/i);
  if (/^(remove|change)\b/i.test(command)) {
    if (!edit || (edit[1].toLowerCase()==='remove'?edit[3]!==undefined:edit[3]===undefined)) return {body:'Use REMOVE <line> or CHANGE <line> <whole packs>, with a quantity from 1 to 99.'};
    const index=lines.findIndex(l=>l.line_no===Number(edit[2]));
    if (index<0) return {body:'That cart line does not exist. Reply CART for the current line numbers.'};
    if (edit[1].toLowerCase()==='remove') lines.splice(index,1);
    else {
      const packs=Number(edit[3]);const v=catalog.find(v=>v.id===lines[index].variant_id);
      if (!Number.isInteger(packs) || packs<1 || packs>99) return {body:'Use a whole quantity from 1 to 99 packs. Use REMOVE to delete a line.'};
      if (!v?.active || !v.price || v.available===null || packs>v.available) return {body:'That quantity is not currently available. The cart is unchanged; use CART to review availability.'};
      lines[index].packs=packs;
    }
    await saveCart(db,cart,lines,occurredAt);
    if (prompt) prompt=await writePrompt(db,cart,lines,catalog,prompt.request_text,prompt.remaining_requests);
    return {body:renderCart(lines,catalog,prompt?10:20)+(prompt?`\n\n${renderPrompt(prompt)}`:'')};
  }
  const action=command.match(/^(choose|skip|replace)\s+([a-f0-9]{16})(?:\s+(.*))?$/i);
  if (action || /^(choose|skip|replace)\b/i.test(command) || prompt) {
    if (!prompt) return {body:'That choice is no longer active for your cart. Reply CART or send a new shopping list.'};
    if (action && action[2].toLowerCase()!==prompt.token) return {body:`That choice code is no longer current.\n${renderPrompt(prompt)}`};
    if (prompt.expired || prompt.cart_revision!==cart.revision) {
      prompt=await writePrompt(db,cart,lines,catalog,prompt.request_text,prompt.remaining_requests);
      return {body:`The choice expired or the cart changed. Please use these fresh options.\n${renderPrompt(prompt)}`};
    }
    if (!action) return failedChoice(db,prompt);
    const verb=action[1].toLowerCase();const argument=action[3]?.trim()??'';
    if (verb==='skip') {
      if (argument) return failedChoice(db,prompt);
      return {body:await advance(db,cart,lines,catalog,prompt.remaining_requests,occurredAt,'Item skipped.')};
    }
    if (verb==='replace') {
      try {
        const items=parseList(argument);
        if (items.length!==1) throw new ShoppingInputError('Replace one item at a time.');
        return {body:await advance(db,cart,lines,catalog,[items[0].raw,...prompt.remaining_requests],occurredAt,'Replacement requested.')};
      } catch (error) { if (!(error instanceof ShoppingInputError)) throw error;return failedChoice(db,prompt); }
    }
    const choice=/^[1-3]$/.test(argument)?prompt.choices.find(c=>c.position===Number(argument)):undefined;
    if (!choice) return failedChoice(db,prompt);
    const v=catalog.find(v=>v.id===choice.variant_id);
    const already=lines.find(l=>l.variant_id===choice.variant_id)?.packs??0;
    if (!v?.active || v.price!==choice.unit_price || v.quantity!==choice.pack_quantity || v.unit!==choice.pack_unit ||
      v.count!==choice.pack_count || title(v)!==choice.display_name || v.available===null || v.available<already+choice.packs ||
      already+choice.packs>99 || (lines.length>=20 && already===0)) {
      prompt=await writePrompt(db,cart,lines,catalog,prompt.request_text,prompt.remaining_requests);
      return {body:`Price, pack or availability changed. Nothing was added; choose again.\n${renderPrompt(prompt)}`};
    }
    addOffer(cart,lines,{variant:v,packs:choice.packs,exact:true,reason:''});
    return {body:await advance(db,cart,lines,catalog,prompt.remaining_requests,occurredAt,'Selected pack added.')};
  }
  try {
    const requests=parseList(command.replace(/^add\s+/i,''));
    return {body:await advance(db,cart,lines,catalog,requests.map(r=>r.raw),occurredAt)};
  } catch (error) {
    if (!(error instanceof ShoppingInputError)) throw error;
    return {body:`${error.message} Cart unchanged. Example: 2 milk 1 l, 1 kg rice.`};
  }
}
