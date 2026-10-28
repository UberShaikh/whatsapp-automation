import { Skeleton } from '@/components/ui/skeleton';
export default function Loading() {return <main className="flex flex-col gap-6 p-6" aria-label="Loading inventory"><Skeleton className="h-9 w-44" /><Skeleton className="h-20 w-full" /><Skeleton className="h-9 w-80 max-w-full" />{Array.from({length:10},(_,i)=><Skeleton key={i} className="h-9 w-full" />)}</main>;}
