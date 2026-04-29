'use client';

import * as React from 'react';
import { Eye, EyeOff } from 'lucide-react';

import { Input } from './input';
import { cn } from '@/lib/utils';

// ============================================================
// Input de senha com botão pra revelar/esconder.
// Mesma assinatura de <Input>, mas força type alternando entre
// "password" e "text" via state interno. Aceita className extra
// pro wrapper externo via wrapperClassName.
// ============================================================
const PasswordInput = React.forwardRef<
  HTMLInputElement,
  Omit<React.ComponentProps<'input'>, 'type'> & { wrapperClassName?: string }
>(({ className, wrapperClassName, ...props }, ref) => {
  const [show, setShow] = React.useState(false);
  return (
    <div className={cn('relative', wrapperClassName)}>
      <Input
        ref={ref}
        type={show ? 'text' : 'password'}
        className={cn('pr-10', className)}
        {...props}
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        aria-label={show ? 'Esconder senha' : 'Mostrar senha'}
        tabIndex={-1}
        className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-muted-foreground hover:text-foreground transition-colors rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
});
PasswordInput.displayName = 'PasswordInput';

export { PasswordInput };
