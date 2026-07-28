[English](../../README.MD) | [Русский](README_RU.MD) | [Deutsch](README_DE.MD) | [Español](README_ES.MD) | [Français](README_FR.MD) | [Italiano](README_IT.MD) | [日本語](README_JA.MD) | [한국어](README_KO.MD) | [Polski](README_PL.MD) | [Português (BR)](README_PT-BR.MD) | [中文（简体）](README_ZH-CN.MD) | [Türkçe](README_TR.MD) | **Čeština**

---

# Co je Chatter?

Chatter je multi-platformní systém s AI agentem, který bezi na serveru a lze jej jedním kliknutím sdílet s přáteli nebo rodinou! Můžete si také nasadit vlastní službu s plány, limity a pohodlnou správou.

Ceny modelů se stahují automaticky. Vše, co potřebujete, je nastavit rozpočet pro předplatné.

> **Platební systém zatím není integrován!**

![Chatter propojuje Telegram a Desktop](../assets/chatter-telegram-desktop.gif)

Chtěli jste sdílet AI se svou matkou, ale technologie jí připadá příliš složitá? Dejte jí svého Telegram bota. Žádná křivka učení.

Chtěli jste vlastního Jarvis, který by rozsvítil světla, reagoval na hlasové příkazy a v noci stáhl rolety? Po připojení integrace chytré domácnosti to Chatter zvládne bez dalšího kódu nebo zbytečně utracených tokenů.

Nebo jste si jen chtěli zahrát roli s botem, ale nechtělo se vám hrabat se v konfiguracích, rozjíždět lokální server a vymýšlet nastavení? Chatter má nejuživatelsky přívětivější rozhraní a pohodlný admin panel (jak jen to jde).

AI agent běží na serveru (backend) a propojuje Telegram s vaším PC.

```
Telegram <-> Backend <-> Desktop
```

Uživatel Telegramu může pokračovat ve stejných chatech a ovládat své PC, pokud je Desktop připojen. Většina funkcí je dostupná bez ohledu na to, odkud byla zpráva odeslána.

---

## Jak je projekt strukturován?

- **backend-api** — veškerá serverová logika Chatteru. Agent, nástroje, paměť, chaty, limity, uživatelé a veškerá sdílená logika jsou zde.
- **desktop-app** — Electron aplikace pro komunikaci s agentem a ovládání vašeho PC.
- **Telegram bot** — druhé plnohodnotné rozhraní ke stejnému účtu, chatům a funkcím. Nachází se v kořenovém adresáři projektu (nepohodlné, ale tady to všechno začalo).
- **admin-panel** — správa modelů, klíčů, uživatelů, limitů, záloh a stavu serveru.
- **chatter-manager** — propojuje admin panel s Dockerem, umožňuje spouštět, zastavovat a aktualizovat komponenty.
- **webapp-notes** — Telegram miniaplikace pro poznámky.
- **voice-service** — volitelný lokální přepis a syntéza řeči.

Všechny serverové komponenty beží v oddělených Docker kontejnerech a jsou propojeny přes Docker Compose. Můžete si tak ponechat jen to, co skutečně potřebujete.

---

## Jak nainstalovat?

1. Pronajměte si server a nezapomeňte na něj nainstalovat fail2ban. Instalátor nakonfiguruje UFW automaticky: zachová přístup ke skutečnému SSH portu serveru a otevře porty 80/443 pro Chatter.
2. Otevřete konzoli a spusťte:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/NikitaCherepov/chatter/main/install.sh | sudo bash
   ```
3. **UJISTĚTE SE**, že si uložíte přihlašovací jméno a heslo zobrazené na konci instalace.
4. Přejděte do admin panelu na adrese vašeho serveru a zadejte přihlašovací jméno a heslo zobrazené v konzoli.
5. Dokončete kroky potřebné pro první spuštění:
   - Přidejte model a API klíč pro Auto mode.
   - Přidejte model a API klíč pro Lite mode.
   - Získejte Telegram token od [BotFather](https://t.me/BotFather) a přidejte jej do panelu.
   - Volitelně zkopírujte odkaz Webapp-Notes poskytnutý v panelu a přidejte jej do svého bota.
6. Napište botovi zprávu, schvalte svůj profil přes admin panel a poté si udělte administrátorská práva.

**Hotovo!**

---

## Jak připojit Desktop aplikaci?

1. Stáhněte si aplikaci z Releases a nainstalujte ji. Windows může varovat o chybějícím digitálním podpisu: sestavení aktuálně není podepsáno certifikátem.
2. Přejděte do sekce Přístupové klíče v admin panelu.
3. Vytvořte nový klíč a vložte jej do Desktop aplikace.
4. Zaregistrujte se.

**Hotovo!**

---

## Jak propojit účet na PC s Telegramem?

1. Přejděte do nastavení na desktopu.
2. Vyberte "Propojené účty".
3. Klikněte na "Telegram".
4. Pošlete do Telegram bota: `/link`
5. Zadejte kód zobrazený na obrazovce.

**Hotovo!**

---

## Jak to sdílet s přitelem?

**Přes Telegram:**
1. Pošlete jim Telegram bota a počkejte, až napíší.
2. Schvalte jejich účet z admin panelu.

**Přes Desktop:**
1. Pošlete jim Desktop aplikaci a sdílejte Přístupový klíč pro připojení k vašemu serveru.

**Hotovo!**

Vždy můžete vidět, jestli někdo sdílel váš klíč, a můžete jej kdykoli zrušit.

---

## Co všechno admin panel umí?

![Přehled serveru v admin panelu Chatteru](../assets/admin-overview.png)

1. **Sledovat stav komponent** a restartovat je.
2. **Chcete přidat nový model?** Není třeba znovu zadávat uložený API klíč nebo procházet celý OpenRouter při hledání názvu modelu.
   - API klíče lze ukládat a znovu používat.
   - Vyhledávač modelů pro OpenRouter je zabudovaný přímo v admin panelu.
   - Seznam poskytovatelů se naplní automaticky, jakmile vyberete model. Chcete, aby požadavky směřovaly pouze k určitému poskytovateli? Stačí jej vybrat z rozbalovací nabídky.
   - Ceny tokenů pro vstup/výstup/mezipaměť se nastaví automaticky při výběru modelu.
   - Vision model je k dispozici samostatně — pokud hlavní model není multimodální, požádá Vision, aby popsal obrázek, který jste přiložili.

   ![Výběr modelu, poskytovatele a ceny v admin panelu](../assets/admin-model-selection.gif)

3. **Pohodlná správa limitů.**
   - Stačí nastavit rozpočet, který může uživatel utratit.
   - Přizpůsobitelné limity pro obrázky a webové vyhledávání pro všechny uživatele a možnost zakázat připojování obrázků.

   ![Nastavení plánů, rozpočtů a limitů](../assets/admin-plans-limits.png)

4. **Analýza** toho, které modely uživatelé používají, zda jsou zapojeni subagenti, jak dobře jsou zprávy ukládány do mezipaměti a mnohem více.

   ![Uživatelské statistiky, připojení a využití modelů](../assets/admin-user-usage.png)

5. Backend logy a grafy výkonu serveru.
6. Pohodlná integrace dostupných služeb. Vložte klíč, zadejte údaje a vše funguje ihned po vybalení.
7. **Vlastní sestavení:**
   - Nechcete Telegram miniaplikaci? Nepovolujte ji.
   - Nemáte kapacitu pro serverovou TTS a přepis řeči? Žádný problém.
   - Můžete nakonfigurovat tolik předpřipravených promptů pro své uživatele, kolik chcete.
8. Potřebujete zabanovat uživatele? Jedno kliknutí a okamžitě ztratí přístup k vašemu serveru přes Telegram i Desktop aplikaci. Přístupový klíč lze také kdykoli zrušit.

---

## Co všechno Chatter umí?

1. Používat vektorovou paměť. Každý uživatel ve výchozím nastavení dostane samostatný izolovaný záznam. V současné době je k dispozici pouze integrace [Pinecone](https://app.pinecone.io/).
2. Probouzet se na "Alexa", "Hey, Jarvis", "Hey Mycroft" nebo "Hey Rhasspy" s podporou rozpoznávání řeči a hlasových odpovědí.

   ![Chatter hlasová aktivace a ovládání rozhraní](../assets/chatter-voice-activation.gif)

3. Integrováno do Desktop aplikace:
   - lokální Piper model pro TTS;
   - nativní Chrome TTS model;
   - [Cartesia](https://www.cartesia.ai/) integrace.
4. Spouštět příkazy na PC a také upravovat a číst soubory. Lze použít jako CLI.

   ![Chatter samostatně vytváří a otevírá webové stránky](../assets/chatter-site-creation.gif)

5. Číst a odesílat e-maily z přidaných poštovních schránek. V současné době je k dispozici pohodlná řízená integrace pro [Gmail](https://mail.google.com/mail/) a [Yandex](https://mail.yandex.ru/) a také jakýkoli jiný e-mail, který můžete nakonfigurovat ručně. Odesílání e-mailů vyžaduje potvrzení uživatele.
6. Používat webové vyhledávání prostřednictvím služby [Tavily](https://www.tavily.com/).
7. Číst a parsovat webové stránky pomocí [Browserless](https://www.browserless.io/pricing).
8. Generovat obrázky z reference nebo z textu přes OpenRouter.
9. Používat subagenty pro jakýkoli úkol.

   ![Chatter paralelní subagenti při práci](../assets/chatter-parallel-subagents.gif)

10. Volat specializované agenty. Například: komprese a konverze videí do jiných formátů.
11. Spravovat své servery. Bot nikdy neuvidí váš SSH klíč ani sudo heslo. Pro spouštění příkazů se SSH relace otevírá přímo na vašem serveru. SSH klíč lze stáhnout jedním tlačítkem přímo z vašeho počítače.
12. Ukládat a používat Runbook instrukce pro pozdější použití a sdílet je s ostatními.
13. Ukládat makra pro dramatické ovládání (*Alexo, je čas pracovat!*).
14. Vlastní prompty a editor AI zabudovaný přímo v panelu pro pohodlné úpravy.
15. Nastavovat úkoly a připomínky. Například: rozsvítit světlo, připomenout vám za měsíc vyhodit oční kapky nebo zkontrolovat server (pouze pokud jsou příkazy v povoleném seznamu), zatímco spíte.
16. Ovládat pixelového avatara a přizpůsobovat jeho náladu konverzaci přímo na obrazovce. Také na něm zobrazovat jakékoli obrázky a GIFy, které našel na internetu.
17. Vytvářet pixel art a vykreslovat jej přímo na pixelového avatara.
18. Ukládat chaty jako DOCX, odesílat zprávy z chatu přímo na propojený Telegram účet a mnoho dalších Quality of Life funkcí.
19. Baví vás hrát si s boty? **Dice Mode** je zabudován, při každé odeslané zprávě hází d20 a ovlivňuje příběh!
20. Ovládat mapu zabudovanou v rozhraní aplikace, pamatovat si body na mapě a plánovat trasy (ale informace si dvakrát zkontrolujte!).
21. Ukládat poznámky do svého poznámkového bloku, který je také přístupný z Telegram aplikace.
22. Konfigurovat velikost kontextu, pohodlně vybírat modely pro subagenty bez dotýkání se konfigurací a nastavovat úrovně uvažování (aktuálně dostupné pro poskytovatele OpenRouter, DeepSeek a Xiaomi).
23. Ovládat webkameru, pořizovat snímky obrazovky a klikat na obrazovku, když je Desktop připojen. Jakákoli taková akce vyžaduje vaše potvrzení.
24. Většina funkcí je přístupná z Telegramu s pohodlnou nabídkou a inline tlačítky.
25. Ovládat svou chytrou domácnost a rozsvěcovat světla podle plánu. Yandex integrace je k dispozici; Zigbee podpora je v současné době experimentální a vyžaduje další testování.
26. Připojovat dokumenty a fotografie i k modelu bez vision schopností (pokud je vision model nastaven samostatně).
27. Přepisovat hlasové zprávy z Telegramu! (vyžaduje výkonný server s alespoň 2 jádry, 2 GB RAM a povoleným voice-api)
28. Pohodlné a rychlé vytváření větví chatu a regenerace s instrukcemi.
29. Bot navrhne příkaz, ale nevíte, co dělá? Stiskněte tlačítko Review a Lite model posoudí jeho rizika.

---

## Na co je Chatter zaměřen?

### 1. Bezpečná činnost agenta

- Každá akce na serveru/PC je povolena pouze se souhlasem uživatele. Výjimky: povolený Yolo mode, Allow Always nebo "práce v této složce". "Práce v této složce" najde nejbližší `.git` a navrhne jej jako výchozí.
- Agent nikdy nevidí váš SSH klíč ani heslo: jsou dosazovány automaticky a ukládány šifrované. **NEDÁVEJTE** agentovi své heslo, i když o něj požádá. Má samostatný příkaz pro vytvoření nového uživatele na serveru!
- Na desktopu můžete selektivně zakázat funkce kvůli bezpečnosti. Můžete zakázat zápis a povolit pouze čtení, zakázat subagenty, internet nebo PC příkazy. Nebo mu zcela odříznout přístup k vaší paměti.
- E-maily, SSH klíče a citlivá data jsou šifrovány.
- Všechny požadavky API admin panelu procházejí přes reverzní proxy a Chatter Manager, zatímco opakované pokusy o přihlášení jsou automaticky blokovány.
- Základní ochrana proti prompt injection je zabudována.
- Pokud nevíte, co dělá příkaz navržený neurální sítí, stisknete Review a jiná neurální síť vám jej vysvětlí a posoudí rizika.

   ![Kontrola rizik příkazu před provedením](../assets/chatter-command-review.gif)

### 2. Neúnavná optimalizace

- Systémové prompty a další opakované části kontextu zůstávají stabilní, aby poskytovatel mohl uložit do mezipaměti až 90–95 % vstupních tokenů.
- Chaty, fotografie a zprávy se načítají dynamicky, aby nedošlo k přetížení DOM. Virtualizace není použita (nenávidím ji): místo toho se používá tlačítko pro načtení dalších a výpočet založený na počtu znaků.
- OpenRouter vás přesměrovává na různé poskytovatele a narušuje ukládání do mezipaměti a vy se do toho nechcete hrabat a konfigurovat klíče? Stačí vybrat poskytovatele staženého přímo z OpenRouteru a bude použit pouze tento poskytovatel.
- Můžete zadat více poskytovatelů (OpenRouter/DeepSeek/Xiaomi/atd.), a pokud první selže s chybou, úkol je okamžitě přesměrován na jiného.
- Nemáte peníze na to, abyste pokaždé spouštěli vision model? Žádný problém. Přidejte vision model jednou a váš hlavní AI bot ho jednoduše požádá, aby popsal obrázek, který jste přiložili.
- Nemáte peníze na TTS, ale přesto ho chcete? K tomu jsou zabudovány lokální modely. Mnoho externích integrací také nabízí bezplatnou úroveň.
- Nechcete, aby si AI znovu a znovu generovala pomocný kód a pokaždé pálila tokeny? Chatterovy vestavěné nástroje jsou implementovány předem v kódu. Vypadá to jako nevýhoda, že? Ale takto můžete pracovat na Chatteru (pokud chcete) vedle předplatného velkých služeb, stačí provést `git clone` na svém počítači.
- Desktop aplikace v normálním režimu spotřebuje asi 300 MB RAM a téměř nezatěžuje CPU. Serverové kontejnery se počítají zvlášť, zatímco TTS a Whisper přirozeně vyžadují více zdrojů. Pro srovnání: Codex mi na počítači dokázal nabobtnat na desítky gigabajtů — nemohl jsem si odpustit rýpanec :)
- Aby nedošlo k narušení ukládání do mezipaměti, když kontext přeteče, je 50 % konverzace archivováno (v budoucnu bude přidáno krátké shrnutí pro kompresi).
- Pokud se dokument nevejde, Chatter automaticky zkrátí jeho obsah a zachová až 90 % zvoleného limit kontextu.
- Vyhrazený Lite model se používá pro generování názvů chatů, recenzí a dalších nenáročných požadavků.

### 3. Pohodlí

- Chcete přeposlat obrázky nebo zprávy generované AI na Telegram, abyste je měli v telefonu? Stiskněte jedno tlačítko.
- Chcete vylepšit prompt? Stiskněte jedno tlačítko a aplikujte změny navržené AI.
- Nechcete vyplňovat makra nebo psát něco do poznámkového bloku? Požádejte AI, aby to udělala.
- Nechcete hledat svůj SSH klíč po celém PC? Stiskněte jedno tlačítko :D
- Odešli jste z domova a chcete pokračovat v konverzaci z telefonu? Všechny chaty, výběr promptů a výběr modelu jsou k dispozici přímo z Telegramu!
- Nechcete se znovu trápit hledáním API klíče, vybírat model na OpenRouteru nebo zjišťovat, jak parsovat uvažování nového modelu? API klíče lze ukládat, modely se stahují automaticky a okamžitě zobrazují cenu, limity kontextu a dostupné poskytovatele pro zachování ukládání do mezipaměti! DeepSeek a Xiaomi jsou zakódovány jako poskytovatelé třetích stran (pokud se objeví noví jako Mistral — napište mi, přidám je).
- Nechcete ručně počítat, kolik každý model stojí? OpenRouter vyplní své vlastní hodnoty a pro ostatní jsou k dispozici předvolby.
- Vaši uživatelé se nechtějí zabývat výběrem modelů? Auto mode je tu vždy!
- Všechny integrace později získají popisy a rychlé průvodce. Ty již existují pro integraci chytré domácnosti.

### 4. Přizpůsobení

- Parametry každého modelu lze konfigurovat. Teplota, Top P a další.
- Funkce Desktop aplikace lze zakázat a přizpůsobit.

---

## Překlad projektu do vašeho jazyka

Rozhodli jste se přeložit projekt do svého jazyka? Je to rychlé a snadné:

1. Přidejte svůj jazyk do `shared/languages.ts` — toto je jediný zdroj pravdy pro seznam jazyků ve všech komponentách.
2. Spusťte:
   ```bash
   npm run sync:languages
   ```
   pro aktualizaci místních kopií seznamu.
3. Přidejte svůj API klíč do `.env.i18n`:
   ```
   I18N_TRANSLATE_API_URL=url
   I18N_TRANSLATE_API_KEY=your_key
   I18N_TRANSLATE_MODEL=your_model
   ```
4. Spusťte:
   ```bash
   npm run i18n:translate:all
   ```
   Tento příkaz samostatně přeloží Telegram bota, Desktop, Backend API, Webapp Notes, admin panel a soubory changelogu.
5. Užijte si to.

---

## Důležité

- Služba může obsahovat chyby, které jsem dosud nenašel. Pokud nějakou najdete — nahlaste ji do Issues, vyřešíme to. Chyby, o kterých již vím, jsou v backlogu oprav. Na projektu pracuji sám, takže pomoc je vítána!
- Budoucí plány zahrnují refaktoring desktop-app i backend-api.
- Při používání Chatteru jako CLI pro práci se mohou stále vyskytovat problémy (např. může si splést řetězec a nezkontrolovat typy, což zanechá chybu). Pracuji na zlepšení.
