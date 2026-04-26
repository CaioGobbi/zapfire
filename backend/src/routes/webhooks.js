// ============================================================
// WEBHOOKS — endpoints de eventos de gateways externos
// ============================================================
// Por ora, só Kirvano. Futuros: meta-ads, Typeform, etc.
//
// REGRAS DE OURO (não quebre):
// 1. Token inválido/ausente → 401. Nenhum processamento.
// 2. Token válido → responde SEMPRE 200, mesmo em erro interno,
//    pra Kirvano não entrar em retry loop.
// 3. Zero log do token (nem em audit_logs nem em pino).
// 4. Idempotência via Payment.kirvanoSaleId (no service).
// ============================================================

import { z } from 'zod';

import { mapKirvanoEvent } from '../lib/kirvanoParser.js';
import { prisma } from '../lib/prisma.js';
import {
  processSaleApproved,
  processSubscriptionRenewed,
  processSubscriptionCanceled,
  processSubscriptionExpired,
  processSaleRefundOrChargeback,
} from '../services/kirvanoService.js';

// ------------------------------------------------------------
// Schema Zod — tolerante a campos extras (passthrough)
// ------------------------------------------------------------
// Kirvano tende a adicionar campos novos sem versionar. .passthrough()
// permite aceitar payloads mais ricos sem quebrar.
// ------------------------------------------------------------
const kirvanoCustomerSchema = z
  .object({
    email: z.string().email(),
    name: z.string().optional(),
    phone_number: z.string().optional(),
    document: z.string().optional(),
  })
  .passthrough();

const kirvanoPlanSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    charge_frequency: z.string().optional(),
    next_charge_date: z.string().optional(),
  })
  .passthrough();

const kirvanoProductSchema = z
  .object({
    id: z.string().optional(),
    offer_id: z.string().optional(),
    name: z.string().optional(),
    price: z.string().optional(),
  })
  .passthrough();

const kirvanoPaymentSchema = z
  .object({
    method: z.string().optional(),
    total_amount: z.string().optional(),
  })
  .passthrough();

const kirvanoSubscriptionRefSchema = z
  .object({
    id: z.string(),
    status: z.string().optional(),
  })
  .passthrough();

const kirvanoWebhookSchema = z
  .object({
    event: z.string().min(1),
    sale_id: z.string().min(1),
    status: z.string().optional(),
    type: z.string().optional(),
    created_at: z.string().optional(),
    finished_at: z.string().optional(),
    customer: kirvanoCustomerSchema,
    products: z.array(kirvanoProductSchema).optional(),
    plan: kirvanoPlanSchema.optional(),
    subscription: kirvanoSubscriptionRefSchema.optional(),
    payment: kirvanoPaymentSchema.optional(),
    payment_method: z.string().optional(),
    total_price: z.string().optional(),
    reason: z.string().optional(),
  })
  .passthrough();

// ------------------------------------------------------------
// Schema Resend webhook (Sprint 6)
// ------------------------------------------------------------
const resendWebhookSchema = z
  .object({
    type: z.string().min(1), // email.sent, email.delivered, email.bounced, email.complained, etc
    created_at: z.string().optional(),
    data: z
      .object({
        email_id: z.string().optional(),
        to: z.array(z.string()).optional(),
        subject: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

// Extrai o status canônico a partir do evento.
// Referência: https://resend.com/docs/dashboard/webhooks/event-types
const RESEND_EVENT_STATUS = {
  'email.sent':      'sent',
  'email.delivered': 'delivered',
  'email.bounced':   'bounced',
  'email.complained':'complained',
  'email.delivery_delayed': 'delayed',
  'email.failed':    'failed',
  'email.opened':    null,   // ignora
  'email.clicked':   null,   // ignora
};

// ------------------------------------------------------------
// Registra as rotas
// ------------------------------------------------------------
export default async function webhookRoutes(fastify) {
  fastify.post(
    '/webhooks/kirvano',
    {
      config: {
        rateLimit: {
          max: 120,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      // 1. Auth — header `security-token` tem que bater com env
      // (descoberto empiricamente em 2026-04-26: a Kirvano usa o nome
      // `security-token`, não `X-Kirvano-Token` como assumimos antes;
      // a doc oficial só diz "Token: opcional" sem revelar o header.
      // ATENÇÃO: o botão "Testar Integração" do painel Kirvano NÃO
      // envia o token — só eventos reais incluem o header.)
      const expectedToken = process.env.KIRVANO_WEBHOOK_TOKEN;
      const receivedToken = request.headers['security-token'];

      if (!expectedToken) {
        // Sem env configurada = rejeita tudo (fail-secure)
        fastify.log.error({ msg: 'KIRVANO_WEBHOOK_TOKEN não configurado' });
        return reply.code(401).send({ ok: false, code: 'UNAUTHORIZED' });
      }
      if (!receivedToken || receivedToken !== expectedToken) {
        // NÃO loga o VALOR do token (poderia vazar em arquivos de log)
        const ipAddress =
          request.headers['x-forwarded-for']?.split(',')[0].trim() || request.ip;
        fastify.log.warn({ msg: 'webhook kirvano: token inválido', ipAddress });
        return reply.code(401).send({ ok: false, code: 'UNAUTHORIZED' });
      }

      // 2. Valida body com Zod
      const parsed = kirvanoWebhookSchema.safeParse(request.body);
      if (!parsed.success) {
        // Responde 200 pra Kirvano não ficar retry-ing;
        // loga pra a gente investigar o payload deformado depois
        fastify.log.warn({
          msg: 'webhook kirvano: body inválido',
          errors: parsed.error.flatten(),
          rawEvent: request.body?.event,
          rawSaleId: request.body?.sale_id,
        });
        await safeAuditBadPayload(request.body, parsed.error.flatten());
        return reply.code(200).send({ ok: false, code: 'BAD_PAYLOAD' });
      }

      const payload = parsed.data;

      // 3. Mapeia evento canônico — ignora os desconhecidos
      const event = mapKirvanoEvent(payload.event);
      if (!event) {
        fastify.log.info({ msg: 'webhook kirvano: evento ignorado', event: payload.event, saleId: payload.sale_id });
        return reply.code(200).send({ ok: true, ignored: payload.event });
      }

      // 4. Dispatch
      let result;
      try {
        switch (event) {
          case 'SALE_APPROVED':
            result = await processSaleApproved(payload);
            break;
          case 'SUBSCRIPTION_RENEWED':
            result = await processSubscriptionRenewed(payload);
            break;
          case 'SUBSCRIPTION_CANCELED':
            result = await processSubscriptionCanceled(payload);
            break;
          case 'SUBSCRIPTION_EXPIRED':
            result = await processSubscriptionExpired(payload);
            break;
          case 'SALE_REFUNDED':
            result = await processSaleRefundOrChargeback(payload, 'REFUND');
            break;
          case 'SALE_CHARGEBACK':
            result = await processSaleRefundOrChargeback(payload, 'CHARGEBACK');
            break;
          case 'PIX_GENERATED':
          case 'PIX_EXPIRED':
            result = { ok: true, processed: event, info: 'log_only' };
            break;
          default:
            result = { ok: true, ignored: event };
        }
      } catch (err) {
        // Erro interno — loga, responde 200 pra Kirvano, NÃO deixa ela retry
        fastify.log.error({ msg: 'webhook kirvano: exception', event, saleId: payload.sale_id, err });
        await safeAuditError(event, payload.sale_id, err?.message || String(err));
        return reply.code(200).send({ ok: false, code: 'INTERNAL_ERROR' });
      }

      fastify.log.info({ msg: 'webhook kirvano: ok', event, saleId: payload.sale_id, result });
      return reply.code(200).send({ ok: true, ...result });
    }
  );

  // ==========================================================
  // POST /webhooks/resend — eventos de entrega de email
  // ==========================================================
  // Auth: header X-Zapfire-Resend-Token deve bater com RESEND_WEBHOOK_TOKEN.
  // Se a env não tá configurada, rejeita tudo (fail-secure).
  //
  // Sempre retorna 200 após validar token (evita retry loop do Resend).
  // Erros de processamento vão pra audit_logs.
  //
  // TODO Sprint 7: migrar pra assinatura svix (padrão do Resend) em vez
  // de token simples no header. Pra MVP, token compartilhado é suficiente.
  // ==========================================================
  fastify.post(
    '/webhooks/resend',
    { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const expected = process.env.RESEND_WEBHOOK_TOKEN;
      const received = request.headers['x-zapfire-resend-token'];
      if (!expected) {
        fastify.log.error({ msg: 'RESEND_WEBHOOK_TOKEN não configurado' });
        return reply.code(401).send({ ok: false, code: 'UNAUTHORIZED' });
      }
      if (!received || received !== expected) {
        fastify.log.warn({ msg: 'webhook resend: token inválido' });
        return reply.code(401).send({ ok: false, code: 'UNAUTHORIZED' });
      }

      const parsed = resendWebhookSchema.safeParse(request.body);
      if (!parsed.success) {
        fastify.log.warn({ msg: 'webhook resend: payload inválido', errors: parsed.error.flatten() });
        return reply.code(200).send({ ok: false, code: 'BAD_PAYLOAD' });
      }

      const { type, data } = parsed.data;
      const emailId = data?.email_id;
      const status = RESEND_EVENT_STATUS[type];

      // Evento que não nos interessa (opened/clicked) — só loga, 200 OK
      if (status === null) {
        fastify.log.info({ msg: 'webhook resend: evento ignorado', type, emailId });
        return reply.code(200).send({ ok: true, ignored: type });
      }
      if (status === undefined) {
        fastify.log.info({ msg: 'webhook resend: tipo desconhecido', type });
        return reply.code(200).send({ ok: true, ignored: type });
      }
      if (!emailId) {
        fastify.log.warn({ msg: 'webhook resend: sem email_id', type });
        return reply.code(200).send({ ok: true, warning: 'no_email_id' });
      }

      // Localiza EmailToken por resendEmailId e atualiza status
      try {
        const updated = await prisma.emailToken.updateMany({
          where: { resendEmailId: emailId },
          data: { deliveryStatus: status, deliveryUpdatedAt: new Date() },
        });

        // Se foi bounce/complained, registra em audit_logs pra o admin
        // conseguir investigar via UI
        if (status === 'bounced' || status === 'complained' || status === 'failed') {
          const token = await prisma.emailToken.findFirst({
            where: { resendEmailId: emailId },
            include: { user: { select: { id: true, email: true } } },
          });
          if (token) {
            await prisma.auditLog.create({
              data: {
                userId: token.userId,
                action: `email.${status}`,
                entityType: 'EmailToken',
                entityId: token.id,
                metadata: {
                  resendEventType: type,
                  resendEmailId: emailId,
                  userEmail: token.user?.email,
                  subject: data?.subject,
                  to: data?.to,
                },
              },
            });
          }
        }

        fastify.log.info({
          msg: 'webhook resend: status atualizado',
          type,
          status,
          emailId,
          matched: updated.count,
        });
        return reply.code(200).send({ ok: true, status, matched: updated.count });
      } catch (err) {
        fastify.log.error({ msg: 'webhook resend: exception', err: err?.message });
        await safeAuditError(type, emailId, err?.message || String(err));
        return reply.code(200).send({ ok: false, code: 'INTERNAL_ERROR' });
      }
    }
  );
}

// ------------------------------------------------------------
// Helpers de audit (silenciam erro pra não cascatear)
// ------------------------------------------------------------
async function safeAuditBadPayload(body, errors) {
  try {
    await prisma.auditLog.create({
      data: {
        action: 'webhook.bad_payload',
        entityType: 'KirvanoWebhook',
        metadata: {
          rawEvent: body?.event ?? null,
          rawSaleId: body?.sale_id ?? null,
          errors,
        },
      },
    });
  } catch (err) {
    console.error('[webhook:audit_bad_payload]', err.message);
  }
}

async function safeAuditError(event, saleId, errMsg) {
  try {
    await prisma.auditLog.create({
      data: {
        action: 'webhook.error',
        entityType: 'KirvanoWebhook',
        metadata: { event, saleId, errMsg },
      },
    });
  } catch (err) {
    console.error('[webhook:audit_error]', err.message);
  }
}
