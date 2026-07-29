[English](../../README.MD) | [Русский](README_RU.MD) | [Deutsch](README_DE.MD) | [Español](README_ES.MD) | [Français](README_FR.MD) | **Italiano** | [日本語](README_JA.MD) | [한국어](README_KO.MD) | [Polski](README_PL.MD) | [Português (BR)](README_PT-BR.MD) | [中文（简体）](README_ZH-CN.MD) | [Türkçe](README_TR.MD) | [Čeština](README_CS.MD)

---

# Cos'è Chatter?

Chatter è un sistema multi-piattaforma con un agente AI che funziona su un server e può essere condiviso con amici o familiari con un clic! Puoi anche distribuire il tuo servizio con piani, limiti e una gestione comoda.

I prezzi dei modelli vengono recuperati automaticamente da OpenRouter. Tutto ciò che serve è impostare un budget per l'abbonamento.

> **Il sistema di pagamento non è ancora integrato!**

![Chatter collega Telegram e Desktop](../assets/chatter-telegram-desktop.gif)

Volevi condividere l'AI con tua mamma ma lei trova la tecnologia troppo complicata? Dalle il tuo bot Telegram. Curva di apprendimento zero.

Volevi il tuo Jarvis personale che accende le luci, risponde ai comandi vocali e abbassa le tende di notte? Dopo aver collegato l'integrazione della casa intelligente, Chatter può farlo senza codice aggiuntivo o token sprecati.

O forse volevi semplicemente giocare di ruolo con un bot ma non avevi voglia di scavare tra le configurazioni, avviare un server locale e capire le impostazioni? Chatter ha l'interfaccia più user-friendly e un pannello di amministrazione comodo (per quanto possibile).

L'agente AI funziona sul server (backend) e collega Telegram e il tuo PC.

```
Telegram <-> Backend <-> Desktop
```

Un utente Telegram può continuare le stesse chat e controllare il proprio PC mentre Desktop è connesso. La maggior parte delle funzionalità è disponibile indipendentemente da dove è stato inviato il messaggio.

---

## Com'è strutturato il progetto?

 - **backend-api** — tutta la logica lato server di Chatter. L'agente, gli strumenti, la memoria, le chat, i limiti, gli utenti e tutta la logica condivisa vivono qui.
 - **desktop-app** — app Electron per comunicare con l'agente e controllare il tuo PC.
 - **Telegram bot** — una seconda interfaccia completa per lo stesso account, chat e funzionalità. Si trova nella root del progetto (scomodo, ma è da lì che tutto è iniziato).
 - **admin-panel** — gestione di modelli, chiavi, utenti, limiti, backup e stato del server.
 - **chatter-manager** — collega il pannello di amministrazione a Docker, permettendoti di avviare, fermare e aggiornare i componenti.
 - **webapp-notes** — mini-app Telegram per le note.
 - **voice-service** — servizio opzionale solo per Telegram: trascrive i messaggi vocali in arrivo e legge automaticamente la risposta di Chatter quando l'utente invia un messaggio vocale.

Tutti i componenti del server funzionano in contenitori Docker separati e sono collegati tramite Docker Compose. In questo modo puoi tenere solo ciò di cui hai effettivamente bisogno.

---

## Come installare?

 1. Noleggia un server e assicurati di installare fail2ban. Il programma di installazione configurerà UFW automaticamente: manterrà l'accesso alla porta SSH effettiva del server e aprirà le porte 80/443 per Chatter.
 2. Apri una console ed esegui:
    ```bash
    curl -fsSL https://raw.githubusercontent.com/NikitaCherepov/chatter/main/install.sh | sudo bash
    ```
 3. **ASSICURATI** di salvare il login e la password mostrati al termine dell'installazione.
 4. Vai al pannello di amministrazione all'indirizzo del tuo server e inserisci il login e la password mostrati nella console.
 5. Completa i passaggi richiesti per il primo avvio:
    - Aggiungi un modello e una chiave API per la modalità Auto.
    - Aggiungi un modello e una chiave API per la modalità Lite.
    - Ottieni un token Telegram da [BotFather](https://t.me/BotFather) e aggiungilo al pannello.
    - Opzionalmente, copia il link Webapp-Notes fornito nel pannello e aggiungilo al tuo bot.
 6. Invia un messaggio al bot e approva il tuo profilo tramite il pannello di amministrazione, poi concediti i diritti di amministratore.

**Fatto!**

---

## Come collegare l'App Desktop?

 1. Scarica l'app dalle Releases e installala. Windows potrebbe avvertire riguardo a una firma digitale mancante: la build attualmente non è firmata con un certificato.
 2. Vai alla sezione Access Keys nel pannello di amministrazione.
 3. Crea una nuova chiave e incollala nell'app Desktop.
 4. Registrati.

**Fatto!**

---

## Come collegare l'account PC e Telegram insieme?

 1. Vai alle impostazioni sul desktop.
 2. Seleziona "Linked accounts".
 3. Clicca su "Telegram".
 4. Invia nel bot Telegram: `/link`
 5. Inserisci il codice mostrato sullo schermo.

**Fatto!**

---

## Come condividerlo con un amico?

**Tramite Telegram:**
 1. Invia il bot Telegram e attendi che ti scriva.
 2. Approva il suo account dal pannello di amministrazione.

**Tramite Desktop:**
 1. Invia l'app Desktop e condividi una chiave di accesso per connetterti al tuo server.

**Fatto!**

Puoi sempre vedere se qualcuno ha condiviso la tua chiave e puoi revocarla in qualsiasi momento.

---

## Cosa può fare il pannello di amministrazione?

![Panoramica del server nel pannello di amministrazione di Chatter](../assets/admin-overview.png)

 1. **Monitora lo stato dei componenti** e riavviali.
 2. **Vuoi aggiungere un nuovo modello?** Non c'è bisogno di reinserire una chiave API salvata o di cercare in tutto OpenRouter un nome di modello.
    - Le chiavi API possono essere salvate e riutilizzate.
    - Un motore di ricerca modelli per OpenRouter è integrato nel pannello di amministrazione.
    - L'elenco dei provider viene popolato non appena selezioni un modello. Vuoi che le richieste vadano solo a un provider specifico? Basta selezionarlo dal menu a discesa.
    - I prezzi dei token di input/output/cache vengono impostati automaticamente quando selezioni un modello.
    - Un modello Vision è disponibile separatamente — se il modello principale non è multimodale, chiederà a Vision di descrivere l'immagine che hai allegato.

    ![Selezione di modello, provider e prezzo nel pannello di amministrazione](../assets/admin-model-selection.gif)

 3. **Gestione comoda dei limiti.**
    - Basta impostare il budget che un utente può spendere.
    - Limiti personalizzabili per immagini e ricerca web per tutti gli utenti, più la possibilità di disabilitare gli allegati di immagini.

    ![Impostazione di piani, budget e limiti](../assets/admin-plans-limits.png)

 4. **Analisi** di quali modelli gli utenti stanno usando, se i subagenti sono coinvolti, quanto bene vengono memorizzati nella cache i messaggi e molto altro.

    ![Statistiche utente, connessioni e utilizzo dei modelli](../assets/admin-user-usage.png)

 5. Log del backend e grafici delle prestazioni del server.
 6. Integrazione comoda dei servizi disponibili. Incolla una chiave, inserisci i dati e tutto funziona subito.
 7. **Build personalizzata:**
    - Non vuoi la mini-app Telegram? Non abilitarla.
    - Non hai capacità per TTS lato server e trascrizione vocale? Nessun problema.
    - Puoi configurare tutti i prompt preimpostati che vuoi per i tuoi utenti.
 8. Devi bannare un utente? Un clic, e perde immediatamente l'accesso al tuo server tramite Telegram e l'app Desktop. La chiave di accesso può anche essere revocata in qualsiasi momento.

---

## Cosa può fare Chatter?

 1. Usare la memoria vettoriale. Ogni utente ottiene un record isolato separato per impostazione predefinita. Attualmente è disponibile solo l'integrazione con [Pinecone](https://app.pinecone.io/).
 2. Risvegliarsi con "Alexa", "Hey, Jarvis", "Hey Mycroft", o "Hey Rhasspy", con supporto per il riconoscimento vocale e le risposte vocali.

    ![Attivazione vocale e controllo UI di Chatter](../assets/chatter-voice-activation.gif)

 3. Integrato nell'app Desktop:
    - modello locale Piper per TTS;
    - modello nativo Chrome TTS;
    - integrazione con [Cartesia](https://www.cartesia.ai/).
 4. Eseguire comandi sul PC, oltre a modificare e leggere file. Può essere usato come CLI.

    ![Chatter crea e apre un sito web da solo](../assets/chatter-site-creation.gif)

 5. Leggere e inviare email dalle caselle di posta che hai aggiunto. Attualmente, l'integrazione guidata è disponibile per [Gmail](https://mail.google.com/mail/) e [Yandex](https://mail.yandex.ru/), così come per qualsiasi altra email che puoi configurare manualmente. L'invio di email richiede la conferma dell'utente.
 6. Usare la ricerca web tramite il servizio [Tavily](https://www.tavily.com/).
 7. Leggere e analizzare siti web usando [Browserless](https://www.browserless.io/pricing).
 8. Generare immagini da un riferimento o da testo tramite OpenRouter.
 9. Usare subagenti per qualsiasi compito.

    ![Subagenti paralleli di Chatter al lavoro](../assets/chatter-parallel-subagents.gif)

 10. Invocare agenti specializzati. Ad esempio: comprimere e convertire video in altri formati.
 11. Gestire i tuoi server. Il bot non vede mai la tua chiave SSH o la password sudo. Per l'esecuzione dei comandi, una sessione SSH si apre direttamente sul tuo server. La chiave SSH può essere importata con un pulsante direttamente dal tuo computer.
 12. Salvare e usare istruzioni Runbook per un uso futuro, e condividerle con altri.
 13. Salvare macro per il controllo vocale (*Alexa, è ora di lavorare!*).
 14. Prompt personalizzati, più un editor AI integrato direttamente nel pannello per modifiche comode.
 15. Impostare compiti e promemoria. Ad esempio: accendi la luce, ricordati di buttare le gocce per gli occhi tra un mese, o controlla il server (solo se i comandi sono nella lista consentita) mentre dormi.
 16. Controllare il tuo avatar pixel e regolare il suo umore in base alla conversazione direttamente sullo schermo. Visualizza anche qualsiasi immagine e GIF che ha trovato su internet.
 17. Creare pixel art e visualizzarla direttamente sull'avatar pixel.
 18. Salvare chat come DOCX, inviare messaggi da una chat direttamente a un account Telegram collegato, più molte altre funzionalità Quality of Life.
 19. Ti piace giocare di ruolo con i bot? La **Dice Mode** è integrata, lancia un d20 su ogni messaggio che invii e influenza la storia!
 20. Controllare la mappa integrata nell'interfaccia dell'app, ricordare punti sulla mappa e tracciare percorsi (ma ricontrolla le informazioni!).
 21. Salvare note nel tuo blocco note, accessibile anche dall'app Telegram.
 22. Configurare la dimensione del contesto, selezionare comodamente i modelli per i subagenti senza toccare le configurazioni, e impostare i livelli di ragionamento (attualmente disponibili per i provider OpenRouter, DeepSeek e Xiaomi).
 23. Controllare la webcam, fare screenshot e cliccare sullo schermo mentre Desktop è connesso. Qualsiasi azione di questo tipo richiede la tua conferma.
 24. La maggior parte delle funzionalità è accessibile da Telegram con un menu comodo e pulsanti inline.
 25. Controllare la tua casa intelligente e accendere le luci su programmazione. L'integrazione con Yandex è disponibile; il supporto Zigbee è attualmente sperimentale e necessita di ulteriori test.
 26. Allegare documenti e foto anche a un modello senza visione (quando un modello vision è configurato separatamente).
 27. Trascrivere messaggi vocali da Telegram! (richiede un server potente con almeno 2 core, 2 GB di RAM e voice-api abilitato)
 28. Creazione comoda e veloce di rami di chat, più rigenerazione con istruzioni.
 29. Il bot suggerisce un comando ma non sai cosa fa? Premi il pulsante Review e il modello Lite ne valuta i rischi.

---

## Su cosa si concentra Chatter?

### 1. Operazioni sicure dell'agente

 - Ogni azione sul server/PC è consentita solo con l'approvazione dell'utente. Eccezioni: modalità Yolo abilitata, Allow Always, o "lavora in questa cartella". "Lavora in questa cartella" trova il `.git` più vicino e lo suggerisce come predefinito.
 - L'agente non vede mai la tua chiave SSH o password: vengono sostituite automaticamente e memorizzate in modo crittografato. **NON** dare la password all'agente, anche se la chiede. Ha un comando separato per creare un nuovo utente sul server!
 - Sul desktop, puoi disabilitare selettivamente le funzionalità per sicurezza. Puoi vietare la scrittura dei dati consentendo solo la lettura, disabilitare subagenti, internet o comandi PC. O tagliare completamente il suo accesso alla tua memoria.
 - Email, chiavi SSH e dati sensibili sono crittografati.
 - Tutte le richieste API del pannello di amministrazione passano attraverso un proxy inverso e Chatter Manager, mentre i tentativi di login ripetuti vengono automaticamente bloccati.
 - La protezione di base contro l'iniezione di prompt è integrata.
 - Se non sai cosa fa un comando suggerito dalla rete neurale, premi Review e un'altra rete neurale te lo spiega, valutando i rischi.

    ![Controllo dei rischi dei comandi prima dell'esecuzione](../assets/chatter-command-review.gif)

### 2. Ottimizzazione incessante

 - I prompt di sistema e altre parti di contesto ripetute rimangono stabili in modo che il provider possa memorizzare nella cache fino al 90-95% dei token di input.
 - Chat, foto e messaggi vengono caricati dinamicamente per evitare di sovraccaricare il DOM. La virtualizzazione non viene utilizzata (la odio): invece, vengono usati un pulsante "carica di più" e un calcolo basato sul conteggio dei caratteri.
 - OpenRouter ti reindirizza a diversi provider e rompe la cache, e non hai voglia di scavare e configurare le chiavi? Basta selezionare un provider prelevato direttamente da OpenRouter, e solo quel provider verrà utilizzato.
 - Puoi inserire più provider (OpenRouter/DeepSeek/Xiaomi/ecc.), e se il primo fallisce con un errore, il compito viene immediatamente reindirizzato a un altro.
 - Non hai soldi per eseguire un modello vision ogni volta? Nessun problema. Aggiungi un modello vision una volta, e il tuo bot AI principale gli chiederà semplicemente di descrivere l'immagine che hai allegato.
 - Non hai soldi per TTS ma lo vuoi comunque? I modelli locali sono integrati per questo. Molte integrazioni esterne offrono anche un livello gratuito.
 - Non vuoi che l'AI generi codice di utilità per sé stessa ancora e ancora bruciando token ogni volta? Gli strumenti integrati di Chatter sono implementati in codice in anticipo. Sembra uno svantaggio, vero? Ma in questo modo puoi lavorare su Chatter (se vuoi) insieme agli abbonamenti ai servizi principali, semplicemente facendo `git clone` sul tuo computer.
 - L'app Desktop in modalità normale utilizza circa 300 MB di RAM e carica a malapena la CPU. I contenitori del server vengono contati separatamente, mentre TTS e Whisper richiedono naturalmente più risorse. Anche Codex sul mio computer può tranquillamente rallentare e andare a scatti.
 - Per evitare di rompere la cache, quando il contesto trabocca, il 50% della conversazione viene archiviato (un breve riassunto per compressione verrà aggiunto in futuro).
 - Se un documento non entra, Chatter ne taglia automaticamente il contenuto, mantenendo fino al 90% del limite di contesto selezionato.
 - Un modello Lite dedicato viene utilizzato per generare titoli di chat, recensioni e altre richieste leggere.

### 3. Convenienza

 - Vuoi inoltrare immagini o messaggi generati dall'AI al tuo Telegram per averli sul telefono? Premi un pulsante.
 - Vuoi migliorare un prompt? Premi un pulsante e applica le modifiche suggerite dall'AI.
 - Non vuoi compilare macro o scrivere qualcosa nel blocco note? Chiedi all'AI di farlo.
 - Non vuoi cercare la tua chiave SSH in tutto il PC? Premi un pulsante :D
 - Sei uscito di casa e vuoi continuare la conversazione dal telefono? Tutte le chat, la selezione dei prompt e la scelta del modello sono disponibili direttamente da Telegram!
 - Non vuoi faticare e cercare di nuovo la tua chiave API, scegliere un modello su OpenRouter, o capire come analizzare il ragionamento di un nuovo modello? Le chiavi API possono essere salvate, i modelli vengono prelevati automaticamente e mostrano immediatamente costo, limiti di contesto e provider disponibili per preservare la cache! E DeepSeek e Xiaomi sono codificati come provider di terze parti (se ne appaiono di nuovi come Mistral — scrivimi, li aggiungerò).
 - Non vuoi calcolare manualmente quanto costa ogni modello? OpenRouter inserisce i suoi valori e ci sono preset per gli altri.
 - I tuoi utenti non vogliono preoccuparsi di scegliere i modelli? La modalità Auto è sempre disponibile!
 - Tutte le integrazioni riceveranno in seguito descrizioni e guide rapide. Queste esistono già per l'integrazione della casa intelligente.

### 4. Personalizzazione

 - I parametri di ogni modello possono essere configurati. Temperatura, Top P e altri.
 - Le funzionalità dell'app Desktop possono essere disabilitate e personalizzate.

---

## Tradurre il progetto nella tua lingua

Hai deciso di tradurre il progetto nella tua lingua? È veloce e facile:

 1. Aggiungi la tua lingua a `shared/languages.ts` — questa è l'unica fonte di verità per l'elenco delle lingue in tutti i componenti.
 2. Esegui:
    ```bash
    npm run sync:languages
    ```
    per aggiornare le copie locali dell'elenco.
 3. Aggiungi la tua chiave API a `.env.i18n`:
    ```
    I18N_TRANSLATE_API_URL=url
    I18N_TRANSLATE_API_KEY=your_key
    I18N_TRANSLATE_MODEL=your_model
    ```
 4. Esegui:
    ```bash
    npm run i18n:translate:all
    ```
    Questo comando tradurrà separatamente i file del bot Telegram, Desktop, Backend API, Webapp Notes, pannello di amministrazione e changelog.
 5. Goditi il risultato.

---

## Importante

 - Il servizio potrebbe contenere bug che non ho ancora trovato. Se ne trovi uno — segnalalo nelle Issues, lo risolveremo. I bug che già conosco sono nel backlog delle correzioni. Lavoro al progetto da solo, quindi l'aiuto è benvenuto!
 - I piani futuri includono il refactoring sia del desktop-app che del backend-api.
 - Quando usi Chatter come CLI per lavoro, potrebbero ancora verificarsi problemi (ad esempio, potrebbe confondere una stringa e non controllare i tipi, lasciando un errore). Sto lavorando per migliorare questo aspetto.
 - **Avviso di sicurezza:** Chatter è in fase di sviluppo attivo e presenta un'ampia superficie di attacco a causa delle sue integrazioni, degli strumenti di controllo remoto e dell'architettura self-hosted. Sebbene la sicurezza sia una priorità, nessun software può essere garantito come completamente sicuro. Controlla la configurazione prima di esporre un'istanza a Internet, mantienila aggiornata e segnala le vulnerabilità in modo responsabile. La protezione continuerà a migliorare con l'evoluzione del progetto.
