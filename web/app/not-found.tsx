import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 text-center">
      <div className="w-10 h-10 rounded-lg bg-zf-accent text-white flex items-center justify-center font-bold text-xl mb-6">
        Z
      </div>
      <h1 className="text-4xl font-semibold">404</h1>
      <p className="text-muted-foreground mt-2">Página não encontrada.</p>
      <Button asChild variant="outline" className="mt-6">
        <Link href="/">Voltar pra home</Link>
      </Button>
    </div>
  );
}
