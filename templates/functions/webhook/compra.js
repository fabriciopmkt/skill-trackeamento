// Webhook de compra do checkout externo.
//
// Instalar em: functions/webhook/<plataforma>/[slug].js
//   O nome do arquivo entre colchetes e o que captura o segredo da URL.
//   A rota final fica: POST /webhook/<plataforma>/<uuid-secreto>
//   Guarde o uuid na variavel de ambiente WEBHOOK_SLUG e cole a URL
//   completa no painel da plataforma. Slug errado responde 404.
//
// Um arquivo por plataforma. A unica parte que muda entre elas e a funcao
// mapearPayload: copie este arquivo e reescreva so ela. Nao coloque
// condicional de plataforma no meio do fluxo comum.
//
// Ver: references/checkout-externo.md

// O caminho do import conta dois niveis acima porque o arquivo instalado
// fica em functions/webhook/<plataforma>/[slug].js. Se voce instalar em
// functions/webhook/[slug].js, troque para '../_tracking-lib.js'.
import {
  sha256, emailMeta, emailGoogle, telefoneMeta, telefoneGoogle, nomePessoa,
  enviarMeta, enviarGA4, enviarGoogle, lerResultado, comparacaoSegura, json,
} from '../../_tracking-lib.js';

// ---------------------------------------------------------------------------
// ADAPTADOR: a unica parte especifica da plataforma
// ---------------------------------------------------------------------------
// Devolva sempre esta forma. Descubra os nomes reais dos campos olhando a
// tabela webhook_raw_log depois de uma compra de teste: eles raramente batem
// com a documentacao.
function mapearPayload(p) {
  return {
    transactionId: String(p.transaction_id ?? p.transaction ?? p.order_id ?? ''),
    status: String(p.status ?? p.order_status ?? '').toLowerCase(),
    // O trk que a pagina de venda passou no campo livre do checkout.
    // Cada plataforma usa um nome: xcod, sck, tracker.code1, metadata...
    trk: String(p.trk ?? p.sck ?? p.xcod ?? p.tracker?.code1 ?? ''),
    // Prefira o valor BRUTO, para casar com o relatorio de vendas.
    valor: Number(p.value ?? p.price ?? p.amount ?? 0),
    moeda: String(p.currency ?? 'BRL').toUpperCase(),
    produtoId: String(p.product_id ?? p.product?.id ?? ''),
    produtoNome: String(p.product_name ?? p.product?.name ?? ''),
    email: String(p.buyer_email ?? p.customer?.email ?? p.email ?? ''),
    telefone: String(p.buyer_phone ?? p.customer?.phone ?? p.phone ?? ''),
    nome: String(p.buyer_name ?? p.customer?.name ?? p.name ?? ''),
    // Horario do fato, em segundos. Sem ele, usa agora.
    quando: Number(p.paid_at ?? p.created_at ?? 0) || Math.floor(Date.now() / 1000),
  };
}

// Status que contam como venda. Todo o resto e registrado e descartado:
// boleto gerado, carrinho abandonado e assinatura cancelada chegam pela
// mesma URL, e disparar Purchase neles infla a receita do gerenciador.
const STATUS_PAGO = new Set(['paid', 'approved', 'completed', 'pago', 'aprovado']);

// ---------------------------------------------------------------------------

export async function onRequestPost(context) {
  const { request, env, params } = context;
  const plataforma = 'checkout'; // troque pelo nome da plataforma

  // --- Porta: slug secreto na URL ----------------------------------------
  // Variavel ausente e 500, nunca aceite silencioso: webhook que aceita
  // qualquer corpo porque o segredo nao foi configurado e porta aberta para
  // conversao falsa.
  if (!env.WEBHOOK_SLUG) {
    console.error('webhook: WEBHOOK_SLUG nao configurada');
    return json({ error: 'nao configurado' }, 500);
  }
  if (!comparacaoSegura(params.slug, env.WEBHOOK_SLUG)) {
    // 404, nao 401: indistinguivel de rota inexistente.
    return new Response('Not found', { status: 404 });
  }

  // --- Corpo cru primeiro -------------------------------------------------
  const textoCru = await request.text();
  let payload = null;
  let erroParse = '';
  try {
    payload = JSON.parse(protegerIdsGrandes(textoCru));
  } catch (e) {
    erroParse = e.message;
  }

  const mapeado = payload ? mapearPayload(payload) : null;

  // Grava TODO POST que passou a porta, antes de qualquer filtro. Serve para
  // descobrir os nomes reais dos campos, reprocessar venda a mao e provar o
  // que chegou. Contem dado pessoal: nunca exponha em endpoint de leitura.
  const registrarCru = (desfecho) => {
    if (!env.DB) return Promise.resolve();
    return env.DB.prepare(`
      INSERT INTO webhook_raw_log (platform, received_at, body, body_keys, status, transaction_id, outcome)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      plataforma, Math.floor(Date.now() / 1000),
      textoCru.slice(0, 20000),
      payload ? Object.keys(payload).join(',') : '',
      mapeado?.status || '', mapeado?.transactionId || '', desfecho
    ).run().catch((e) => console.error('webhook: log cru falhou:', e.message));
  };

  if (!payload) {
    await registrarCru(`erro: json invalido (${erroParse})`);
    return json({ error: 'json invalido' }, 400);
  }
  if (!mapeado.transactionId) {
    await registrarCru('erro: sem id de transacao');
    return json({ error: 'sem id de transacao' }, 400);
  }
  if (!STATUS_PAGO.has(mapeado.status)) {
    await registrarCru(`ignorado: status ${mapeado.status}`);
    // 200 de proposito: a plataforma nao deve tentar de novo.
    return json({ ok: true, ignorado: `status ${mapeado.status}` });
  }

  // --- Recupera a atribuicao pelo trk ------------------------------------
  let atrib = {};
  if (mapeado.trk && env.DB) {
    try {
      const linha = await env.DB.prepare(
        'SELECT * FROM checkout_sessions WHERE trk = ?'
      ).bind(mapeado.trk).first();
      if (linha) atrib = linha;
    } catch (e) {
      console.error('webhook: lookup do trk falhou:', e.message);
    }
  }

  // --- Hash ---------------------------------------------------------------
  const [hEmailMeta, hEmailGoogle, hTelMeta, hTelGoogle, hNome] = await Promise.all([
    sha256(emailMeta(mapeado.email)),
    sha256(emailGoogle(mapeado.email)),
    sha256(telefoneMeta(mapeado.telefone, env.DEFAULT_COUNTRY_CODE)),
    sha256(telefoneGoogle(mapeado.telefone, env.DEFAULT_COUNTRY_CODE)),
    sha256(nomePessoa(mapeado.nome.split(' ')[0])),
  ]);

  // event_id deterministico: reentrega da plataforma dedupe no Meta.
  const eventId = `compra-${mapeado.transactionId}`;

  const userDataMeta = {};
  if (hEmailMeta) userDataMeta.em = [hEmailMeta];
  if (hTelMeta)   userDataMeta.ph = [hTelMeta];
  if (hNome)      userDataMeta.fn = [hNome];
  if (atrib.fbp) userDataMeta.fbp = atrib.fbp;
  if (atrib.fbc) userDataMeta.fbc = atrib.fbc;
  if (atrib.external_id) userDataMeta.external_id = [await sha256(String(atrib.external_id).toLowerCase())];
  if (atrib.ip_address) userDataMeta.client_ip_address = atrib.ip_address;
  if (atrib.user_agent) userDataMeta.client_user_agent = atrib.user_agent;

  // --- Dispara para as tres plataformas ---------------------------------
  const resultados = await Promise.allSettled([
    enviarMeta({
      env,
      eventName: 'Purchase',
      eventTime: mapeado.quando,
      eventId,
      eventSourceUrl: atrib.event_source_url || '',
      // A compra aconteceu fora da sua pagina, sem o visitante presente no
      // seu dominio: o action_source certo e system_generated.
      actionSource: 'system_generated',
      userData: userDataMeta,
      customData: {
        value: mapeado.valor,
        currency: mapeado.moeda,
        ...(mapeado.produtoId ? { content_ids: [mapeado.produtoId], content_type: 'product' } : {}),
        ...(mapeado.produtoNome ? { content_name: mapeado.produtoNome } : {}),
      },
    }),
    enviarGA4({
      env,
      eventName: 'purchase',
      clientId: atrib.ga_client_id || '',
      timestampSegundos: mapeado.quando,
      params: {
        transaction_id: mapeado.transactionId,
        value: mapeado.valor,
        currency: mapeado.moeda,
        ...(mapeado.produtoNome ? { items: [{ item_id: mapeado.produtoId, item_name: mapeado.produtoNome }] } : {}),
      },
    }),
    enviarGoogle({
      env,
      clickIds: { gclid: atrib.gclid || '', wbraid: atrib.wbraid || '', gbraid: atrib.gbraid || '' },
      hashedEmail: hEmailGoogle,
      hashedPhone: hTelGoogle,
      eventTimeSegundos: mapeado.quando,
      transactionId: eventId,
      valor: mapeado.valor,
      moeda: mapeado.moeda,
      eventSource: 'WEB',
    }),
  ]);

  const meta   = await lerResultado(resultados[0]);
  const ga4    = await lerResultado(resultados[1]);
  const google = await lerResultado(resultados[2]);

  // --- Grava a compra ----------------------------------------------------
  // O indice unico em transaction_id protege contra reentrega: a segunda
  // tentativa falha no INSERT e isso e o resultado esperado.
  let gravou = true;
  if (env.DB) {
    try {
      await env.DB.prepare(`
        INSERT INTO purchase_log (
          transaction_id, platform, event_id, event_type,
          product_id, product_name, value, currency, status,
          trk, session_id, fbp, fbc, gclid, ga_client_id,
          utm_source, utm_medium, utm_campaign, utm_content, utm_term,
          meta_status_code, meta_response_ok, meta_response_body,
          ga4_status_code, ga4_response_ok, ga4_response_body,
          google_status_code, google_response_ok, google_response_body,
          raw_email, raw_phone, raw_name, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        mapeado.transactionId, plataforma, eventId, 'purchase',
        mapeado.produtoId, mapeado.produtoNome, mapeado.valor, mapeado.moeda, mapeado.status,
        mapeado.trk, atrib.session_id || '', atrib.fbp || '', atrib.fbc || '',
        atrib.gclid || '', atrib.ga_client_id || '',
        atrib.utm_source || '', atrib.utm_medium || '', atrib.utm_campaign || '',
        atrib.utm_content || '', atrib.utm_term || '',
        meta.status, meta.ok, meta.body,
        ga4.status, ga4.ok, ga4.body,
        google.status, google.ok, google.body,
        mapeado.email, mapeado.telefone, mapeado.nome,
        Math.floor(Date.now() / 1000)
      ).run();
    } catch (e) {
      gravou = false;
      // Erro de unicidade quer dizer reentrega: nao e problema.
      console.error('webhook: insert de compra falhou:', e.message);
    }
  }

  await registrarCru(gravou ? `processado: ${eventId}` : `duplicado ou erro: ${eventId}`);

  // 200 mesmo com falha de plataforma: so 5xx faz a plataforma reentregar, e
  // reentregar nao conserta credencial errada.
  return json({
    ok: true,
    transaction_id: mapeado.transactionId,
    atribuicao: mapeado.trk ? (atrib.trk ? 'recuperada' : 'trk sem sessao') : 'sem trk',
    entrega: { meta: meta.status, ga4: ga4.status, google: google.status },
  });
}

// Ids de transacao e de anuncio passam de 16 digitos, acima do inteiro
// seguro do JavaScript. Sem aspas no JSON, o JSON.parse arredonda e o id
// gravado fica errado. Isto poe as aspas antes de interpretar.
function protegerIdsGrandes(texto) {
  return String(texto || '').replace(/:(\s*)(\d{16,})(\s*[,}])/g, ':$1"$2"$3');
}
