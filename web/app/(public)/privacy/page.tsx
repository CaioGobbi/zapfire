import Link from 'next/link';

// Política de privacidade pública — URL usada no formulário da Chrome Web Store
// e no rodapé do painel. Conteúdo em pt-BR (produto é brasileiro) mas descreve
// coisas que auditores internacionais conseguem interpretar sem tradução.

export const metadata = {
  title: 'Política de Privacidade',
  description: 'Política de privacidade do Zapfire — o que coletamos, por que, e seus direitos (LGPD).',
};

export default function PrivacyPage() {
  return (
    <div className="max-w-3xl mx-auto py-12 px-6 prose prose-invert">
      <h1 className="text-3xl font-semibold mb-2">Política de Privacidade</h1>
      <p className="text-muted-foreground text-sm mb-8">
        Última atualização: 24 de abril de 2026
      </p>

      <Section title="1. Quem somos">
        <p>
          Zapfire é uma extensão para Chrome que adiciona recursos de produtividade ao WhatsApp Web
          — envio de áudios, scripts, mídias e funis automatizados. O serviço é operado pela
          <strong> IMP (O Improvável)</strong>, CNPJ a ser informado, com sede no Brasil.
        </p>
        <p>
          Contato para assuntos de privacidade: <a href="mailto:contato@zapfire.com.br">contato@zapfire.com.br</a>
        </p>
      </Section>

      <Section title="2. Quais dados coletamos">
        <h3>2.1 Dados fornecidos pelo cliente no momento da compra (via Kirvano)</h3>
        <ul>
          <li>Nome completo</li>
          <li>Email</li>
          <li>CPF ou CNPJ (opcional, para emissão de nota fiscal)</li>
          <li>Dados de pagamento — processados exclusivamente pela <strong>Kirvano</strong>.
            Nós nunca armazenamos número de cartão ou código de segurança.</li>
        </ul>

        <h3>2.2 Dados coletados pela extensão durante o uso</h3>
        <ul>
          <li>
            <strong>Número do WhatsApp do próprio usuário</strong>: lido do <code>localStorage</code> do
            WhatsApp Web para vincular sua chave de acesso a um número único (anti-compartilhamento).
          </li>
          <li>
            <strong>Identificador do dispositivo (UUID aleatório)</strong>: gerado pela extensão na
            instalação, armazenado em <code>chrome.storage.local</code>. Usado para contar
            dispositivos simultâneos (limite de 4 por chave).
          </li>
          <li>
            <strong>User-Agent e versão do Chrome</strong>: enviados na validação para diagnóstico.
          </li>
          <li>
            <strong>Endereço IP</strong>: registrado pelo servidor em cada validação para detectar
            padrões de uso anômalo (anti-pirataria).
          </li>
        </ul>

        <h3>2.3 Dados gerados pelo cliente (nunca saem do navegador dele)</h3>
        <ul>
          <li>Items criados no gerenciador (mensagens, áudios, imagens, vídeos, arquivos)</li>
          <li>Funis configurados</li>
          <li>Histórico de envios locais</li>
        </ul>
        <p>
          Esses dados ficam exclusivamente em <code>IndexedDB</code> local do navegador do cliente.
          Nossos servidores <strong>não têm acesso</strong> a áudios, scripts, mídias ou quaisquer
          conteúdos criados no gerenciador.
        </p>
      </Section>

      <Section title="3. Como usamos os dados">
        <ul>
          <li><strong>Email</strong>: comunicações transacionais (boas-vindas, confirmação de renovação, avisos de vencimento). Nunca marketing sem consentimento explícito.</li>
          <li><strong>Nome e CPF</strong>: emissão de nota fiscal e identificação para suporte.</li>
          <li><strong>Número do WhatsApp</strong>: vincular cada chave de acesso a um único número. Impede que um cliente compartilhe a chave comprada com outras pessoas.</li>
          <li><strong>Device ID, User-Agent, IP</strong>: controlar limite de dispositivos simultâneos, detectar pirataria, diagnóstico de suporte.</li>
        </ul>
      </Section>

      <Section title="4. Onde armazenamos">
        <ul>
          <li>
            <strong>Banco de dados</strong>: PostgreSQL hospedado na <strong>Railway</strong>,
            data center us-east (EUA). Transferência internacional baseada em legítimo interesse
            (infra do serviço).
          </li>
          <li>
            <strong>Painel web</strong>: servido via <strong>Vercel</strong>, edge network global.
          </li>
          <li>
            <strong>Emails transacionais</strong>: enviados via <strong>Resend</strong>.
          </li>
          <li>
            <strong>Conteúdo criado no gerenciador (seu material)</strong>: apenas no seu navegador.
            Nunca sai dele.
          </li>
        </ul>
      </Section>

      <Section title="5. Compartilhamento com terceiros">
        <p>Compartilhamos dados estritamente necessários com:</p>
        <ul>
          <li>
            <strong>Kirvano</strong> (gateway de pagamento): nome, email, CPF, valor. Política da
            Kirvano: <a href="https://kirvano.com" target="_blank" rel="noopener noreferrer">kirvano.com</a>
          </li>
          <li>
            <strong>Resend</strong> (envio de email transacional): email do destinatário e conteúdo
            do email. Política: <a href="https://resend.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer">resend.com/legal/privacy-policy</a>
          </li>
          <li>
            <strong>Railway</strong> (infra backend): processa os dados armazenados. Política: <a href="https://railway.com/legal/privacy" target="_blank" rel="noopener noreferrer">railway.com/legal/privacy</a>
          </li>
          <li>
            <strong>Vercel</strong> (infra painel): requisições HTTP passam pelos servidores deles. Política: <a href="https://vercel.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer">vercel.com/legal/privacy-policy</a>
          </li>
        </ul>
        <p>
          <strong>Nenhum dado é compartilhado com a Meta/WhatsApp</strong>. A extensão opera
          localmente no seu navegador; as ações que ela executa no WhatsApp Web acontecem como
          se fossem do próprio usuário.
        </p>
      </Section>

      <Section title="6. Por quanto tempo guardamos">
        <ul>
          <li><strong>Dados de conta</strong>: enquanto sua conta estiver ativa, até 5 anos após
            o cancelamento (prazo para eventuais questões fiscais e legais).</li>
          <li><strong>Logs de validação</strong>: 6 meses, depois são anonimizados.</li>
          <li><strong>Emails enviados</strong>: registros no Resend por 30 dias (conforme política deles).</li>
        </ul>
      </Section>

      <Section title="7. Seus direitos (LGPD)">
        <p>Você tem direito a:</p>
        <ul>
          <li>Acessar os dados que temos sobre você</li>
          <li>Corrigir dados incorretos</li>
          <li>Pedir a exclusão da sua conta e dados associados</li>
          <li>Portar seus dados para outro serviço</li>
          <li>Revogar consentimento ou se opor ao tratamento</li>
          <li>Reclamar junto à ANPD (Autoridade Nacional de Proteção de Dados)</li>
        </ul>
        <p>
          Para exercer qualquer desses direitos, envie um email para
          <a href="mailto:contato@zapfire.com.br"> contato@zapfire.com.br</a> com o assunto
          "LGPD - [direito desejado]". Respondemos em até 15 dias úteis.
        </p>
      </Section>

      <Section title="8. Segurança">
        <ul>
          <li>Senhas armazenadas com bcrypt (cost factor 12).</li>
          <li>Tokens de magic link armazenados como SHA-256 hash (nunca em plaintext).</li>
          <li>Comunicação entre painel e backend via HTTPS.</li>
          <li>Cookies de sessão HttpOnly, Secure e SameSite=Lax.</li>
          <li>Rate limiting em endpoints sensíveis (login, webhooks).</li>
        </ul>
      </Section>

      <Section title="9. Cookies">
        <p>Usamos apenas um cookie estritamente necessário:</p>
        <ul>
          <li>
            <code>zf_refresh</code>: token de sessão do painel web. HttpOnly, Secure, SameSite=Lax,
            válido por 30 dias, renovado automaticamente a cada uso.
          </li>
        </ul>
        <p>Não usamos cookies de tracking, analytics de terceiros ou publicidade.</p>
      </Section>

      <Section title="10. Alterações nesta política">
        <p>
          Podemos atualizar esta política. Mudanças materiais serão comunicadas por email para
          clientes ativos, com pelo menos 30 dias de antecedência. A data de última atualização
          no topo desta página indica a versão atual.
        </p>
      </Section>

      <div className="mt-12 pt-6 border-t border-border text-sm text-muted-foreground">
        <Link href="/login" className="hover:underline">Voltar ao painel</Link>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-xl font-semibold mb-3">{title}</h2>
      <div className="text-sm leading-relaxed space-y-3 [&>ul]:list-disc [&>ul]:pl-6 [&>ul]:space-y-1 [&>h3]:text-base [&>h3]:font-medium [&>h3]:mt-4 [&>h3]:mb-2 [&_code]:bg-secondary [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_a]:text-zf-accent [&_a:hover]:underline">
        {children}
      </div>
    </section>
  );
}
