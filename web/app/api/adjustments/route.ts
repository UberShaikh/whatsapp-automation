import { NextResponse,type NextRequest } from 'next/server';
import { merchantApi } from '@/lib/merchant-api';
export async function POST(request:NextRequest) {
  if (request.headers.get('origin')!==request.nextUrl.origin) return NextResponse.json({error:'Reload this page before saving stock.'},{status:403});
  if (!request.headers.get('content-type')?.startsWith('application/json')) return NextResponse.json({error:'Send a JSON adjustment.'},{status:415});
  try {
    const reader=request.body?.getReader();const parts:Uint8Array[]=[];let size=0;
    if (reader) while (true) {
      const chunk=await reader.read();if (chunk.done) break;
      size+=chunk.value.byteLength;
      if (size>8192) {await reader.cancel();return NextResponse.json({error:'The adjustment is too large.'},{status:413});}
      parts.push(chunk.value);
    }
    const body=Buffer.concat(parts).toString('utf8');
    const response=await merchantApi('adjustments',{method:'POST',body});
    return NextResponse.json(await response.json(),{status:response.status});
  } catch {return NextResponse.json({error:'Save could not be confirmed. Refresh stock before retrying.'},{status:503});}
}
