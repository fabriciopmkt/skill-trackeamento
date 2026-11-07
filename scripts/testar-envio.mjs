#!/usr/bin/env node
// Dispara um evento de teste para cada plataforma e imprime a resposta crua.
//
// Uso (de dentro da pasta do projeto, onde está o .dev.vars):
//   node scripts/testar-envio.mjs --todos
//   node scripts/testar-envio.mjs --meta
//   node scripts/testar-envio.mjs --ga4
//   node scripts/testar-envio.mjs --google
//   node scripts/testar-envio.mjs --todos --vars=../outro/.dev.vars
//
// O que ele faz em cada destino:
//   Meta ..... manda um Lead de teste. Precisa de META_TEST_EVENT_CODE para
//              o evento aparecer na aba "Testar eventos" e NÃO contar.
//   GA4 ...... usa o endpoint /debug/mp/collect, que devolve os problemas
//              (o endpoint normal responde 204 para tudo, até para payload
//              errado).
//   Google ... manda com validateOnly: confere credencial, conta, ação e
//              formato sem gravar conversão nenhuma.
//
// Nenhum destes envios cria conversão de verdade.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const quer = (nome) => argv.includes(`--${nome}`) || argv.includes('--todos');
const arqVars = (argv.find((a) => a.startsWith('--vars=')) || '').split('=')[1] || '.dev.vars';

if (argv.length === 0) {
  console.log('Use --todos, ou --meta, --ga4, --google. Veja o topo do arquivo.');
  process.exit(0);
}

// --- Carrega o .dev.vars --------------------------------------------------
const env = { ...process.env };
try {
  for (const linha of readFileSync(arqVars, 'utf8').split('\n')) {
    const t = linha.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  console.log(`Variáveis lidas de ${arqVars}\n`);
} catch (_) {
  console.log(`Não achei ${arqVars}. Usando só as variáveis do ambiente.\n`);
}

const sha256 = (v) => (v ? createHash('sha256').update(String(v)).digest('hex') : '');

const EMAIL_TESTE = 'teste.trackeamento@exemplo.com';
const agora = Math.floor(Date.now() / 1000);
const idEvento = `teste-${agora}`;

const faltando = (campos) => campos.filter((c) => !env[c]);
const titulo = (t) => console.log(`\n=== ${t} ===`);

// --- Meta -----------------------------------------------------------------
if (quer('meta')) {
  titulo('Meta CAPI');
  const falta = faltando(['META_PIXEL_ID', 'META_ACCESS_TOKEN']);
  if (falta.length) {
    console.log(`Faltando: ${falta.join(', ')}`);
  } else {
    if (!env.META_TEST_EVENT_CODE) {
      console.log('AVISO: sem META_TEST_EVENT_CODE este evento conta como real.');
      console.log('Pegue o código em Events Manager > Testar eventos.\n');
    }
    const corpo = {
      data: [{
        event_name: 'Lead',
        event_time: agora,
        event_id: idEvento,
        action_source: 'website',
        event_source_url: 'https://exemplo.com/teste',
        user_data: {
          em: [sha256(EMAIL_TESTE)],
          client_ip_address: '203.0.113.10',
          client_user_agent: 'Mozilla/5.0 (teste de trackeamento)',
          fbp: `fb.1.${Date.now()}.1234567890`,
        },
      }],
      access_token: env.META_ACCESS_TOKEN,
      ...(env.META_TEST_EVENT_CODE ? { test_event_code: env.META_TEST_EVENT_CODE } : {}),
    };
    const r = await fetch(`https://graph.facebook.com/v25.0/${env.META_PIXEL_ID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    const txt = await r.text();
    console.log(`HTTP ${r.status}`);
    console.log(txt);
    if (r.ok) {
      console.log(`\nevent_id: ${idEvento}`);
      console.log('Confira em Events Manager > Testar eventos.');
    }
  }
}

// --- GA4 ------------------------------------------------------------------
if (quer('ga4')) {
  titulo('GA4 Measurement Protocol (endpoint de depuração)');
  const falta = faltando(['GA4_MEASUREMENT_ID', 'GA4_API_SECRET']);
  if (falta.length) {
    console.log(`Faltando: ${falta.join(', ')}`);
  } else {
    const corpo = {
      client_id: `${Math.floor(Math.random() * 1000000000)}.${agora}`,
      events: [{
        name: 'generate_lead',
        params: { engagement_time_msec: 100, currency: 'BRL', value: 1, debug_mode: true },
      }],
    };
    const url = `https://www.google-analytics.com/debug/mp/collect?measurement_id=${env.GA4_MEASUREMENT_ID}&api_secret=${env.GA4_API_SECRET}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    const txt = await r.text();
    console.log(`HTTP ${r.status}`);
    console.log(txt || '(sem corpo)');
    try {
      const j = JSON.parse(txt);
      if (Array.isArray(j.validationMessages) && j.validationMessages.length === 0) {
        console.log('\nPayload válido. Veja o evento no DebugView do GA4.');
      }
    } catch (_) {}
  }
}

// --- Google ---------------------------------------------------------------
if (quer('google')) {
  titulo('Google (Data Manager API, validateOnly)');
  const falta = faltando([
    'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN',
    'GOOGLE_ADS_CUSTOMER_ID',
  ]);
  const acao = env.GOOGLE_ACAO_LEAD_QUALIFICADO || env.GOOGLE_ADS_CONVERSION_ACTION_ID;
  if (falta.length || !acao) {
    console.log(`Faltando: ${[...falta, ...(acao ? [] : ['uma ação de conversão'])].join(', ')}`);
  } else {
    const tk = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: env.GOOGLE_REFRESH_TOKEN,
      }),
    });
    const tkJson = await tk.json().catch(() => ({}));

    if (!tk.ok || !tkJson.access_token) {
      console.log(`OAuth falhou: HTTP ${tk.status}`);
      console.log(JSON.stringify(tkJson, null, 2));
      console.log('\ninvalid_grant quase sempre é o refresh token de 7 dias de app em');
      console.log('modo "Em teste". Publique o app e gere outro token.');
    } else {
      console.log('OAuth ok.');
      const soDigitos = (v) => String(v || '').replace(/\D/g, '');
      // E-mail normalizado como o Google pede, antes do hash.
      const emailGoogle = (e) => {
        const s = String(e).toLowerCase().replace(/\s+/g, '');
        const at = s.lastIndexOf('@');
        if (at < 1) return s;
        const dom = s.slice(at + 1);
        let loc = s.slice(0, at);
        if (dom === 'gmail.com' || dom === 'googlemail.com') loc = loc.split('+')[0].replace(/\./g, '');
        return `${loc}@${dom}`;
      };
      const corpo = {
        destinations: [{
          operatingAccount: { accountType: 'GOOGLE_ADS', accountId: soDigitos(env.GOOGLE_ADS_CUSTOMER_ID) },
          ...(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID
            ? { loginAccount: { accountType: 'GOOGLE_ADS', accountId: soDigitos(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) } }
            : {}),
          productDestinationId: soDigitos(acao),
        }],
        encoding: 'HEX',
        events: [{
          eventTimestamp: new Date(agora * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
          eventSource: 'CRM',
          transactionId: idEvento,
          userData: { userIdentifiers: [{ emailAddress: sha256(emailGoogle(EMAIL_TESTE)) }] },
        }],
        validateOnly: true,
      };
      const r = await fetch('https://datamanager.googleapis.com/v1/events:ingest', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tkJson.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
      });
      const txt = await r.text();
      console.log(`HTTP ${r.status}`);
      console.log(txt || '(sem corpo)');
      if (r.ok) {
        console.log('\nCredencial, conta, ação e formato validados. Nada foi gravado.');
      } else {
        console.log('\nA tabela de erros está em references/google-conversoes.md.');
      }
    }
  }
}

console.log('');
