# Adicionar uma plataforma que não está aqui

Meta, GA4 e Google Ads vêm prontos. TikTok, LinkedIn, Pinterest, Kwai, Microsoft Ads e qualquer plataforma nova seguem o mesmo molde: todas copiaram a mesma ideia. Levante cinco respostas e a implementação sai em meia hora.

## As cinco respostas

| Pergunta | No Meta, por exemplo |
|---|---|
| Qual o parâmetro de clique na URL? | `fbclid` |
| Qual o cookie ou identificador de navegador? | `_fbp` |
| Qual o endpoint de eventos de servidor e a autenticação? | `graph.facebook.com/.../events`, token de acesso |
| Como o dado pessoal é normalizado antes do hash? | Minúsculas e trim, telefone com país |
| Como o evento de browser é deduplicado com o de servidor? | `event_id` compartilhado |

Com isso respondido, o resto é escrever a função de envio.

## Mapa de partida das principais

Confirme na documentação atual de cada uma antes de implantar: endpoint, nome de campo e versão mudam.

| Plataforma | Parâmetro de clique | API de servidor | Chave de dedupe |
|---|---|---|---|
| TikTok | `ttclid` | Events API | `event_id` |
| LinkedIn | `li_fat_id` | Conversions API | Identificador do usuário |
| Pinterest | `epik` | Conversions API | `event_id` |
| Microsoft Ads | `msclkid` | Conversões offline (UET) | Id de transação |
| Kwai | `click_id` | Events API | `event_id` |
| Snapchat | `ScCid` | Conversions API | `client_dedup_id` |

O `_middleware.js` já captura `msclkid`. Para as outras, acrescente o parâmetro na captura e uma coluna em `sessions`.

## Onde encaixar no código

1. **Capture o identificador.** Em `_middleware.js`, adicione o parâmetro à leitura crua da query (use a função `getRawParam`, nunca `searchParams.get`, para não decodificar o valor) e à gravação em `sessions`.

2. **Acrescente a coluna.** Um arquivo SQL novo com `ALTER TABLE sessions ADD COLUMN ttclid TEXT;` e as colunas de resposta em `event_log`, no mesmo padrão das existentes.

3. **Escreva a função de envio** em `tracker.js`, no formato das que já existem:

```js
async function enviarParaPlataforma({ body, identificadores, hashes, env }) {
  if (!env.PLATAFORMA_TOKEN || !env.PLATAFORMA_PIXEL_ID) {
    return { skipped: 'credencial ausente', payload: null, response: null };
  }
  const payload = { /* formato da plataforma */ };
  const payloadJson = JSON.stringify(payload);
  const response = await fetch('https://endpoint-da-plataforma', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.PLATAFORMA_TOKEN}` },
    body: payloadJson,
  });
  return { payload: payloadJson, response };
}
```

Duas regras do formato: **devolva sempre `{ payload, response }`**, para o chamador registrar a resposta crua, e **nunca lance exceção por credencial faltando**, devolva `skipped`. Plataforma não configurada não pode derrubar as outras.

4. **Inclua no disparo paralelo.** Adicione a chamada no `Promise.allSettled` e trate o resultado no mesmo padrão. `allSettled` é essencial: uma plataforma fora do ar não pode impedir as outras de receber.

5. **Registre o resultado.** Grave status e corpo na linha do `event_log`.

## Erros que todas cometem

- **Nome de evento próprio.** Quase nenhuma usa `Lead` ou `Purchase` com esse nome. Faça o mapeamento num objeto no topo do arquivo.
- **Normalização diferente.** Algumas pedem telefone em E.164 com `+`, outras só dígitos. Algumas pedem hash em base64, não em hexadecimal.
- **Janela de idade do evento.** Varia de 24 horas a 7 dias. Documente a sua no código.
- **Limite de requisição.** Plataformas menores derrubam a chamada em volume de pico. Lote ou fila resolve.
- **Resposta 200 com erro no corpo.** O padrão que o Google criou virou comum. Sempre leia o corpo.

## Vale a pena?

Cada plataforma a mais é um endpoint para manter, uma credencial para rotacionar e um lugar a mais para quebrar em silêncio. Só adicione plataforma onde existe verba real e otimização automática em jogo. Para canal de teste com verba pequena, UTM mais o relatório do seu banco já responde de onde veio a venda.
