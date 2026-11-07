# Arquitetura e cadeia de identidade

## O problema que a arquitetura resolve

Uma conversão só serve para otimizar campanha se a plataforma conseguir ligar o evento à pessoa que clicou no anúncio. Três coisas quebram essa ligação:

1. **ITP e navegador.** Safari limita cookie criado por JavaScript a 7 dias. Firefox bloqueia rastreador conhecido. Chrome encurtou a vida de cookie de terceiro.
2. **Bloqueador de anúncio.** Entre 15% e 30% do público bloqueia o script do pixel. Esse visitante converte e nenhuma plataforma fica sabendo.
3. **Domínio de terceiro.** Checkout, agendador e área de membros rodam em outro domínio. O cookie do seu site não existe lá.

A resposta é a mesma para os três: **capture a identidade no servidor, no seu próprio domínio, e envie o evento de servidor para servidor.** O pixel do browser continua instalado, só deixa de ser a única fonte.

## As três camadas

```
     Visitante clica no anúncio (fbclid / gclid na URL)
                          |
   CAMADA 1 ...... _middleware.js roda ANTES da página
                   gera _trk_sid, _trk_eid, _fbp, _fbc
                   grava a linha em `sessions`
                   responde com Set-Cookie (400 dias)
                          |
                   Página carrega, pixel dispara PageView
                          |
     Visitante preenche o formulário ou clica em comprar
                          |
   CAMADA 2 ...... POST /tracker
                   lê cookie + linha de `sessions`
                   normaliza e faz hash do dado pessoal
                   dispara Meta CAPI e GA4 em paralelo
                   grava `event_log` com a resposta crua
                          |
            ( se a venda acontece em checkout de terceiro )
                          |
   CAMADA 3 ...... POST /checkout-session guarda o `trk`
                   visitante sai para o checkout com o `trk`
                   webhook de compra devolve o `trk`
                   lookup em `checkout_sessions` recupera tudo
                   dispara Purchase para Meta, GA4 e Google
                          |
            ( quando o funil continua dentro do CRM )
                          |
                   POST /api/conversao-crm
                   acha a visita pelo e-mail, envia
                   lead qualificado, contrato, reembolso
```

## Tabela de identificadores

| Identificador | Nasce onde | Guardado em | Serve para |
|---|---|---|---|
| `_trk_sid` | Middleware, um UUID por visita | Cookie 400 dias + `sessions.session_id` | Ligar todo evento à visita que o originou |
| `_trk_eid` | Middleware, um UUID por visitante | Cookie 400 dias + `sessions.external_id` | `external_id` do Advanced Matching do Meta |
| `_fbp` | Middleware, formato `fb.<index>.<ts>.<rand>` | Cookie + `sessions.fbp` | Meta CAPI. Único identificador que sobra quando o pixel é bloqueado |
| `_fbc` | Middleware, derivado do `fbclid` da URL | Cookie + `sessions.fbc` | Meta CAPI. É o que liga a conversão ao clique no anúncio |
| `gclid`, `wbraid`, `gbraid` | Parâmetro da URL do anúncio do Google | `sessions` e `checkout_sessions` | Conversão de clique no Google Ads |
| `msclkid` | Parâmetro da URL do Microsoft Ads | `sessions` | Conversão no Microsoft Ads, se for usar |
| `ga_client_id` | Lido do cookie `_ga` do GA4 | `event_log` e `checkout_sessions` | GA4 Measurement Protocol |
| `event_id` | Browser, um UUID por evento | `event_log` e `purchase_log` | Dedupe entre pixel e API de conversões |
| `trk` | JavaScript da página de venda, um UUID por intenção de compra | `checkout_sessions.trk` (chave única) | Recuperar a atribuição no webhook do checkout |

## Por que `_fbp` e `_fbc` são montados pelo servidor

O formato é público e simples:

```
_fbp = fb.<sub_domain_index>.<timestamp_ms>.<numero_aleatorio>
_fbc = fb.<sub_domain_index>.<timestamp_ms>.<fbclid cru da URL>
```

O `sub_domain_index` é a quantidade de rótulos do domínio registrável menos um:

| Domínio | Rótulos do domínio registrável | Index |
|---|---|---|
| `exemplo.com` | 2 | 1 |
| `exemplo.com.br` | 3 | 2 |
| `exemplo.co.uk` | 3 | 2 |

O `_middleware.js` calcula isso do cabeçalho `Host` em tempo de execução, com uma lista dos domínios de segundo nível mais comuns. Index errado faz o Meta descartar o identificador em silêncio.

**Pegadinha do `fbclid`:** leia o parâmetro do texto cru da query, nunca com `url.searchParams.get()`. O `searchParams` decodifica percent-encoding e o Meta espera o `fbclid` exatamente como veio na URL. Um `%3D` virando `=` quebra o match.

## Por que servir a página antes de gravar no banco

O middleware chama `next()` primeiro e grava em `sessions` dentro de `context.waitUntil()`. A escrita acontece depois da resposta sair, então o banco nunca entra no tempo de carregamento da página. Banco fora do ar vira evento perdido, nunca página lenta.

## Precedência de identificador

Quando a mesma informação vem de vários lugares, vale esta ordem:

1. **Cookie HTTP lido na requisição** (foi o servidor que escreveu, é o mais confiável).
2. **Linha de `sessions`** (foi o middleware que gravou, sobrevive ao cookie apagado na mesma visita).
3. **Corpo do POST enviado pelo browser** (pode ter sido mexido por extensão ou bloqueado).

Em checkout externo há um quarto nível: a atribuição que o próprio checkout capturou. Ela entra sempre como reserva, nunca misturada com a da sua sessão. Ver `references/checkout-externo.md`.

## O que fica em cada tabela

| Tabela | Uma linha por | Guarda |
|---|---|---|
| `sessions` | Visita | Identificadores, UTMs, URL de entrada, referer, IP, user agent |
| `event_log` | Evento de conversão (sem PageView) | Nome, `event_id`, resposta crua de cada plataforma, diagnóstico de saúde |
| `checkout_sessions` | Intenção de compra | `trk` + a atribuição congelada no momento do clique |
| `purchase_log` | Compra confirmada | Valor, moeda, id da transação, produto, atribuição, resposta de cada plataforma |
| `envio_crm` | Evento de fundo de funil enviado | Chave do registro no CRM, o que casou, resultado por destino |

Guardar a **resposta crua** de cada plataforma é o que transforma depuração de meio dia em consulta de trinta segundos. Status 200 com `partialFailureError` no corpo é falha, e só o corpo mostra isso.
