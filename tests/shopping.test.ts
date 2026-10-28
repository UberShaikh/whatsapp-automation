import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEFAULT_FILE } from '../scripts/seed-groceries.ts';
import { baseQuantity,cleanText,parseItem,parseList,ShoppingInputError } from '../app/shopping-parser.ts';
import { label,matchVariants,money,paise,planOffer } from '../app/catalog.ts';
import type { Variant } from '../app/catalog.ts';

const data=JSON.parse(readFileSync(DEFAULT_FILE,'utf8'));
const catalog:Variant[]=data.products.map((p:Record<string,unknown>)=>({id:p.sku,sku:p.sku,name:p.name,brand:p.brand,
  aliases:p.aliases,active:true,quantity:Number(p.pack_quantity).toFixed(3),unit:p.pack_unit,count:p.pack_count,
  price:p.demo_selling_price,available:p.demo_opening_stock_packs}));
const variant=(sku:string)=>catalog.find(v=>v.sku===sku)!;

test('shopping lists parse counts, pack sizes, weights, aliases and common separators',()=>{
  const items=parseList('2 milk 1 l, 1 kg rice\nnamak and please 2 onions');
  assert.equal(items.length,4);
  assert.deepEqual(items[0].size,{quantity:'1',unit:'l'});assert.equal(items[0].count,2);assert.equal(items[0].query,'milk');
  assert.equal(items[1].total,true);assert.equal(items[1].query,'rice');
  assert.equal(items[3].query,'onion');assert.equal(items[3].count,2);
  for (const raw of ['2 x 500 ml milk','2x500ml milk','2 packs 500 ml milk']) {
    const r=parseItem(raw);assert.equal(r.count,2);assert.equal(r.query,'milk');assert.equal(r.size?.unit,'ml');
  }
});

test('invalid quantities and oversized lists fail before any item is applied',()=>{
  for (const raw of ['-1 milk','0 milk','2.5 milk','2.0000000000000000001 milk','100 milk','1/2 kg rice','1-2 milk','0 kg rice','1.2345 kg rice','2milk']) {
    assert.throws(()=>parseItem(raw),ShoppingInputError,raw);
  }
  assert.throws(()=>parseList(Array(11).fill('milk').join(',')),ShoppingInputError);
  assert.throws(()=>parseList('milk, -1 rice'),ShoppingInputError);
});

test('aliases match only catalog-backed terms; unknown brands and unknown products do not match',()=>{
  assert.equal(matchVariants(parseItem('doodh').query,catalog)[0].brand,'Amul');
  assert.equal(matchVariants(parseItem('chawal').query,catalog)[0].brand,'India Gate');
  assert.equal(matchVariants('mother dairy milk',catalog).length,0);
  assert.equal(matchVariants('organic dragonfruit',catalog).length,0);
  assert.equal(matchVariants('soap',catalog).length,2);
  assert.equal(matchVariants('soap',catalog.map(v=>({...v,active:false}))).length,0);
});

test('exact requests retain counts and use compatible unit conversions without floating point',()=>{
  const milk=variant('MILK-AMUL-TAAZA-UHT-1L');const rice=variant('RICE-IG-CLASSIC-1KG');
  assert.deepEqual([planOffer(parseItem('2 milk 1 l'),milk).packs,planOffer(parseItem('2 milk 1 l'),milk).exact],[2,true]);
  assert.deepEqual([planOffer(parseItem('2 kg rice'),rice).packs,planOffer(parseItem('2 kg rice'),rice).exact],[2,true]);
  assert.equal(baseQuantity('0.500','kg'),baseQuantity('500','g'));
  assert.equal(baseQuantity('0.001','l'),baseQuantity('1','ml'));
});

test('larger packs, volume-to-weight mismatches and unavailable stock require explicit choices',()=>{
  const atta=planOffer(parseItem('1 kg atta'),variant('ATTA-AASHIRVAAD-5KG'));
  assert.equal(atta.exact,false);assert.equal(atta.packs,1);
  const oil=planOffer(parseItem('1 litre sunflower oil'),variant('OIL-FORTUNE-SUNLITE-870G'));
  assert.equal(oil.exact,false);assert.match(oil.reason,/Weight and volume/);
  const banana=planOffer(parseItem('banana'),variant('FRUIT-FRESHO-BANANA-1KG'));
  assert.equal(banana.packs,0);assert.equal(banana.exact,false);
});

test('two 500 ml milk packs propose one 1 l pack but never silently accept the different pack',()=>{
  const offer=planOffer(parseItem('2 x 500 ml milk'),variant('MILK-AMUL-TAAZA-UHT-1L'));
  assert.equal(offer.packs,1);assert.equal(offer.exact,false);
});

test('multipack counts are not mistaken for individual bars',()=>{
  const vim=variant('DISHWASH-VIM-LEMON-4X190G');
  const twoBars=parseItem('2 Vim bars');assert.equal(twoBars.pieces,true);
  assert.equal(planOffer(twoBars,vim).packs,1);assert.equal(planOffer(twoBars,vim).exact,false);
  assert.equal(planOffer(parseItem('4 Vim bars'),vim).packs,1);
  assert.equal(planOffer(parseItem('4 Vim bars'),vim).exact,true);
  assert.equal(planOffer(parseItem('2 packs Vim'),vim).packs,2);
  assert.equal(planOffer(parseItem('2 packs Vim'),vim).exact,true);
  assert.equal(planOffer(parseItem('2 Vim'),vim).exact,false);
});

test('partial availability and existing cart quantities cannot silently reduce or exceed the requested count',()=>{
  const moong=planOffer(parseItem('1 kg moong dal'),variant('DAL-TS-MOONG-500G'));
  assert.equal(moong.packs,1);assert.equal(moong.exact,false);
  const milk=variant('MILK-AMUL-TAAZA-UHT-1L');
  assert.equal(planOffer(parseItem('2 milk'),milk,23).exact,false);
  assert.equal(planOffer(parseItem('2 milk'),milk,23).packs,1);
  assert.equal(planOffer(parseItem('milk'),{...milk,available:200},99).packs,0);
});

test('prices stay exact decimal strings and customer labels never expose retailer URLs',()=>{
  assert.equal(money(paise('281.22')*3n),'INR 843.66');
  assert.equal(money(paise('9999999999.99')*99n),'INR 989999999999.01');
  assert.doesNotMatch(label({...catalog[0],name:'Rice https://www.bigbasket.com/product\nextra'}),/https?:|bigbasket/);
  assert.equal(cleanText('item bigbasket.com/pd/123'),'item');
  assert.equal(cleanText('hello\nworld'),'hello world');
});
