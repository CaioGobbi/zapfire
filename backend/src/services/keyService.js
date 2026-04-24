// ============================================================
// KEY SERVICE — lógica de validação e bind das chaves de acesso
// ============================================================
// ESTA É A PARTE MAIS CRÍTICA DO BACKEND INTEIRO.
// Toda vez que a extensão abre no WhatsApp Web, ela bate aqui.
// Se esse endpoint falhar ou ficar lento, o produto fica inutilizável.
// ============================================================

import { prisma } from '../lib/prisma.js';
import crypto from 'node:crypto';

// ------------------------------------------------------------
// Normaliza número de telefone pra formato canônico.
// WhatsApp Web pode retornar o número em formatos diferentes
// dependendo da versão, então a gente normaliza pra só dígitos.
// ------------------------------------------------------------
export function normalizePhone(phone) {
  if (!phone) return null;
  return String(phone).replace(/\D/g, '');
}

// ------------------------------------------------------------
// Gera uma chave de acesso no formato do ZapVoice:
// UUID v4 sem hífens (32 caracteres hex).
// Ex: "3b36c0db084640b688a4c4e58d9c7f96"
// ------------------------------------------------------------
export function generateKeyValue() {
  return crypto.randomUUID().replace(/-/g, '');
}

// ------------------------------------------------------------
// VALIDAÇÃO — chamada principal pela extensão
// ------------------------------------------------------------
// Fluxo:
// 1. Chave existe?
// 2. Assinatura tá ativa?
// 3. Número bate com o boundPhone? (se ainda não tem bind, faz o bind agora)
// 4. Dispositivo tá dentro do limite?
// 5. Loga tudo pra auditoria
// ------------------------------------------------------------
export async function validateKey({ keyValue, phone, deviceId, ipAddress, userAgent }) {
  const normalizedPhone = normalizePhone(phone);

  // Busca a chave com tudo que a gente precisa
  const key = await prisma.accessKey.findUnique({
    where: { keyValue },
    include: {
      subscription: { include: { plan: true } },
      devices: true,
    },
  });

  // ---------- 1. Chave existe? ----------
  if (!key) {
    await logValidation({
      keyValueTry: keyValue,
      phoneTry: normalizedPhone,
      deviceId,
      ipAddress,
      userAgent,
      result: 'INVALID_KEY',
      reason: 'Chave não encontrada',
    });
    return { ok: false, code: 'INVALID_KEY', message: 'Chave inválida' };
  }

  // ---------- 2. Chave bloqueada? ----------
  if (key.status === 'BLOCKED' || key.status === 'SUSPENDED') {
    await logValidation({
      accessKeyId: key.id,
      keyValueTry: keyValue,
      phoneTry: normalizedPhone,
      deviceId,
      ipAddress,
      userAgent,
      result: 'BLOCKED',
      reason: key.blockedReason || 'Chave bloqueada',
    });
    return { ok: false, code: 'BLOCKED', message: 'Chave bloqueada. Entre em contato com o suporte.' };
  }

  // ---------- 3. Assinatura vigente? ----------
  const now = new Date();
  const sub = key.subscription;
  const isSubActive =
    (sub.status === 'ACTIVE' || sub.status === 'CANCELED') &&
    sub.currentPeriodEnd > now;

  if (!isSubActive) {
    await logValidation({
      accessKeyId: key.id,
      keyValueTry: keyValue,
      phoneTry: normalizedPhone,
      deviceId,
      ipAddress,
      userAgent,
      result: 'EXPIRED',
      reason: `Assinatura ${sub.status}, vence em ${sub.currentPeriodEnd}`,
    });
    return { ok: false, code: 'EXPIRED', message: 'Assinatura expirada. Renove seu plano.' };
  }

  // ---------- 4. Bind de número ----------
  if (!key.boundPhone) {
    // PRIMEIRA VEZ — faz o bind e trava pra sempre
    await prisma.accessKey.update({
      where: { id: key.id },
      data: { boundPhone: normalizedPhone, boundAt: new Date() },
    });
    await logAudit({
      userId: key.userId,
      action: 'key.bound',
      entityType: 'AccessKey',
      entityId: key.id,
      metadata: { boundPhone: normalizedPhone, deviceId },
      ipAddress,
    });
  } else if (key.boundPhone !== normalizedPhone) {
    // Chave já travada em outro número — NEGA
    await logValidation({
      accessKeyId: key.id,
      keyValueTry: keyValue,
      phoneTry: normalizedPhone,
      deviceId,
      ipAddress,
      userAgent,
      result: 'WRONG_PHONE',
      reason: `Chave vinculada a ${key.boundPhone}, tentativa com ${normalizedPhone}`,
    });
    return {
      ok: false,
      code: 'WRONG_PHONE',
      message: 'Esta chave está vinculada a outro número de WhatsApp.',
    };
  }

  // ---------- 5. Controle de dispositivos ----------
  const maxDevices = sub.plan.maxDevicesPerKey;
  const existingDevice = key.devices.find((d) => d.deviceId === deviceId);

  if (existingDevice) {
    // Device já conhecido — só atualiza lastSeen
    await prisma.keyDevice.update({
      where: { id: existingDevice.id },
      data: { lastSeenAt: new Date(), ipAddress, userAgent },
    });
  } else {
    // Device novo — confere se tá dentro do limite
    if (key.devices.length >= maxDevices) {
      await logValidation({
        accessKeyId: key.id,
        keyValueTry: keyValue,
        phoneTry: normalizedPhone,
        deviceId,
        ipAddress,
        userAgent,
        result: 'DEVICE_LIMIT',
        reason: `Já atingiu limite de ${maxDevices} dispositivos`,
      });
      return {
        ok: false,
        code: 'DEVICE_LIMIT',
        message: `Limite de ${maxDevices} dispositivos atingido. Remova um dispositivo no painel.`,
      };
    }
    await prisma.keyDevice.create({
      data: {
        accessKeyId: key.id,
        deviceId,
        ipAddress,
        userAgent,
      },
    });
  }

  // ---------- 6. Sucesso — atualiza lastUsedAt ----------
  await prisma.accessKey.update({
    where: { id: key.id },
    data: { lastUsedAt: new Date() },
  });

  await logValidation({
    accessKeyId: key.id,
    keyValueTry: keyValue,
    phoneTry: normalizedPhone,
    deviceId,
    ipAddress,
    userAgent,
    result: 'SUCCESS',
  });

  return {
    ok: true,
    code: 'SUCCESS',
    data: {
      label: key.label,
      boundPhone: key.boundPhone || normalizedPhone,
      expiresAt: sub.currentPeriodEnd,
      plan: {
        code: sub.plan.code,
        name: sub.plan.name,
        features: sub.plan.features,
        maxDevices: sub.plan.maxDevicesPerKey,
      },
    },
  };
}

// ------------------------------------------------------------
// Helpers de log
// ------------------------------------------------------------
async function logValidation(data) {
  try {
    await prisma.validationLog.create({ data });
  } catch (err) {
    // Log não pode derrubar validação — só imprime e segue
    console.error('[validationLog] Falhou:', err.message);
  }
}

async function logAudit(data) {
  try {
    await prisma.auditLog.create({ data });
  } catch (err) {
    console.error('[auditLog] Falhou:', err.message);
  }
}

// ------------------------------------------------------------
// ADMIN — reset do bind (cliente trocou de número)
// ------------------------------------------------------------
export async function resetKeyBind({ keyId, adminUserId, ipAddress }) {
  const key = await prisma.accessKey.findUnique({ where: { id: keyId } });
  if (!key) throw new Error('Chave não encontrada');

  await prisma.$transaction([
    prisma.accessKey.update({
      where: { id: keyId },
      data: { boundPhone: null, boundAt: null },
    }),
    prisma.keyDevice.deleteMany({ where: { accessKeyId: keyId } }),
  ]);

  await logAudit({
    userId: adminUserId,
    action: 'bind.reset',
    entityType: 'AccessKey',
    entityId: keyId,
    metadata: { previousPhone: key.boundPhone },
    ipAddress,
  });

  return { ok: true };
}
