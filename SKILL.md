---
name: trackeamento-conversoes
description: "Monta trackeamento de conversão de ponta a ponta numa landing page hospedada na Cloudflare Pages: pixel no browser, API de conversões server-side (Meta CAPI e GA4 Measurement Protocol), conversão do Google Ads pela Data Manager API com OAuth criado no Google Cloud, cadeia de identidade que sobrevive a ITP e a bloqueador de anúncio, ponte para checkout externo por webhook e envio de evento de fundo de funil (lead qualificado, venda, reembolso) a partir do CRM. Use sempre que pedirem para instalar pixel, configurar API de conversões, CAPI, enviar conversão para o Meta ou para o Google, mandar lead qualificado para plataforma de anúncio, medir atribuição, parar evento duplicado, aumentar taxa de match ou investigar conversão que não aparece no gerenciador, mesmo sem a palavra 'tracking'."
---

# Trackeamento de conversões: pixel, API de conversões e Google

Método para colocar no ar um trackeamento que continua medindo quando o navegador apaga cookie de terceiro, quando o bloqueador derruba o pixel e quando a venda acontece fora do seu domínio. Roda inteiro na Cloudflare Pages (Pages Functions + D1), sem GTM server-side e sem servidor próprio.

O que este método entrega, em três camadas:

1. **Identidade capturada na borda.** Cada visita ganha identificadores gravados em cookie primário de 400 dias e numa linha de banco, antes de qualquer JavaScript rodar.
2. **Conversão enviada pelo servidor.** O evento sai do seu domínio para Meta CAPI, GA4 Measurement Protocol e Google Ads, com o pixel do browser deduplicado pelo mesmo `event_id`.
3. **Fundo de funil reconectado.** Venda em checkout externo e evento de CRM (lead qualificado, contrato assinado, reembolso) voltam a se ligar à visita que os originou e viram conversão nas plataformas.

## Antes de escrever código, levante cinco coisas

Pergunte e anote. Quase todo erro de implantação vem de uma dessas respostas faltando.

| Item | Por que trava se faltar |
|---|---|
| Onde a LP está hospedada e qual o domínio final | Cookie primário e `sub_domain_index` do Meta dependem do domínio real, não do `*.pages.dev` |
| Onde a conversão acontece: no seu domínio ou em checkout de terceiro | Checkout externo exige a ponte do `trk` (`references/checkout-externo.md`), que é outra implantação |
| Quais plataformas recebem o evento | Meta, Google e GA4 pedem credencial diferente e normalização de dado diferente |
| Quem é a fonte da verdade do funil: a LP ou um CRM | Define quem controla a idempotência do evento de fundo de funil |
| Se existe consentimento de cookie na página | Decide se o evento sai sempre ou só com consentimento (`references/privacidade.md`) |

## Ordem de implantação

Siga nesta ordem. Cada fase é verificável sozinha, e pular para a seguinte sem provar a anterior é o jeito mais rápido de passar uma semana atrás de um evento que nunca chegou.

### Fase 1: banco e identidade na borda

1. Crie o banco D1 e aplique `templates/schema.sql`.
2. Instale `templates/functions/_middleware.js`. Ele gera `_trk_sid` e `_trk_eid`, monta `_fbp` e `_fbc` conforme a especificação do Meta, captura `gclid`, `wbraid`, `gbraid`, `msclkid` e as UTMs, grava a linha em `sessions` e serve a página sem esperar o banco.
3. Prove: abra a LP com `?fbclid=teste123&gclid=teste456&utm_source=prova`, confira os cookies no navegador e a linha em `sessions`.

Por que o cookie é escrito pelo servidor, e não pelo pixel: cookie criado por JavaScript vive 7 dias no Safari (ITP) e não nasce quando o bloqueador impede o script do Meta. Escrito pelo cabeçalho HTTP do seu próprio domínio, vive 400 dias e nasce sempre. Essa troca sozinha costuma recuperar entre 15% e 30% dos eventos.

### Fase 2: pixel no browser com dedupe

1. Cole o bloco de `templates/lp-snippet.html` na LP.
2. Todo evento nasce com um `event_id` (`crypto.randomUUID()`) usado nas duas pontas: no `eventID` do pixel e no `event_id` do envio pelo servidor.
3. Prove: no Events Manager, o evento aparece com as duas origens e sem contagem dobrada.

### Fase 3: API de conversões (servidor)

1. Instale `templates/functions/tracker.js`, o endpoint `POST /tracker`.
2. Configure os segredos de Meta e GA4 (`templates/.dev.vars.example` lista todos).
3. Leia `references/meta.md` antes de mexer no hash de dado pessoal: normalização errada derruba a taxa de match sem dar erro nenhum.
4. Prove com o `test_event_code` do Meta e com o DebugView do GA4.

### Fase 4: Google

1. Crie o projeto e as credenciais seguindo `references/google-cloud.md`. É a fase mais burocrática: projeto, API habilitada, tela de consentimento, cliente OAuth e refresh token.
2. Gere o refresh token com `scripts/oauth-google.mjs` (roda na sua máquina, abre o navegador, imprime o token).
3. Leia `references/google-conversoes.md` e escolha o caminho: **Data Manager API** (`events:ingest`, o caminho atual para quem está começando) ou `uploadClickConversions` da API do Google Ads (só funciona para conta que já importava por ele).
4. Prove com `validateOnly: true`, que confere credencial, conta, ação e formato sem gravar conversão.

### Fase 5: checkout externo (só se a venda sai do seu domínio)

Leia `references/checkout-externo.md`. Instale `templates/functions/checkout-session.js` e `templates/functions/webhook/compra.js`. O resumo da ponte: a página de venda gera um `trk`, grava a atribuição inteira ligada a ele, passa o `trk` para o checkout num campo livre, e o webhook de compra devolve esse `trk` para você reconstruir de onde a venda veio.

### Fase 6: evento de fundo de funil a partir do CRM

Leia `references/evento-do-crm.md`. Instale `templates/functions/api/conversao-crm.js`. É o que faz o algoritmo da plataforma otimizar por lead que vale, em vez de otimizar por volume de formulário preenchido.

## Regras duras

- **Nunca envie dado pessoal cru para plataforma de anúncio.** E-mail, telefone e nome vão em SHA-256 depois de normalizados. Cada plataforma normaliza diferente: `references/meta.md` e `references/google-conversoes.md` trazem as duas tabelas.
- **Nunca grave `PageView` no banco.** O evento continua saindo para as plataformas, só não vira linha. PageView é cerca de 70% do volume de escrita e nenhum relatório de conversão usa.
- **Todo SQL com `.bind()`.** Nenhuma interpolação de string com valor que veio do visitante.
- **Pixel e servidor compartilham o `event_id`.** Sem isso, toda conversão conta duas vezes e o custo por resultado aparece pela metade.
- **Não queime evento com robô.** Prévia de link do WhatsApp, `facebookexternalhit` e crawler disparam PageView de verdade. O filtro de user agent fica no `tracker.js`.
- **Segredo por função, nunca compartilhado.** A senha do cron, a do painel e a do webhook de terceiro são três valores diferentes: trocar um não pode derrubar os outros.
- **Na Cloudflare Pages, o deploy publica a pasta inteira.** Não existe filtro de arquivo (o `.assetsignore` não é respeitado pelo `wrangler pages deploy`). Qualquer arquivo na pasta fica acessível em `https://seu-dominio/<caminho>`. Bloqueie o que não é público com regra `301` no `_redirects`, e nunca deixe segredo em arquivo dentro da pasta publicada.
- **Idempotência tem um dono só.** Quem decide "este evento já foi enviado" é quem tem a fonte da verdade (normalmente o CRM). Quem envia obedece e devolve o resultado.

## Mapa dos arquivos

| Arquivo | Papel |
|---|---|
| `templates/functions/_middleware.js` | Roda em toda requisição de página: gera identificador, monta `_fbp` e `_fbc`, grava `sessions` |
| `templates/functions/_tracking-lib.js` | Hash, normalização por plataforma, filtro de robô, envio para Meta, GA4 e Google, leitura de resultado. Importado pelos outros |
| `templates/functions/tracker.js` | `POST /tracker`: recebe o evento do browser, faz hash do dado pessoal, dispara Meta CAPI e GA4, registra o resultado |
| `templates/functions/checkout-session.js` | `POST /checkout-session`: guarda a atribuição ligada ao `trk` antes de o visitante sair para o checkout |
| `templates/functions/webhook/compra.js` | Recebe a compra do checkout externo, acha o `trk`, enriquece e dispara Purchase para as três plataformas |
| `templates/functions/api/conversao-crm.js` | Recebe do CRM os eventos de fundo de funil e envia com `action_source` de sistema |
| `templates/lp-snippet.html` | Bloco para colar na LP: pixel, GA4, dedupe por `event_id`, envio no submit |
| `templates/schema.sql` | Tabelas `sessions`, `event_log`, `checkout_sessions`, `purchase_log`, `envio_crm` |
| `templates/wrangler.toml.example` | Binding do D1 e nome do projeto |
| `templates/.dev.vars.example` | Lista completa de segredos, com comentário de onde achar cada um |
| `scripts/oauth-google.mjs` | Gera o refresh token do Google na sua máquina |
| `scripts/testar-envio.mjs` | Dispara um evento de teste para cada plataforma e imprime a resposta crua |

## Referências

| Para… | Leia |
|---|---|
| Entender a cadeia de identidade salto por salto | `references/arquitetura.md` |
| Pixel, CAPI, hash, dedupe e taxa de match do Meta | `references/meta.md` |
| GA4: Measurement Protocol, `client_id`, janelas e nome de evento | `references/ga4.md` |
| Criar projeto, habilitar API, cliente OAuth e refresh token | `references/google-cloud.md` |
| Enviar conversão para o Google (Data Manager e API do Google Ads) | `references/google-conversoes.md` |
| Venda em checkout de terceiro | `references/checkout-externo.md` |
| Lead qualificado, venda confirmada e reembolso saindo do CRM | `references/evento-do-crm.md` |
| Consentimento, dado pessoal e retenção | `references/privacidade.md` |
| Provar que cada salto funciona, e achar onde quebrou | `references/verificacao.md` |
| Adicionar uma plataforma que não está aqui | `references/outra-plataforma.md` |

## Decisões com padrão pronto

Mude só sabendo por quê.

| Decisão | Padrão | Como trocar |
|---|---|---|
| Prefixo dos cookies próprios | `_trk_sid`, `_trk_eid` | Troque nos dois lugares: `_middleware.js` e `tracker.js` |
| Validade do cookie | 400 dias (teto que o Chrome aceita) | `maxAge` no `_middleware.js` |
| Código de país do telefone | `55` | Segredo `DEFAULT_COUNTRY_CODE` |
| Fuso do horário da conversão no Google | `-03:00` | Segredo `TIMEZONE_OFFSET`, no fuso da conta de anúncio |
| `PageView` no banco | Não grava | Trecho `shouldLogEvent` do `tracker.js` |
| Retenção de dado pessoal cru | Guarda sem prazo | Worker agendado com `DELETE`, ver `references/privacidade.md` |
| Moeda | `BRL` | Segredo `DEFAULT_CURRENCY` |
