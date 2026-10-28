import { merchantApi } from '@/lib/merchant-api';
export async function GET() {
  try {const response=await merchantApi('inventory');return Response.json(await response.json(),{status:response.status});}
  catch {return Response.json({error:'Inventory is unavailable. Try refreshing.'},{status:503});}
}
