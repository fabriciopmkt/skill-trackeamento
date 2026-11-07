# GA4: Measurement Protocol

O GA4 entra aqui por dois motivos: ele é o relatório que cruza mídia com comportamento, e conversão marcada nele pode ser importada como conversão no Google Ads sem nenhuma API. Para trackeamento de mídia paga, o valor está em mandar **só a conversão** pelo servidor e deixar o resto com a tag normal da página.

## Divisão de trabalho

| Evento | Quem manda |
|---|---|
| `page_view`, rolagem, clique, tempo na página | Tag `gtag.js` na página |
| `generate_lead`, `purchase`, `begin_checkout` | Servidor, pelo Measurement Protocol |

Mandar `page_view` pelo servidor dobra a sessão nos relatórios e não ajuda em nada.

## O `client_id` é tudo

Sem o `client_id` certo, o GA4 cria um usuário novo para cada evento: a conversão aparece desligada da origem, e o relatório de aquisição mostra "direto" para tudo.

O `client_id` está no cookie `_ga` do visitante, que a tag `gtag.js` escreve no seu domínio:

```
_ga = GA1.1.1234567890.1699999999
                ^^^^^^^^^^^^^^^^^^^^
                client_id = 1234567890.1699999999
```

Pegue os **dois últimos** segmentos separados por ponto. O servidor lê esse cookie na requisição.

Quando o cookie não existe (bloqueador, primeira visita antes de a tag carregar, navegação com JavaScript desligado), gere um valor no formato `<numero>.<timestamp>` e registre que foi fallback. O evento entra, atribuído a um usuário novo. Medir a frequência disso diz quanto do seu GA4 é cego.

O `session_id` vem do cookie `_ga_<ID_DO_FLUXO>`, com formato diferente conforme a versão da tag. Ele é opcional: sem ele o evento entra numa sessão nova.

## Endpoint

```
POST https://www.google-analytics.com/mp/collect
  ?measurement_id=G-XXXXXXXXXX
  &api_secret=<API_SECRET>
```

```json
{
  "client_id": "1234567890.1699999999",
  "timestamp_micros": 1760000000000000,
  "events": [{
    "name": "generate_lead",
    "params": {
      "session_id": "1760000000",
      "engagement_time_msec": 100,
      "currency": "BRL",
      "value": 1200,
      "page_location": "https://seu-dominio/lp"
    }
  }]
}
```

O `api_secret` sai do painel do GA4, em **Administrador > Fluxos de dados > seu fluxo > Protocolo de medição > Criar**. É um segredo: nunca no HTML.

## Nomes de evento

Use os nomes que o GA4 já entende, senão o evento não alimenta relatório nenhum:

| O que é | Nome no GA4 |
|---|---|
| Lead captado | `generate_lead` |
| Checkout iniciado | `begin_checkout` |
| Compra | `purchase` |
| Cadastro gratuito concluído | `sign_up` |

Para evento que não tem equivalente padrão (lead qualificado, contrato assinado), use nome próprio em letras minúsculas com sublinhado e marque como conversão no painel. Nome próprio em português facilita a leitura do relatório por quem não é da área.

Marcar como conversão: **Administrador > Eventos de conversão > Novo evento de conversão**, com o nome exato.

## Janelas de tempo

| Regra | Valor |
|---|---|
| `timestamp_micros` no passado | Até **72 horas**. Mais velho, o GA4 descarta |
| Resposta de erro | Não existe. O endpoint devolve `204` mesmo recusando o evento |
| Latência no relatório | Minutos no tempo real, até 24 horas nos relatórios padrão |

**O `204` é a pegadinha central do Measurement Protocol.** Payload errado, nome de evento inválido, `api_secret` trocado: tudo devolve `204 No Content`. A única forma de ver o que o GA4 pensou do seu evento é o endpoint de validação ou o DebugView.

## Como validar de verdade

1. **Endpoint de depuração**, que devolve os problemas:

```
POST https://www.google-analytics.com/debug/mp/collect?measurement_id=...&api_secret=...
```

Mesmo corpo. A resposta traz `validationMessages` com o que está errado. Use sempre antes do primeiro envio real.

2. **DebugView**, em **Administrador > DebugView**: adicione `"debug_mode": true` em `params` e o evento aparece na tela em segundos, com todos os parâmetros.

Tire o `debug_mode` depois: evento em modo de depuração não entra nos relatórios normais.

## Importar a conversão do GA4 no Google Ads

Caminho mais curto quando a conversão nasce no site e você não quer montar a Data Manager API:

1. Vincule GA4 e Google Ads (**Administrador > Vínculos com produtos > Google Ads**).
2. No Google Ads, **Objetivos > Conversões > Nova ação > Importar > Google Analytics 4**.
3. Escolha o evento.

Limites: a conversão passa a depender do modelo do GA4 (que faz modelagem quando falta consentimento), chega com mais atraso, e evento de CRM com mais de 72 horas nunca entra. Para fundo de funil, a Data Manager API continua sendo o caminho.

## Erros e sintomas

| Sintoma | Causa |
|---|---|
| Evento no DebugView e nada no relatório | Falta `engagement_time_msec` e `session_id`, ou o `debug_mode` ficou ligado |
| Toda conversão como "direto" | `client_id` gerado em fallback: o cookie `_ga` não estava sendo lido |
| Conversão de CRM não aparece | `timestamp_micros` com mais de 72 horas |
| `204` e nada acontece | Use o endpoint `/debug/mp/collect` para ver a mensagem real |
| Sessão dobrada | `page_view` indo pelo servidor além da tag |
