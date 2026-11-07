# Checkout externo: levar a atribuição e trazer de volta

Quando a venda acontece em domínio de terceiro (plataforma de infoproduto, gateway, agendador), o cookie do seu site não existe lá. A plataforma sabe que vendeu e não sabe de onde veio; você sabe de onde veio e não sabe que vendeu. A ponte resolve isso com um identificador seu que viaja de ida e volta.

## A ponte do `trk`, salto por salto

```
1. Visitante chega na página de venda
   O middleware já gravou a sessão com fbp, fbc, gclid e UTMs

2. O JavaScript da página gera trk = crypto.randomUUID()

3. POST /checkout-session  { trk, utms, event_source_url }
   O servidor junta o trk com TUDO o que a sessão tem
   e grava uma linha em `checkout_sessions`

4. O link do checkout é reescrito com o trk num campo livre
   da plataforma (cada uma tem o seu nome)

5. Visitante compra. A plataforma guarda o campo livre

6. A plataforma chama o seu webhook de compra e devolve o trk

7. Lookup em `checkout_sessions` pelo trk:
   voltaram fbp, fbc, gclid, ga_client_id, UTMs, IP, user agent

8. Purchase sai para Meta, GA4 e Google com a atribuição correta
```

O passo 3 é o que torna a ponte confiável: a atribuição é congelada **no momento do clique**, não reconstruída depois.

## O campo livre de cada plataforma

Toda plataforma de checkout tem um parâmetro de rastreamento que ela devolve no webhook. Os nomes variam:

| Plataforma | Parâmetro na URL | Onde volta no webhook |
|---|---|---|
| Hotmart | `xcod` | Campo de tracking do comprador |
| Eduzz | `tracker.code1` (ou `cod1`) | Objeto de tracking |
| Kiwify | `sck` | Campo de tracking |
| Checkout próprio ou gateway | Qualquer campo de metadado livre | Onde você definir |

Confira o nome atual na documentação da plataforma antes de implantar: esses nomes mudam. O jeito honesto de descobrir é fazer uma compra de teste com o campo preenchido e olhar o corpo cru que chegou no webhook.

## Grave o corpo cru antes de qualquer filtro

Regra que paga por si na primeira semana: todo POST que passa a autenticação do webhook vai para uma tabela de log cru **antes** de qualquer validação. Status diferente de pago, reentrega duplicada e JSON quebrado também ficam registrados.

Serve para três coisas:

1. Descobrir os nomes reais dos campos que a plataforma manda (eles raramente batem com a documentação).
2. Reprocessar à mão a venda que caiu num intervalo ruim.
3. Provar o que chegou quando a plataforma afirma que enviou.

O log cru tem dado pessoal do comprador. Nunca exponha em endpoint de leitura.

## Proteger o webhook

- **URL com segredo no caminho.** Rota `/webhook/<plataforma>/<uuid>`, com o UUID guardado como variável de ambiente. Caminho errado responde 404, indistinguível de rota inexistente.
- **Compare o segredo em tempo constante**, não com `===`.
- **Verifique a assinatura quando a plataforma oferecer** (HMAC do corpo, token fixo em cabeçalho). É melhor que a URL secreta: a URL vaza em log de proxy.
- **Variável de ambiente ausente é 500, nunca aceite silencioso.** Webhook que aceita qualquer corpo porque o segredo não foi configurado é porta aberta para conversão falsa.
- **Idempotência pelo id da transação.** Plataforma reentrega. Use índice único no id e trate repetição como sucesso.

## Pegadinhas que custam dia de trabalho

**Id grande virando número errado.** Ids de anúncio e de transação passam de 16 dígitos, acima do inteiro seguro do JavaScript. Se a plataforma manda sem aspas no JSON, o `JSON.parse` arredonda e o id gravado está errado. Conserte no texto cru, pondo aspas nos valores longos antes de interpretar, e peça o campo entre aspas quando quem envia é uma automação sua.

**Status que não é pagamento.** Quase toda plataforma manda evento de carrinho abandonado, boleto gerado, assinatura cancelada e reembolso pela mesma URL. Filtre pelo status e registre o que foi descartado. Disparar Purchase em boleto gerado infla a receita do gerenciador e estraga a otimização.

**Valor com taxa descontada.** Algumas mandam valor bruto, outras líquido, outras os dois com nomes parecidos. Decida qual você quer ver no gerenciador (recomendo o bruto, para casar com o relatório de vendas) e documente a escolha no código.

**Atribuição que o próprio checkout captura.** Várias plataformas guardam referer e URL de entrada e devolvem no webhook. Isso é reserva, nunca substituto: se a sua sessão da LP tem a UTM, ela vale. UTM entra como conjunto inteiro, nunca campo a campo de fontes diferentes, senão você cria uma origem que nunca existiu. Cuidado também com sufixo que o gateway cola na URL (`?reload=1` e parecidos) sujando o valor.

**`fbclid` que só o checkout viu.** Quando a sessão não tem `fbc` e o checkout devolve um `fbclid`, monte o `fbc` com o timestamp da captura: `fb.<index>.<ms>.<fbclid>`.

## Quando não há `trk`

Acontece: visitante abriu o checkout por link salvo, veio de outro canal, ou a plataforma perdeu o campo. Mande a conversão de qualquer forma, com o que existir (e-mail com hash, telefone, valor). Ela conta como venda e não é atribuída a uma campanha. Registre a ausência: a proporção de vendas sem `trk` mede a saúde da ponte, e um salto nesse número é o primeiro sinal de que a plataforma mudou o nome do campo.
