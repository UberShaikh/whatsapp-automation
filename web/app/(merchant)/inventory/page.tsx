import { MerchantWorkspace } from '@/components/merchant-workspace';
import { loadWorkspace } from '@/lib/workspace';
export default async function InventoryPage() {return <MerchantWorkspace {...await loadWorkspace('inventory')} />;}
