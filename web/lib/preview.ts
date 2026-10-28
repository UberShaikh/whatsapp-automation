import 'server-only';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Product } from './inventory';

export async function previewProducts():Promise<Product[]> {
  const data=JSON.parse(await fs.readFile(path.resolve('../data/seed/indian-household-groceries.json'),'utf8'));
  return data.products.map((p:{sku:string;name:string;brand:string;category_path:string[];pack_quantity:number;pack_unit:string;pack_count:number;demo_selling_price:string;demo_opening_stock_packs:number})=>{
    const hash=createHash('sha256').update(p.sku).digest('hex');
    return {id:`${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`,
      sku:p.sku,name:p.name,brand:p.brand,category:p.category_path.at(-1)!,pack_quantity:String(p.pack_quantity),pack_unit:p.pack_unit,pack_count:p.pack_count,
      is_active:true,price:p.demo_selling_price,on_hand:p.demo_opening_stock_packs,reserved:0,available:p.demo_opening_stock_packs};
  });
}
