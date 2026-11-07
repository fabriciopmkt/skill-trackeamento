// POST /checkout-session: congela a atribuicao antes de o visitante sair
// para um checkout de terceiro.
//
// A pagina de venda gera um trk (UUID), chama este endpoint e coloca o trk
// num campo livre da URL do checkout. Quando a compra acontece, o webhook
// devolve o trk e o lookup aqui recupera a atribuicao inteira.
//
// Congelar no clique, e nao reconstruir depois, e o que faz a ponte ser
// confiavel: o cookie pode nao existir mais quando o webhook chegar.
//
// Instalar em: functions/checkout-session.js
// Ver: references/checkout-externo.md

import { lerCookies, validarCookieFb, clientIdGA4, json } from './_tracking-lib.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const trk = String(body.trk || '').trim();
    if (!trk) return json({ error: 'trk ausente' }, 400, CORS);

    const cookies = lerCookies(request.headers.get('Cookie') || '');
    const clientIp =
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '';
    const userAgent = request.headers.get('user-agent') || '';

    const sessionId = cookies['_trk_sid'] || '';
    let sessao = {};
    if (sessionId && env.DB) {
      try {
        const linha = await env.DB.prepare(
          'SELECT * FROM sessions WHERE session_id = ?'
        ).bind(sessionId).first();
        if (linha) sessao = linha;
      } catch (e) {
        console.error('checkout-session: lookup falhou:', e.message);
      }
    }

    const fbp = validarCookieFb(cookies['_fbp']) || validarCookieFb(sessao.fbp) || '';
    const fbc = validarCookieFb(cookies['_fbc']) || validarCookieFb(sessao.fbc) || '';
    const externalId = cookies['_trk_eid'] || sessao.external_id || '';
    const gaClientId = clientIdGA4(cookies['_ga'] || '') || body.ga_client_id || '';

    // Identificador de clique: a sessao do middleware tem prioridade sobre o
    // que a pagina mandou.
    const gclid  = sessao.gclid  || body.gclid  || '';
    const wbraid = sessao.wbraid || body.wbraid || '';
    const gbraid = sessao.gbraid || body.gbraid || '';

    // UTM entra como CONJUNTO: ou a da sessao, ou a que a pagina mandou.
    // Misturar campo a campo de fontes diferentes cria uma origem que nunca
    // existiu no relatorio.
    const temUtmSessao = !!(sessao.utm_source || sessao.utm_medium || sessao.utm_campaign);
    const utm = temUtmSessao
      ? {
          source: sessao.utm_source || '', medium: sessao.utm_medium || '',
          campaign: sessao.utm_campaign || '', content: sessao.utm_content || '',
          term: sessao.utm_term || '',
        }
      : {
          source: body.utm_source || '', medium: body.utm_medium || '',
          campaign: body.utm_campaign || '', content: body.utm_content || '',
          term: body.utm_term || '',
        };

    if (env.DB) {
      // INSERT OR REPLACE: o visitante pode clicar em comprar varias vezes,
      // e vale a ultima intencao com o mesmo trk.
      await env.DB.prepare(`
        INSERT OR REPLACE INTO checkout_sessions (
          trk, session_id, ip_address, user_agent, external_id,
          fbp, fbc, gclid, wbraid, gbraid, ga_client_id,
          utm_source, utm_medium, utm_campaign, utm_content, utm_term,
          event_source_url, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        trk, sessionId, clientIp, userAgent, externalId,
        fbp, fbc, gclid, wbraid, gbraid, gaClientId,
        utm.source, utm.medium, utm.campaign, utm.content, utm.term,
        body.event_source_url || '', Math.floor(Date.now() / 1000)
      ).run();
    }

    return json({ ok: true, trk }, 200, CORS);

  } catch (err) {
    console.error('checkout-session: erro:', err.message);
    return json({ error: err.message }, 500, CORS);
  }
}
