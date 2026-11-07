// Cloudflare Pages Functions: roda em TODA requisicao de pagina.
//
// Captura a identidade antes de qualquer JavaScript do navegador rodar:
// gera os ids proprios, monta _fbp e _fbc no formato do Meta, le os
// parametros de clique e as UTMs, grava a sessao e responde com cookie
// primario de 400 dias.
//
// Por que no servidor: cookie escrito por JavaScript vive 7 dias no Safari
// (ITP) e nao nasce quando o bloqueador derruba o script do pixel. Escrito
// pelo cabecalho HTTP do proprio dominio, vive 400 dias e nasce sempre.
//
// Instalar em: functions/_middleware.js

export async function onRequest(context) {
  const { request, next, env } = context;
  const url = new URL(request.url);

  // So intercepta requisicao de pagina. Asset, endpoint e painel ficam de
  // fora: nao faz sentido criar cookie de tracking quando alguem abre a API.
  const ehPagina = !url.pathname.match(
    /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map|json|webp|avif|mp4|webm|pdf|xml|txt)$/i
  ) && !url.pathname.startsWith('/tracker')
    && !url.pathname.startsWith('/checkout-session')
    && !url.pathname.startsWith('/webhook/')
    && !url.pathname.startsWith('/api/');

  if (!ehPagina) return next();

  // --- Parametros de clique -------------------------------------------------
  // IMPORTANTE: leia do texto cru da query, nunca com url.searchParams.get().
  // O searchParams decodifica percent-encoding e o Meta espera o fbclid
  // exatamente como apareceu na URL. Um %3D virando = quebra o match.
  const fbclid  = paramCru(url.search, 'fbclid');
  const gclid   = paramCru(url.search, 'gclid');
  const wbraid  = paramCru(url.search, 'wbraid');
  const gbraid  = paramCru(url.search, 'gbraid');
  const msclkid = paramCru(url.search, 'msclkid');

  // UTM pode ser decodificada sem problema: ninguem casa hash com ela.
  const utmSource   = url.searchParams.get('utm_source') || '';
  const utmMedium   = url.searchParams.get('utm_medium') || '';
  const utmCampaign = url.searchParams.get('utm_campaign') || '';
  const utmContent  = url.searchParams.get('utm_content') || '';
  const utmTerm     = url.searchParams.get('utm_term') || '';

  // --- Cookies que ja existem ----------------------------------------------
  const cookies = lerCookies(request.headers.get('Cookie') || '');
  let sessionId  = cookies['_trk_sid'] || '';
  let externalId = cookies['_trk_eid'] || '';
  const fbcAtual = cookies['_fbc'] || '';
  const fbpAtual = cookies['_fbp'] || '';

  if (!sessionId)  sessionId  = crypto.randomUUID();
  if (!externalId) externalId = crypto.randomUUID();

  // --- sub_domain_index da especificacao do Meta ---------------------------
  // E a quantidade de rotulos do dominio registravel menos um:
  //   exemplo.com    -> 2 rotulos -> index 1
  //   exemplo.com.br -> 3 rotulos -> index 2
  // Calculado do cabecalho Host, entao o mesmo codigo serve para qualquer
  // dominio sem configuracao. Index errado faz o Meta descartar calado.
  const SUB_DOMAIN_INDEX = calcularSubDomainIndex(request.headers.get('host') || '');

  // --- _fbc a partir do fbclid ---------------------------------------------
  let fbc = fbcAtual;
  if (fbclid) {
    const conteudoAtual = fbcAtual ? fbcAtual.split('.')[3] || '' : '';
    // Clique novo (ou primeiro clique) sobrescreve: o fbclid mais recente e
    // o que a plataforma ainda atribui.
    if (!fbcAtual || conteudoAtual !== fbclid) {
      fbc = `fb.${SUB_DOMAIN_INDEX}.${Date.now()}.${fbclid}`;
    }
  }

  // --- _fbp se nao existir -------------------------------------------------
  let fbp = fbpAtual;
  if (!fbp) {
    fbp = `fb.${SUB_DOMAIN_INDEX}.${Date.now()}.${Math.floor(Math.random() * 9000000000) + 1000000000}`;
  }

  const clientIp  = request.headers.get('cf-connecting-ip') || '';
  const userAgent = request.headers.get('user-agent') || '';
  const referrer  = request.headers.get('referer') || '';
  const agora     = Math.floor(Date.now() / 1000);

  // --- Serve a pagina PRIMEIRO --------------------------------------------
  // O banco nunca entra no tempo de carregamento: a gravacao acontece em
  // waitUntil, depois de a resposta sair. Banco fora do ar vira evento
  // perdido, nunca pagina lenta.
  const resposta = await next();

  // --- Cookies (400 dias, o teto que o Chrome aceita) ---------------------
  const maxAge = 34560000;
  const base = `Path=/; Max-Age=${maxAge}; SameSite=Lax; Secure`;

  const headers = new Headers(resposta.headers);
  headers.append('Set-Cookie', `_trk_sid=${sessionId}; ${base}`);
  headers.append('Set-Cookie', `_trk_eid=${externalId}; ${base}`);
  headers.append('Set-Cookie', `_fbp=${fbp}; ${base}`);
  if (fbc) headers.append('Set-Cookie', `_fbc=${fbc}; ${base}`);

  const novaResposta = new Response(resposta.body, {
    status: resposta.status,
    statusText: resposta.statusText,
    headers,
  });

  // --- Grava a sessao em segundo plano ------------------------------------
  // O CASE WHEN protege o primeiro toque: parametro vazio numa visita
  // posterior nao apaga o gclid que trouxe a pessoa.
  context.waitUntil((async () => {
    try {
      if (!env.DB) return;
      await env.DB.prepare(`
        INSERT INTO sessions (
          session_id, external_id, fbclid, gclid, wbraid, gbraid, msclkid,
          fbc, fbp, ip_address, user_agent, referrer, landing_url,
          utm_source, utm_medium, utm_campaign, utm_content, utm_term,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          fbclid       = CASE WHEN excluded.fbclid       <> '' THEN excluded.fbclid       ELSE sessions.fbclid       END,
          gclid        = CASE WHEN excluded.gclid        <> '' THEN excluded.gclid        ELSE sessions.gclid        END,
          wbraid       = CASE WHEN excluded.wbraid       <> '' THEN excluded.wbraid       ELSE sessions.wbraid       END,
          gbraid       = CASE WHEN excluded.gbraid       <> '' THEN excluded.gbraid       ELSE sessions.gbraid       END,
          msclkid      = CASE WHEN excluded.msclkid      <> '' THEN excluded.msclkid      ELSE sessions.msclkid      END,
          fbc          = CASE WHEN excluded.fbc          <> '' THEN excluded.fbc          ELSE sessions.fbc          END,
          utm_source   = CASE WHEN excluded.utm_source   <> '' THEN excluded.utm_source   ELSE sessions.utm_source   END,
          utm_medium   = CASE WHEN excluded.utm_medium   <> '' THEN excluded.utm_medium   ELSE sessions.utm_medium   END,
          utm_campaign = CASE WHEN excluded.utm_campaign <> '' THEN excluded.utm_campaign ELSE sessions.utm_campaign END,
          utm_content  = CASE WHEN excluded.utm_content  <> '' THEN excluded.utm_content  ELSE sessions.utm_content  END,
          utm_term     = CASE WHEN excluded.utm_term     <> '' THEN excluded.utm_term     ELSE sessions.utm_term     END,
          updated_at   = excluded.updated_at
      `).bind(
        sessionId, externalId, fbclid, gclid, wbraid, gbraid, msclkid,
        fbc, fbp, clientIp, userAgent, referrer, url.toString(),
        utmSource, utmMedium, utmCampaign, utmContent, utmTerm,
        agora, agora
      ).run();
    } catch (e) {
      console.error('middleware: erro ao gravar sessao:', e.message);
    }
  })());

  return novaResposta;
}

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

function lerCookies(cabecalho) {
  const out = {};
  cabecalho.split(';').forEach((c) => {
    const [nome, ...resto] = c.trim().split('=');
    if (nome) out[nome.trim()] = resto.join('=');
  });
  return out;
}

function paramCru(query, nome) {
  const m = (query || '').match(new RegExp('[?&]' + nome + '=([^&]*)'));
  return m ? m[1] : '';
}

// Dominios de segundo nivel em que o dominio registravel tem 3 rotulos.
// A lista completa de sufixos publicos e pesada demais para a borda; estes
// cobrem os casos comuns. Qualquer outro cai no padrao de 2 rotulos, que e
// o certo para .com, .net, .org, .io e companhia.
const TLDS_COMPOSTOS = new Set([
  'com.br', 'com.ar', 'com.mx', 'com.co', 'com.pe', 'com.ve', 'com.ec',
  'com.au', 'com.pt', 'com.pl', 'com.tr', 'com.ua',
  'com.cn', 'com.tw', 'com.hk', 'com.sg', 'com.my', 'com.ph', 'com.vn',
  'co.uk', 'co.jp', 'co.kr', 'co.nz', 'co.za', 'co.in', 'co.id',
  'net.br', 'org.br', 'adv.br',
]);

function calcularSubDomainIndex(host) {
  if (!host) return 1;
  const hostname = host.split(':')[0].toLowerCase();
  const partes = hostname.split('.');
  if (partes.length < 2) return 0;
  if (TLDS_COMPOSTOS.has(partes.slice(-2).join('.'))) return 2;
  return 1;
}
