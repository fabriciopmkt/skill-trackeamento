# Enviar conversão para o Google

## Escolha o caminho antes de escrever código

| Caminho | Serve para | Limite |
|---|---|---|
| Tag no site (`gtag`) | Conversão que acontece na sua página | Morre com bloqueador e com ITP. Não cobre conversão offline |
| **Data Manager API** (`events:ingest`) | Conversão de clique e conversão vinda do CRM | É o caminho atual. Sem falha parcial: um campo ruim derruba a chamada inteira |
| `uploadClickConversions` da API do Google Ads | O mesmo, pela API antiga | **Só funciona para conta que já importava por ele.** Ver abaixo |
| Enhanced conversions for leads | Conversão sem `gclid`, casada por e-mail com hash | Exige aceitar os termos de dados do cliente na conta |
| `offlineUserDataJob` | Público de Customer Match | Não é conversão, é lista de audiência |

**Comece pela Data Manager API.** Ela cobre conversão de clique e conversão de CRM com o mesmo endpoint, não pede developer token e não depende de allowlist.

### Por que o `uploadClickConversions` não serve mais para começar agora

Em meados de 2026 o Google passou a restringir o `uploadClickConversions` da API do Google Ads às contas que já importavam conversão por ele. Conta nova recebe:

```
CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE
```

Testado em outubro de 2026 na v23 com developer token aprovado em nível Básico: o erro aparece mesmo com credencial, ação e payload corretos. Se você já tem integração antiga funcionando, ela continua: não há motivo para migrar com pressa. Para integração nova, use a Data Manager API.

## 1. Crie a ação de conversão

Na interface do Google Ads, em **Objetivos > Conversões > Nova ação de conversão > Importar > Outras fontes de dados ou CRM**.

Escolha o subtipo:

| Subtipo | Quando |
|---|---|
| Monitorar conversões de cliques | Você tem `gclid`. É o caso normal |
| Monitorar conversões de chamadas | Conversão de ligação |

Configure:

| Campo | Recomendação |
|---|---|
| Categoria | A que descreve o evento. Para lead que passou pela qualificação, **Lead qualificado**. Para venda, **Compra** |
| Valor | Valor real quando existir. Valor fixo quando não existir, para o algoritmo ter escala |
| Contagem | **Uma** para lead, **Todas** para venda recorrente |
| Janela de conversão de clique | 30 dias para lead, até 90 se o ciclo for longo |
| Ação de conversão principal | Marque **só** o que você quer que a campanha otimize |

**O erro que anula o trabalho:** mandar a conversão para uma ação secundária, que não entra em nenhuma estratégia de lance. O evento chega, aparece no relatório, e o algoritmo ignora. Confira se a ação está entre as principais da campanha.

Pegue o id numérico da ação na URL da tela dela (`ctId=` ou o parâmetro equivalente), ou pela API do Google Ads consultando `conversion_action`.

## 2. Normalização que o Google espera

Diferente do Meta. Aplique antes do SHA-256:

| Campo | Normalização |
|---|---|
| E-mail | Minúsculas, sem nenhum espaço. **Em `gmail.com` e `googlemail.com`**, remova os pontos do nome e o `+sufixo` |
| Telefone | Formato E.164 antes do hash: `+5511987654321` |
| Nome e sobrenome | Minúsculas, sem espaço nas pontas |
| CEP | Sem hash. Vai cru |
| País | Sem hash. Código ISO de duas letras |

O `emailAddress` do Google aceita hash em hexadecimal ou em base64; declare qual com `encoding: "HEX"` ou `"BASE64"` no corpo. O hash em hexadecimal minúsculo é o mesmo que o Meta usa, então a mesma função serve para os dois. Só a normalização do e-mail difere.

## 3. Data Manager API

```
POST https://datamanager.googleapis.com/v1/events:ingest
Authorization: Bearer <access_token>
Content-Type: application/json
```

```json
{
  "destinations": [{
    "operatingAccount": { "accountType": "GOOGLE_ADS", "accountId": "1234567890" },
    "loginAccount":     { "accountType": "GOOGLE_ADS", "accountId": "9876543210" },
    "productDestinationId": "987654321"
  }],
  "encoding": "HEX",
  "events": [{
    "adIdentifiers": { "gclid": "Cj0KCQ..." },
    "eventTimestamp": "2026-11-07T14:32:10Z",
    "transactionId": "lq-00042",
    "eventSource": "WEB",
    "conversionValue": 1200.00,
    "currency": "BRL",
    "userData": {
      "userIdentifiers": [{ "emailAddress": "<sha256 do e-mail normalizado>" }]
    }
  }],
  "validateOnly": false
}
```

O que cada parte faz:

- `operatingAccount`: a conta que é dona da ação de conversão.
- `loginAccount`: a conta administradora pela qual o usuário do OAuth tem acesso. Omita se não houver MCC.
- `productDestinationId`: o id numérico da ação de conversão.
- `adIdentifiers`: `gclid`, `gbraid` ou `wbraid`. Mande o que você tem, com `gclid` em primeiro lugar.
- `transactionId`: a chave de dedupe. Use um valor determinístico derivado do registro de origem (`lq-<id do negócio>`, `venda-<id da transação>`). Reenvio do mesmo evento não cria conversão nova.
- `eventSource`: `WEB` para evento que começou no site, `CRM` para evento que nasceu no seu sistema.
- `userData`: identificadores com hash. Sem `adIdentifiers`, é por aqui que o Google casa a conversão (o caminho de enhanced conversions for leads).

**Sem falha parcial.** Diferente da API do Google Ads, aqui um evento inválido derruba o lote inteiro. Mande um evento por chamada, ou lotes pequenos, e registre o corpo da resposta.

## 4. `uploadClickConversions` (integração existente)

```
POST https://googleads.googleapis.com/v21/customers/<CUSTOMER_ID>:uploadClickConversions
Authorization: Bearer <access_token>
developer-token: <DEVELOPER_TOKEN>
login-customer-id: <MCC_ID>
```

```json
{
  "conversions": [{
    "conversionAction": "customers/1234567890/conversionActions/987654321",
    "conversionDateTime": "2026-11-07 14:32:10-03:00",
    "conversionValue": 1200.00,
    "currencyCode": "BRL",
    "orderId": "venda-12345",
    "gclid": "Cj0KCQ...",
    "userIdentifiers": [{ "hashedEmail": "<sha256>" }]
  }],
  "partialFailure": true,
  "validateOnly": false
}
```

Três detalhes que custam tempo:

1. **Fixe a versão na URL.** As bibliotecas oficiais ficam atrás da API REST e quebram com "API version not found". Chamar REST direto resolve.
2. **O fuso do `conversionDateTime` tem que ser o da conta de anúncio.** Formato `YYYY-MM-DD HH:MM:SS±HH:MM`. Fuso errado joga a conversão para antes do clique e o Google recusa com `CONVERSION_PRECEDES_GCLID`.
3. **Status 200 não quer dizer sucesso.** Com `partialFailure: true`, o corpo pode trazer `partialFailureError` e nada foi gravado. Leia o corpo e trate como falha.

## 5. Janelas e prazos

| Regra | Valor |
|---|---|
| Idade máxima do clique | A janela de conversão da ação (padrão 30 dias, até 90) |
| Atraso até aparecer no relatório | Até 3 horas, em geral menos |
| Atraso até influenciar lance | A estratégia leva alguns dias para reagir |
| Importação mais recomendada | Diária ou contínua. Não acumule semanas |

Conversão fora da janela não dá erro útil: ela simplesmente não aparece. Ao depurar, compare a data do clique com a janela da ação antes de suspeitar do código.

## 6. Erros reais

| Erro | Causa |
|---|---|
| `CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE` | `uploadClickConversions` em conta nova. Use a Data Manager API |
| `CONVERSION_PRECEDES_GCLID` | Fuso errado no horário, ou horário anterior ao clique |
| `NO_CONVERSION_ACTION_FOUND` | Id da ação errado, ou ação em outra conta |
| `CLICK_NOT_FOUND` | `gclid` inválido, de outra conta, ou clique fora da janela |
| `INVALID_USER_IDENTIFIER` | Hash com maiúscula, com espaço, ou e-mail sem a normalização do Gmail |
| `DUPLICATE_TRANSACTION_ID` ou conversão não contabilizada | Esperado em reenvio. É o dedupe funcionando |
| `PERMISSION_DENIED` | Falta `loginAccount`, ou o usuário do OAuth não tem acesso à conta |
| Chamada inteira falhando sem campo apontado | Data Manager não tem falha parcial. Mande um evento por chamada para descobrir qual |

## 7. Quando não existe `gclid`

Acontece sempre: lead que veio de busca orgânica, de indicação, ou de campanha onde o parâmetro foi perdido num redirecionamento. Duas respostas:

1. **Mande com `userData` e sem `adIdentifiers`.** É o caminho de enhanced conversions for leads: o Google casa pelo e-mail com hash. Exige aceitar os termos de dados do cliente na conta de anúncio.
2. **Aceite o teto.** Nenhuma conversão sem identificador de clique será atribuída a uma campanha específica. Medir a taxa de match (quantos dos seus eventos têm `gclid`) é mais útil que persegui-la: ela mostra quanto do seu funil vem de mídia rastreável.

Antes de qualquer suspeita de código, verifique se o `gclid` está chegando na URL de destino. Redirecionamento que não preserva query string é a causa mais comum, e aparece no `sessions.landing_url`.
