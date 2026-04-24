'use client';

// ============================================================
// Landing page pública (rota /)
// ============================================================
// Não redireciona mais pra /dashboard ou /login automaticamente.
// Aparece sempre; se o user já tá logado, o botão no header vira
// "Ir pro painel" em vez de "Entrar".
//
// Placeholders (trocar quando tiver as URLs reais):
//   KIRVANO_CHECKOUT_URL  - link do checkout na Kirvano (plano mensal/anual)
//   CHROME_WEB_STORE_URL  - link da extensão na CWS (após aprovação)
//
// Os dois abrem em nova aba com noopener/noreferrer por segurança.
// ============================================================

import Link from 'next/link';
import { useAuthStore } from '@/lib/authStore';
import { Button } from '@/components/ui/button';
import {
  ArrowRight,
  Mic,
  MessageSquare,
  Workflow,
  Zap,
  ShieldCheck,
  Chrome,
  Check,
  Sparkles,
} from 'lucide-react';

// TODO Sprint 8 — substituir pelos URLs reais
const KIRVANO_CHECKOUT_URL = '#TODO-CHECKOUT-KIRVANO';
const KIRVANO_CHECKOUT_ANNUAL_URL = '#TODO-CHECKOUT-KIRVANO-ANUAL';
const CHROME_WEB_STORE_URL = '#TODO-CHROME-WEB-STORE';

export default function LandingPage() {
  const { accessToken } = useAuthStore();

  return (
    <main className="relative overflow-hidden">
      {/* Glow de fundo no hero */}
      <div
        aria-hidden
        className="absolute inset-x-0 -top-40 -z-10 h-[640px] bg-[radial-gradient(circle_at_50%_20%,rgba(255,59,48,0.18),transparent_60%)]"
      />

      {/* ============== Header ============== */}
      <header className="container flex items-center justify-between py-6">
        <Link href="/" className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-md bg-zf-accent text-white flex items-center justify-center font-bold text-lg">
            Z
          </div>
          <span className="text-xl font-semibold">Zapfire</span>
        </Link>
        <div className="flex items-center gap-3">
          {accessToken ? (
            <Button asChild>
              <Link href="/dashboard">Ir pro painel</Link>
            </Button>
          ) : (
            <>
              <Link
                href="/login"
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Entrar
              </Link>
              <Button asChild>
                <a href={KIRVANO_CHECKOUT_URL} target="_blank" rel="noopener noreferrer">
                  Assinar
                </a>
              </Button>
            </>
          )}
        </div>
      </header>

      {/* ============== Hero ============== */}
      <section className="container pt-20 pb-24 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-zf-accent/10 border border-zf-accent/30 text-xs text-zf-accent font-medium mb-6">
          <Sparkles className="w-3 h-3" />
          Pra afiliados, closers e SDRs que vendem no WhatsApp
        </div>
        <h1 className="text-5xl sm:text-6xl font-bold tracking-tight max-w-4xl mx-auto leading-[1.05]">
          Seu WhatsApp Web virou
          <span className="text-zf-accent"> máquina de vendas</span>
        </h1>
        <p className="mt-6 text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
          Áudios pré-gravados com waveform real, scripts 1-clique e funis
          automatizados que rodam em várias conversas ao mesmo tempo. Sem abrir
          outra tela, sem plugin esquisito — direto no WA Web.
        </p>
        <div className="mt-10 flex flex-col sm:flex-row gap-3 justify-center items-center">
          <Button asChild size="lg" className="text-base">
            <a href={KIRVANO_CHECKOUT_URL} target="_blank" rel="noopener noreferrer">
              Começar agora — R$ 47/mês
              <ArrowRight className="w-4 h-4 ml-2" />
            </a>
          </Button>
          <Button asChild size="lg" variant="outline" className="text-base">
            <a href={CHROME_WEB_STORE_URL} target="_blank" rel="noopener noreferrer">
              <Chrome className="w-4 h-4 mr-2" />
              Instalar extensão
            </a>
          </Button>
        </div>
        <p className="mt-6 text-xs text-muted-foreground">
          Compra segura via Kirvano · Cancele quando quiser · Funciona em Chrome, Edge, Brave
        </p>
      </section>

      {/* ============== Features ============== */}
      <section className="container py-20 border-t border-border">
        <div className="text-center mb-14">
          <h2 className="text-3xl sm:text-4xl font-bold mb-3">
            Tudo que você precisa pra escalar no 1-a-1
          </h2>
          <p className="text-muted-foreground max-w-2xl mx-auto">
            Sem integração complicada, sem webhook quebrando, sem bot que parece
            robô. É o seu WhatsApp com superpoderes.
          </p>
        </div>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <FeatureCard
            Icon={Mic}
            color="text-zf-type-audio"
            title="Áudios salvos"
            body="Mande suas gravações como se estivesse gravando na hora. Waveform real que aparece pro destinatário."
          />
          <FeatureCard
            Icon={MessageSquare}
            color="text-zf-type-text"
            title="Scripts 1-clique"
            body="Biblioteca de mensagens prontas. Click no chip, envia — sem copiar e colar nunca mais."
          />
          <FeatureCard
            Icon={Workflow}
            color="text-zf-accent"
            title="Funis automatizados"
            body="Sequência de mensagens com delays entre cada uma. Rode vários pra conversas diferentes ao mesmo tempo."
          />
          <FeatureCard
            Icon={Zap}
            color="text-zf-type-media"
            title="QuickBar no rodapé"
            body="Barra horizontal no input do WA. Seus items mais usados em alcance de click, sem abrir menu."
          />
        </div>
      </section>

      {/* ============== Como funciona ============== */}
      <section className="container py-20 border-t border-border">
        <div className="text-center mb-14">
          <h2 className="text-3xl sm:text-4xl font-bold mb-3">
            Como funciona
          </h2>
          <p className="text-muted-foreground">Do pagamento ao primeiro envio em menos de 5 minutos.</p>
        </div>
        <div className="grid gap-8 md:grid-cols-3 max-w-4xl mx-auto">
          <StepCard
            n="1"
            title="Assine"
            body="Escolhe mensal ou anual. Pagamento rápido pela Kirvano — cartão, Pix ou boleto."
          />
          <StepCard
            n="2"
            title="Receba a chave"
            body="No seu email chega a chave de acesso e o link pra configurar sua senha do painel."
          />
          <StepCard
            n="3"
            title="Ative e mande bala"
            body="Instala a extensão, cola a chave, abre o WhatsApp Web. Já tá pronto."
          />
        </div>
      </section>

      {/* ============== Planos ============== */}
      <section id="planos" className="container py-20 border-t border-border">
        <div className="text-center mb-14">
          <h2 className="text-3xl sm:text-4xl font-bold mb-3">Planos</h2>
          <p className="text-muted-foreground">Sem fidelidade, cancele quando quiser.</p>
        </div>
        <div className="grid gap-6 md:grid-cols-2 max-w-3xl mx-auto">
          <PlanCard
            name="Mensal"
            price="R$ 47"
            period="/mês"
            subtitle="Comece sem compromisso"
            bullets={[
              'Todas as funcionalidades',
              '4 dispositivos simultâneos',
              'Suporte por email',
              'Cancele quando quiser',
            ]}
            ctaLabel="Assinar mensal"
            ctaUrl={KIRVANO_CHECKOUT_URL}
          />
          <PlanCard
            name="Anual"
            price="R$ 395"
            period="/ano"
            subtitle="Economize ~30% vs mensal"
            highlighted
            bullets={[
              'Tudo do Mensal',
              '2 meses grátis',
              'Suporte prioritário',
              'Trava de preço por 12 meses',
            ]}
            ctaLabel="Assinar anual"
            ctaUrl={KIRVANO_CHECKOUT_ANNUAL_URL}
          />
        </div>
      </section>

      {/* ============== Trust / privacidade ============== */}
      <section className="container py-20 border-t border-border">
        <div className="max-w-3xl mx-auto grid gap-6 md:grid-cols-2 items-start">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-zf-success/10 border border-zf-success/30 text-xs text-zf-success font-medium mb-4">
              <ShieldCheck className="w-3 h-3" />
              Privacidade em primeiro lugar
            </div>
            <h2 className="text-2xl sm:text-3xl font-bold mb-3">
              Seus áudios e scripts nunca saem do seu navegador
            </h2>
            <p className="text-muted-foreground leading-relaxed">
              Toda biblioteca que você cria fica em IndexedDB local, dentro do
              Chrome. A gente não armazena conteúdo seu em servidor nenhum. O
              único que transita é o dado de licenciamento (email + chave +
              número do WhatsApp pra bind).
            </p>
          </div>
          <div className="space-y-3 text-sm">
            <TrustItem text="Chave vinculada a 1 número = zero compartilhamento indevido" />
            <TrustItem text="Até 4 Chromes simultâneos no mesmo número" />
            <TrustItem text="Envios invisíveis — sem abrir chat, sem roubar foco" />
            <TrustItem text="Conformidade LGPD + política clara" />
          </div>
        </div>
      </section>

      {/* ============== Final CTA ============== */}
      <section className="container py-24 text-center border-t border-border">
        <h2 className="text-3xl sm:text-4xl font-bold mb-3">
          Pronto pra parar de copiar e colar?
        </h2>
        <p className="text-muted-foreground max-w-xl mx-auto mb-8">
          47 reais por mês é menos que um almoço. E você ganha horas por dia de
          volta.
        </p>
        <Button asChild size="lg" className="text-base">
          <a href={KIRVANO_CHECKOUT_URL} target="_blank" rel="noopener noreferrer">
            Começar agora
            <ArrowRight className="w-4 h-4 ml-2" />
          </a>
        </Button>
      </section>

      {/* ============== Footer ============== */}
      <footer className="container py-10 border-t border-border flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-3">
          <div className="w-6 h-6 rounded bg-zf-accent text-white flex items-center justify-center font-bold text-xs">
            Z
          </div>
          <span>© {new Date().getFullYear()} Zapfire. Produto IMP.</span>
        </div>
        <div className="flex gap-5">
          <Link href="/privacy" className="hover:text-foreground">Privacidade</Link>
          <a href="mailto:contato@zapfire.com.br" className="hover:text-foreground">Contato</a>
          <a
            href={CHROME_WEB_STORE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground inline-flex items-center gap-1"
          >
            <Chrome className="w-3.5 h-3.5" />
            Instalar extensão
          </a>
        </div>
      </footer>
    </main>
  );
}

// ============================================================
// Sub-componentes
// ============================================================

function FeatureCard({
  Icon,
  color,
  title,
  body,
}: {
  Icon: React.ElementType;
  color: string;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card/30 p-6 hover:bg-card/60 transition-colors">
      <div className={`w-10 h-10 rounded-md bg-secondary flex items-center justify-center mb-4 ${color}`}>
        <Icon className="w-5 h-5" />
      </div>
      <h3 className="font-semibold mb-2">{title}</h3>
      <p className="text-sm text-muted-foreground leading-relaxed">{body}</p>
    </div>
  );
}

function StepCard({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="text-center">
      <div className="w-12 h-12 rounded-full bg-zf-accent/15 border border-zf-accent/40 text-zf-accent flex items-center justify-center font-bold text-lg mx-auto mb-4">
        {n}
      </div>
      <h3 className="font-semibold mb-2">{title}</h3>
      <p className="text-sm text-muted-foreground leading-relaxed">{body}</p>
    </div>
  );
}

function PlanCard({
  name,
  price,
  period,
  subtitle,
  bullets,
  ctaLabel,
  ctaUrl,
  highlighted = false,
}: {
  name: string;
  price: string;
  period: string;
  subtitle: string;
  bullets: string[];
  ctaLabel: string;
  ctaUrl: string;
  highlighted?: boolean;
}) {
  return (
    <div
      className={`relative rounded-lg p-8 flex flex-col ${
        highlighted
          ? 'border-2 border-zf-accent bg-zf-accent/5 shadow-[0_0_48px_rgba(255,59,48,0.08)]'
          : 'border border-border bg-card/30'
      }`}
    >
      {highlighted && (
        <div className="absolute -top-3 left-6 px-3 py-1 rounded-full bg-zf-accent text-white text-xs font-semibold">
          MAIS ESCOLHIDO
        </div>
      )}
      <div className="mb-5">
        <div className="text-lg font-semibold">{name}</div>
        <div className="text-sm text-muted-foreground mt-1">{subtitle}</div>
      </div>
      <div className="mb-6">
        <span className="text-4xl font-bold">{price}</span>
        <span className="text-muted-foreground ml-1">{period}</span>
      </div>
      <ul className="space-y-3 mb-8 flex-1">
        {bullets.map((b) => (
          <li key={b} className="flex items-start gap-2 text-sm">
            <Check className="w-4 h-4 text-zf-success flex-shrink-0 mt-0.5" />
            <span>{b}</span>
          </li>
        ))}
      </ul>
      <Button asChild variant={highlighted ? 'default' : 'outline'} size="lg">
        <a href={ctaUrl} target="_blank" rel="noopener noreferrer">
          {ctaLabel}
        </a>
      </Button>
    </div>
  );
}

function TrustItem({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2">
      <Check className="w-4 h-4 text-zf-success flex-shrink-0 mt-0.5" />
      <span className="text-muted-foreground">{text}</span>
    </div>
  );
}
