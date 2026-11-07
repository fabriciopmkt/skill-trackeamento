# skill-trackeamento

Skill de [Claude Code](https://claude.com/claude-code) para montar trackeamento de conversão de ponta a ponta numa landing page na Cloudflare Pages: pixel no browser, API de conversões server-side e conversão offline para o Google Ads, com a cadeia de identidade que sobrevive ao ITP do Safari e ao bloqueador de anúncio.

Nasceu de uma operação real de tráfego pago com LP na Cloudflare Pages e checkout externo. Os erros que custaram tempo estão documentados como regra, não como teoria.

## O que ela cobre

- **Identidade na borda.** `_fbp`, `_fbc`, `gclid`, `wbraid`, `gbraid`, `msclkid`, UTMs e um id de visita, gravados em cookie primário de 400 dias pelo cabeçalho HTTP e numa tabela de sessões, antes de qualquer JavaScript rodar.
- **Meta.** Pixel no browser e Conversions API no servidor, deduplicados pelo mesmo `event_id`, com a tabela de normalização e hash que define a taxa de match.
- **GA4.** Measurement Protocol com o `client_id` lido do cookie `_ga`, nome de evento certo e as janelas de tempo que o Google descarta em silêncio.
- **Google Ads.** Conversão de clique e conversão vinda do CRM pela **Data Manager API** (`events:ingest`), incluindo o passo a passo do Google Cloud (projeto, API, tela de consentimento, cliente OAuth, refresh token) e por que o `uploadClickConversions` da API do Google Ads não serve mais para quem está começando agora.
- **Checkout externo.** A ponte que leva a atribuição até um checkout de terceiro e a recupera no webhook de compra.
- **Evento de fundo de funil.** Mandar "lead qualificado", "contrato assinado" ou "reembolso" do CRM para as plataformas, com controle de idempotência e simulação antes do envio real.
- **Verificação.** Sete pontos de checagem que provam cada salto da cadeia, do cookie até o evento aparecer no gerenciador.

Tudo roda em Cloudflare Pages Functions + D1. Sem GTM server-side, sem container pago, sem servidor.

## Instalar

```bash
git clone https://github.com/SEU-USUARIO/skill-trackeamento ~/.claude/skills/trackeamento-conversoes
```

Reabra o Claude Code e peça algo como "instala o pixel e a API de conversões nessa LP". A skill é acionada pela descrição, sem comando.

Para usar num projeto só, clone em `.claude/skills/trackeamento-conversoes` dentro do repo.

## Como está organizado

```
SKILL.md              ordem de implantação em 6 fases, regras duras, decisões com padrão
references/           um arquivo por assunto, lido sob demanda
templates/            código para copiar: middleware, endpoints, schema, snippet da LP
scripts/              refresh token do Google e disparo de evento de teste
```

## O que esta skill não faz

- Não cria a LP. Ela instala trackeamento em página que já existe.
- Não gerencia campanha nem lê métrica de plataforma.
- Não substitui análise jurídica de privacidade. `references/privacidade.md` traz o que a arquitetura resolve e o que continua decisão sua.

## Licença

MIT. Nenhuma credencial, id de conta, domínio ou dado de cliente está neste repositório: todo valor sensível aparece como variável de ambiente.
