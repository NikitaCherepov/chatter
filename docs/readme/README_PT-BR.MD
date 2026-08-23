[English](../../README.MD) | [Русский](README_RU.MD) | [Deutsch](README_DE.MD) | [Español](README_ES.MD) | [Français](README_FR.MD) | [Italiano](README_IT.MD) | [日本語](README_JA.MD) | [한국어](README_KO.MD) | [Polski](README_PL.MD) | **Português (BR)** | [中文（简体）](README_ZH-CN.MD) | [Türkçe](README_TR.MD) | [Čeština](README_CS.MD)

---

# O que e o Chatter?

Chatter e um sistema multiplataforma com um agente de IA que roda em um servidor e pode ser compartilhado com amigos ou familiares com um clique! Voce tambem pode implantar seu proprio servico com planos, limites e gerenciamento conveniente.

Os preços dos modelos são obtidos automaticamente do OpenRouter. Tudo que você precisa é definir um orçamento para a assinatura.

> **O sistema de pagamento ainda nao foi integrado!**

![Chatter conecta Telegram e Desktop](../assets/chatter-telegram-desktop.gif)

Queria compartilhar IA com sua mae, mas ela acha a tecnologia complicada demais? De a ela seu bot do Telegram. Curva de aprendizado zero.

Queria seu proprio Jarvis que acende as luzes, responde a comandos de voz e abaixa as persianas a noite? Apos conectar a integracao de casa inteligente, o Chatter pode fazer isso sem codigo adicional ou tokens desperdicados.

Ou talvez voce so quisesse interpretar papeis com um bot, mas nao queria fuçar em configuracoes, subir um servidor local e descobrir as opcoes? O Chatter tem a interface mais amigavel e um painel de administracao conveniente (tanto quanto possivel).

O agente de IA roda no servidor (backend) e conecta o Telegram ao seu PC.

```
Telegram <-> Backend <-> Desktop
```

Um usuario do Telegram pode continuar as mesmas conversas e controlar seu PC enquanto o Desktop estiver conectado. A maioria dos recursos esta disponivel independentemente de onde a mensagem foi enviada.

---

## Como o projeto esta estruturado?

- **backend-api** — toda a logica do lado do servidor do Chatter. O agente, ferramentas, memoria, chats, limites, usuarios e toda a logica compartilhada vivem aqui.
- **desktop-app** — aplicativo Electron para se comunicar com o agente e controlar seu PC.
- **Telegram bot** — uma segunda interface completa para a mesma conta, chats e recursos. Esta localizado na raiz do projeto (inconveniente, mas foi ai que tudo comecou).
- **admin-panel** — gerenciamento de modelos, chaves, usuarios, limites, backups e estado do servidor.
- **chatter-manager** — conecta o painel de administracao ao Docker, permitindo iniciar, parar e atualizar componentes.
- **webapp-notes** — mini-aplicativo do Telegram para notas.
- **voice-service** — serviço opcional exclusivo do Telegram: transcreve mensagens de voz recebidas e reproduz automaticamente por voz a resposta do Chatter quando o usuário envia uma mensagem de voz.

Todos os componentes do servidor rodam em contêineres Docker separados e sao ligados via Docker Compose. Assim, voce pode manter apenas o que realmente precisa.

---

## Como instalar?

1. Alugue um servidor e certifique-se de instalar o fail2ban nele. O instalador configurara o UFW automaticamente: ele preservara o acesso a porta SSH real do servidor e abrira as portas 80/443 para o Chatter.
2. Abra um console e execute:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/NikitaCherepov/chatter/main/install.sh | sudo bash
   ```
3. **CERTIFIQUE-SE** de salvar o login e a senha exibidos ao final da instalacao.
4. Vá para o painel de administracao no endereco do seu servidor e insira o login e a senha mostrados no console.
5. Conclua as etapas necessarias para a primeira execucao:
   - Adicione um modelo e chave de API para o modo Auto.
   - Adicione um modelo e chave de API para o modo Lite.
   - Obtenha um token do Telegram do [BotFather](https://t.me/BotFather) e adicione-o ao painel.
   - Opcionalmente, copie o link do Webapp-Notes fornecido no painel e adicione-o ao seu bot.
6. Envie uma mensagem para o bot e aprove seu perfil pelo painel de administracao, entao conceda a si mesmo direitos de administrador.

**Pronto!**

---

## Como conectar o aplicativo Desktop?

1. Baixe o aplicativo em Releases e instale-o. O Windows pode alertar sobre a ausencia de uma assinatura digital: a compilacao atualmente nao e assinada com um certificado.
2. Vá para a secao de Chaves de Acesso no painel de administracao.
3. Crie uma nova chave e cole-a no aplicativo Desktop.
4. Registre-se.

**Pronto!**

---

## Como vincular sua conta do PC ao Telegram?

1. Vá para as configuracoes no desktop.
2. Selecione "Contas vinculadas".
3. Clique em "Telegram".
4. Envie no bot do Telegram: `/link`
5. Insira o codigo mostrado na tela.

**Pronto!**

---

## Como compartilhar com um amigo?

**Via Telegram:**
1. Envie a eles o bot do Telegram e espere ate que eles enviem uma mensagem.
2. Aprove a conta deles pelo painel de administracao.

**Via Desktop:**
1. Envie a eles o aplicativo Desktop e compartilhe uma Chave de Acesso para conectar ao seu servidor.

**Pronto!**

Voce sempre pode ver se alguem compartilhou sua chave e pode revoga-la a qualquer momento.

---

## O que o painel de administracao pode fazer?

![Visao geral do painel de administracao do Chatter](../assets/admin-overview.png)

1. **Monitore o estado dos componentes** e reinicie-os.
2. **Quer adicionar um novo modelo?** Nao ha necessidade de reinserir uma chave de API salva ou navegar por todo o OpenRouter procurando um nome de modelo.
   - Chaves de API podem ser salvas e reutilizadas.
   - Um mecanismo de busca de modelos para OpenRouter esta integrado ao painel de administracao.
   - A lista de provedores e preenchida assim que voce seleciona um modelo. Quer que as requisicoes vao apenas para um provedor especifico? Basta escolhe-lo no menu suspenso.
   - Os precos dos tokens de entrada/saida/cache sao definidos automaticamente ao selecionar um modelo.
   - Os provedores OpenRouter selecionados podem ser monitorados automaticamente. O Chatter pode notificar os administradores quando um provedor desaparece ou altera os preços e mudar para a alternativa disponível mais barata, rápida ou com menor latência.
   - Um modelo Vision esta disponivel separadamente — se o modelo principal nao for multimodal, ele pedira ao Vision para descrever a imagem que voce anexou.

   ![Selecionando modelo, provedor e precos no painel de administracao](../assets/admin-model-selection.gif)

3. **Gerenciamento conveniente de limites.**
   - Basta definir o orcamento que um usuario pode gastar.
   - Limites personalizaveis para imagens e pesquisa na web para todos os usuarios, alem da capacidade de desativar anexos de imagem.

   ![Configurando planos, orcamentos e limites](../assets/admin-plans-limits.png)

4. **Analise** de quais modelos os usuarios estao usando, se subagentes estao envolvidos, o quao bem as mensagens estao sendo armazenadas em cache e muito mais.

   ![Estatisticas de usuario, conexoes e uso de modelos](../assets/admin-user-usage.png)

5. Logs do backend e graficos de desempenho do servidor.
6. Integracao conveniente de servicos disponiveis. Cole uma chave, insira os dados, e tudo funciona imediatamente.
7. **Construcao personalizada:**
   - Nao quer o mini-aplicativo do Telegram? Nao o ative.
   - Nao tem capacidade para TTS e transcricao de voz no lado do servidor? Sem problema.
   - Voce pode configurar quantos prompts predefinidos quiser para seus usuarios.
8. Precisa banir um usuario? Um clique, e ele perde imediatamente o acesso ao seu servidor pelo Telegram e pelo aplicativo Desktop. A chave de acesso tambem pode ser revogada a qualquer momento.

---

## O que o Chatter pode fazer?

1. Usar memoria vetorial. Cada usuario recebe um registro isolado separado por padrao. Atualmente, apenas a integracao com [Pinecone](https://app.pinecone.io/) esta disponivel.
   - Esqueceu em qual chat algo foi discutido? Peça ao Chatter para pesquisar nas conversas disponíveis para você, encontrar as mensagens relevantes e abrir o chat original.
2. Acordar com "Alexa", "Hey, Jarvis", "Hey Mycroft" ou "Hey Rhasspy", com suporte para reconhecimento de fala e respostas de voz.

   ![Ativacao por voz e controle de interface do Chatter](../assets/chatter-voice-activation.gif)

3. Integrado ao aplicativo Desktop:
   - modelo local Piper para TTS;
   - modelo nativo Chrome TTS;
   - integracao com [Cartesia](https://www.cartesia.ai/).
4. Executar comandos no PC, bem como editar e ler arquivos. Pode ser usado como CLI.

   ![Chatter cria e abre um site sozinho](../assets/chatter-site-creation.gif)

5. Ler e enviar e-mails das caixas de entrada adicionadas, incluindo anexos. Atualmente, a integração guiada está disponível para [Gmail](https://mail.google.com/mail/) e [Yandex](https://mail.yandex.ru/), além de qualquer outro e-mail que possa ser configurado manualmente. Cada e-mail enviado requer confirmação do usuário.
6. Usar pesquisa na web via servico [Tavily](https://www.tavily.com/).
7. Ler e analisar sites usando [Browserless](https://www.browserless.io/pricing).
8. Gerar imagens a partir de uma referencia ou de texto via OpenRouter.
9. Usar subagentes para qualquer tarefa.

   ![Subagentes paralelos do Chatter em acao](../assets/chatter-parallel-subagents.gif)

10. Invocar agentes especializados. Por exemplo: comprimir e converter videos para outros formatos.
11. Gerenciar seus servidores. O bot nunca ve sua chave SSH ou senha sudo. Para execucao de comandos, uma sessao SSH e aberta diretamente no seu servidor. A chave SSH pode ser obtida com um botao diretamente do seu computador.
12. Salvar e usar instrucoes Runbook para uso futuro e compartilha-las com outros.
13. Salvar macros para controle dramatico (*Alexa, hora de trabalhar!*).
14. Prompts personalizados, mais um editor de IA integrado diretamente ao painel para edicao conveniente.
15. Definir tarefas e lembretes. Por exemplo: acender a luz, lembrar de descartar o colirio em um mes ou verificar o servidor (apenas se os comandos estiverem na lista permitida) enquanto voce dorme.
16. Controlar seu avatar pixel e ajustar seu humor de acordo com a conversa diretamente na tela. Tambem exibir quaisquer imagens e GIFs que ele encontrou na internet.
17. Criar pixel art e exibi-la diretamente no avatar pixel.
18. Salvar chats como DOCX, enviar mensagens de um chat diretamente para uma conta vinculada do Telegram, alem de muitos outros recursos de Quality of Life.
19. Gosta de interpretar papeis com bots? O **Dice Mode** esta integrado, rolando um d20 a cada mensagem enviada e influenciando a historia!
20. Controlar o mapa integrado a interface do aplicativo, lembrar pontos no mapa e traçar rotas (mas verifique as informacoes!).
21. Salvar notas em seu bloco de notas, que tambem esta acessivel pelo aplicativo Telegram.
22. Configurar o tamanho do contexto, selecionar convenientemente modelos para subagentes sem mexer em configuracoes e definir niveis de raciocinio (atualmente disponivel para provedores OpenRouter, DeepSeek e Xiaomi).
23. Controlar a webcam, tirar screenshots e clicar na tela enquanto o Desktop estiver conectado. Qualquer acao desse tipo requer sua confirmacao.
24. A maioria dos recursos esta acessivel pelo Telegram com um menu conveniente e botoes inline.
25. Controlar sua casa inteligente e acender luzes em um cronograma. A integracao Yandex esta disponivel; o suporte a Zigbee e atualmente experimental e precisa de mais testes.
26. Anexar documentos e fotos mesmo a um modelo sem vision (quando um modelo vision está configurado separadamente). Os documentos não precisam mais preencher o contexto imediatamente: o assistente pode consultar seus metadados, lê-los em partes e pesquisar seu conteúdo. O Desktop também inclui visualizações integradas para formatos de documentos comuns.
27. Transcrever mensagens de voz do Telegram! (requer um servidor potente com pelo menos 2 nucleos, 2 GB de RAM e voice-api ativado)
28. Adicionar vários personagens de IA a um único chat para role-play solo, discussões ou tarefas colaborativas. Escolha manualmente quem responde em seguida ou deixe os bots responderem em sequência.
29. Convidar outras pessoas e amigos para uma sala compartilhada. Cada participante pode trazer seu próprio bot ou interagir com bots disponibilizados por outros participantes.
30. Organizar chats em pastas e filtrá-los por prompt, modelo, arquivos ou imagens.
31. Deixar respostas longas continuarem em segundo plano e receber uma notificação quando o Chatter terminar.
32. Criação conveniente e rápida de ramificações de chat, além de regeneração com instruções.
33. O bot sugere um comando, mas você não sabe o que ele faz? Pressione o botão Review e o modelo Lite avaliará seus riscos.
34. Usar o navegador integrado ao Chatter Desktop. O assistente pode ler a página que você abriu, rolá-la, abrir links, clicar em controles e preencher campos comuns. As ações do navegador podem exigir sua confirmação, os downloads são sempre pausados para aprovação e os campos de senha não ficam disponíveis para o modelo.

---

## No que o Chatter e focado?

### 1. Operacoes seguras do agente

- Toda acao no servidor/PC e permitida apenas com aprovacao do usuario. Excecoes: modo Yolo ativado, Allow Always ou "trabalhar nesta pasta". "Trabalhar nesta pasta" encontra o `.git` mais proximo e o sugere como padrao.
- O agente nunca ve sua chave SSH ou senha: eles sao substituidos automaticamente e armazenados criptografados. **NAO** de sua senha ao agente, mesmo que ele peca. Ele tem um comando separado para criar um novo usuario no servidor!
- No desktop, voce pode desativar seletivamente recursos por seguranca. Voce pode proibir a gravacao de dados permitindo apenas leituras, desativar subagentes, internet ou comandos do PC. Ou cortar completamente seu acesso a sua memoria.
- E-mails, chaves SSH e dados confidenciais sao criptografados.
- Todas as requisicoes de API do painel de administracao passam por um proxy reverso e pelo Chatter Manager, enquanto tentativas repetidas de login sao automaticamente bloqueadas.
- Protecao basica contra injecao de prompt esta integrada.
- Se voce nao sabe o que um comando sugerido pela rede neural faz, voce pressiona Review e outra rede neural explica para voce, avaliando os riscos.

   ![Verificando riscos de comando antes da execucao](../assets/chatter-command-review.gif)

### 2. Otimizacao incansavel

- Prompts de sistema e outras partes repetidas do contexto permanecem estaveis para que o provedor possa armazenar em cache ate 90–95% dos tokens de entrada.
- Chats, fotos e mensagens sao carregados dinamicamente para evitar sobrecarga do DOM. A virtualizacao nao e usada (eu a odeio): em vez disso, sao usados um botao "carregar mais" e calculo baseado na contagem de caracteres.
- O OpenRouter redireciona voce para diferentes provedores e quebra o cache, e voce nao quer fuçar e configurar chaves? Basta selecionar um provedor obtido diretamente do OpenRouter, e apenas esse provedor sera usado.
- Voce pode inserir varios provedores (OpenRouter/DeepSeek/Xiaomi/etc), e se o primeiro falhar com um erro, a tarefa e imediatamente redirecionada para outro.
- Nao tem dinheiro para rodar um modelo vision toda vez? Sem problema. Adicione um modelo vision uma vez, e seu bot de IA principal simplesmente pedira que ele descreva a imagem que voce anexou.
- Nao tem dinheiro para TTS mas ainda quer? Modelos locais estao integrados para isso. Muitas integracoes externas tambem oferecem um nivel gratuito.
- Nao quer que a IA gere codigo utilitario para si mesma repetidamente e queime tokens toda vez? As ferramentas integradas do Chatter sao implementadas em codigo antecipadamente. Parece uma desvantagem, certo? Mas assim voce pode trabalhar no Chatter (se quiser) juntamente com assinaturas de servicos principais, apenas fazendo `git clone` no seu computador.
- O aplicativo Desktop em modo normal usa cerca de 300 MB de RAM e mal carrega a CPU. Os contêineres do servidor sao contados separadamente, enquanto TTS e Whisper naturalmente exigem mais recursos. O proprio Codex pode ficar lento e travar tranquilamente na minha maquina.
- Para evitar quebrar o cache, quando o contexto transborda, 50% da conversa e arquivada (um breve resumo para compressao sera adicionado no futuro).
- Se um documento nao couber, o Chatter automaticamente corta seu conteudo, mantendo ate 90% do limite de contexto selecionado.
- Um modelo Lite dedicado e usado para gerar titulos de chats, revisoes e outras requisicoes leves.

### 3. Conveniencia

- Quer encaminhar imagens ou mensagens geradas pela IA para seu Telegram para que estejam no seu celular? Pressione um botao.
- Quer melhorar um prompt? Pressione um botao e aplique as alteracoes que a IA sugerir.
- Nao quer preencher macros ou escrever algo no bloco de notas? Peça a IA para fazer isso.
- Nao quer procurar sua chave SSH em todo o seu PC? Pressione um botao :D
- Saiu de casa e quer continuar a conversa do seu celular? Todos os chats, selecao de prompts e escolha de modelo estao disponiveis diretamente do Telegram!
- Nao quer se esforcar e procurar sua chave de API novamente, escolher um modelo no OpenRouter ou descobrir como interpretar o raciocinio de um novo modelo? As chaves de API podem ser salvas, os modelos sao obtidos automaticamente e mostram imediatamente o custo, limites de contexto e provedores disponiveis para preservar o cache! E DeepSeek e Xiaomi estao codificados como provedores de terceiros (se novos como Mistral aparecerem — me escreva, eu os adicionarei).
- Nao quer calcular manualmente quanto cada modelo custa? O OpenRouter preenche seus proprios valores, e ha predefinicoes para outros.
- Seus usuarios nao querem se preocupar em escolher modelos? O modo Auto esta sempre ai!
- Todas as integracoes receberao posteriormente descricoes e guias de inicio rapido. Estes ja existem para a integracao de casa inteligente.

### 4. Personalizacao

- Os parametros de cada modelo podem ser configurados. Temperatura, Top P e outros.
- A funcionalidade do aplicativo Desktop pode ser desativada e personalizada.

---

## Traduzindo o projeto para seu idioma

Decidiu traduzir o projeto para seu idioma? E rapido e facil:

1. Adicione seu idioma em `shared/languages.ts` — esta e a unica fonte de verdade para a lista de idiomas em todos os componentes.
2. Execute:
   ```bash
   npm run sync:languages
   ```
   para atualizar copias locais da lista.
3. Adicione sua chave de API ao `.env.i18n`:
   ```
   I18N_TRANSLATE_API_URL=url
   I18N_TRANSLATE_API_KEY=your_key
   I18N_TRANSLATE_MODEL=your_model
   ```
4. Execute:
   ```bash
   npm run i18n:translate:all
   ```
   Este comando traduzira separadamente os arquivos do bot do Telegram, Desktop, Backend API, Webapp Notes, painel de administracao e changelog.
5. Aproveite.

---

## Importante

- O servico pode conter bugs que ainda nao encontrei. Se voce encontrar um — envie-o para Issues, vamos resolver. Os bugs que ja conheco estao na fila de correcao. Estou trabalhando no projeto sozinho, entao ajuda e bem-vinda!
- Planos futuros incluem refatoracao tanto do desktop-app quanto do backend-api.
- Ao usar o Chatter como CLI para trabalho, problemas ainda podem ocorrer (por exemplo, pode confundir uma string e nao verificar tipos, deixando um erro). Estou trabalhando para melhorar isso.
- **Aviso de seguranca:** O Chatter esta em desenvolvimento ativo e possui uma ampla superficie de ataque devido as integracoes, ferramentas de controle remoto e arquitetura self-hosted. Embora a seguranca seja uma prioridade, nenhum software pode ser garantido como totalmente seguro. Revise a configuracao antes de expor uma instancia a Internet, mantenha-a atualizada e relate vulnerabilidades de forma responsavel. O fortalecimento da seguranca continuara conforme o projeto evolui.
