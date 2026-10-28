import { MerchantWorkspace } from '@/components/merchant-workspace';
import { loadWorkspace } from '@/lib/workspace';
export default async function AccountPage() {return <MerchantWorkspace {...await loadWorkspace('account')} />;}
