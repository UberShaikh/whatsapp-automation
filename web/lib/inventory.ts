import { z } from 'zod';
export type Product={id:string;sku:string;name:string;brand:string;category:string;pack_quantity:string;pack_unit:string;pack_count:number;is_active:boolean;price:string|null;on_hand:number;reserved:number;available:number};
export type Movement={id:string;created_at:string;kind:string;quantity:number;sku:string;name:string;brand:string;action:string|null;reason:string|null;before_qty:number|null;after_qty:number|null;reserved_qty:number|null;user_id:string|null;order_reference:string|null};
export const pack=(p:Product)=>`${p.pack_count>1?`${p.pack_count} × `:''}${Number(p.pack_quantity)} ${p.pack_unit}`;
export const productName=(p:Product)=>`${p.brand} ${p.name}`;
export const price=(amount:string|null)=>amount && /^\d+\.\d{2}$/.test(amount)?new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'}).format(Number(amount)):'Unpriced';
export const stockStatus=(p:Product)=>!p.is_active?'Inactive':p.available===0?'Out of stock':p.available<=5?'Low stock':'In stock';
export const adjustmentSchema=z.object({
  variantId:z.uuid('Choose a product.'),action:z.enum(['receive','remove','recount']),
  quantity:z.number({error:'Enter a whole pack quantity.'}).int('Use whole packs.').min(0).max(1000000),
  reason:z.string().trim().min(3,'Add a reason of at least 3 characters.').max(200),
}).refine(v=>v.action==='recount' || v.quantity>0,{path:['quantity'],message:'Enter at least one pack.'});
export type AdjustmentValues=z.infer<typeof adjustmentSchema>;
export function nextStock(p:Product,values:AdjustmentValues) {
  const next=values.action==='recount'?values.quantity:p.on_hand+(values.action==='receive'?values.quantity:-values.quantity);
  if (next<p.reserved) throw new Error(`Keep at least ${p.reserved} reserved pack(s) on hand.`);
  if (next>1000000) throw new Error('On-hand stock cannot exceed 1,000,000 packs.');
  if (next===p.on_hand) throw new Error('The stock count is unchanged.');
  return next;
}
