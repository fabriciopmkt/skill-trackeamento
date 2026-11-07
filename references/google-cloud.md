# Google Cloud: projeto, API, OAuth e refresh token

A parte técnica do envio de conversão para o Google é pequena. A parte burocrática é esta, e ela esconde duas armadilhas que fazem o trackeamento funcionar por uma semana e parar sozinho. Siga na ordem.

## 1. Projeto

1. Abra `console.cloud.google.com` logado na conta que tem acesso à conta de anúncio.
2. Crie um projeto. Nome livre, algo como `trackeamento-conversoes`.
3. Anote o id do projeto.

Não precisa de faturamento ativo para as APIs de conversão.

## 2. Habilite a API que você vai usar

Em **APIs e serviços > Biblioteca**, habilite:

| API | Nome na biblioteca | Quando |
|---|---|---|
| Data Manager API | `Data Manager API` | Caminho atual para enviar conversão. Habilite sempre |
| Google Ads API | `Google Ads API` | Só se você vai ler métrica da conta, ou se já importava conversão por ela |

## 3. Tela de consentimento OAuth

Em **APIs e serviços > Tela de permissão OAuth**:

1. Tipo de usuário: **Externo** (se a conta não é Google Workspace) ou **Interno** (se é, e todo mundo que vai autorizar está no mesmo domínio).
2. Preencha nome do app, e-mail de suporte e e-mail do desenvolvedor.
3. Em **Usuários de teste**, adicione o e-mail que vai autorizar.

### Armadilha 1: o refresh token de 7 dias

**App externo em modo "Em teste" tem refresh token que expira em 7 dias.** O trackeamento funciona, você comemora, e na semana seguinte toda conversão falha com `invalid_grant` sem nenhuma mudança no código.

Saídas, em ordem de preferência:

1. **Publique o app** (botão "Publicar app" na tela de consentimento). Como ele usa escopo sensível e só você autoriza, fica em "Produção" sem precisar de verificação do Google para uso próprio. O refresh token passa a não expirar por tempo.
2. **Use tipo Interno**, se a conta é Workspace. Interno não tem o limite de 7 dias.
3. Se precisar ficar em teste por algum motivo, coloque um alarme para regerar o token toda semana. É ruim: não faça isso em produção.

Mesmo publicado, o refresh token morre se: você revogar o acesso, trocar a senha da conta em alguns casos, ficar seis meses sem usar, ou gerar mais de 100 tokens para o mesmo par de cliente e usuário (o mais antigo cai).

### Armadilha 2: conta de serviço não serve

Conta de serviço parece o caminho certo para servidor, e não funciona aqui: a API do Google Ads recusa conta de serviço, a menos que exista delegação de domínio no Workspace. O caminho testado é OAuth de usuário com refresh token guardado como segredo. Trate o refresh token como senha.

## 4. Cliente OAuth

Em **APIs e serviços > Credenciais > Criar credenciais > ID do cliente OAuth**:

- Tipo de aplicativo: **App para computador**. Ele aceita `http://localhost` como retorno, que é o que o script de geração usa.
- Anote **Client ID** e **Client secret**.

Se preferir tipo "Aplicativo da Web", adicione `http://localhost:8787/oauth/callback` em URIs de redirecionamento autorizados e use a mesma porta no script.

## 5. Escopos

Peça só o que vai usar:

| Escopo | Para |
|---|---|
| `https://www.googleapis.com/auth/datamanager` | Data Manager API: enviar conversão |
| `https://www.googleapis.com/auth/adwords` | Google Ads API: ler métrica, ou o `uploadClickConversions` antigo |

Os dois podem ir no mesmo token, mas vale gerar credenciais separadas: o token de leitura de métrica roda num cron e o de conversão no caminho da venda. Separado, rotacionar um não derruba o outro.

## 6. Gere o refresh token

Na sua máquina:

```bash
node scripts/oauth-google.mjs
```

O script sobe um servidor local, abre o navegador, recebe o código de autorização e troca por tokens. Ele pede `access_type=offline` e `prompt=consent`, que é o que garante o refresh token na resposta (sem `prompt=consent`, a segunda autorização volta sem refresh token e você acha que o script quebrou).

Guarde o que sair:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
```

## 7. Developer token (só para a API do Google Ads)

A Data Manager API **não** usa developer token. A API do Google Ads usa, e ele vem de outro lugar: na conta administradora (MCC), em **Ferramentas > Central de API**.

| Nível | O que dá |
|---|---|
| Teste | Só conta de teste. Não serve para produção |
| Básico | Produção, com limite diário de operações. Suficiente para esse uso |
| Padrão | Limite alto |

Para sair de Teste, você envia um formulário descrevendo a ferramenta. Descreva o que ela é de verdade: ferramenta interna, para a sua própria conta, que envia conversão primária e lê métrica. Deixe claro que não é comercializada e não acessa conta de terceiro.

## 8. Ids da conta

| Variável | O que é | Onde achar |
|---|---|---|
| `GOOGLE_ADS_CUSTOMER_ID` | Conta que é dona da ação de conversão | Canto superior da interface do Google Ads, só dígitos, sem hífen |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Conta administradora (MCC) pela qual o usuário do OAuth acessa | Id do MCC, só dígitos. Deixe vazio se a conta não está sob MCC |
| `GOOGLE_ADS_CONVERSION_ACTION_ID` | Id numérico da ação de conversão | Ver `references/google-conversoes.md` |

Sempre tire os hífens no código. `123-456-7890` vira `1234567890`.

## 9. Prove sem gravar nada

Toda chamada aceita `validateOnly: true`. Ela confere credencial, conta, ação e formato do payload e devolve erro detalhado, sem criar conversão. Use antes do primeiro envio real, depois de qualquer troca de credencial e sempre que mexer no payload.

## Erros de autenticação e o que significam

| Erro | Causa |
|---|---|
| `invalid_grant` | Refresh token expirado (app em modo teste), revogado, ou do cliente OAuth errado |
| `invalid_client` | Client id e secret não são do mesmo cliente, ou um deles tem espaço colado |
| `access_denied` na autorização | O e-mail não está em usuários de teste, ou o app está em teste e você usou outra conta |
| Resposta sem `refresh_token` | Faltou `access_type=offline` ou `prompt=consent` |
| `PERMISSION_DENIED` com escopo ok | A API não foi habilitada no projeto, ou o usuário não tem acesso à conta de anúncio |
| `USER_PERMISSION_DENIED` | Falta a conta de login (MCC), ou o usuário não tem permissão nela |
| `DEVELOPER_TOKEN_NOT_APPROVED` | Developer token ainda em nível Teste |
| `CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE` | Caso do `uploadClickConversions`. Ver `references/google-conversoes.md` |
