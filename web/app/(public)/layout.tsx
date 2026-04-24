import { ReactNode } from 'react';

// Layout pras páginas públicas (/login, /primeiro-acesso)
// Centraliza vertical+horizontal, com uma "marca" sutil em cima.
export default function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 py-12">
      <div className="mb-8 flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-zf-accent text-white flex items-center justify-center font-bold text-xl">
          Z
        </div>
        <div className="text-2xl font-semibold">Zapfire</div>
      </div>
      {children}
    </div>
  );
}
