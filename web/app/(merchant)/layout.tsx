import { redirect } from 'next/navigation';
import { supabase,authConfigured } from '@/lib/supabase';
export const dynamic='force-dynamic';
export default async function MerchantLayout({children}:{children:React.ReactNode}) {
  if (!authConfigured()) redirect('/login');
  const client=await supabase();const {data:{user}}=await client.auth.getUser();
  if (!user) redirect('/login');
  return children;
}
