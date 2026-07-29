[English](../../README.MD) | [Русский](README_RU.MD) | [Deutsch](README_DE.MD) | [Español](README_ES.MD) | [Français](README_FR.MD) | [Italiano](README_IT.MD) | [日本語](README_JA.MD) | [한국어](README_KO.MD) | [Polski](README_PL.MD) | [Português (BR)](README_PT-BR.MD) | [中文（简体）](README_ZH-CN.MD) | **Türkçe** | [Čeština](README_CS.MD)

---

# Chatter Nedir?

Chatter, bir sunucuda çalışan ve arkadaşlarınız veya ailenizle tek tıkla paylaşılabilen, çok platformlu bir yapay zeka ajan sistemidir! Ayrıca planlar, limitler ve kullanışlı yönetim ile kendi hizmetinizi de kurabilirsiniz.

Model fiyatları otomatik olarak OpenRouter'dan alınır. Tek ihtiyacınız, abonelik için bir bütçe belirlemektir.

> **Ödeme sistemi henüz entegre edilmedi!**

![Chatter, Telegram ve Masaüstünü birbirine bağlar](../assets/chatter-telegram-desktop.gif)

Yapay zekayı annenizle paylaşmak istediniz ama teknolojiyi çok karmaşık mı buluyor? Ona Telegram botunuzu verin. Sıfır öğrenme eğrisi.

Kendi Jarvis'inize sahip olmak istediniz ama ışıkları açsın, sesli komutlara yanıt versin ve geceleri perdesini indirsin mi? Akıllı ev entegrasyonunu bağladıktan sonra Chatter, ek kod veya boşa harcanmış token olmadan bunu yapabilir.

Ya da belki sadece bir botla rol yapmak istediniz ama konfigürasyonları kurcalamak, yerel bir sunucu başlatmak ve ayarları anlamak istemediniz mi? Chatter, mümkün olduğunca kullanıcı dostu bir arayüze ve kullanışlı bir yönetim paneline sahiptir.

Yapay zeka ajanı sunucuda (backend) çalışır ve Telegram ile PC'nizi birbirine bağlar.

```
Telegram <-> Backend <-> Desktop
```

Bir Telegram kullanıcısı, Masaüstü bağlıyken aynı sohbetlere devam edebilir ve PC'sini kontrol edebilir. Çoğu özellik, mesajın nereden gönderildiğine bakılmaksızın kullanılabilir.

---

## Proje nasıl yapılandırılmıştır?

- **backend-api** — Chatter'ın tüm sunucu tarafı mantığı. Ajan, araçlar, bellek, sohbetler, limitler, kullanıcılar ve tüm paylaşılan mantık burada bulunur.
- **desktop-app** — Ajanla iletişim kurmak ve PC'nizi kontrol etmek için Electron uygulaması.
- **Telegram bot** — Aynı hesap, sohbetler ve özellikler için ikinci tam teşekküllü arayüz. Proje kök dizininde bulunur (kullanışsız ama her şeyin başladığı yer burası).
- **admin-panel** — Modellerin, anahtarların, kullanıcıların, limitlerin, yedeklemelerin ve sunucu durumunun yönetimi.
- **chatter-manager** — Yönetim panelini Docker'a bağlayarak bileşenleri başlatmanıza, durdurmanıza ve güncellemenize olanak tanır.
- **webapp-notes** — Notlar için Telegram mini uygulaması.
- **voice-service** — yalnızca Telegram için isteğe bağlı hizmet: gelen sesli mesajları yazıya döker ve kullanıcı sesli mesaj gönderdiğinde Chatter'ın yanıtını otomatik olarak seslendirir.

Tüm sunucu bileşenleri ayrı Docker konteynırlarında çalışır ve Docker Compose ile birbirine bağlanır. Böylece yalnızca gerçekten ihtiyacınız olanı tutabilirsiniz.

---

## Nasıl kurulur?

1. Bir sunucu kiralayın ve üzerine fail2ban kurduğunuzdan emin olun. Yükleyici, UFW'yi otomatik olarak yapılandıracaktır: sunucunun gerçek SSH portuna erişimi koruyacak ve Chatter için 80/443 portlarını açacaktır.
2. Bir konsol açın ve çalıştırın:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/NikitaCherepov/chatter/main/install.sh | sudo bash
   ```
3. **Kurulumun sonunda görüntülenen kullanıcı adı ve şifreyi kaydettiğinizden EMİN OLUN.**
4. Yönetim paneline sunucunuzun adresinden gidin ve konsolda gösterilen kullanıcı adı ve şifreyi girin.
5. İlk başlatma için gerekli adımları tamamlayın:
   - Auto modu için bir model ve API anahtarı ekleyin.
   - Lite modu için bir model ve API anahtarı ekleyin.
   - [BotFather](https://t.me/BotFather)'dan bir Telegram token'ı alın ve panele ekleyin.
   - İsteğe bağlı olarak, panelde sağlanan Webapp-Notes bağlantısını kopyalayın ve botunuza ekleyin.
6. Bota mesaj atın ve profilinizi yönetim panelinden onaylayın, ardından kendinize yönetici hakları verin.

**Tamamlandı!**

---

## Masaüstü Uygulaması Nasıl Bağlanır?

1. Uygulamayı Releases bölümünden indirin ve kurun. Windows, dijital imza eksikliği hakkında uyarı verebilir: derleme şu anda bir sertifika ile imzalanmamıştır.
2. Yönetim panelinde Erişim Anahtarları bölümüne gidin.
3. Yeni bir anahtar oluşturun ve Masaüstü uygulamasına yapıştırın.
4. Kaydolun.

**Tamamlandı!**

---

## PC Hesabı ve Telegram Nasıl Bağlanır?

1. Masaüstünde ayarlara gidin.
2. "Bağlı hesaplar"ı seçin.
3. "Telegram" üzerine tıklayın.
4. Telegram botuna gönderin: `/link`
5. Ekranda gösterilen kodu girin.

**Tamamlandı!**

---

## Bir Arkadaşınızla Nasıl Paylaşırsınız?

**Telegram Üzerinden:**
1. Onlara Telegram botunu gönderin ve mesaj atmalarını bekleyin.
2. Hesaplarını yönetim panelinden onaylayın.

**Masaüstü Üzerinden:**
1. Onlara Masaüstü uygulamasını gönderin ve sunucunuza bağlanmak için bir Erişim Anahtarı paylaşın.

**Tamamlandı!**

Anahtarınızı birinin paylaşıp paylaşmadığını her zaman görebilir ve istediğiniz zaman iptal edebilirsiniz.

---

## Yönetim Paneli Neler Yapabilir?

![Chatter yönetim paneli sunucu genel bakış](../assets/admin-overview.png)

1. **Bileşen durumunu izleyin** ve yeniden başlatın.
2. **Yeni bir model eklemek mi istiyorsunuz?** Kaydedilmiş bir API anahtarını yeniden girmenize veya OpenRouter'da bir model adı aramanıza gerek yok.
   - API anahtarları kaydedilebilir ve yeniden kullanılabilir.
   - OpenRouter için bir model arama motoru yönetim paneline entegre edilmiştir.
   - Bir model seçtiğinizde sağlayıcı listesi otomatik olarak doldurulur. İsteklerin yalnızca belirli bir sağlayıcıya gitmesini mi istiyorsunuz? Açılır menüden seçmeniz yeterli.
   - Girdi/çıktı/önbellek token fiyatları, bir model seçtiğinizde otomatik olarak ayarlanır.
   - Görme (Vision) modeli ayrı olarak mevcuttur — ana model çok modlu değilse, eklediğiniz görseli tanımlaması için Vision'a sorar.

   ![Yönetim panelinde model, sağlayıcı ve fiyatlandırma seçme](../assets/admin-model-selection.gif)

3. **Kullanışlı limit yönetimi.**
   - Sadece bir kullanıcının harcayabileceği bütçeyi belirleyin.
   - Tüm kullanıcılar için görsel ve web arama limitleri özelleştirilebilir, ayrıca görsel ekleme özelliğini devre dışı bırakma imkanı.

   ![Planlar, bütçeler ve limitler ayarlama](../assets/admin-plans-limits.png)

4. Hangi modellerin kullanıldığı, alt ajanların devreye girip girmediği, mesajların ne kadar iyi önbelleğe alındığı ve çok daha fazlası hakkında **analiz**.

   ![Kullanıcı istatistikleri, bağlantılar ve model kullanımı](../assets/admin-user-usage.png)

5. Backend günlükleri ve sunucu performans grafikleri.
6. Mevcut hizmetlerin kullanışlı entegrasyonu. Bir anahtar yapıştırın, verileri girin ve her şey kutudan çıktığı gibi çalışır.
7. **Özel derleme:**
   - Telegram mini uygulamasını istemiyor musunuz? Etkinleştirmeyin.
   - Sunucu tarafında TTS ve ses transkripsiyonu için kapasiteniz mi yok? Sorun değil.
   - Kullanıcılarınız için istediğiniz kadar hazır prompt yapılandırabilirsiniz.
8. Bir kullanıcıyı yasaklamanız mı gerekiyor? Tek tıkla, Telegram ve Masaüstü uygulaması üzerinden sunucunuza erişimlerini hemen kaybederler. Erişim anahtarı da istediğiniz zaman iptal edilebilir.

---

## Chatter Neler Yapabilir?

1. Vektör belleği kullanın. Her kullanıcı varsayılan olarak ayrı, izole bir kayıt alır. Şu anda yalnızca [Pinecone](https://app.pinecone.io/) entegrasyonu mevcuttur.
2. "Alexa", "Hey, Jarvis", "Hey Mycroft" veya "Hey Rhasspy" ile uyandırma, konuşma tanıma ve sesli yanıt desteği ile.

   ![Chatter ses aktivasyonu ve arayüz kontrolü](../assets/chatter-voice-activation.gif)

3. Masaüstü uygulamasına entegre:
   - TTS için yerel Piper modeli;
   - yerel Chrome TTS modeli;
   - [Cartesia](https://www.cartesia.ai/) entegrasyonu.
4. PC'de komutları çalıştırmanın yanı sıra dosyaları düzenleme ve okuma. CLI olarak kullanılabilir.

   ![Chatter kendi başına bir web sitesi oluşturur ve açar](../assets/chatter-site-creation.gif)

5. Eklediğiniz posta kutularından e-postaları okuma ve gönderme. Şu anda [Gmail](https://mail.google.com/mail/) ve [Yandex](https://mail.yandex.ru/) için kullanışlı rehberli entegrasyonun yanı sıra manuel olarak yapılandırabileceğiniz diğer tüm e-postalar mevcuttur. E-posta göndermek kullanıcı onayı gerektirir.
6. [Tavily](https://www.tavily.com/) hizmeti aracılığıyla web araması kullanın.
7. [Browserless](https://www.browserless.io/pricing) kullanarak web sitelerini okuyun ve ayrıştırın.
8. OpenRouter aracılığıyla bir referanstan veya metinden görsel oluşturun.
9. Herhangi bir görev için alt ajanlar kullanın.

   ![Çalışan Chatter paralel alt ajanları](../assets/chatter-parallel-subagents.gif)

10. Uzmanlaşmış ajanları çağırın. Örneğin: videoları sıkıştırma ve diğer formatlara dönüştürme.
11. Sunucularınızı yönetin. Bot, SSH anahtarınızı veya sudo şifrenizi asla görmez. Komutları çalıştırmak için bir SSH oturumu doğrudan sunucunuzda açılır. SSH anahtarı tek bir düğmeyle doğrudan bilgisayarınızdan çekilebilir.
12. Runbook talimatlarını daha sonra kullanmak üzere kaydedin ve başkalarıyla paylaşın.
13. Dramatik kontrol için makrolar kaydedin (*Alexa, çalışma zamanı!*).
14. Özel promptlar ve kullanışlı düzenleme için panele entegre edilmiş bir yapay zeka düzenleyicisi.
15. Görevler ve hatırlatıcılar ayarlayın. Örneğin: ışığı açın, bir ay içinde göz damlalarını atmanızı hatırlatın veya siz uyurken sunucuyu kontrol edin (yalnızca komutlar izin listesindeyse).
16. Piksel avatarınızı kontrol edin ve ruh halini ekrandaki sohbete göre ayarlayın. Ayrıca internette bulduğu görselleri ve GIF'leri üzerinde görüntüleyin.
17. Piksel sanatı oluşturun ve doğrudan piksel avatarına çıktılayın.
18. Sohbetleri DOCX olarak kaydedin, bir sohbetten gelen mesajları doğrudan bağlı bir Telegram hesabına gönderin ve daha birçok Quality of Life özelliği.
19. Botlarla rol yapmayı seviyor musunuz? **Dice Mode** entegre edilmiştir, gönderdiğiniz her mesajda bir d20 atar ve hikayeyi etkiler!
20. Uygulama arayüzüne entegre haritayı kontrol edin, haritadaki noktaları hatırlayın ve rotalar çizin (ancak bilgileri çift kontrol edin!).
21. Not defterinize notlar kaydedin; bu notlara Telegram uygulamasından da erişilebilir.
22. Bağlam boyutunu yapılandırın, konfigürasyonlara dokunmadan alt ajanlar için kullanışlı bir şekilde model seçin ve akıl yürütme seviyelerini ayarlayın (şu anda OpenRouter, DeepSeek ve Xiaomi sağlayıcıları için mevcuttur).
23. Masaüstü bağlıyken web kamerasını kontrol edin, ekran görüntüsü alın ve ekrana tıklayın. Bu tür herhangi bir işlem onayınızı gerektirir.
24. Çoğu özelliğe Telegram'dan kullanışlı bir menü ve satır içi düğmelerle erişilebilir.
25. Akıllı evinizi kontrol edin ve programlı olarak ışıkları açın. Yandex entegrasyonu mevcuttur; Zigbee desteği şu anda deneyseldir ve daha fazla teste ihtiyaç duyar.
26. Görme yeteneği olmayan bir modele bile belge ve fotoğraf ekleyin (bir görme modeli ayrı olarak ayarlandığında).
27. Telegram'dan sesli mesajları yazıya dökün! (en az 2 çekirdek, 2 GB RAM ve voice-api etkin olan güçlü bir sunucu gerektirir)
28. Kullanışlı ve hızlı sohbet dalları oluşturma ve talimatlarla yeniden oluşturma.
29. Bot bir komut öneriyor ama ne işe yaradığını bilmiyor musunuz? İncele düğmesine basın ve Lite model risklerini değerlendirsin.

---

## Chatter Neye Odaklanmıştır?

### 1. Güvenli ajan işlemleri

- Her sunucu/PC eylemi yalnızca kullanıcı onayı ile gerçekleştirilebilir. İstisnalar: Yolo mode etkin, Allow Always veya "bu klasörde çalış". "Bu klasörde çalış" en yakın `.git`'i bulur ve varsayılan olarak önerir.
- Ajan, SSH anahtarınızı veya şifrenizi asla görmez: bunlar otomatik olarak değiştirilir ve şifrelenmiş olarak saklanır. Ajan istese bile şifrenizi **VERMEYİN**. Sunucuda yeni bir kullanıcı oluşturmak için ayrı bir komutu vardır!
- Masaüstünde, güvenlik için bazı özellikleri seçici olarak devre dışı bırakabilirsiniz. Yalnızca okumaya izin verirken yazmayı yasaklayabilir, alt ajanları, interneti veya PC komutlarını devre dışı bırakabilirsiniz. Veya belleğinize erişimini tamamen kesebilirsiniz.
- E-posta, SSH anahtarları ve hassas veriler şifrelenir.
- Yönetim panelindeki tüm API istekleri bir ters proxy ve Chatter Manager üzerinden geçerken, tekrarlanan giriş denemeleri otomatik olarak engellenir.
- Temel prompt enjeksiyon koruması entegre edilmiştir.
- Sinir ağı tarafından önerilen bir komutun ne yaptığını bilmiyorsanız, İncele düğmesine basarsınız ve başka bir sinir ağı bunu size açıklayarak riskleri değerlendirir.

   ![Çalıştırmadan önce komut risklerini kontrol etme](../assets/chatter-command-review.gif)

### 2. Amansız optimizasyon

- Sistem promptları ve diğer tekrarlanan bağlam parçaları, sağlayıcının girdi tokenlarının %90-95'ine kadarını önbelleğe alabilmesi için sabit kalır.
- Sohbetler, fotoğraflar ve mesajlar, DOM'un aşırı yüklenmesini önlemek için dinamik olarak yüklenir. Sanallaştırma kullanılmaz (ondan nefret ederim): bunun yerine, daha fazla yükle düğmesi ve karakter sayısı tabanlı hesaplama kullanılır.
- OpenRouter sizi farklı sağlayıcılara yönlendirir ve önbelleğe almayı bozar; kurcalayıp anahtarları yapılandırmak istemiyor musunuz? Doğrudan OpenRouter'dan çekilen bir sağlayıcı seçin ve yalnızca o sağlayıcı kullanılacaktır.
- Birden fazla sağlayıcı girebilirsiniz (OpenRouter/DeepSeek/Xiaomi/vb.) ve ilki bir hatayla başarısız olursa, görev hemen diğerine yönlendirilir.
- Her seferinde bir görme modeli çalıştırmak için paranız mı yok? Sorun değil. Görme modelini bir kez ekleyin ve ana yapay zeka botunuz, eklediğiniz görseli tanımlaması için ondan istesin.
- TTS için paranız yok ama yine de istiyor musunuz? Bunun için yerel modeller entegre edilmiştir. Birçok harici entegrasyon da ücretsiz bir katman sunar.
- Yapay zekanın kendisi için tekrar tekrar yardımcı kod oluşturmasını ve her seferinde token yakmasını istemiyor musunuz? Chatter'ın entegre araçları önceden kodda uygulanmıştır. Bir dezavantaj gibi görünüyor, değil mi? Ancak bu şekilde Chatter üzerinde (isterseniz) büyük hizmet aboneliklerinin yanında, bilgisayarınızda sadece `git clone` yaparak çalışabilirsiniz.
- Masaüstü uygulaması normal modda yaklaşık 300 MB RAM kullanır ve CPU'yu neredeyse hiç zorlamaz. Sunucu konteynırları ayrı ayrı sayılırken, TTS ve Whisper doğal olarak daha fazla kaynak gerektirir. Codex'in kendisi bile benim bilgisayarımda rahatlıkla yavaşlayıp takılabiliyor.
- Önbelleğe almayı bozmamak için, bağlam taştığında konuşmanın %50'si arşivlenir (gelecekte sıkıştırma için kısa bir özetleme eklenecektir).
- Bir belge sığmazsa, Chatter içeriğini otomatik olarak kırparak seçilen bağlam limitinin %90'ına kadarını korur.
- Sohbet başlıkları oluşturma, incelemeler ve diğer hafif istekler için özel bir Lite modeli kullanılır.

### 3. Kullanışlılık

- Yapay zeka tarafından oluşturulan görselleri veya mesajları telefonunuzda olması için Telegram'ınıza iletmek mi istiyorsunuz? Tek düğmeye basın.
- Bir prompt'u geliştirmek mi istiyorsunuz? Tek düğmeye basın ve yapay zekanın önerdiği değişiklikleri uygulayın.
- Makroları doldurmak veya not defterine bir şeyler yazmak istemiyor musunuz? Yapay zekadan yapmasını isteyin.
- SSH anahtarınızı tüm PC'nizde aramak istemiyor musunuz? Tek düğmeye basın :D
- Evden çıktınız ve sohbete telefonunuzdan devam etmek mi istiyorsunuz? Tüm sohbetler, prompt seçimi ve model seçimi doğrudan Telegram'dan kullanılabilir!
- API anahtarınızı tekrar bulmak için uğraşmak, OpenRouter'da bir model seçmek veya yeni bir modelin akıl yürütmesini nasıl ayrıştıracağınızı anlamak istemiyor musunuz? API anahtarları kaydedilebilir, modeller otomatik olarak çekilir ve maliyeti, bağlam limitlerini ve önbelleğe almayı korumak için mevcut sağlayıcıları anında gösterir! DeepSeek ve Xiaomi üçüncü taraf sağlayıcılar olarak kodlanmıştır (Mistral gibi yenileri çıkarsa — bana yazın, eklerim).
- Her modelin ne kadara mal olduğunu manuel olarak hesaplamak istemiyor musunuz? OpenRouter kendi değerlerini doldurur ve diğerleri için hazır ayarlar mevcuttur.
- Kullanıcılarınız model seçimlerini anlamakla uğraşmak istemiyor mu? Auto mode her zaman orada!
- Tüm entegrasyonlar daha sonra açıklamalar ve hızlı başlangıç kılavuzları alacaktır. Bunlar akıllı ev entegrasyonu için zaten mevcuttur.

### 4. Özelleştirme

- Her modelin parametreleri yapılandırılabilir. Sıcaklık, Top P ve diğerleri.
- Masaüstü uygulaması işlevselliği devre dışı bırakılabilir ve özelleştirilebilir.

---

## Projeyi Dilinize Çevirme

Projeyi dilinize çevirmeye mi karar verdiniz? Hızlı ve kolaydır:

1. Dilinizi `shared/languages.ts` dosyasına ekleyin — bu, tüm bileşenlerdeki dil listesi için tek doğruluk kaynağıdır.
2. Liste yerel kopyalarını güncellemek için aşağıdakini çalıştırın:
   ```bash
   npm run sync:languages
   ```
3. API anahtarınızı `.env.i18n` dosyasına ekleyin:
   ```
   I18N_TRANSLATE_API_URL=url
   I18N_TRANSLATE_API_KEY=your_key
   I18N_TRANSLATE_MODEL=your_model
   ```
4. Aşağıdakini çalıştırın:
   ```bash
   npm run i18n:translate:all
   ```
   Bu komut, Telegram botu, Masaüstü, Backend API, Webapp Notes, yönetim paneli ve değişiklik günlüğü dosyalarını ayrı ayrı çevirecektir.
5. Keyfini çıkarın.

---

## Önemli

- Hizmet, henüz bulamadığım hatalar içerebilir. Bir tane bulursanız — Issues'a gönderin, çözeriz. Bildiğim hatalar düzeltme birikimindedir. Proje üzerinde tek başıma çalışıyorum, bu yüzden yardım memnuniyetle karşılanır!
- Gelecek planları arasında hem desktop-app hem de backend-api'nin yeniden düzenlenmesi bulunmaktadır.
- Chatter'ı iş için bir CLI olarak kullanırken hala sorunlar oluşabilir (örneğin, bir string'i karıştırabilir ve türleri kontrol etmeyerek bir hata bırakabilir). Bunu iyileştirmek için çalışıyorum.
- **Güvenlik notu:** Chatter aktif olarak geliştirilmektedir ve entegrasyonları, uzaktan kontrol araçları ve self-hosted mimarisi nedeniyle geniş bir saldırı yüzeyine sahiptir. Güvenlik öncelik olarak ele alınsa da hiçbir yazılımın tamamen güvenli olduğu garanti edilemez. Bir örneği internete açmadan önce yapılandırmayı gözden geçirin, güncel tutun ve güvenlik açıklarını sorumlu bir şekilde bildirin. Proje geliştikçe güvenlik güçlendirmeleri devam edecektir.
