# Meta: pixel, Conversions API e taxa de match

## O que cada ponta faz

| | Pixel (browser) | CAPI (servidor) |
|---|---|---|
| Sobrevive a bloqueador | Não | Sim |
| Sobrevive ao ITP | Parcialmente | Sim |
| Enxerga comportamento na página | Sim | Não |
| Manda dado pessoal com hash | Limitado | Sim, completo |
| É a fonte autoritativa aqui | Não | Sim |

Instale os dois. O pixel cobre comportamento e dá sinal imediato; o CAPI garante a conversão.

## Dedupe: a regra que não pode falhar

Cada evento nasce com um id no browser e esse mesmo id vai nas duas pontas:

```js
const eventId = crypto.randomUUID();
fbq('track', 'Lead', {}, { eventID: eventId });   // browser
// e no corpo do POST /tracker: { event_name: 'Lead', event_id: eventId }
```

O Meta considera duplicado quando `event_name` e o id coincidem dentro de 48 horas. Sem o id compartilhado, cada conversão conta duas vezes, o custo por resultado aparece pela metade e a campanha é otimizada com número errado.

Também mantenha o `event_time` próximo nas duas pontas. O servidor usa o timestamp que o browser mandou, nunca o seu.

## Normalização antes do hash

Hash de valor normalizado errado não dá erro: entra como evento sem match. É a falha mais cara e mais silenciosa do CAPI.

| Campo | Chave | Normalização que o Meta espera |
|---|---|---|
| E-mail | `em` | Minúsculas, sem espaço nas pontas. Nada mais: não remova ponto nem `+sufixo` |
| Telefone | `ph` | Só dígitos, **com código do país e DDD**. Sem `+`, sem espaço, sem parêntese |
| Nome | `fn`, `ln` | Minúsculas. **Mantenha acento, apóstrofo e hífen** |
| Cidade, estado | `ct`, `st` | Minúsculas, sem espaço nem pontuação |
| CEP | `zp` | Só dígitos, primeiros 5 |
| Id próprio | `external_id` | Aceita hash ou valor cru, mantenha o mesmo critério sempre |

Depois de normalizar, SHA-256 em hexadecimal minúsculo. Cada campo vai como array: `em: [hash]`.

**O erro clássico do telefone.** Quem preenche formulário escreve `(11) 98765-4321`, sem país. Vai para o hash como `11987654321` e nunca casa, porque o Meta espera `5511987654321`. O `tracker.js` prefixa o código do país quando o número tem comprimento de número local. Configure `DEFAULT_COUNTRY_CODE`.

**O erro clássico do nome.** É tentador tirar acento de "João" para "normalizar". O Meta guarda o hash com acento: tirar derruba o match de boa parte da base brasileira.

**Nunca vai com hash:** `fbp`, `fbc`, `client_ip_address`, `client_user_agent`. Vão crus.

## Campos que não são dado pessoal e valem muito

Mandar só e-mail com hash é desperdiçar o que você já tem:

- `fbc`: liga a conversão direto ao clique. Quando existe, é o sinal mais forte.
- `fbp`: identifica o navegador. É o que sobra quando o pixel foi bloqueado.
- `client_ip_address` e `client_user_agent`: obrigatórios na prática para evento `website`, e entram no match probabilístico.

## `action_source`

| Valor | Quando usar |
|---|---|
| `website` | Evento que aconteceu numa página sua (PageView, Lead, InitiateCheckout) |
| `system_generated` | Evento que o seu sistema gerou sem o visitante estar presente: conversão vinda do CRM, venda confirmada por webhook |
| `phone_call`, `chat`, `physical_store` | Conversão que aconteceu nesses canais |

Valor errado não bloqueia o evento, piora a qualidade atribuída à origem.

## Nome de evento: prefira o padrão

O Meta otimiza melhor em evento que ele já sabe interpretar. Para fundo de funil, escolha o evento padrão mais próximo e renomeie o rótulo na interface, em vez de criar evento customizado:

| O que é na sua operação | Evento padrão que serve |
|---|---|
| Lead virou reunião, apresentação, consulta marcada | `Schedule` |
| Lead passou pela qualificação | `SubmitApplication` ou `Schedule` |
| Cadastro concluído em produto gratuito | `CompleteRegistration` |
| Compra paga | `Purchase` |
| Carrinho ou checkout iniciado | `InitiateCheckout` |

Evento customizado funciona, só entra em menos otimizações automáticas.

## Janelas de tempo

| Regra | Valor |
|---|---|
| Idade máxima do `event_time` | 7 dias. Mais velho, o Meta recusa |
| Janela de dedupe por `event_id` | 48 horas |
| Atraso recomendado para evento de servidor | Nenhum. Mande na hora |

Evento de CRM que demorou mais de 7 dias para acontecer: pule o Meta, registre o motivo e mande para os outros destinos. É melhor que gerar erro no log.

## Endpoint

```
POST https://graph.facebook.com/v25.0/<PIXEL_ID>/events
```

Corpo mínimo:

```json
{
  "data": [{
    "event_name": "Lead",
    "event_time": 1760000000,
    "event_id": "uuid-compartilhado-com-o-pixel",
    "event_source_url": "https://seu-dominio/lp",
    "action_source": "website",
    "user_data": {
      "em": ["<sha256>"],
      "ph": ["<sha256>"],
      "fbp": "fb.2.1760000000000.1234567890",
      "fbc": "fb.2.1760000000000.IwAR0abc",
      "client_ip_address": "203.0.113.10",
      "client_user_agent": "Mozilla/5.0 ..."
    }
  }],
  "test_event_code": "TEST12345"
}
```

O token pode ir no parâmetro `access_token` da URL ou no corpo. No corpo é melhor: não aparece em log de requisição.

Fixe a versão da API na URL (`v25.0`). Chamada sem versão segue a versão corrente e muda de comportamento sem aviso.

## Testar

1. Events Manager, aba **Testar eventos**, copie o código e coloque em `META_TEST_EVENT_CODE`.
2. Dispare o evento. Ele aparece na aba em segundos, com os campos recebidos.
3. **Tire o código quando terminar.** Evento com `test_event_code` não conta para otimização nem para relatório.
4. Depois do teste, veja a **Qualidade da correspondência de eventos** por evento. Abaixo de 5,0 há dado faltando ou normalização errada.

## Erros reais e o que significam

| Sintoma | Causa provável |
|---|---|
| Status 200, evento não aparece | `test_event_code` esquecido, ou `event_time` com mais de 7 dias |
| Conversão contando dobrado | `eventID` do pixel diferente do `event_id` do servidor, ou pixel disparando duas vezes |
| Qualidade da correspondência caiu depois do deploy | Mudou a normalização. Compare hash de um valor conhecido antes e depois |
| `Invalid parameter` sem detalhe | Campo com hash que deveria ir cru (`fbp`, `fbc`) ou o contrário |
| Lead no pixel e nenhum no CAPI | O `/tracker` está no caminho que o middleware intercepta, ou CORS bloqueando o POST |
| Taxa de match alta e campanha sem atribuir | Falta `fbc`. Confira se o `fbclid` está sendo lido cru da query |

## Mais de um pixel na mesma página

`fbq('track', 'X')` sem id dispara em **todos** os pixels inicializados na página, e cada pixel reivindica a atribuição na janela dele. Dois pixels de contas diferentes na mesma LP inflam as duas contas com a mesma conversão.

Quando precisar de dois pixels, decida com intenção quais eventos cada um recebe e documente a escolha no código, com a data e o motivo. Alguém vai achar que é esquecimento e "consertar".
