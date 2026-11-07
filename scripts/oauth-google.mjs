#!/usr/bin/env node
// Gera o refresh token do Google na sua máquina.
//
// Uso:
//   node scripts/oauth-google.mjs                       (escopo datamanager)
//   node scripts/oauth-google.mjs --escopo=adwords      (API do Google Ads)
//   node scripts/oauth-google.mjs --escopo=ambos
//
// Antes de rodar, tenha em mãos o Client ID e o Client secret de um cliente
// OAuth do tipo "App para computador", criado no Google Cloud.
// Passo a passo completo: references/google-cloud.md
//
// Nada é enviado para lugar nenhum além do Google: o servidor sobe em
// localhost só para receber o código de autorização.

import http from 'node:http';
import { createInterface } from 'node:readline';
import { exec } from 'node:child_process';

const PORTA = 8787;
const REDIRECT = `http://localhost:${PORTA}/callback`;

const ESCOPOS = {
  datamanager: ['https://www.googleapis.com/auth/datamanager'],
  adwords: ['https://www.googleapis.com/auth/adwords'],
  ambos: [
    'https://www.googleapis.com/auth/datamanager',
    'https://www.googleapis.com/auth/adwords',
  ],
};

const arg = process.argv.find((a) => a.startsWith('--escopo='));
const nomeEscopo = arg ? arg.split('=')[1] : 'datamanager';
const escopos = ESCOPOS[nomeEscopo];

if (!escopos) {
  console.error(`Escopo inválido: ${nomeEscopo}. Use datamanager, adwords ou ambos.`);
  process.exit(1);
}

const pergunta = (texto) => new Promise((resolve) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question(texto, (r) => { rl.close(); resolve(r.trim()); });
});

function abrirNavegador(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, (e) => {
    if (e) console.log('\nAbra este endereço no navegador:\n' + url + '\n');
  });
}

console.log('\n=== Refresh token do Google ===\n');
console.log(`Escopo: ${escopos.join(' ')}\n`);
console.log(`O cliente OAuth precisa aceitar este retorno: ${REDIRECT}`);
console.log('(no tipo "App para computador" ele já é aceito)\n');

const clientId = await pergunta('Client ID: ');
const clientSecret = await pergunta('Client secret: ');

if (!clientId || !clientSecret) {
  console.error('Client ID e secret são obrigatórios.');
  process.exit(1);
}

const estado = Math.random().toString(36).slice(2);

const urlAuth = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: clientId,
  redirect_uri: REDIRECT,
  response_type: 'code',
  scope: escopos.join(' '),
  // access_type=offline e prompt=consent são o que garantem o refresh
  // token na resposta. Sem prompt=consent, a segunda autorização volta sem
  // refresh token e parece que o script quebrou.
  access_type: 'offline',
  prompt: 'consent',
  state: estado,
});

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORTA}`);
  if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }

  const erro = url.searchParams.get('error');
  if (erro) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
       .end(`<h2>Autorização recusada</h2><p>${erro}</p><p>Pode fechar esta aba.</p>`);
    console.error(`\nAutorização recusada: ${erro}`);
    console.error('Se diz access_denied: o e-mail usado não está em "Usuários de teste" na tela de consentimento.');
    servidor.close(); process.exit(1);
  }

  const code = url.searchParams.get('code');
  if (url.searchParams.get('state') !== estado) {
    res.writeHead(400).end('estado inválido');
    servidor.close(); process.exit(1);
  }

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
    }),
  });

  const data = await r.json().catch(() => ({}));

  if (!r.ok || !data.refresh_token) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
       .end('<h2>Falhou</h2><p>Veja o terminal. Pode fechar esta aba.</p>');
    console.error('\nNão veio refresh token.');
    console.error(JSON.stringify(data, null, 2));
    console.error('\nCausas comuns:');
    console.error('  invalid_client ....... client id e secret não são do mesmo cliente');
    console.error('  sem refresh_token .... autorização repetida: revogue o acesso em');
    console.error('                         myaccount.google.com/permissions e tente de novo');
    servidor.close(); process.exit(1);
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
     .end('<h2>Pronto</h2><p>O refresh token está no terminal. Pode fechar esta aba.</p>');

  console.log('\n--- Cole no .dev.vars e no painel da Cloudflare ---\n');
  console.log(`GOOGLE_CLIENT_ID=${clientId}`);
  console.log(`GOOGLE_CLIENT_SECRET=${clientSecret}`);
  console.log(`GOOGLE_REFRESH_TOKEN=${data.refresh_token}`);
  console.log('\nTrate o refresh token como senha: ele dá acesso à conta de anúncio.');
  console.log('\nSe o app está em modo "Em teste" na tela de consentimento, este token');
  console.log('expira em 7 dias. Publique o app antes de usar em produção.\n');

  servidor.close();
  process.exit(0);
});

servidor.listen(PORTA, () => {
  console.log(`\nAguardando autorização em ${REDIRECT} ...\n`);
  abrirNavegador(urlAuth);
});
