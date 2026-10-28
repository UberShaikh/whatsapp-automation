import { MerchantWorkspace } from '@/components/merchant-workspace';
import { loadWorkspace } from '@/lib/workspace';
export default async function HistoryPage() {return <MerchantWorkspace {...await loadWorkspace('history')} />;}
