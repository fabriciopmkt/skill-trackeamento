# Evento de fundo de funil a partir do CRM

Formulário preenchido é o começo do funil. Se a campanha otimiza por isso, ela aprende a trazer quem preenche formulário, o que não é a mesma coisa que trazer cliente. Mandar o evento de fundo de funil de volta para a plataforma muda o que o algoritmo procura.

Exemplos de evento que vale enviar:

| Evento no seu funil | Meta | GA4 | Google Ads |
|---|---|---|---|
| Lead passou pela qualificação | `Schedule` ou `SubmitApplication` | `lead_qualificado` | Ação com categoria **Lead qualificado** |
| Reunião ou consulta realizada | `Schedule` | `reuniao_realizada` | Ação própria |
| Proposta enviada | `SubmitApplication` | `proposta_enviada` | Ação própria |
| Contrato fechado | `Purchase` | `purchase` | Ação com categoria **Compra** |
| Reembolso ou cancelamento | Valor negativo, ver abaixo | `refund` | Ajuste de conversão |

## Quem faz o quê

Separe em dois lados, mesmo que os dois sejam seus:

| Lado | Responsabilidade |
|---|---|
| **CRM** (fonte da verdade) | Sabe quem avançou de etapa e quando. Decide quem ainda não foi enviado. Grava o resultado. **Não tem credencial de plataforma** |
| **Endpoint de envio** (onde o tracking mora) | Tem as credenciais, o banco com as sessões e as funções de OAuth. Recebe os fatos, resolve a identidade e envia |

Essa divisão evita duplicar segredo em dois sistemas e deixa claro quem controla a idempotência. O CRM manda uma lista de fatos, o endpoint devolve um resultado por item.

## Reconectar a pessoa à visita

O CRM tem e-mail e telefone. A plataforma de anúncio precisa de `gclid`, `fbc`, `fbp` ou `ga_client_id`. A ponte é o `event_log`:

```sql
SELECT session_id, ga_client_id, timestamp
  FROM event_log
 WHERE event_name = 'Lead'
   AND LOWER(TRIM(raw_email)) = ?
 ORDER BY timestamp DESC
 LIMIT 1
```

Depois busque a linha de `sessions` por esse `session_id` para recuperar `gclid`, `fbc`, `fbp`, IP, user agent e URL de entrada.

**Mais recente e não o primeiro.** Quem preencheu duas vezes tem duas visitas; a última é a que a plataforma ainda atribui dentro da janela dela.

Case por e-mail normalizado (minúsculas, sem espaço). Telefone serve de segunda tentativa, só dígitos, comparando os últimos 8 ou 9 para absorver diferença de DDD e de código de país.

## Taxa de match é diagnóstico, não defeito

Parte dos leads nunca vai casar: entraram por telefone, por indicação, por base antiga, ou antes de o tracking existir. Esse teto é informação de negócio, e mede quanto do funil vem de mídia rastreável.

Antes do primeiro envio real, rode em modo simulação (`dry_run`): o endpoint resolve a identidade, responde o que **seria** enviado e não chama plataforma nenhuma nem grava nada. É assim que se mede a taxa de match sem poluir a conta com evento de teste. Simulação pode rodar quantas vezes quiser.

## Idempotência

Quem avança de etapa, volta e avança de novo pode disparar o mesmo evento várias vezes. Três camadas de proteção, nessa ordem:

1. **Registro por chave no CRM.** Uma linha por registro enviado, com restrição de unicidade. Idempotência é por registro, não por transição de etapa.
2. **`event_id` determinístico no Meta.** `lq-<id do negócio>`. Reenvio do mesmo id dedupe na janela de 48 horas.
3. **`transactionId` determinístico no Google.** A mesma chave. Reenvio não cria conversão nova.

Com as três, "enviou mas falhou ao gravar" tem como pior resultado um reenvio que as plataformas descartam.

## Horário do evento

Use **o horário em que o fato aconteceu**, nunca o do envio. Se a pessoa chegou na etapa ontem e o cron rodou hoje, o evento é de ontem. Horário errado desloca a conversão para fora da janela de atribuição do clique e a campanha não recebe o crédito.

Quando houver várias transições registradas, use o `MIN` do horário: interessa quando a pessoa chegou lá pela primeira vez.

## As janelas mandam no que é possível

| Destino | Idade máxima | O que fazer quando passa |
|---|---|---|
| Meta CAPI | 7 dias | Pule o Meta, registre o motivo, siga com os outros |
| GA4 Measurement Protocol | 72 horas | Pule o GA4 (ele devolve `204` e descarta calado) |
| Google Ads | A janela de conversão da ação (30 a 90 dias) | Mande: é o destino que aceita evento mais antigo |

Por isso o envio precisa ser frequente. Um cron a cada 15 minutos ou de hora em hora mantém quase tudo dentro de todas as janelas; um envio semanal entrega conversão só para o Google.

## Reembolso e cancelamento

- **Meta:** evento `Purchase` com valor negativo não é aceito. Use a API de eventos de reembolso ou, mais simples, pare de enviar aquele valor e aceite a imprecisão em vendas canceladas, registrando o caso.
- **Google Ads:** use ajuste de conversão (`RETRACTION` para cancelar, `RESTATEMENT` para corrigir valor), casando pelo mesmo `orderId` ou `transactionId` do envio original. É aqui que a chave determinística paga de novo.
- **GA4:** evento `refund` com o mesmo `transaction_id`.

## Antes de ligar o envio real

1. Rode com `dry_run` e olhe a taxa de match. Abaixo de 30%, o problema é de captura, não de envio: investigue antes.
2. Rode com `validate_only` no Google, para provar credencial e ação sem gravar.
3. Mande um registro só, de verdade, e confirme nos três gerenciadores.
4. Só então ligue o lote e o cron.
5. Na primeira semana, compare a quantidade enviada com a quantidade que apareceu em cada plataforma. Diferença constante aponta janela; diferença aleatória aponta erro intermitente no log de resposta.
