// POST /tracker: a API de conversoes do seu dominio.
//
// Recebe o evento que o navegador disparou, recupera os identificadores que
// o middleware ja tinha capturado, faz hash do dado pessoal, dispara Meta
// CAPI e GA4 em paralelo e registra tudo com a resposta crua.
//
// O pixel do navegador dispara o mesmo evento com o MESMO event_id: e o que
// evita contagem dobrada.
//
// Instalar em: functions/tracker.js

import {
  sha256, emailMeta, telefoneMeta, nomePessoa,
  lerCookies, validarCookieFb, clientIdGA4, sessionIdGA4,
  detectarRobo, lerNavegador,
  enviarMeta, enviarGA4, lerResultado, json,
} from './_tracking-lib.js';

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
    const dados = body.user_data || {};

    const clientIp =
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || '';
    const userAgent = request.headers.get('user-agent') || '';
    const cookies = lerCookies(request.headers.get('Cookie') || '');

    // --- Recupera a sessao gravada pelo middleware -------------------------
    const sessionId = cookies['_trk_sid'] || '';
    let sessao = {};
    if (sessionId && env.DB) {
      try {
        const linha = await env.DB.prepare(
          'SELECT * FROM sessions WHERE session_id = ?'
        ).bind(sessionId).first();
        if (linha) sessao = linha;
      } catch (e) {
        console.error('tracker: lookup de sessao falhou:', e.message);
      }
    }

    // --- Precedencia dos identificadores ----------------------------------
    // Cookie HTTP (escrito pelo servidor) primeiro, sessao em segundo, corpo
    // do POST por ultimo: o corpo pode ter sido mexido por extensao.
    const fbp = validarCookieFb(cookies['_fbp']) || validarCookieFb(sessao.fbp) || validarCookieFb(dados.fbp) || '';
    const fbc = validarCookieFb(cookies['_fbc']) || validarCookieFb(sessao.fbc) || validarCookieFb(dados.fbc) || '';
    const externalId = cookies['_trk_eid'] || sessao.external_id || dados.external_id || '';

    // De onde veio cada identificador: e a metrica que mostra quanto do
    // publico bloqueia o pixel.
    const origemFbp = dados.fbp ? 'pixel_js' : (cookies['_fbp'] ? 'cookie_http' : (sessao.fbp ? 'sessao' : 'nenhum'));
    const origemFbc = cookies['_fbc'] ? 'cookie_http' : (sessao.fbc ? 'sessao' : (dados.fbc ? 'pixel_js' : 'nenhum'));
    const pixelBloqueado = (!dados.fbp && !dados.fbc) ? 1 : 0;

    // --- GA4: so leitura do cookie, nunca escrita -------------------------
    const cidDoCookie = clientIdGA4(cookies['_ga'] || '');
    const gaClientId = cidDoCookie || dados.ga_client_id ||
      `${Math.floor(Math.random() * 1000000000)}.${Math.floor(Date.now() / 1000)}`;
    const gaFallback = (!cidDoCookie && !dados.ga_client_id) ? 1 : 0;
    const gaSessionId = sessionIdGA4(cookies);

    // --- Hash do dado pessoal ---------------------------------------------
    const emailCru = dados.em || '';
    const [hEmail, hNome, hSobrenome, hTelefone, hExternalId] = await Promise.all([
      sha256(emailMeta(emailCru)),
      sha256(nomePessoa(dados.fn)),
      sha256(nomePessoa(dados.ln)),
      sha256(telefoneMeta(dados.ph, env.DEFAULT_COUNTRY_CODE)),
      sha256(String(externalId || '').toLowerCase()),
    ]);

    const { ehRobo, motivo } = detectarRobo(userAgent);

    // --- Monta o user_data do Meta ----------------------------------------
    const userDataMeta = { client_ip_address: clientIp, client_user_agent: userAgent };
    if (hEmail)      userDataMeta.em = [hEmail];
    if (hNome)       userDataMeta.fn = [hNome];
    if (hSobrenome)  userDataMeta.ln = [hSobrenome];
    if (hTelefone)   userDataMeta.ph = [hTelefone];
    if (hExternalId) userDataMeta.external_id = [hExternalId];
    if (fbp) userDataMeta.fbp = fbp;   // sem hash, de proposito
    if (fbc) userDataMeta.fbc = fbc;   // sem hash, de proposito

    // --- Dispara (robo nao gasta evento) ----------------------------------
    // allSettled: plataforma fora do ar nao impede a outra de receber.
    const eventTime = Number(body.event_time) || Math.floor(Date.now() / 1000);
    const nomeEvento = body.event_name || 'Lead';
    const ehPageView = ['pageview', 'page_view'].includes(String(nomeEvento).toLowerCase());

    const resultados = ehRobo ? [] : await Promise.allSettled([
      enviarMeta({
        env,
        eventName: nomeEvento,
        eventTime,
        eventId: body.event_id,
        eventSourceUrl: body.event_source_url || '',
        actionSource: 'website',
        userData: userDataMeta,
        customData: body.custom_data || {},
      }),
      // PageView nao vai para o GA4: a tag da pagina ja manda, e enviar
      // pelos dois lados dobra a sessao no relatorio.
      ehPageView
        ? Promise.resolve({ skipped: 'pageview nao vai para o GA4', payload: null, response: null })
        : enviarGA4({
            env,
            eventName: nomeEvento,
            clientId: gaClientId,
            sessionId: gaSessionId,
            timestampSegundos: eventTime,
            params: {
              page_location: body.event_source_url || '',
              ...(body.custom_data?.value ? { value: body.custom_data.value } : {}),
              ...(body.custom_data?.currency ? { currency: body.custom_data.currency } : {}),
            },
          }),
    ]);

    const meta = await lerResultado(resultados[0]);
    const ga4  = await lerResultado(resultados[1]);

    // --- Registro ---------------------------------------------------------
    // PageView NAO vira linha: ele e cerca de 70% do volume de escrita e
    // nenhum relatorio de conversao usa. O evento continua saindo para as
    // plataformas, so nao e gravado.
    if (env.DB && !ehPageView) {
      const nav = lerNavegador(userAgent);
      context.waitUntil((async () => {
        try {
          await env.DB.prepare(`
            INSERT INTO event_log (
              session_id, event_name, event_id, timestamp,
              browser, os, is_mobile,
              pixel_was_blocked, fbp_source, fbc_source,
              ga_cookie_present, ga_client_id_fallback,
              is_bot, bot_reason, consent_status,
              meta_status_code, meta_response_ok, meta_response_body, meta_payload_sent,
              ga4_status_code, ga4_response_ok, ga4_response_body, ga4_payload_sent,
              has_email, has_phone, has_name,
              raw_email, ga_client_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            sessionId, nomeEvento, body.event_id || '', eventTime,
            nav.browser, nav.os, nav.isMobile ? 1 : 0,
            pixelBloqueado, origemFbp, origemFbc,
            cookies['_ga'] ? 1 : 0, gaFallback,
            ehRobo ? 1 : 0, motivo,
            // Preencha com o estado real do consentimento. Ver
            // references/privacidade.md.
            body.consent_status || 'desconhecido',
            meta.status, meta.ok, meta.body, meta.payload,
            ga4.status, ga4.ok, ga4.body, ga4.payload,
            hEmail ? 1 : 0, hTelefone ? 1 : 0, (hNome || hSobrenome) ? 1 : 0,
            emailCru, gaClientId
          ).run();
        } catch (e) {
          console.error('tracker: erro ao gravar event_log:', e.message);
        }
      })());
    }

    // Responde ok mesmo com falha de plataforma: o formulario do visitante
    // nunca pode travar por causa do tracking.
    return json({ ok: true, bot: ehRobo }, 200, CORS);

  } catch (err) {
    console.error('tracker: erro inesperado:', err.message);
    return json({ error: err.message }, 500, CORS);
  }
}
