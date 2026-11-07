// POST /api/conversao-crm: recebe do CRM os eventos de fundo de funil e
// devolve a conversao para as plataformas de anuncio.
//
// Quem chama: o seu CRM (ou um cron que le o CRM). Ele manda os FATOS
// (quem avancou de etapa e quando) e controla a idempotencia. Este endpoint
// tem as credenciais, resolve a identidade e envia. Essa divisao evita
// duplicar segredo em dois sistemas.
//
// Body:
//   {
//     "eventos": [
//       { "registro_id": "42", "evento": "lead_qualificado",
//         "email": "pessoa@exemplo.com", "telefone": "11987654321",
//         "aconteceu_em": 1762500000, "valor": 0 }
//     ],
//     "dry_run": true,        // resolve identidade e NAO envia nem grava
//     "validate_only": false  // envia ao Google com validateOnly
//   }
//
// Instalar em: functions/api/conversao-crm.js
// Ver: references/evento-do-crm.md

import {
  sha256, emailMeta, emailGoogle, telefoneMeta, telefoneGoogle,
  enviarMeta, enviarGA4, enviarGoogle, lerResultado, comparacaoSegura, json,
} from '../_tracking-lib.js';

// ---------------------------------------------------------------------------
// Mapeamento de evento: o nome no seu funil vira o nome de cada plataforma.
//
// No Meta, prefira evento PADRAO: ele otimiza melhor em evento que ja sabe
// interpretar. Renomeie o rotulo na interface em vez de criar evento
// customizado. "Schedule" descreve bem uma reuniao ou apresentacao marcada.
//
// `acao` e o id da acao de conversao do Google Ads para aquele evento.
// Cada evento merece a sua acao, com a categoria certa (Lead qualificado,
// Compra). Variavel de ambiente por evento mantem o id fora do codigo.
// ---------------------------------------------------------------------------
const EVENTOS = {
  lead_qualificado: {
    meta: 'Schedule',
    ga4: 'lead_qualificado',
    acao: (env) => env.GOOGLE_ACAO_LEAD_QUALIFICADO,
  },
  reuniao_realizada: {
    meta: 'Schedule',
    ga4: 'reuniao_realizada',
    acao: (env) => env.GOOGLE_ACAO_REUNIAO,
  },
  contrato_fechado: {
    meta: 'Purchase',
    ga4: 'purchase',
    acao: (env) => env.GOOGLE_ACAO_CONTRATO,
  },
};

// Meta recusa evento com mais de 7 dias. GA4 descarta calado (com 204)
// acima de 72 h. O Google aceita dentro da janela de conversao da acao,
// de 30 a 90 dias: e o destino que aguenta o evento mais antigo.
const LIMITE_META_S = 7 * 24 * 3600;
const LIMITE_GA4_S  = 3 * 24 * 3600;

const resumir = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number') return String(v).slice(0, 200);
  return JSON.stringify(v).slice(0, 200);
};

export async function onRequestPost(context) {
  const { request, env } = context;

  // --- Porta: segredo proprio, separado dos outros -----------------------
  // Senha propria de proposito: trocar a senha deste endpoint nao pode
  // derrubar o webhook de compra nem o painel.
  if (!env.CRM_SECRET) return json({ error: 'nao configurado' }, 500);
  if (!comparacaoSegura(request.headers.get('x-crm-secret') || '', env.CRM_SECRET)) {
    return json({ error: 'nao autorizado' }, 401);
  }
  if (!env.DB) return json({ error: 'banco nao conectado' }, 500);

  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'json invalido' }, 400); }

  const eventos = Array.isArray(body?.eventos) ? body.eventos : [];
  const dryRun = body?.dry_run === true;
  const validateOnly = !dryRun && body?.validate_only === true;

  if (eventos.length === 0) return json({ ok: true, dry_run: dryRun, resultados: [] });
  if (eventos.length > 200) return json({ error: 'lote grande demais (maximo 200)' }, 400);

  const agora = Math.floor(Date.now() / 1000);
  const resultados = [];
  const paraGravar = [];

  for (const e of eventos) {
    const registroId = String(e?.registro_id || '');
    const email = String(e?.email || '').trim().toLowerCase();
    const nomeEvento = String(e?.evento || 'lead_qualificado');
    // Horario do FATO, nunca o do envio. Horario errado joga a conversao
    // para fora da janela de atribuicao do clique.
    const quando = Number(e?.aconteceu_em) || agora;
    const idade = agora - quando;

    const item = {
      registro_id: registroId,
      evento: nomeEvento,
      casou: false,
      identificadores: { gclid: false, fbc: false, fbp: false, ga_client_id: false },
      destinos: {},
    };

    const config = EVENTOS[nomeEvento];
    if (!config) { item.erro = `evento desconhecido: ${nomeEvento}`; resultados.push(item); continue; }
    if (!registroId || !email) { item.erro = 'registro sem id ou sem email'; resultados.push(item); continue; }

    // --- Reconecta a pessoa a visita que gerou o lead --------------------
    // O evento de Lead mais recente daquele e-mail traz o session_id e o
    // client_id do GA4. O mais recente, nao o primeiro: quem preencheu duas
    // vezes tem a ultima visita como a que a plataforma ainda atribui.
    let ev = null;
    let sessao = null;
    try {
      ev = await env.DB.prepare(`
        SELECT session_id, ga_client_id, timestamp
          FROM event_log
         WHERE LOWER(TRIM(raw_email)) = ?
           AND event_name IN ('Lead', 'lead')
         ORDER BY timestamp DESC
         LIMIT 1
      `).bind(email).first();

      if (ev?.session_id) {
        sessao = await env.DB.prepare(`
          SELECT gclid, wbraid, gbraid, fbc, fbp, ip_address, user_agent, landing_url
            FROM sessions WHERE session_id = ?
        `).bind(ev.session_id).first();
      }
    } catch (err) {
      item.erro = `lookup falhou: ${err.message}`;
      resultados.push(item);
      continue;
    }

    if (!ev) {
      // Lead que entrou por fora das paginas rastreadas (telefone,
      // indicacao, base antiga). Nao e defeito: e o teto natural de quem
      // veio de midia rastreavel.
      item.motivo = 'email nao encontrado no tracking';
      resultados.push(item);
      continue;
    }

    item.casou = true;
    const gclid = sessao?.gclid || '';
    const fbc = sessao?.fbc || '';
    const fbp = sessao?.fbp || '';
    const gaClientId = ev.ga_client_id || '';
    item.identificadores = { gclid: !!gclid, fbc: !!fbc, fbp: !!fbp, ga_client_id: !!gaClientId };

    // --- Simulacao: mede a taxa de match sem poluir plataforma ----------
    if (dryRun) {
      item.destinos = {
        meta: idade > LIMITE_META_S ? 'pularia: mais de 7 dias'
          : !env.META_ACCESS_TOKEN ? 'pularia: sem credencial' : 'enviaria',
        ga4: !gaClientId ? 'pularia: sem client_id'
          : idade > LIMITE_GA4_S ? 'pularia: mais de 72 h' : 'enviaria',
        google: !gclid ? 'pularia: sem gclid (cairia em dado pessoal)'
          : !config.acao(env) ? 'pularia: acao de conversao nao configurada' : 'enviaria',
      };
      resultados.push(item);
      continue;
    }

    const [hEmailMeta, hEmailGoogle, hTelMeta, hTelGoogle] = await Promise.all([
      sha256(emailMeta(email)),
      sha256(emailGoogle(email)),
      sha256(telefoneMeta(e?.telefone, env.DEFAULT_COUNTRY_CODE)),
      sha256(telefoneGoogle(e?.telefone, env.DEFAULT_COUNTRY_CODE)),
    ]);

    // Chave deterministica: reenvio do mesmo registro dedupe no Meta (48 h)
    // e no Google (transactionId). E o que limita o estrago quando o envio
    // funciona e a gravacao falha.
    const chave = `${nomeEvento}-${registroId}`;

    const userDataMeta = {};
    if (hEmailMeta) userDataMeta.em = [hEmailMeta];
    if (hTelMeta) userDataMeta.ph = [hTelMeta];
    if (fbc) userDataMeta.fbc = fbc;
    if (fbp) userDataMeta.fbp = fbp;
    if (sessao?.ip_address) userDataMeta.client_ip_address = sessao.ip_address;
    if (sessao?.user_agent) userDataMeta.client_user_agent = sessao.user_agent;

    const envios = [];

    // --- Meta -----------------------------------------------------------
    if (validateOnly) {
      item.destinos.meta = 'ignorado: validate_only';
      envios.push(Promise.resolve(null));
    } else if (idade > LIMITE_META_S) {
      item.destinos.meta = 'ignorado: evento com mais de 7 dias';
      envios.push(Promise.resolve(null));
    } else {
      envios.push(enviarMeta({
        env,
        eventName: config.meta,
        eventTime: quando,
        eventId: chave,
        // O visitante nao esta presente: o evento nasceu no seu sistema.
        actionSource: 'system_generated',
        userData: userDataMeta,
        customData: e?.valor ? { value: Number(e.valor), currency: e?.moeda || env.DEFAULT_CURRENCY || 'BRL' } : {},
      }));
    }

    // --- GA4 ------------------------------------------------------------
    if (validateOnly || !gaClientId || idade > LIMITE_GA4_S) {
      item.destinos.ga4 = validateOnly ? 'ignorado: validate_only'
        : !gaClientId ? 'ignorado: sem client_id' : 'ignorado: evento com mais de 72 h';
      envios.push(Promise.resolve(null));
    } else {
      envios.push(enviarGA4({
        env,
        eventName: config.ga4,
        clientId: gaClientId,
        timestampSegundos: quando,
        params: {
          ...(e?.valor ? { value: Number(e.valor), currency: e?.moeda || 'BRL' } : {}),
          registro_id: registroId,
        },
      }));
    }

    // --- Google ---------------------------------------------------------
    // Sem gclid, o envio vai com dado pessoal e o Google casa pelo e-mail
    // (o caminho de enhanced conversions for leads). Exige aceitar os termos
    // de dados do cliente na conta de anuncio.
    envios.push(enviarGoogle({
      env,
      conversionActionId: config.acao(env),
      clickIds: { gclid, wbraid: sessao?.wbraid || '', gbraid: sessao?.gbraid || '' },
      hashedEmail: hEmailGoogle,
      hashedPhone: hTelGoogle,
      eventTimeSegundos: quando,
      transactionId: chave,
      valor: e?.valor || 0,
      moeda: e?.moeda || env.DEFAULT_CURRENCY || 'BRL',
      // O fato nasceu no seu sistema, nao numa pagina.
      eventSource: 'CRM',
      validateOnly,
    }));

    const r = await Promise.allSettled(envios);
    const meta = r[0]?.value === null ? null : await lerResultado(r[0]);
    const ga4 = r[1]?.value === null ? null : await lerResultado(r[1]);
    const google = await lerResultado(r[2]);

    if (meta) item.destinos.meta = { status: meta.status, ok: meta.ok, body: meta.body.slice(0, 200) };
    if (ga4) item.destinos.ga4 = { status: ga4.status, ok: ga4.ok };
    item.destinos.google = {
      status: google.status, ok: google.ok,
      body: validateOnly ? google.body : google.body.slice(0, 300),
    };

    paraGravar.push(env.DB.prepare(`
      INSERT INTO envio_crm (
        registro_id, evento, aconteceu_em, enviado_em, casou,
        tinha_gclid, tinha_fbc, tinha_ga_cid,
        meta_status, ga4_status, google_status, detalhe
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(registro_id) DO NOTHING
    `).bind(
      registroId, nomeEvento, quando, agora, 1,
      gclid ? 1 : 0, fbc ? 1 : 0, gaClientId ? 1 : 0,
      resumir(item.destinos.meta), resumir(item.destinos.ga4), resumir(item.destinos.google),
      JSON.stringify(item).slice(0, 1000)
    ));

    resultados.push(item);
  }

  // Grava o que foi enviado. Falha aqui no pior caso gera reenvio no proximo
  // ciclo, e a chave deterministica faz as plataformas descartarem.
  if (!dryRun && !validateOnly && paraGravar.length) {
    try {
      await env.DB.batch(paraGravar);
    } catch (err) {
      return json({
        ok: false,
        error: `envio feito mas gravacao falhou: ${err.message}`,
        enviados: resultados.length,
        resultados,
      }, 500);
    }
  }

  const casados = resultados.filter((r) => r.casou).length;
  return json({
    ok: true,
    dry_run: dryRun,
    ...(validateOnly ? { validate_only: true } : {}),
    recebidos: eventos.length,
    casados,
    taxa_match: eventos.length ? Math.round((casados / eventos.length) * 100) : 0,
    resultados,
  });
}
