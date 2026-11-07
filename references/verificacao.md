# Verificação: provar cada salto

Sete pontos de checagem, na ordem da cadeia. Quando alguém diz "o tracking não está funcionando", a pergunta certa é "qual salto quebrou". Rode do 1 para o 7 e pare no primeiro que falha: tudo depois dele falha por consequência.

Substitua `SEU_DOMINIO` e `SEU_BANCO` nos comandos.

## 1. O middleware gera os identificadores

**Teste.** Abra numa aba anônima:

```
https://SEU_DOMINIO/sua-lp?fbclid=teste123&gclid=teste456&utm_source=prova&utm_medium=verificacao
```

No console do navegador, `document.cookie` deve conter `_trk_sid`, `_trk_eid`, `_fbp` e `_fbc`.

**Passou se** os quatro existem, o `_fbc` termina com `teste123` e o índice do `_fbp` bate com o seu domínio (1 para `.com`, 2 para `.com.br`).

**Falhou:** o caminho da LP está na lista de exclusão do middleware, o arquivo não está em `functions/_middleware.js`, ou o deploy não subiu.

## 2. A sessão foi gravada

```bash
npx wrangler d1 execute SEU_BANCO --remote --command "SELECT session_id, fbclid, gclid, fbc, fbp, utm_source, landing_url FROM sessions ORDER BY created_at DESC LIMIT 3"
```

**Passou se** a linha mais recente tem o `fbclid` e o `gclid` do teste.

**Falhou:** binding `DB` com outro nome no `wrangler.toml`, schema não aplicado, ou a tabela não existe. Erro de banco aparece no log: `npx wrangler pages deployment tail`.

## 3. O pixel dispara com `eventID`

**Teste.** Com a extensão Meta Pixel Helper aberta, ou na aba Rede filtrando por `facebook.com/tr`, preencha o formulário.

**Passou se** o Lead aparece uma vez só e a requisição tem o parâmetro `eid` preenchido.

**Falhou:** `eventID` não está sendo passado no quarto argumento de `fbq`, ou o pixel está instalado duas vezes na página (procure por `fbq(` no HTML).

## 4. O servidor recebeu e respondeu

```bash
npx wrangler d1 execute SEU_BANCO --remote --command "SELECT event_name, event_id, meta_status_code, meta_response_ok, ga4_status_code, is_bot, bot_reason FROM event_log ORDER BY timestamp DESC LIMIT 5"
```

**Passou se** há uma linha com o evento, `meta_status_code` 200 e `meta_response_ok` 1.

**Falhou e nenhuma linha apareceu:** o POST não chegou. Veja a aba Rede: 404 quer dizer arquivo no lugar errado, erro de CORS quer dizer que o endpoint não devolve os cabeçalhos, e falha de rede silenciosa é bloqueador derrubando o `fetch` (teste sem extensão).

**Falhou com status diferente de 200:** leia a coluna de resposta crua. O Meta diz exatamente qual campo recusou.

## 5. O Meta recebeu

**Teste.** Events Manager, aba **Testar eventos**, com `META_TEST_EVENT_CODE` configurado.

**Passou se** o evento aparece em segundos, mostrando o `event_id` e os campos de `user_data`.

Depois, na aba **Visão geral**, confira:

| Sinal | O que quer dizer |
|---|---|
| Origem "Navegador e servidor" | Dedupe funcionando |
| Eventos duplicados no alerta | `event_id` diferente nas duas pontas |
| Qualidade da correspondência abaixo de 5 | Normalização errada ou dado faltando |
| "Nenhum evento recebido" | Pixel id ou token do pixel errado |

**Tire o `test_event_code` ao terminar.** Evento de teste não conta para otimização.

## 6. O GA4 recebeu

O endpoint normal devolve `204` para tudo, então valide com o de depuração:

```bash
curl -s -X POST "https://www.google-analytics.com/debug/mp/collect?measurement_id=G-XXXXXXXXXX&api_secret=SEU_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"client_id":"1234.5678","events":[{"name":"generate_lead","params":{"engagement_time_msec":100}}]}'
```

**Passou se** `validationMessages` vem vazio.

Depois confirme no DebugView, com `debug_mode: true` no evento.

**Falhou:** `api_secret` de outro fluxo de dados, nome de evento inválido, ou `timestamp_micros` com mais de 72 horas.

## 7. O Google Ads recebeu

**Teste.** Mande um evento com `validateOnly: true`.

**Passou se** a resposta é 200 sem erro no corpo.

Para confirmar que a conversão foi gravada de verdade, mande sem `validateOnly` e olhe em **Objetivos > Conversões** depois de até 3 horas.

**Falhou:** a tabela de erros em `references/google-conversoes.md` cobre os casos. Os três mais comuns: fuso errado no horário, ação de conversão de outra conta e clique fora da janela.

## Checagens de saúde que valem acompanhar

Depois de no ar, essas consultas mostram o trackeamento perdendo qualidade antes de alguém reclamar:

```sql
-- Quanto do público bloqueia o pixel (a linha salva pelo cookie do servidor)
SELECT COUNT(*) AS total,
       SUM(pixel_was_blocked) AS bloqueados,
       ROUND(100.0 * SUM(pixel_was_blocked) / COUNT(*), 1) AS pct
  FROM event_log
 WHERE timestamp > unixepoch() - 604800;

-- De onde vieram os identificadores do Meta
SELECT fbp_source, COUNT(*) FROM event_log
 WHERE timestamp > unixepoch() - 604800 GROUP BY fbp_source;

-- Quanto do funil tem identificador de clique
SELECT SUM(CASE WHEN gclid <> '' THEN 1 ELSE 0 END) AS com_gclid,
       SUM(CASE WHEN fbc   <> '' THEN 1 ELSE 0 END) AS com_fbc,
       COUNT(*) AS total
  FROM sessions WHERE created_at > unixepoch() - 604800;

-- Falha de entrega por plataforma
SELECT event_name, COUNT(*) AS falhas FROM event_log
 WHERE meta_response_ok = 0 AND is_bot = 0
   AND timestamp > unixepoch() - 86400
 GROUP BY event_name;

-- Robô filtrado (deve existir: prévia de link e crawler são reais)
SELECT bot_reason, COUNT(*) FROM event_log
 WHERE is_bot = 1 AND timestamp > unixepoch() - 604800 GROUP BY bot_reason;
```

Mudança brusca em qualquer um desses números é sinal de quebra. Queda de `com_gclid` costuma ser redirecionamento novo comendo a query string; salto de `pixel_was_blocked` costuma ser mudança de público, não defeito.

## Diferença entre plataforma e banco

Nunca vai bater exatamente, e isso é normal: janela de atribuição, modelagem de conversão, filtro de robô da plataforma e evento fora de janela. A diferença que importa é a que **muda** sem explicação. Registre a proporção normal na primeira semana e compare com ela depois.
