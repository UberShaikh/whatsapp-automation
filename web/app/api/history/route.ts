import { merchantApi } from '@/lib/merchant-api';
export async function GET() {
  try {const response=await merchantApi('history');return Response.json(await response.json(),{status:response.status});}
  catch {return Response.json({error:'Stock history is unavailable. Try refreshing.'},{status:503});}
}
