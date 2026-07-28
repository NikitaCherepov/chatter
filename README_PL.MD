[English](README.MD) | [Русский](README_RU.MD) | [Deutsch](README_DE.MD) | [Español](README_ES.MD) | [Français](README_FR.MD) | [Italiano](README_IT.MD) | [日本語](README_JA.MD) | [한국어](README_KO.MD) | **Polski** | [Português (BR)](README_PT-BR.MD) | [中文（简体）](README_ZH-CN.MD) | [Türkçe](README_TR.MD) | [Čeština](README_CS.MD)

---

# Czym jest Chatter?

Chatter to wieloplatformowy system z agentem AI, który działa na serwerze i może być udostępniany znajomym lub rodzinie jednym kliknięciem! Możesz również uruchomić na nim własną usługę z planami, limitami i wygodnym zarządzaniem.

Ceny modeli są pobierane automatycznie. Jedyne, czego potrzebujesz, to ustawić budżet na subskrypcję.

> **System płatności nie jest jeszcze zintegrowany!**

![Chatter łączy Telegram i Desktop](docs/assets/chatter-telegram-desktop.gif)

Chciałeś udostępnić AI swojej mamie, ale uważa, że technologia jest zbyt skomplikowana? Daj jej swojego bota Telegram. Zero krzywej uczenia się.

Chciałeś swojego własnego Jarvisa, który włącza światła, reaguje na komendy głosowe i opuszcza rolety w nocy? Po podłączeniu integracji inteligentnego domu, Chatter może to zrobić bez dodatkowego kodu i marnowania tokenów.

A może po prostu chciałeś odgrywać role z botem, ale nie chciałeś grzebać w konfiguracjach, uruchamiać lokalnego serwera i zastanawiać się nad ustawieniami? Chatter ma najbardziej przyjazny interfejs użytkownika i wygodny panel administracyjny (na tyle, na ile to możliwe).

Agent AI działa na serwerze (backend) i łączy Telegram z Twoim komputerem.

```
Telegram <-> Backend <-> Desktop
```

Użytkownik Telegramu może kontynuować te same rozmowy i kontrolować swój komputer, gdy Desktop jest podłączony. Większość funkcji jest dostępna niezależnie od tego, skąd wiadomość została wysłana.

---

## Jak jest zbudowany projekt?

- **backend-api** — cała logika serwerowa Chattera. Agent, narzędzia, pamięć, czaty, limity, użytkownicy i cała współdzielona logika znajdują się tutaj.
- **desktop-app** — aplikacja Electron do komunikacji z agentem i sterowania komputerem.
- **Telegram bot** — drugi pełnoprawny interfejs do tego samego konta, czatów i funkcji. Znajduje się w katalogu głównym projektu (niewygodne, ale tak to się zaczęło).
- **admin-panel** — zarządzanie modelami, kluczami, użytkownikami, limitami, kopiami zapasowymi i stanem serwera.
- **chatter-manager** — łączy panel administracyjny z Dockerem, umożliwiając uruchamianie, zatrzymywanie i aktualizację komponentów.
- **webapp-notes** — miniaplikacja Telegram do notatek.
- **voice-service** — opcjonalna lokalna transkrypcja i synteza mowy.

Wszystkie komponenty serwerowe działają w osobnych kontenerach Docker i są połączone za pomocą Docker Compose. Możesz więc zachować tylko to, czego naprawdę potrzebujesz.

---

## Jak zainstalować?

1. Wynajmij serwer i pamiętaj, aby zainstalować na nim fail2ban. Instalator skonfiguruje UFW automatycznie: zachowa dostęp do rzeczywistego portu SSH serwera i otworzy porty 80/443 dla Chattera.
2. Otwórz konsolę i uruchom:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/NikitaCherepov/chatter/main/install.sh | sudo bash
   ```
3. **UPEWNIJ SIĘ**, że zapisałeś login i hasło wyświetlone na końcu instalacji.
4. Przejdź do panelu administracyjnego pod adresem swojego serwera i wprowadź login oraz hasło pokazane w konsoli.
5. Wykonaj kroki wymagane przy pierwszym uruchomieniu:
   - Dodaj model i klucz API dla trybu Auto.
   - Dodaj model i klucz API dla trybu Lite.
   - Uzyskaj token Telegram od [BotFather](https://t.me/BotFather) i dodaj go w panelu.
   - Opcjonalnie skopiuj link Webapp-Notes podany w panelu i dodaj go do swojego bota.
6. Wyślij wiadomość do bota i zatwierdź swój profil w panelu administracyjnym, a następnie nadaj sobie uprawnienia administratora.

**Gotowe!**

---

## Jak podłączyć aplikację Desktop?

1. Pobierz aplikację z Releases i zainstaluj ją. System Windows może ostrzec o braku podpisu cyfrowego: kompilacja nie jest obecnie podpisana certyfikatem.
2. Przejdź do sekcji Klucze dostępu w panelu administracyjnym.
3. Utwórz nowy klucz i wklej go do aplikacji Desktop.
4. Zarejestruj się.

**Gotowe!**

---

## Jak połączyć konto PC z Telegramem?

1. Przejdź do ustawień na pulpicie.
2. Wybierz "Połączone konta".
3. Kliknij na "Telegram".
4. Wyślij w bocie Telegram: `/link`
5. Wprowadź kod wyświetlony na ekranie.

**Gotowe!**

---

## Jak udostępnić to znajomemu?

**Przez Telegram:**
1. Wyślij im bota Telegram i poczekaj, aż napiszą.
2. Zatwierdź ich konto z panelu administracyjnego.

**Przez Desktop:**
1. Wyślij im aplikację Desktop i udostępnij Klucz dostępu do połączenia z Twoim serwerem.

**Gotowe!**

Zawsze możesz sprawdzić, czy ktoś udostępnił Twój klucz, i w każdej chwili go unieważnić.

---

## Co potrafi panel administracyjny?

![Podgląd panelu administracyjnego Chatter](docs/assets/admin-overview.png)

1. **Monitoruj stan komponentów** i restartuj je.
2. **Chcesz dodać nowy model?** Nie ma potrzeby ponownego wprowadzania zapisanego klucza API ani przeglądania całego OpenRouter w poszukiwaniu nazwy modelu.
   - Klucze API można zapisywać i ponownie wykorzystywać.
   - Wyszukiwarka modeli dla OpenRouter jest wbudowana w panel administracyjny.
   - Lista dostawców jest wypełniana zaraz po wybraniu modelu. Chcesz, aby żądania trafiały tylko do konkretnego dostawcy? Po prostu wybierz go z listy rozwijanej.
   - Ceny tokenów wejścia/wyjścia/cache są ustawiane automatycznie po wybraniu modelu.
   - Model Vision jest dostępny osobno — jeśli główny model nie jest multimodalny, poprosi Vision o opisanie dołączonego obrazu.

   ![Wybór modelu, dostawcy i ceny w panelu administracyjnym](docs/assets/admin-model-selection.gif)

3. **Wygodne zarządzanie limitami.**
   - Po prostu ustaw budżet, który użytkownik może wydać.
   - Konfigurowalne limity dla obrazów i wyszukiwania w sieci dla wszystkich użytkowników, plus możliwość wyłączenia załączników obrazów.

   ![Konfiguracja planów, budżetów i limitów](docs/assets/admin-plans-limits.png)

4. **Analiza** tego, które modele są używane przez użytkowników, czy subagenci są zaangażowani, jak dobrze buforowane są wiadomości i wiele więcej.

   ![Statystyki użytkowników, połączenia i użycie modeli](docs/assets/admin-user-usage.png)

5. Logi backendu i wykresy wydajności serwera.
6. Wygodna integracja dostępnych usług. Wklej klucz, wprowadź dane, a wszystko działa od razu.
7. **Własna konfiguracja:**
   - Nie chcesz miniaplikacji Telegram? Nie włączaj jej.
   - Brak mocy obliczeniowej na TTS i transkrypcję głosu po stronie serwera? Nie ma problemu.
   - Możesz skonfigurować tyle predefiniowanych promptów dla swoich użytkowników, ile chcesz.
8. Potrzebujesz zbanować użytkownika? Jedno kliknięcie i natychmiast tracą dostęp do Twojego serwera przez Telegram i aplikację Desktop. Klucz dostępu również można w każdej chwili unieważnić.

---

## Co potrafi Chatter?

1. Używa pamięci wektorowej. Każdy użytkownik domyślnie otrzymuje osobny, izolowany zapis. Obecnie dostępna jest tylko integracja z [Pinecone](https://app.pinecone.io/).
2. Budzi się na "Alexa", "Hey, Jarvis", "Hey Mycroft" lub "Hey Rhasspy", z obsługą rozpoznawania mowy i odpowiedzi głosowych.

   ![Aktywacja głosowa Chatter i sterowanie UI](docs/assets/chatter-voice-activation.gif)

3. Wbudowane w aplikację Desktop:
   - lokalny model Piper do TTS;
   - natywny model TTS Chrome;
   - integracja z [Cartesia](https://www.cartesia.ai/).
4. Wykonuje polecenia na komputerze, a także edytuje i odczytuje pliki. Może być używany jako CLI.

   ![Chatter samodzielnie tworzy i otwiera stronę internetową](docs/assets/chatter-site-creation.gif)

5. Odczytuje i wysyła e-maile z dodanych skrzynek pocztowych. Obecnie dostępna jest wygodna, prowadzona integracja dla [Gmail](https://mail.google.com/mail/) i [Yandex](https://mail.yandex.ru/), a także dowolnej innej poczty, którą można skonfigurować ręcznie. Wysyłanie e-maili wymaga potwierdzenia użytkownika.
6. Używa wyszukiwania w sieci przez usługę [Tavily](https://www.tavily.com/).
7. Czyta i analizuje strony internetowe za pomocą [Browserless](https://www.browserless.io/pricing).
8. Generuje obrazy na podstawie referencji lub z tekstu przez OpenRouter.
9. Używa subagentów do dowolnego zadania.

   ![Równoległa praca subagentów Chatter](docs/assets/chatter-parallel-subagents.gif)

10. Wywołuje wyspecjalizowanych agentów. Na przykład: kompresowanie i konwertowanie wideo na inne formaty.
11. Zarządza Twoimi serwerami. Bot nigdy nie widzi Twojego klucza SSH ani hasła sudo. Do wykonywania poleceń sesja SSH otwiera się bezpośrednio na Twoim serwerze. Klucz SSH można pobrać jednym przyciskiem prosto z komputera.
12. Zapisuje i używa instrukcji Runbook do późniejszego wykorzystania oraz udostępnia je innym.
13. Zapisuje makra do dramatycznej kontroli (*Alexa, czas do pracy!*).
14. Niestandardowe prompty, plus edytor AI wbudowany bezpośrednio w panel do wygodnej edycji.
15. Ustawia zadania i przypomnienia. Na przykład: włącz światło, przypomnij o wyrzuceniu kropli do oczu za miesiąc lub sprawdź serwer (tylko jeśli polecenia są na liście dozwolonych), gdy śpisz.
16. Steruje pikselowym awatarem i dostosowuje jego nastrój do rozmowy bezpośrednio na ekranie. Wyświetla również na nim dowolne obrazy i GIF-y znalezione w internecie.
17. Tworzy pixel art i wyświetla go bezpośrednio na pikselowym awatarze.
18. Zapisuje czaty jako DOCX, wysyła wiadomości z czatu bezpośrednio na połączone konto Telegram, plus wiele innych funkcji Quality of Life.
19. Lubisz odgrywanie ról z botami? **Dice Mode** jest wbudowany, rzuca k20 przy każdej wysłanej wiadomości i wpływa na historię!
20. Steruje mapą wbudowaną w interfejs aplikacji, zapamiętuje punkty na mapie i wyznacza trasy (ale sprawdź informacje!).
21. Zapisuje notatki w notesie, który jest również dostępny z aplikacji Telegram.
22. Konfiguruje rozmiar kontekstu, wygodnie wybiera modele dla subagentów bez dotykania konfiguracji i ustawia poziomy rozumowania (obecnie dostępne dla dostawców OpenRouter, DeepSeek i Xiaomi).
23. Steruje kamerą internetową, robi zrzuty ekranu i klika na ekranie, gdy Desktop jest podłączony. Każda taka czynność wymaga Twojego potwierdzenia.
24. Większość funkcji jest dostępna z Telegramu z wygodnym menu i przyciskami inline.
25. Steruje inteligentnym domem i włącza światła zgodnie z harmonogramem. Integracja Yandex jest dostępna; obsługa Zigbee jest obecnie eksperymentalna i wymaga dalszych testów.
26. Dołącza dokumenty i zdjęcia nawet do modelu bez vision (gdy model vision jest skonfigurowany osobno).
27. Transkrybuje wiadomości głosowe z Telegramu! (wymaga wydajnego serwera z co najmniej 2 rdzeniami, 2 GB RAM i włączonym voice-api)
28. Wygodne i szybkie tworzenie gałęzi czatu oraz regeneracja z instrukcjami.
29. Bot sugeruje polecenie, ale nie wiesz, co robi? Naciśnij przycisk Review, a model Lite oceni jego ryzyko.

---

## Na czym skupia się Chatter?

### 1. Bezpieczne działanie agenta

- Każde działanie na serwerze/komputerze jest dozwolone tylko za zgodą użytkownika. Wyjątki: włączony Yolo mode, Allow Always lub "pracuj w tym folderze". "Pracuj w tym folderze" znajduje najbliższy `.git` i sugeruje go jako domyślny.
- Agent nigdy nie widzi Twojego klucza SSH ani hasła: są one podstawiane automatycznie i przechowywane w zaszyfrowanej formie. **NIE** podawaj agentowi swojego hasła, nawet jeśli o nie poprosi. Ma osobną komendę do tworzenia nowego użytkownika na serwerze!
- Na pulpicie możesz selektywnie wyłączać funkcje dla bezpieczeństwa. Możesz zabronić zapisywania danych, zezwalając tylko na odczyt, wyłączyć subagentów, internet lub polecenia PC. Możesz też całkowicie odciąć mu dostęp do swojej pamięci.
- E-maile, klucze SSH i wrażliwe dane są szyfrowane.
- Wszystkie żądania API panelu administracyjnego przechodzą przez reverse proxy i Chatter Manager, a powtarzające się próby logowania są automatycznie blokowane.
- Podstawowa ochrona przed iniekcją promptów jest wbudowana.
- Jeśli nie wiesz, co robi polecenie sugerowane przez sieć neuronową, naciskasz Review, a inna sieć neuronowa wyjaśnia Ci to, oceniając ryzyko.

   ![Sprawdzanie ryzyka polecenia przed wykonaniem](docs/assets/chatter-command-review.gif)

### 2. Nieustanna optymalizacja

- Systemowe prompty i inne powtarzające się części kontekstu pozostają stabilne, aby dostawca mógł buforować do 90–95% tokenów wejściowych.
- Czaty, zdjęcia i wiadomości są ładowane dynamicznie, aby nie przeciążać DOM. Wirtualizacja nie jest używana (nie lubię jej): zamiast tego stosowany jest przycisk "załaduj więcej" i obliczenia oparte na liczbie znaków.
- OpenRouter przekierowuje Cię do różnych dostawców i psuje buforowanie, a nie chcesz grzebać i konfigurować kluczy? Po prostu wybierz dostawcę pobranego bezpośrednio z OpenRouter, a tylko ten dostawca będzie używany.
- Możesz wprowadzić wielu dostawców (OpenRouter/DeepSeek/Xiaomi/etc), a jeśli pierwszy zgłosi błąd, zadanie jest natychmiast przekierowywane do innego.
- Nie masz pieniędzy, aby uruchamiać model vision za każdym razem? Nie ma problemu. Dodaj model vision raz, a Twój główny bot AI po prostu poprosi go o opisanie dołączonego obrazu.
- Nie masz pieniędzy na TTS, ale wciąż go chcesz? Wbudowane są do tego lokalne modele. Wiele zewnętrznych integracji oferuje również darmowy poziom.
- Nie chcesz, aby AI generowało dla siebie kod narzędziowy w kółko i spalało tokeny za każdym razem? Wbudowane narzędzia Chattera są zaimplementowane w kodzie z wyprzedzeniem. Wygląda to jak wada, prawda? Ale w ten sposób możesz pracować nad Chatterem (jeśli chcesz) obok subskrypcji głównych usług, po prostu robiąc `git clone` na swoim komputerze.
- Aplikacja Desktop w normalnym trybie zużywa około 300 MB RAM i ledwo obciąża CPU. Kontenery serwerowe są liczone osobno, podczas gdy TTS i Whisper naturalnie wymagają więcej zasobów. Dla porównania: Codex mógł rozrosnąć się do dziesiątek gigabajtów na moim komputerze — nie mogłem się powstrzymać przed małym uszczypliwością :)
- Aby nie psuć buforowania, gdy kontekst się przepełni, 50% rozmowy jest archiwizowane (krótkie podsumowanie do kompresji zostanie dodane w przyszłości).
- Jeśli dokument nie mieści się, Chatter automatycznie przycina jego zawartość, zachowując do 90% wybranego limitu kontekstu.
- Dedykowany model Lite jest używany do generowania tytułów czatów, recenzji i innych lekkich żądań.

### 3. Wygoda

- Chcesz przesłać obrazy lub wiadomości wygenerowane przez AI do swojego Telegramu, aby były na telefonie? Naciśnij jeden przycisk.
- Chcesz ulepszyć prompt? Naciśnij jeden przycisk i zastosuj zmiany sugerowane przez AI.
- Nie chcesz wypełniać makr ani pisać czegoś w notatniku? Poproś AI, aby to zrobiło.
- Nie chcesz szukać swojego klucza SSH na całym komputerze? Naciśnij jeden przycisk :D
- Wyszedłeś z domu i chcesz kontynuować rozmowę z telefonu? Wszystkie czaty, wybór promptów i wybór modelu są dostępne bezpośrednio z Telegramu!
- Nie chcesz się męczyć i szukać ponownie swojego klucza API, wybierać modelu na OpenRouter ani zastanawiać się, jak sparsować rozumowanie nowego modelu? Klucze API można zapisywać, modele są pobierane automatycznie i natychmiast pokazują koszt, limity kontekstu i dostępnych dostawców, aby zachować buforowanie! A DeepSeek i Xiaomi są zakodowane jako zewnętrzni dostawcy (jeśli pojawią się nowi, jak Mistral — napisz do mnie, dodam ich).
- Nie chcesz ręcznie obliczać, ile kosztuje każdy model? OpenRouter wypełnia swoje własne wartości, a dla innych są gotowe ustawienia.
- Twoi użytkownicy nie chcą zawracać sobie głowy wyborem modeli? Tryb Auto jest zawsze dostępny!
- Wszystkie integracje otrzymają później opisy i przewodniki szybkiego startu. Te już istnieją dla integracji inteligentnego domu.

### 4. Dostosowywanie

- Parametry każdego modelu można konfigurować. Temperatura, Top P i inne.
- Funkcjonalność aplikacji Desktop można wyłączać i dostosowywać.

---

## Tłumaczenie projektu na Twój język

Postanowiłeś przetłumaczyć projekt na swój język? To szybkie i łatwe:

1. Dodaj swój język do `shared/languages.ts` — to jest jedyne źródło prawdy dla listy języków we wszystkich komponentach.
2. Uruchom:
   ```bash
   npm run sync:languages
   ```
   aby zaktualizować lokalne kopie listy.
3. Dodaj swój klucz API do `.env.i18n`:
   ```
   I18N_TRANSLATE_API_URL=url
   I18N_TRANSLATE_API_KEY=your_key
   I18N_TRANSLATE_MODEL=your_model
   ```
4. Uruchom:
   ```bash
   npm run i18n:translate:all
   ```
   To polecenie przetłumaczy osobno pliki bota Telegram, Desktop, Backend API, Webapp Notes, panelu administracyjnego i changeloga.
5. Ciesz się.

---

## Ważne

- Usługa może zawierać błędy, których jeszcze nie znalazłem. Jeśli znajdziesz — zgłoś go w Issues, rozpracujemy to. Błędy, o których już wiem, są w kolejce do naprawy. Pracuję nad projektem sam, więc pomoc jest mile widziana!
- Przyszłe plany obejmują refaktoryzację zarówno desktop-app, jak i backend-api.
- Podczas używania Chattera jako CLI do pracy mogą nadal występować problemy (np. może pomylić string i nie sprawdzić typów, pozostawiając błąd). Pracuję nad poprawą tego.
