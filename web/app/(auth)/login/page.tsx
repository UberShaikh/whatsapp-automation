import { AuthScreen } from '@/components/auth-screen';
export default async function Login({searchParams}:{searchParams:Promise<{link?:string}>}) {return <AuthScreen mode="login" expired={(await searchParams).link==='expired'} />;}
