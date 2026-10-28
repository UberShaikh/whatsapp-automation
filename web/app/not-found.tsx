import Link from 'next/link';
export default function NotFound() {return <main className="mx-auto flex max-w-lg flex-col gap-4 p-8"><h1 className="text-xl font-semibold">Page not found</h1><Link className="text-sm text-primary underline" href="/inventory">Go to inventory</Link></main>;}
