'use client';
import { Button } from '@/components/ui/button';
export default function ErrorPage({reset}:{reset:()=>void}) {return <main className="mx-auto flex max-w-lg flex-col gap-4 p-8"><h1 className="text-xl font-semibold">This page could not load</h1><p className="text-sm text-muted-foreground">Your stock has not been changed by this error. Reload the page before retrying an adjustment.</p><Button onClick={reset}>Reload page</Button></main>;}
