import { notFound } from 'next/navigation';
import { previewProducts } from '@/lib/preview';
import { MerchantWorkspace } from '@/components/merchant-workspace';
export const dynamic='force-dynamic';
export default async function PreviewPage() {
  if (process.env.MERCHANT_PREVIEW!=='true' || process.env.NODE_ENV==='production') notFound();
  return <MerchantWorkspace initialView="inventory" initialProducts={await previewProducts()} initialHistory={[]} name="Merchant" email="" preview />;
}
