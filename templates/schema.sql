-- Schema do trackeamento (Cloudflare D1 / SQLite)
--
-- Aplicar:
--   npx wrangler d1 create SEU_BANCO
--   npx wrangler d1 execute SEU_BANCO --remote --file ./schema.sql
--
-- Para alterar depois, crie arquivos numerados (0002_x.sql, 0003_x.sql) e
-- aplique um por um: ALTER TABLE nao e reentrante, cada arquivo roda uma vez.

-- ---------------------------------------------------------------------------
-- sessions: uma linha por visita. Escrita pelo _middleware.js
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
    session_id   TEXT PRIMARY KEY,     -- cookie _trk_sid
    external_id  TEXT NOT NULL,        -- cookie _trk_eid (Advanced Matching)
    fbclid       TEXT,                 -- cru, exatamente como veio na URL
    gclid        TEXT,
    wbraid       TEXT,
    gbraid       TEXT,
    msclkid      TEXT,
    fbc          TEXT,                 -- fb.<index>.<ms>.<fbclid>
    fbp          TEXT,                 -- fb.<index>.<ms>.<aleatorio>
    ip_address   TEXT,
    user_agent   TEXT,
    referrer     TEXT,
    landing_url  TEXT,                 -- URL completa de entrada, com a query
    utm_source   TEXT,
    utm_medium   TEXT,
    utm_campaign TEXT,
    utm_content  TEXT,
    utm_term     TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at);

-- ---------------------------------------------------------------------------
-- event_log: uma linha por evento de conversao. PageView NAO entra aqui.
-- Guarda a resposta crua de cada plataforma: e o que transforma depuracao
-- de meio dia em consulta de trinta segundos.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT,
    event_name    TEXT NOT NULL,
    event_id      TEXT NOT NULL,       -- mesmo id usado no pixel (dedupe)
    timestamp     INTEGER NOT NULL,

    -- diagnostico de saude
    browser       TEXT,
    os            TEXT,
    is_mobile     INTEGER DEFAULT 0,
    pixel_was_blocked INTEGER DEFAULT 0,
    fbp_source    TEXT,                -- pixel_js | cookie_http | sessao | nenhum
    fbc_source    TEXT,
    ga_cookie_present     INTEGER DEFAULT 0,
    ga_client_id_fallback INTEGER DEFAULT 0,
    is_bot        INTEGER DEFAULT 0,
    bot_reason    TEXT,
    consent_status TEXT,               -- preencher com o estado real

    -- entrega por plataforma
    meta_status_code   INTEGER DEFAULT 0,
    meta_response_ok   INTEGER DEFAULT 0,
    meta_response_body TEXT,
    meta_payload_sent  TEXT,
    ga4_status_code    INTEGER DEFAULT 0,
    ga4_response_ok    INTEGER DEFAULT 0,
    ga4_response_body  TEXT,
    ga4_payload_sent   TEXT,

    -- quais campos existiam (sem guardar o valor)
    has_email     INTEGER DEFAULT 0,
    has_phone     INTEGER DEFAULT 0,
    has_name      INTEGER DEFAULT 0,

    -- dado pessoal cru, so para depuracao e para casar evento de CRM.
    -- Nunca sai do seu banco. Ver references/privacidade.md (retencao).
    raw_email     TEXT,
    ga_client_id  TEXT
);

CREATE INDEX IF NOT EXISTS idx_event_log_timestamp  ON event_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_event_log_event_name ON event_log(event_name);
CREATE INDEX IF NOT EXISTS idx_event_log_raw_email  ON event_log(raw_email);

-- ---------------------------------------------------------------------------
-- checkout_sessions: uma linha por intencao de compra (checkout externo).
-- Congela a atribuicao no momento do clique, para o webhook recuperar.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS checkout_sessions (
    trk          TEXT PRIMARY KEY,     -- UUID gerado na pagina de venda
    session_id   TEXT,
    ip_address   TEXT,
    user_agent   TEXT,
    external_id  TEXT,
    fbp          TEXT,
    fbc          TEXT,
    gclid        TEXT,
    wbraid       TEXT,
    gbraid       TEXT,
    ga_client_id TEXT,
    utm_source   TEXT,
    utm_medium   TEXT,
    utm_campaign TEXT,
    utm_content  TEXT,
    utm_term     TEXT,
    event_source_url TEXT,
    created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_created ON checkout_sessions(created_at);

-- ---------------------------------------------------------------------------
-- purchase_log: uma linha por compra confirmada.
-- O indice unico no transaction_id e a protecao contra reentrega do webhook.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id TEXT NOT NULL,
    platform       TEXT,               -- nome do checkout de origem
    event_id       TEXT,
    event_type     TEXT,               -- purchase | registro | assinatura...
    product_id     TEXT,
    product_name   TEXT,
    value          REAL,
    currency       TEXT,
    status         TEXT,

    -- atribuicao recuperada pelo trk
    trk            TEXT,
    session_id     TEXT,
    fbp            TEXT,
    fbc            TEXT,
    gclid          TEXT,
    ga_client_id   TEXT,
    utm_source     TEXT,
    utm_medium     TEXT,
    utm_campaign   TEXT,
    utm_content    TEXT,
    utm_term       TEXT,
    entry_referer  TEXT,               -- cru, sem classificar
    entry_url      TEXT,

    -- entrega por plataforma
    meta_status_code        INTEGER DEFAULT 0,
    meta_response_ok        INTEGER DEFAULT 0,
    meta_response_body      TEXT,
    ga4_status_code         INTEGER DEFAULT 0,
    ga4_response_ok         INTEGER DEFAULT 0,
    ga4_response_body       TEXT,
    google_status_code      INTEGER DEFAULT 0,
    google_response_ok      INTEGER DEFAULT 0,
    google_response_body    TEXT,

    raw_email      TEXT,
    raw_phone      TEXT,
    raw_name       TEXT,
    created_at     INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_log_transaction
    ON purchase_log(transaction_id);
CREATE INDEX IF NOT EXISTS idx_purchase_log_created ON purchase_log(created_at);

-- ---------------------------------------------------------------------------
-- webhook_raw_log: corpo cru de TODO POST que passou a autenticacao,
-- antes de qualquer filtro. Status errado, duplicado e JSON quebrado
-- tambem ficam aqui. Contem dado pessoal: nunca expor em endpoint.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_raw_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    platform       TEXT,
    received_at    INTEGER NOT NULL,
    body           TEXT,
    body_keys      TEXT,               -- chaves da raiz, para ver os nomes reais
    status         TEXT,
    transaction_id TEXT,
    outcome        TEXT                -- processado | ignorado: ... | erro: ...
);

CREATE INDEX IF NOT EXISTS idx_webhook_raw_received ON webhook_raw_log(received_at);

-- ---------------------------------------------------------------------------
-- envio_crm: uma linha por registro de CRM enviado as plataformas.
-- A chave unica e a idempotencia: um registro dispara uma vez so, mesmo
-- que avance e volte de etapa varias vezes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS envio_crm (
    registro_id    TEXT PRIMARY KEY,   -- id do negocio/lead no CRM
    evento         TEXT NOT NULL,      -- lead_qualificado | contrato | ...
    aconteceu_em   INTEGER NOT NULL,   -- quando o fato ocorreu (nao o envio)
    enviado_em     INTEGER NOT NULL,
    casou          INTEGER DEFAULT 0,  -- achou a visita de origem
    tinha_gclid    INTEGER DEFAULT 0,
    tinha_fbc      INTEGER DEFAULT 0,
    tinha_ga_cid   INTEGER DEFAULT 0,
    meta_status    TEXT,
    ga4_status     TEXT,
    google_status  TEXT,
    detalhe        TEXT                -- resposta resumida, para auditoria
);

CREATE INDEX IF NOT EXISTS idx_envio_crm_enviado ON envio_crm(enviado_em);
