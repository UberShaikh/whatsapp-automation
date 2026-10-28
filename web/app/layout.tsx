import './globals.css';
import type { Metadata } from 'next';
import { Providers } from '@/components/providers';
export const metadata:Metadata={title:{default:'Stockroom — Merchant inventory',template:'%s · Stockroom'},description:'Merchant inventory and stock management.'};
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>) {
  return <html lang="en" suppressHydrationWarning><body><Providers>{children}</Providers></body></html>;
}
