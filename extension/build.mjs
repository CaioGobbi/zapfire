#!/usr/bin/env node
// ============================================================
// ZAPFIRE — Build da extensão pra Chrome Web Store
// ============================================================
// Uso (bash/zsh):
//   ZF_API_BASE="https://zapfire-backend.up.railway.app/api/v1" \
//   ZF_PANEL_URL="https://zapfire.vercel.app" \
//   node build.mjs
//
// Uso (PowerShell):
//   $env:ZF_API_BASE="..."; $env:ZF_PANEL_URL="..."; node build.mjs
//
// Uso (dev, sem env vars):
//   node build.mjs
//   → usa os defaults de config.js (localhost), útil pra testar
//     o próprio pipeline sem hospedar ainda
//
// Saída:
//   extension/dist/extension/                      ← pasta montada pra unpacked
//   extension/dist/zapfire-extension-<version>.zip ← upload direto no CWS
// ============================================================

import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import archiver from 'archiver';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = __dirname;
const DIST_DIR = path.join(SRC, 'dist');
const OUT = path.join(DIST_DIR, 'extension');

// Valores de prod vêm das env vars; fallback pro dev defaults.
const API_BASE = process.env.ZF_API_BASE || 'http://localhost:3000/api/v1';
const PANEL_URL = process.env.ZF_PANEL_URL || 'http://localhost:3001';

// Arquivos/pastas de dev tooling que NÃO entram no dist.
const EXCLUDED = new Set([
  'dist',
  'node_modules',
  'package.json',
  'package-lock.json',
  'build.mjs',
  '.gitignore',
]);

// ------------------------------------------------------------
// 1. Clean + mkdir
// ------------------------------------------------------------
async function clean() {
  await fs.rm(DIST_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });
}

// ------------------------------------------------------------
// 2. Copia tudo da extensão pro dist/ (menos EXCLUDED)
// ------------------------------------------------------------
async function copyAll() {
  const entries = await fs.readdir(SRC, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDED.has(entry.name)) continue;
    const srcPath = path.join(SRC, entry.name);
    const dstPath = path.join(OUT, entry.name);
    await fs.cp(srcPath, dstPath, { recursive: true });
  }
}

// ------------------------------------------------------------
// 3. Reescreve config.js com valores de prod (sobrescreve o
//    arquivo copiado pelo passo anterior).
// ------------------------------------------------------------
async function writeConfig() {
  const content =
`// GERADO POR build.mjs — não editar.
export const API_BASE = ${JSON.stringify(API_BASE)};
export const PANEL_URL = ${JSON.stringify(PANEL_URL)};
`;
  await fs.writeFile(path.join(OUT, 'config.js'), content);
}

// ------------------------------------------------------------
// 4. Atualiza host_permissions do manifest pra incluir o origin
//    do API_BASE (remove localhost se não está no API_BASE).
// ------------------------------------------------------------
async function writeManifest() {
  const manifestPath = path.join(OUT, 'manifest.json');
  const m = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));

  const apiOrigin = new URL(API_BASE).origin + '/*';
  const keepLocalhost = API_BASE.includes('localhost');

  m.host_permissions = (m.host_permissions || []).filter((h) => {
    if (h.includes('localhost') && !keepLocalhost) return false;
    return true;
  });

  if (!m.host_permissions.includes(apiOrigin)) {
    m.host_permissions.push(apiOrigin);
  }

  await fs.writeFile(manifestPath, JSON.stringify(m, null, 2) + '\n');
  return m.version;
}

// ------------------------------------------------------------
// 5. Minifica JS (exceto vendor/) com esbuild.
//    - bundle: false → preserva estrutura de arquivos
//    - format: esm → mantém import/export
//    - allowOverwrite: sim, reescreve em DIST
// ------------------------------------------------------------
async function findJsFiles(dir) {
  const files = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor') continue; // WA-JS + opus ficam intactos
      files.push(...await findJsFiles(p));
    } else if (entry.name.endsWith('.js')) {
      files.push(p);
    }
  }
  return files;
}

async function minify() {
  const files = await findJsFiles(OUT);
  await esbuild.build({
    entryPoints: files,
    outdir: OUT,
    outbase: OUT,
    allowOverwrite: true,
    minify: true,
    bundle: false,
    format: 'esm',
    target: 'chrome120',
    logLevel: 'warning',
  });
  return files.length;
}

// ------------------------------------------------------------
// 6. Gera o .zip pronto pra Chrome Web Store.
// ------------------------------------------------------------
function createZip(version) {
  return new Promise((resolve, reject) => {
    const zipPath = path.join(DIST_DIR, `zapfire-extension-${version}.zip`);
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve({ zipPath, size: archive.pointer() }));
    archive.on('warning', (err) => { if (err.code !== 'ENOENT') reject(err); });
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(OUT, false);
    archive.finalize();
  });
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------
async function main() {
  const isDev = API_BASE.includes('localhost') || PANEL_URL.includes('localhost');

  console.log('🔥 Zapfire — build da extensão');
  console.log('   Mode     :', isDev ? 'DEV (localhost)' : 'PROD');
  console.log('   API_BASE :', API_BASE);
  console.log('   PANEL_URL:', PANEL_URL);
  console.log('');

  await clean();
  await copyAll();
  console.log('✅ Arquivos copiados');

  await writeConfig();
  console.log('✅ config.js escrito');

  const version = await writeManifest();
  console.log('✅ manifest.json atualizado (v' + version + ')');

  const count = await minify();
  console.log(`✅ ${count} arquivos JS minificados`);

  const { zipPath, size } = await createZip(version);
  console.log(`✅ Zip: ${path.relative(process.cwd(), zipPath)} (${(size / 1024).toFixed(1)} KB)`);
  console.log('');

  if (isDev) {
    console.log('⚠️  BUILD DE DEV — não envie esse zip pra CWS.');
    console.log('    Defina ZF_API_BASE e ZF_PANEL_URL pra build de prod.');
  } else {
    console.log('✨ Pronto pra publicar na Chrome Web Store.');
  }
}

main().catch((err) => {
  console.error('❌ Build falhou:', err);
  process.exit(1);
});
