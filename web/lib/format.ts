// ============================================================
// FORMAT — helpers de formatação pra UI (datas, BRL, telefone, chave)
// ============================================================

export function formatBRL(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return (cents / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

export function formatDate(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export function formatDateTime(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Mascara o número do WhatsApp mostrando DDI+DDD e os últimos 4 dígitos.
// Ex: "5511987654321" → "+55 (11) *****-4321"
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '—';
  const clean = String(phone).replace(/\D/g, '');
  if (clean.length < 8) return phone;
  // Tenta padrão BR: 55 + DDD + 9 dígitos. Último grupo = 4 dígitos.
  const last4 = clean.slice(-4);
  const ddd = clean.length >= 11 ? clean.slice(2, 4) : clean.slice(0, 2);
  const prefix = clean.length >= 12 ? clean.slice(0, 2) : '';
  const ddi = prefix ? `+${prefix} ` : '';
  return `${ddi}(${ddd}) *****-${last4}`;
}

// Formata chave hex em 4 grupos de 8 pra ficar mais legível.
// "3b36c0db084640b688a4c4e58d9c7f96" → "3b36c0db 084640b6 88a4c4e5 8d9c7f96"
export function formatKey(key: string): string {
  if (!key) return '';
  const clean = key.replace(/\s+/g, '');
  return clean.replace(/(.{8})/g, '$1 ').trim();
}

export function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => false
    );
  }
  return Promise.resolve(false);
}
