// Funcoes compartilhadas por tracker.js, webhook/compra.js e
// api/conversao-crm.js. Arquivo com _ no nome nao vira rota no Pages.
//
// Instalar em: functions/_tracking-lib.js

// ---------------------------------------------------------------------------
// Hash
// ---------------------------------------------------------------------------

// SHA-256 em hexadecimal minusculo. E o formato que Meta e Google aceitam.
// Recebe o valor JA normalizado: normalizar aqui esconderia a diferenca
// entre o que cada plataforma espera.
export async function sha256(valor) {
  if (!valor) return '';
  const bytes = new TextEncoder().encode(String(valor));
  const buffer = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Normalizacao: cada plataforma pede uma coisa diferente.
// Ver references/meta.md e references/google-conversoes.md.
// ---------------------------------------------------------------------------

// Meta: minusculas e sem espaco nas pontas. Nada mais.
// NAO remova ponto nem +sufixo: o Meta guarda o hash do e-mail como veio.
export function emailMeta(email) {
  return String(email || '').trim().toLowerCase();
}

// Google: minusculas, sem nenhum espaco e, somente em gmail.com e
// googlemail.com, sem os pontos do nome e sem o +sufixo.
export function emailGoogle(email) {
  const e = String(email || '').toLowerCase().replace(/\s+/g, '');
  const at = e.lastIndexOf('@');
  if (at < 1) return e;
  const dominio = e.slice(at + 1);
  let local = e.slice(0, at);
  if (dominio === 'gmail.com' || dominio === 'googlemail.com') {
    local = local.split('+')[0].replace(/\./g, '');
  }
  return `${local}@${dominio}`;
}

// Meta: so digitos, COM codigo do pais e DDD (ex.: 5511987654321).
// Quem preenche formulario quase nunca escreve o codigo do pais, por isso o
// prefixo. A deteccao e por comprimento e e aproximada: publico com varios
// paises misturados perde alguns matches, e resolver isso de verdade pediria
// uma biblioteca de telefone pesada demais para a borda.
export function telefoneMeta(telefone, codigoPais) {
  if (!telefone) return '';
  const cc = String(codigoPais || '55');
  const digitos = String(telefone).replace(/\D/g, '').replace(/^0+/, '');
  if (!digitos) return '';
  // Ja comeca com o codigo do pais num comprimento plausivel: deixa como esta.
  if (digitos.startsWith(cc) && digitos.length >= cc.length + 8 && digitos.length <= cc.length + 11) {
    return digitos;
  }
  // Comprimento de numero local: prefixa o pais.
  if (digitos.length >= 8 && digitos.length <= 11) return cc + digitos;
  // Qualquer outro comprimento: provavelmente numero internacional de outro
  // pais. Deixa intacto.
  return digitos;
}

// Google: E.164, com o + na frente, antes do hash.
export function telefoneGoogle(telefone, codigoPais) {
  const digitos = telefoneMeta(telefone, codigoPais);
  return digitos ? `+${digitos}` : '';
}

// Meta: minusculas, mantendo acento, apostrofo e hifen. Tirar acento de
// "Joao" para "normalizar" derruba o match de boa parte da base brasileira.
export function nomePessoa(nome) {
  return String(nome || '').trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Cookies e identificadores
// ---------------------------------------------------------------------------

export function lerCookies(cabecalho) {
  const out = {};
  String(cabecalho || '').split(';').forEach((c) => {
    const [nome, ...resto] = c.trim().split('=');
    if (nome) out[nome.trim()] = resto.join('=');
  });
  return out;
}

// Rejeita valor que nao tem o formato fb.<index>.<ms>.<conteudo>.
// Cookie corrompido por extensao ou por copia manual de URL e comum, e o
// Meta descarta o evento inteiro quando o formato esta errado.
export function validarCookieFb(valor) {
  if (!valor) return '';
  const p = String(valor).split('.');
  if (p.length < 4 || p.length > 5) return '';
  if (p[0] !== 'fb') return '';
  if (!/^\d+$/.test(p[1]) || !/^\d+$/.test(p[2])) return '';
  if (!p[3]) return '';
  return valor;
}

// client_id do GA4 a partir do cookie _ga (formato GA1.1.<id>.<ts>):
// sao os dois ultimos segmentos.
export function clientIdGA4(cookieGa) {
  if (!cookieGa) return '';
  const p = String(cookieGa).split('.');
  return p.length >= 4 ? `${p[2]}.${p[3]}` : '';
}

// session_id do GA4 a partir do cookie _ga_<ID_DO_FLUXO>. O formato mudou
// entre versoes da tag, por isso os dois caminhos. Opcional: sem ele o
// evento entra numa sessao nova.
export function sessionIdGA4(cookies) {
  for (const [nome, valor] of Object.entries(cookies || {})) {
    if (!nome.startsWith('_ga_') || nome === '_ga' || !valor) continue;
    if (valor.startsWith('GS2')) {
      const corpo = valor.split('.').slice(2).join('.');
      for (const parte of corpo.split('$')) {
        if (parte.startsWith('s') && /^\d+$/.test(parte.slice(1))) return parte.slice(1);
      }
    } else {
      const p = valor.split('.');
      if (p.length >= 3 && /^\d+$/.test(p[2])) return p[2];
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Robo
// ---------------------------------------------------------------------------

// Previa de link do WhatsApp, crawler de rede social e verificador de uptime
// abrem a pagina de verdade e disparam PageView. Sem este filtro, cada link
// compartilhado queima evento de CAPI e suja o pixel.
// O evento do robo continua sendo registrado no banco (para a metrica de
// saude ficar honesta); so o envio as plataformas e suprimido.
export function detectarRobo(userAgent) {
  if (!userAgent || userAgent.length < 10) {
    return { ehRobo: true, motivo: 'user agent ausente ou curto' };
  }
  const padroes = [
    [/googlebot|google-inspectiontool/i, 'Googlebot'],
    [/bingbot|msnbot/i, 'Bingbot'],
    [/facebookexternalhit|facebot/i, 'crawler do Facebook'],
    [/twitterbot/i, 'crawler do X'],
    [/linkedinbot/i, 'crawler do LinkedIn'],
    [/slackbot/i, 'Slackbot'],
    [/whatsapp/i, 'previa do WhatsApp'],
    [/telegrambot/i, 'previa do Telegram'],
    [/discordbot/i, 'previa do Discord'],
    [/bot|crawler|spider|scraper|headless/i, 'robo genérico'],
    [/python-requests|axios|node-fetch|curl|wget|httpie|go-http-client/i, 'biblioteca HTTP'],
    [/phantomjs|selenium|puppeteer|playwright/i, 'automacao de navegador'],
    [/uptime|pingdom|monitis|statuscake/i, 'monitor de uptime'],
  ];
  for (const [padrao, motivo] of padroes) {
    if (padrao.test(userAgent)) return { ehRobo: true, motivo };
  }
  return { ehRobo: false, motivo: '' };
}

export function lerNavegador(ua) {
  const r = { browser: 'desconhecido', os: 'desconhecido', isMobile: false };
  if (!ua) return r;
  r.isMobile = /Mobile|Android|iPhone|iPad/i.test(ua);
  if (/Edg\//i.test(ua)) r.browser = 'Edge';
  else if (/OPR\//i.test(ua)) r.browser = 'Opera';
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) r.browser = 'Chrome';
  else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) r.browser = 'Safari';
  else if (/Firefox\//i.test(ua)) r.browser = 'Firefox';
  if (/Windows/i.test(ua)) r.os = 'Windows';
  else if (/iPhone|iPad/i.test(ua)) r.os = 'iOS';
  else if (/Mac OS X/i.test(ua)) r.os = 'macOS';
  else if (/Android/i.test(ua)) r.os = 'Android';
  else if (/Linux/i.test(ua)) r.os = 'Linux';
  return r;
}

// ---------------------------------------------------------------------------
// Envio: Meta CAPI
// ---------------------------------------------------------------------------

// Sempre devolve { payload, response, skipped } para o chamador registrar a
// resposta crua. Credencial faltando devolve skipped, nunca excecao: uma
// plataforma sem configurar nao pode derrubar as outras.
export async function enviarMeta({ env, eventName, eventTime, eventId, eventSourceUrl, actionSource, userData, customData }) {
  if (!env.META_PIXEL_ID || !env.META_ACCESS_TOKEN) {
    return { skipped: 'credencial do Meta ausente', payload: null, response: null };
  }

  const evento = {
    event_name: eventName,
    event_time: eventTime,
    event_id: eventId,
    action_source: actionSource || 'website',
    user_data: userData,
  };
  if (eventSourceUrl) evento.event_source_url = eventSourceUrl;
  if (customData && Object.keys(customData).length) evento.custom_data = customData;

  const corpo = { data: [evento], access_token: env.META_ACCESS_TOKEN };
  // Codigo de teste faz o evento aparecer na aba "Testar eventos" e NAO
  // contar para otimizacao. Tire a variavel quando terminar o teste.
  if (env.META_TEST_EVENT_CODE) corpo.test_event_code = env.META_TEST_EVENT_CODE;

  const payload = JSON.stringify(corpo);
  // Versao fixa na URL de proposito: chamada sem versao segue a corrente e
  // muda de comportamento sem aviso.
  const response = await fetch(`https://graph.facebook.com/v25.0/${env.META_PIXEL_ID}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  });
  // O token vai no corpo, nao na query: assim nao aparece em log de proxy.
  return { payload: payload.replace(env.META_ACCESS_TOKEN, '<token>'), response };
}

// ---------------------------------------------------------------------------
// Envio: GA4 Measurement Protocol
// ---------------------------------------------------------------------------

const NOME_GA4 = {
  lead: 'generate_lead',
  purchase: 'purchase',
  initiatecheckout: 'begin_checkout',
  completeregistration: 'sign_up',
};

export async function enviarGA4({ env, eventName, clientId, sessionId, timestampSegundos, params }) {
  if (!env.GA4_MEASUREMENT_ID || !env.GA4_API_SECRET) {
    return { skipped: 'credencial do GA4 ausente', payload: null, response: null };
  }
  if (!clientId) {
    return { skipped: 'sem client_id do GA4', payload: null, response: null };
  }

  const nome = NOME_GA4[String(eventName).toLowerCase()] || String(eventName).toLowerCase();

  const corpo = {
    client_id: clientId,
    events: [{
      name: nome,
      params: {
        // engagement_time_msec e session_id sao necessarios para o evento
        // aparecer nos relatorios padrao, nao so no tempo real.
        engagement_time_msec: 100,
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(params || {}),
      },
    }],
  };
  // Measurement Protocol aceita no maximo 72 h no passado. Mais velho, o
  // GA4 responde 204 e descarta calado.
  if (timestampSegundos) corpo.timestamp_micros = timestampSegundos * 1000000;

  const payload = JSON.stringify(corpo);
  const response = await fetch(
    `https://www.google-analytics.com/mp/collect?measurement_id=${env.GA4_MEASUREMENT_ID}&api_secret=${env.GA4_API_SECRET}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload }
  );
  // Atencao: este endpoint devolve 204 para tudo, inclusive payload errado.
  // Para validar de verdade use /debug/mp/collect (ver references/ga4.md).
  return { payload, response };
}

// ---------------------------------------------------------------------------
// Envio: Google (Data Manager API)
// ---------------------------------------------------------------------------

// Cache do access token no escopo do modulo: o isolate atende varias
// requisicoes e o refresh custa uma ida ao Google.
let cacheTokenGoogle = { token: null, expiraEm: 0 };

export async function tokenGoogle(env) {
  const agora = Math.floor(Date.now() / 1000);
  if (cacheTokenGoogle.token && cacheTokenGoogle.expiraEm > agora + 30) {
    return cacheTokenGoogle.token;
  }
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    return null;
  }

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
    }),
  });

  if (!r.ok) {
    // invalid_grant aqui quase sempre e o refresh token de 7 dias de app em
    // modo "Em teste". Ver references/google-cloud.md.
    console.error('Google OAuth falhou:', r.status, (await r.text().catch(() => '')).slice(0, 200));
    return null;
  }
  const data = await r.json().catch(() => ({}));
  if (!data.access_token) return null;

  cacheTokenGoogle = {
    token: data.access_token,
    expiraEm: agora + (data.expires_in || 3600) - 60,
  };
  return data.access_token;
}

const soDigitos = (v) => String(v || '').replace(/\D/g, '');

// Data Manager API: um endpoint para conversao de clique e de CRM.
// NAO tem falha parcial: um campo ruim derruba a chamada inteira, por isso
// um evento por chamada.
export async function enviarGoogle({ env, conversionActionId, clickIds, hashedEmail, hashedPhone, eventTimeSegundos, transactionId, valor, moeda, eventSource, validateOnly }) {
  const acao = conversionActionId || env.GOOGLE_ADS_CONVERSION_ACTION_ID;
  if (!acao || !env.GOOGLE_ADS_CUSTOMER_ID) {
    return { skipped: 'conta ou acao de conversao do Google ausente', payload: null, response: null };
  }

  const ids = clickIds || {};
  const temClique = ids.gclid || ids.wbraid || ids.gbraid;
  // Sem identificador de clique e sem dado pessoal, o Google nao tem como
  // casar nada: nao vale gastar a chamada.
  if (!temClique && !hashedEmail && !hashedPhone) {
    return { skipped: 'sem identificador de clique e sem dado para casar', payload: null, response: null };
  }

  const token = await tokenGoogle(env);
  if (!token) return { skipped: 'OAuth do Google indisponivel', payload: null, response: null };

  const identificadores = [];
  if (hashedEmail) identificadores.push({ emailAddress: hashedEmail });
  if (hashedPhone) identificadores.push({ phoneNumber: hashedPhone });

  const evento = {
    eventTimestamp: new Date((eventTimeSegundos || Math.floor(Date.now() / 1000)) * 1000)
      .toISOString().replace(/\.\d{3}Z$/, 'Z'),
    eventSource: eventSource || 'WEB',
    ...(transactionId ? { transactionId: String(transactionId) } : {}),
    ...(temClique ? {
      adIdentifiers: {
        ...(ids.gclid ? { gclid: ids.gclid } : {}),
        ...(ids.wbraid ? { wbraid: ids.wbraid } : {}),
        ...(ids.gbraid ? { gbraid: ids.gbraid } : {}),
      },
    } : {}),
    ...(identificadores.length ? { userData: { userIdentifiers: identificadores } } : {}),
    ...(valor ? { conversionValue: Number(valor), currency: moeda || env.DEFAULT_CURRENCY || 'BRL' } : {}),
  };

  const corpo = {
    destinations: [{
      // Conta dona da acao de conversao.
      operatingAccount: { accountType: 'GOOGLE_ADS', accountId: soDigitos(env.GOOGLE_ADS_CUSTOMER_ID) },
      // Conta administradora pela qual o usuario do OAuth acessa. Sem MCC,
      // deixe a variavel vazia.
      ...(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID
        ? { loginAccount: { accountType: 'GOOGLE_ADS', accountId: soDigitos(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) } }
        : {}),
      productDestinationId: soDigitos(acao),
    }],
    encoding: 'HEX', // o sha256 daqui devolve hexadecimal
    events: [evento],
    validateOnly: !!validateOnly,
  };

  const payload = JSON.stringify(corpo);
  const response = await fetch('https://datamanager.googleapis.com/v1/events:ingest', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: payload,
  });
  return { payload, response };
}

// ---------------------------------------------------------------------------
// Leitura de resultado
// ---------------------------------------------------------------------------

// Normaliza o retorno de qualquer envio numa forma gravavel.
// Importante: status 200 com erro no corpo e falha. O Google usa esse
// padrao (partialFailureError) e outras plataformas copiaram.
export async function lerResultado(resultado) {
  const saida = { status: 0, ok: 0, body: '', payload: null };
  if (!resultado) return saida;

  if (resultado.status === 'rejected') {
    saida.body = `erro de rede: ${resultado.reason?.message || 'desconhecido'}`;
    return saida;
  }
  const v = resultado.status === 'fulfilled' ? resultado.value : resultado;
  if (!v) return saida;

  saida.payload = v.payload ?? null;
  if (v.skipped) {
    saida.body = `ignorado: ${v.skipped}`;
    return saida;
  }
  if (!v.response) return saida;

  saida.status = v.response.status;
  try { saida.body = await v.response.text(); } catch (e) { saida.body = `erro ao ler resposta: ${e.message}`; }

  let temErroNoCorpo = false;
  try {
    const j = JSON.parse(saida.body);
    temErroNoCorpo = !!(j.partialFailureError || j.error);
  } catch (_) { /* corpo nao e JSON: ignora */ }

  saida.ok = v.response.ok && !temErroNoCorpo ? 1 : 0;
  saida.body = saida.body.slice(0, 2000);
  return saida;
}

export const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

// Comparacao em tempo constante, para segredo em cabecalho de webhook.
// Comparar com === vaza o tamanho do prefixo correto pelo tempo de resposta.
export function comparacaoSegura(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
