[English](../../README.MD) | [Русский](README_RU.MD) | **Deutsch** | [Español](README_ES.MD) | [Français](README_FR.MD) | [Italiano](README_IT.MD) | [日本語](README_JA.MD) | [한국어](README_KO.MD) | [Polski](README_PL.MD) | [Português (BR)](README_PT-BR.MD) | [中文（简体）](README_ZH-CN.MD) | [Türkçe](README_TR.MD) | [Čeština](README_CS.MD)

---

# Was ist Chatter?

Chatter ist ein Multiplattform-System mit einem KI-Agenten, der auf einem Server läuft und mit nur einem Klick mit Freunden oder der Familie geteilt werden kann! Du kannst auch deinen eigenen Dienst darauf mit Tarifen, Limits und praktischer Verwaltung bereitstellen.

Die Modellpreise werden automatisch abgerufen. Alles, was du brauchst, ist ein Budget für das Abonnement festzulegen.

> **Das Zahlungssystem ist noch nicht integriert!**

![Chatter verbindet Telegram und Desktop](../assets/chatter-telegram-desktop.gif)

Wolltest du KI mit deiner Mutter teilen, aber sie findet Technologie zu kompliziert? Gib ihr deinen Telegram-Bot. Null Lernkurve.

Wolltest du deinen eigenen Jarvis, der das Licht einschaltet, auf Sprachbefehle reagiert und nachts die Jalousien herunterlässt? Nach der Verbindung der Smart-Home-Integration kann Chatter dies ohne zusätzlichen Code oder verschwendete Tokens erledigen.

Oder wolltest du vielleicht einfach nur mit einem Bot rollenspielen, aber keine Lust, durch Konfigurationen zu wühlen, einen lokalen Server zu starten und Einstellungen herauszufinden? Chatter hat die benutzerfreundlichste Oberfläche und ein praktisches Admin-Panel (so gut wie möglich).

Der KI-Agent läuft auf dem Server (Backend) und verbindet Telegram und deinen PC miteinander.

```
Telegram <-> Backend <-> Desktop
```

Ein Telegram-Benutzer kann dieselben Chats fortsetzen und seinen PC steuern, während der Desktop verbunden ist. Die meisten Funktionen sind verfügbar, unabhängig davon, wo die Nachricht gesendet wurde.

---

## Wie ist das Projekt strukturiert?

- **backend-api** — die gesamte Server-Logik von Chatter. Der Agent, die Tools, der Speicher, die Chats, die Limits, die Benutzer und die gesamte gemeinsame Logik befinden sich hier.
- **desktop-app** — Electron-App für die Kommunikation mit dem Agenten und die Steuerung deines PCs.
- **Telegram bot** — eine zweite vollwertige Oberfläche für denselben Account, dieselben Chats und Funktionen. Befindet sich im Projektstammverzeichnis (unpraktisch, aber dort hat alles angefangen).
- **admin-panel** — Verwaltung von Modellen, Schlüsseln, Benutzern, Limits, Backups und Serverstatus.
- **chatter-manager** — verbindet das Admin-Panel mit Docker und ermöglicht das Starten, Stoppen und Aktualisieren von Komponenten.
- **webapp-notes** — Telegram-Mini-App für Notizen.
- **voice-service** — optionaler Dienst nur für Telegram: transkribiert eingehende Sprachnachrichten und vertont Chatters Antwort automatisch, wenn der Benutzer eine Sprachnachricht sendet.

Alle Serverkomponenten laufen in separaten Docker-Containern und sind über Docker Compose verbunden. Du kannst also nur das behalten, was du tatsächlich brauchst.

---

## Wie installiert man?

1. Miete einen Server und stelle sicher, dass fail2ban darauf installiert ist. Das Installationsprogramm konfiguriert UFW automatisch: Es erhält den Zugriff auf den tatsächlichen SSH-Port des Servers und öffnet die Ports 80/443 für Chatter.
2. Öffne eine Konsole und führe Folgendes aus:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/NikitaCherepov/chatter/main/install.sh | sudo bash
   ```
3. **STELLE SICHER**, dass du den am Ende der Installation angezeigten Benutzernamen und das Passwort speicherst.
4. Gehe zum Admin-Panel unter der Adresse deines Servers und gib den in der Konsole angezeigten Benutzernamen und das Passwort ein.
5. Führe die für den ersten Start erforderlichen Schritte aus:
   - Füge ein Modell und einen API-Schlüssel für den Auto-Modus hinzu.
   - Füge ein Modell und einen API-Schlüssel für den Lite-Modus hinzu.
   - Hole dir ein Telegram-Token von [BotFather](https://t.me/BotFather) und füge es im Panel hinzu.
   - Optional: Kopiere den im Panel bereitgestellten Webapp-Notes-Link und füge ihn deinem Bot hinzu.
6. Schreibe dem Bot und bestätige dein Profil über das Admin-Panel, dann erteile dir selbst Administratorrechte.

**Fertig!**

---

## Wie verbindet man die Desktop-App?

1. Lade die App aus Releases herunter und installiere sie. Windows kann dich fehlende digitale Signatur warnen: Der Build ist derzeit nicht mit einem Zertifikat signiert.
2. Gehe zum Bereich Zugangsschlüssel im Admin-Panel.
3. Erstelle einen neuen Schlüssel und füge ihn in die Desktop-App ein.
4. Registriere dich.

**Fertig!**

---

## Wie verknüpft man seinen PC-Account mit Telegram?

1. Gehe in den Einstellungen auf dem Desktop.
2. Wähle "Verknüpfte Konten".
3. Klicke auf "Telegram".
4. Sende im Telegram-Bot: `/link`
5. Gib den auf dem Bildschirm angezeigten Code ein.

**Fertig!**

---

## Wie teilt man es mit einem Freund?

**Über Telegram:**
1. Sende ihnen den Telegram-Bot und warte, bis sie eine Nachricht senden.
2. Bestätige ihr Konto über das Admin-Panel.

**Über Desktop:**
1. Sende ihnen die Desktop-App und teile einen Zugangsschlüssel, um eine Verbindung zu deinem Server herzustellen.

**Fertig!**

Du kannst jederzeit sehen, ob jemand deinen Schlüssel geteilt hat, und ihn jederzeit widerrufen.

---

## Was kann das Admin-Panel?

![Chatter Admin-Panel Server-Übersicht](../assets/admin-overview.png)

1. **Komponentenstatus überwachen** und neu starten.
2. **Ein neues Modell hinzufügen?** Kein erneutes Eingeben eines gespeicherten API-Schlüssels oder Durchsuchen von ganz OpenRouter nach einem Modellnamen erforderlich.
   - API-Schlüssel können gespeichert und wiederverwendet werden.
   - Eine Modellsuche für OpenRouter ist in das Admin-Panel integriert.
   - Die Anbieterliste wird automatisch ausgefüllt, sobald du ein Modell auswählst. Möchtest du, dass Anfragen nur an einen bestimmten Anbieter gehen? Wähle ihn einfach aus dem Dropdown-Menü.
   - Ein-/Ausgabe-/Cache-Token-Preise werden automatisch festgelegt, wenn du ein Modell auswählst.
   - Ein Vision-Modell ist separat verfügbar. Wenn das Hauptmodell nicht multimodal ist, wird Vision gebeten, das angehängte Bild zu beschreiben.

   ![Auswahl eines Modells, Anbieters und Preises im Admin-Panel](../assets/admin-model-selection.gif)

3. **Praktische Limitverwaltung.**
   - Lege einfach das Budget fest, das ein Benutzer ausgeben kann.
   - Anpassbare Limits für Bilder und Websuche für alle Benutzer, plus die Möglichkeit, Bildanhäge zu deaktivieren.

   ![Einrichten von Tarifen, Budgets und Limits](../assets/admin-plans-limits.png)

4. **Analyse** darüber, welche Modelle Benutzer verwenden, ob Subagenten beteiligt sind, wie gut Nachrichten gecacht werden und vieles mehr.

   ![Benutzerstatistiken, Verbindungen und Modellnutzung](../assets/admin-user-usage.png)

5. Backend-Logs und Server-Leistungsdiagramme.
6. Praktische Integration verfügbarer Dienste. Füge einen Schlüssel ein, gib die Daten ein, und alles funktioniert sofort.
7. **Individuelle Zusammenstellung:**
   - Du möchtest die Telegram-Mini-App nicht? Aktiviere sie einfach nicht.
   - Keine Kapazität für serverseitige TTS und Sprachtranskription? Kein Problem.
   - Du kannst so viele voreingestellte Prompt-Vorlagen für deine Benutzer konfigurieren, wie du möchtest.
8. Musst du einen Benutzer sperren? Ein Klick, und er verliert sofort den Zugriff auf deinen Server über Telegram und die Desktop-App. Der Zugangsschlüssel kann ebenfalls jederzeit widerrufen werden.

---

## Was kann Chatter?

1. Vektorspeicher nutzen. Jeder Benutzer erhält standardmäßig einen separaten isolierten Datensatz. Derzeit ist nur die [Pinecone](https://app.pinecone.io/)-Integration verfügbar.
2. Auf "Alexa", "Hey, Jarvis", "Hey Mycroft" oder "Hey Rhasspy" reagieren, mit Unterstützung für Spracherkennung und Sprachantworten.

   ![Chatter Sprachaktivierung und UI-Steuerung](../assets/chatter-voice-activation.gif)

3. In die Desktop-App integriert:
   - lokales Piper-Modell für TTS;
   - natives Chrome TTS-Modell;
   - [Cartesia](https://www.cartesia.ai/)-Integration.
4. Befehle auf dem PC ausführen sowie Dateien bearbeiten und lesen. Kann als CLI verwendet werden.

   ![Chatter erstellt und öffnet eigenständig eine Website](../assets/chatter-site-creation.gif)

5. E-Mails von hinzugefügten Postfächern lesen und senden. Derzeit ist eine praktische geführte Integration für [Gmail](https://mail.google.com/mail/) und [Yandex](https://mail.yandex.ru/) sowie für jede andere E-Mail-Adresse verfügbar, die man manuell konfigurieren kann. Das Senden von E-Mails erfordert eine Benutzerbestätigung.
6. Websuche über den [Tavily](https://www.tavily.com/)-Dienst nutzen.
7. Websites mit [Browserless](https://www.browserless.io/pricing) lesen und parsen.
8. Bilder anhand einer Referenz oder aus Text über OpenRouter generieren.
9. Subagenten für jede Aufgabe einsetzen.

   ![Chatter parallele Subagenten bei der Arbeit](../assets/chatter-parallel-subagents.gif)

10. Spezialisierte Agenten aufrufen. Zum Beispiel: Komprimieren und Konvertieren von Videos in andere Formate.
11. Deine Server verwalten. Der Bot sieht niemals deinen SSH-Schlüssel oder dein sudo-Passwort. Zur Befehlsausführung wird eine SSH-Sitzung direkt auf deinem Server geöffnet. Der SSH-Schlüssel kann mit einem Klick direkt von deinem Computer abgerufen werden.
12. Runbook-Anleitungen für die spätere Verwendung speichern und mit anderen teilen.
13. Makros für dramatische Steuerung speichern (*Alexa, es ist Zeit zu arbeiten!*).
14. Benutzerdefinierte Prompts, plus einen KI-Editor, der direkt in das Panel integriert ist, für bequeme Bearbeitung.
15. Aufgaben und Erinnerungen festlegen. Zum Beispiel: Licht einschalten, daran erinnern, die Augentropfen in einem Monat zu entsorgen, oder den Server überprüfen (nur wenn Befehle in der erlaubten Liste sind), während du schläfst.
16. Deinen Pixel-Avatar steuern und seine Stimmung an die Konversation anpassen, direkt auf dem Bildschirm. Zeige auch alle Bilder und GIFs an, die er im Internet gefunden hat.
17. Pixel-Art erstellen und direkt auf dem Pixel-Avatar ausgeben.
18. Chats als DOCX speichern, Nachrichten aus einem Chat direkt an ein verknüpftes Telegram-Konto senden, plus viele weitere Quality of Life-Funktionen.
19. Magst du Rollenspiele mit Bots? Der **Dice Mode** ist integriert und würfelt bei jeder gesendeten Nachricht einen W20, der die Geschichte beeinflusst!
20. Die in die App-Oberfläche integrierte Karte steuern, Punkte auf der Karte merken und Routen planen (aber überprüfe die Informationen!).
21. Notizen in deinem Notizbuch speichern, das auch über die Telegram-App zugänglich ist.
22. Kontextgröße konfigurieren, Modelle für Subagenten bequem auswählen, ohne Konfigurationen zu bearbeiten, und Reasoning-Stufen festlegen (derzeit verfügbar für OpenRouter-, DeepSeek- und Xiaomi-Anbieter).
23. Die Webcam steuern, Screenshots machen und auf dem Bildschirm klicken, während der Desktop verbunden ist. Jede solche Aktion erfordert deine Bestätigung.
24. Die meisten Funktionen sind über Telegram mit einem praktischen Menü und Inline-Buttons zugänglich.
25. Dein Smart Home steuern und Licht nach Zeitplan einschalten. Die Yandex-Integration ist verfügbar; die Zigbee-Unterstützung ist derzeit experimentell und erfordert weitere Tests.
26. Dokumente und Fotos auch an ein Modell ohne Vision anhängen (wenn ein Vision-Modell separat eingerichtet ist).
27. Sprachnachrichten von Telegram transkribieren! (erfordert einen leistungsstarken Server mit mindestens 2 Kernen, 2 GB RAM und aktiviertem voice-api)
28. Praktische und schnelle Erstellung von Chat-Zweigen sowie Neugenerierung mit Anweisungen.
29. Der Bot schlägt einen Befehl vor, aber du weißt nicht, was er tut? Drücke die Review-Taste, und das Lite-Modell bewertet seine Risiken.

---

## Worauf liegt der Fokus von Chatter?

### 1. Sichere Agentenoperationen

- Jede Server-/PC-Aktion ist nur mit Benutzerzustimmung erlaubt. Ausnahmen: Yolo Mode aktiviert, Allow Always oder "in diesem Ordner arbeiten". "In diesem Ordner arbeiten" findet das nächste `.git` und schlägt es als Standard vor.
- Der Agent sieht niemals deinen SSH-Schlüssel oder dein Passwort: Sie werden automatisch ersetzt und verschlüsselt gespeichert. **Gib** dem Agenten NIEMALS dein Passwort, selbst wenn er danach fragt. Es gibt einen separaten Befehl zum Erstellen eines neuen Benutzers auf dem Server!
- Auf dem Desktop kannst du Funktionen selektiv deaktivieren, um die Sicherheit zu erhöhen. Du kannst das Schreiben von Daten verbieten, während nur Lesezugriff erlaubt ist, Subagenten, Internet- oder PC-Befehle deaktivieren. Oder ihm den Zugriff auf deinen Speicher vollständig entziehen.
- E-Mails, SSH-Schlüssel und sensible Daten werden verschlüsselt.
- Alle Admin-Panel-API-Anfragen laufen über einen Reverse Proxy und Chatter Manager, während wiederholte Anmeldeversuche automatisch blockiert werden.
- Ein grundlegender Prompt-Injection-Schutz ist integriert.
- Wenn du nicht weißt, was ein vom neuronalen Netz vorgeschlagener Befehl tut, drückst du Review, und ein anderes neuronales Netz erklärt es dir und bewertet die Risiken.

   ![Überprüfung von Befehlsrisiken vor der Ausführung](../assets/chatter-command-review.gif)

### 2. Unermüdliche Optimierung

- System-Prompts und andere wiederholte Kontextteile bleiben stabil, damit der Anbieter bis zu 90–95 % der Eingabe-Tokens cachen kann.
- Chats, Fotos und Nachrichten werden dynamisch geladen, um eine Überlastung des DOM zu vermeiden. Virtualisierung wird nicht verwendet (ich hasse sie): Stattdessen werden ein "Mehr laden"-Button und eine Berechnung auf Zeichenbasis verwendet.
- OpenRouter leitet dich zu verschiedenen Anbietern weiter und unterbricht das Caching, und du hast keine Lust, Konfigurationen anzupassen? Wähle einfach einen direkt von OpenRouter abgerufenen Anbieter aus, und nur dieser Anbieter wird verwendet.
- Du kannst mehrere Anbieter eintragen (OpenRouter/DeepSeek/Xiaomi/etc), und wenn der erste mit einem Fehler fehlschlägt, wird die Aufgabe sofort an einen anderen weitergeleitet.
- Kein Geld, um jedes Mal ein Vision-Modell laufen zu lassen? Kein Problem. Füge einmal ein Vision-Modell hinzu, und dein Haupt-KI-Bot bittet es einfach, das von dir angehängte Bild zu beschreiben.
- Kein Geld für TTS, aber du möchtest es trotzdem? Dafür sind lokale Modelle integriert. Viele externe Integrationen bieten auch einen kostenlosen Tarif an.
- Möchtest du nicht, dass die KI ständig Hilfscode für sich selbst generiert und jedes Mal Tokens verbrennt? Die integrierten Tools von Chatter sind bereits im Code implementiert. Sieht aus wie ein Nachteil, oder? Aber so kannst du an Chatter arbeiten (wenn du möchtest) neben Abonnements großer Dienste, indem du einfach `git clone` auf deinem Computer ausführst.
- Die Desktop-App verbraucht im Normalmodus etwa 300 MB RAM und belastet die CPU kaum. Server-Container werden separat gezählt, während TTS und Whisper natürlich mehr Ressourcen benötigen. Selbst Codex kann auf meinem Rechner problemlos langsam werden und ruckeln.
- Um das Caching nicht zu brechen, werden bei Kontextüberlauf 50 % der Konversation archiviert (eine kurze Zusammenfassung zur Komprimierung wird in Zukunft hinzugefügt).
- Wenn ein Dokument nicht passt, kürzt Chatter automatisch seinen Inhalt, wobei bis zu 90 % des ausgewählten Kontextlimits erhalten bleiben.
- Ein dediziertes Lite-Modell wird für die Generierung von Chat-Titeln, Überprüfungen und anderen leichten Anfragen verwendet.

### 3. Bequemlichkeit

- Möchtest du vom KI generierte Bilder oder Nachrichten an dein Telegram weiterleiten, damit sie auf deinem Handy sind? Drücke eine Taste.
- Möchtest du einen Prompt verbessern? Drücke eine Taste und übernehme die vom KI vorgeschlagenen Änderungen.
- Keine Lust, Makros auszufüllen oder etwas in das Notizbuch zu schreiben? Bitte die KI, es zu tun.
- Keine Lust, deinen SSH-Schlüssel auf deinem gesamten PC zu suchen? Drücke eine Taste :D
- Das Haus verlassen und das Gespräch vom Handy aus fortsetzen möchten? Alle Chats, Prompt-Auswahl und Modellauswahl sind direkt über Telegram verfügbar!
- Keine Lust, dich durchzukämpfen und deinen API-Schlüssel erneut zu suchen, ein Modell auf OpenRouter auszuwählen oder herauszufinden, wie man das Reasoning eines neuen Modells parst? API-Schlüssel können gespeichert werden, Modelle werden automatisch abgerufen und zeigen sofort Kosten, Kontextlimits und verfügbare Anbieter an, um das Caching zu erhalten! Und DeepSeek und Xiaomi sind als Drittanbieter kodiert (wenn neue wie Mistral auftauchen – schreib mir, ich füge sie hinzu).
- Keine Lust, manuell zu berechnen, wie viel jedes Modell kostet? OpenRouter füllt seine eigenen Werte aus, und es gibt Voreinstellungen für andere.
- Deine Benutzer haben keine Lust, sich mit der Modellauswahl herumzuschlagen? Der Auto Mode ist immer da!
- Alle Integrationen erhalten später Beschreibungen und Schnellstartanleitungen. Diese existieren bereits für die Smart-Home-Integration.

### 4. Anpassung

- Die Parameter jedes Modells können konfiguriert werden. Temperatur, Top P und andere.
- Die Funktionalität der Desktop-App kann deaktiviert und angepasst werden.

---

## Das Projekt in deine Sprache übersetzen

Hast du dich entschieden, das Projekt in deine Sprache zu übersetzen? Es ist schnell und einfach:

1. Füge deine Sprache zu `shared/languages.ts` hinzu – dies ist die einzige maßgebliche Quelle für die Sprachliste aller Komponenten.
2. Führe Folgendes aus:
   ```bash
   npm run sync:languages
   ```
   um die lokalen Kopien der Liste zu aktualisieren.
3. Füge deinen API-Schlüssel zu `.env.i18n` hinzu:
   ```
   I18N_TRANSLATE_API_URL=url
   I18N_TRANSLATE_API_KEY=your_key
   I18N_TRANSLATE_MODEL=your_model
   ```
4. Führe Folgendes aus:
   ```bash
   npm run i18n:translate:all
   ```
   Dieser Befehl übersetzt separat die Dateien des Telegram-Bots, Desktops, der Backend-API, der Webapp Notes, des Admin-Panels und des Changelogs.
5. Viel Spaß.

---

## Wichtig

- Der Dienst kann Fehler enthalten, die ich noch nicht gefunden habe. Wenn du einen findest – reiche ihn bei Issues ein, wir werden ihn klären. Die Fehler, die ich bereits kenne, befinden sich im Fix-Backlog. Ich arbeite allein an dem Projekt, daher ist Hilfe willkommen!
- Zukünftige Pläne umfassen ein Refactoring sowohl der Desktop-App als auch der Backend-API.
- Bei der Verwendung von Chatter als CLI für die Arbeit können noch Probleme auftreten (z. B. könnte es einen String verwechseln und keine Typen überprüfen, sodass ein Fehler bleibt). Ich arbeite daran, dies zu verbessern.
- **Sicherheitshinweis:** Chatter wird aktiv entwickelt und hat aufgrund seiner Integrationen, Fernsteuerungswerkzeuge und Self-Hosted-Architektur eine große Angriffsfläche. Obwohl Sicherheit Priorität hat, kann keine Software als vollständig sicher garantiert werden. Prüfe die Konfiguration, bevor du eine Instanz im Internet erreichbar machst, halte sie aktuell und melde Schwachstellen verantwortungsvoll. Die Absicherung wird mit der Weiterentwicklung des Projekts fortlaufend verbessert.
