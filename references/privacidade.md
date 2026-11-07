# Consentimento, dado pessoal e retenção

Este arquivo descreve o que a arquitetura resolve e o que continua decisão de quem implanta. Não é parecer jurídico.

## O que sai do seu servidor

| Dado | Como vai | Para quem |
|---|---|---|
| E-mail, telefone, nome | SHA-256, nunca cru | Meta, Google |
| IP e user agent | Crus | Meta (exigidos para evento de site) |
| `fbp`, `fbc`, `gclid`, `ga_client_id` | Crus | A plataforma que os criou |
| Valor, moeda, nome do produto | Crus | Todas |

Dado pessoal cru fica no **seu** banco, para depuração, e nunca é enviado para plataforma de anúncio.

Vale saber: hash não é anonimização. O e-mail com hash é um identificador pseudônimo, e é justamente por ser determinístico que a plataforma consegue casar a pessoa. Trate a coluna de hash com o mesmo cuidado da coluna crua.

## Consentimento

A arquitetura é compatível com três posturas. Escolha uma com intenção, implante e documente:

| Postura | Como fica | Quando faz sentido |
|---|---|---|
| **Enviar sempre** | O middleware grava e o evento sai independente do banner | Público só no Brasil, com base legal de legítimo interesse avaliada, e banner informativo |
| **Esperar o consentimento** | O middleware grava a sessão, e o `/tracker` só dispara quando o corpo traz consentimento aceito | Público na União Europeia ou no Reino Unido, ou política interna mais conservadora |
| **Dois níveis** | Evento sai sempre com dado mínimo (sem identificador pessoal) e completo com consentimento | Operação que quer medir volume sem perder conformidade |

O `event_log` tem a coluna `consent_status` justamente para você conseguir provar depois o que foi enviado sob qual condição. Preencha com o estado real, nunca com um valor fixo.

Para a postura de esperar: mande o estado do consentimento no corpo do POST e trate a ausência como negativa. O Meta tem o Consent Mode do pixel no browser e o Google tem o campo de consentimento nos payloads de conversão: quando você opera sob regime europeu, preencher esses campos é obrigatório, e evento sem eles pode ser descartado.

## Lista do que nunca pode acontecer

- Dado pessoal cru em URL, query string ou log de requisição.
- Segredo em arquivo dentro da pasta publicada pela Cloudflare Pages (o deploy publica tudo, sem filtro).
- Endpoint de leitura devolvendo a coluna de e-mail cru ou o corpo cru de webhook sem autenticação.
- Dado de pessoa física identificada em relatório compartilhado fora da operação.
- Hash do e-mail usado como identificador público (em URL, em id de elemento, em parâmetro de link).

## Retenção

O padrão desta arquitetura é guardar sem prazo, que é a escolha errada para quase todo mundo. Uma rotina agendada resolve:

```sql
-- Apaga dado pessoal cru de eventos com mais de 180 dias,
-- mantendo a linha para o relatório agregado
UPDATE event_log
   SET raw_email = NULL
 WHERE timestamp < unixepoch() - 15552000
   AND raw_email IS NOT NULL;

-- Apaga sessões antigas que nunca viraram evento
DELETE FROM sessions
 WHERE created_at < unixepoch() - 15552000
   AND session_id NOT IN (SELECT session_id FROM event_log WHERE session_id IS NOT NULL);
```

Escolha o prazo pela utilidade real: o ciclo de venda mais longo que você mede, mais uma folga. Guardar além disso aumenta risco sem aumentar informação.

O corpo cru de webhook merece prazo mais curto (30 a 90 dias): ele serve para depurar integração, e tem dado de pagamento do comprador.

## Direito do titular

Quando alguém pede exclusão, você precisa achar e apagar em três lugares:

1. **Seu banco:** `event_log` (por `raw_email`), `sessions` (pelos `session_id` ligados), `purchase_log` e a tabela de envio de CRM.
2. **As plataformas:** o Meta tem a API de exclusão de dados e o Google tem remoção por identificador. Encaminhe, não prometa o que só a plataforma faz.
3. **Suas ferramentas de e-mail e CRM**, que não são tratadas por esta skill.

Ter uma consulta pronta para localizar tudo por e-mail é parte da implantação, não um extra.

## Página de política

Se você captura lead, a página precisa dizer, em linguagem simples: quais dados coleta, para quê, com quem compartilha (nomeie Meta e Google), por quanto tempo guarda e como pedir exclusão. Link visível no formulário e no rodapé. É o requisito mais fácil de cumprir e o mais esquecido.
