export type Unit='g'|'kg'|'ml'|'l';
export type ItemRequest={raw:string;query:string;count:number;explicitPacks:boolean;pieces:boolean;
  size?:{quantity:string;unit:Unit};total:boolean};
export class ShoppingInputError extends Error {}

export function cleanText(text:string,max=200) {
  return text.replace(/https?:\/\/\S+|www\.\S+/gi,'').replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?#]\S*)?/gi,'')
    .replace(/[\r\n\t]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
}
export function normalize(text:string) {
  const plurals:Record<string,string>={onions:'onion',potatoes:'potato',tomatoes:'tomato',bananas:'banana',soaps:'soap',biscuits:'biscuit',bars:'bar',dals:'dal'};
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().split(/\s+/).map(w=>plurals[w]??w).join(' ');
}
const units='kilograms?|kgs?|grams?|gms?|kg|gm|g|millilit(?:re|er)s?|ml|lit(?:re|er)s?|ltr?s?|l';
function unit(value:string):Unit {
  if (value.startsWith('k')) return 'kg';
  if (value.startsWith('g')) return 'g';
  if (value.startsWith('m')) return 'ml';
  return 'l';
}
function size(quantity:string,label:string) {
  if (!/^\d{1,3}(?:\.\d{1,3})?$/.test(quantity) || Number(quantity)<=0) throw new ShoppingInputError('Use a positive quantity up to 999.999 with at most three decimal places.');
  return {quantity,unit:unit(label)};
}

export function parseItem(text:string):ItemRequest {
  const raw=text.trim();
  if (!raw || raw.length>200) throw new ShoppingInputError('Keep each item between 1 and 200 characters.');
  let rest=raw.toLowerCase().replace(/^please\s+/,'').replace(/^(?:add|buy|need|i want|i need)\s+/,'').trim();
  if (/^-|\d\s*[-/]\s*\d/.test(rest)) throw new ShoppingInputError('Use one quantity per item; for example 0.5 kg rice, not a range or fraction.');
  const request:ItemRequest={raw,query:'',count:1,explicitPacks:false,pieces:false,total:false};
  const multiplied=rest.match(new RegExp(`^(\\d+)\\s*[x×]\\s*(\\d+(?:\\.\\d+)?)\\s*(${units})\\b\\s+(.+)$`,'i'));
  if (multiplied) {
    request.count=Number(multiplied[1]);
    if (request.count<1 || request.count>99) throw new ShoppingInputError('Use 1 to 99 whole sellable packs.');
    request.size=size(multiplied[2],multiplied[3]);rest=multiplied[4];
  }
  const measured=rest.match(new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(${units})\\b\\s+(.+)$`,'i'));
  if (measured && !multiplied) {
    request.size=size(measured[1],measured[2]);request.total=true;rest=measured[3];
  } else if (!multiplied) {
    const count=rest.match(/^(\d+(?:\.\d+)?)\s+(?:(packs?|packets?|bottles?|bags?|bars?|pieces?|pcs?)\s+)?(.+)$/);
    if (count) {
      const n=Number(count[1]);
      if (!/^\d{1,2}(?:\.0{1,3})?$/.test(count[1]) || !Number.isInteger(n) || n<1 || n>99) throw new ShoppingInputError('Use 1 to 99 whole sellable packs, or specify a weight/volume.');
      request.count=n;rest=count[3];
      request.pieces=!!count[2] && /^(bar|piece|pc)/.test(count[2]);
      request.explicitPacks=!!count[2] && !request.pieces;
    } else if (/^[\d.+-]/.test(rest)) throw new ShoppingInputError('Write the quantity and item separately; for example 2 milk 1 l.');
    const container=rest.match(/\s+(packs?|packets?|bottles?|bags?|bars?|pieces?|pcs?)$/);
    if (container && count) {
      request.pieces=/^(bar|piece|pc)/.test(container[1]);request.explicitPacks=!request.pieces;
      rest=rest.slice(0,container.index).trim();
    }
    const packPrefix=rest.match(new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(${units})\\b\\s+(.+)$`,'i'));
    const suffix=rest.match(new RegExp(`(?:^|\\s)(\\d+(?:\\.\\d+)?)\\s*(${units})\\s*$`,'i'));
    if (packPrefix) { request.size=size(packPrefix[1],packPrefix[2]);rest=packPrefix[3]; }
    else if (suffix) { request.size=size(suffix[1],suffix[2]);rest=rest.slice(0,suffix.index).trim(); }
  }
  request.query=normalize(rest.replace(/\b(?:please|some|of|the)\b/gi,' '));
  if (!request.query || request.query.length>160) throw new ShoppingInputError('Include a product name or brand, for example 1 kg rice.');
  return request;
}

export function parseList(text:string) {
  const parts=text.trim().split(/[,;\n]+|\s+and\s+/i).map(s=>s.trim()).filter(Boolean);
  if (!parts.length || parts.length>10) throw new ShoppingInputError('Send 1 to 10 items separated by commas or new lines.');
  return parts.map(parseItem);
}

export function baseQuantity(quantity:string,unit:Unit) {
  const [whole,fraction='']=quantity.split('.');
  return (BigInt(whole)*1000n+BigInt(fraction.padEnd(3,'0')))*(unit==='kg'||unit==='l'?1000n:1n);
}
export const family=(unit:Unit)=>unit==='g'||unit==='kg'?'mass':'volume';
