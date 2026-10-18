# SpotPusula Cloud — sanal yönetim denemesi

Bu paket, mevcut SpotPusula hesaplama motorunun ayrı bir bulut uyarlamasıdır.
Kaynak kod public olabilir; portföy, işlemler ve model yanıtları public değildir.
Gerçek borsa emri veya Binance hesap anahtarı kullanılmaz.

## Durum

Uygulama Cloudflare'da yayındadır; tarama GitHub Actions ile, model yorumu Gemini
Free Tier ile çalışır. Dış hizmetler ve ücretsiz kotalar nedeniyle kesintisizlik
garantisi yoktur. Panel son analiz ve fiyat kontrol zamanlarını gösterir.

## Mimari

- GitHub Actions standart Linux çalıştırıcısı: her 4 saatte Python taraması + Gemini.
- Cloudflare Worker: korumalı panel, karar denetimi, dakikalık sanal stop/hedef takibi.
- Cloudflare D1: tek yetkili sanal cüzdan, işlem günlüğü ve raporlar.
- Ücretsiz workers.dev adresi; alan adı satın almak gerekmez.
- Dakikalık takip gerçek zaman garantisi değildir. Dolum, gözlenen bid/ask üzerinden
  komisyon ve kaymayla yapılır; kesintide geçmiş stop fiyatından işlem uydurulmaz.

Türkiye saatiyle plan: 03.10, 07.10, 11.10, 15.10, 19.10, 23.10.
15–20 dakikalık tarama bittiğinde rapor gelir. GitHub gecikebilir; public depolarda
60 gün etkinlik olmazsa zamanlanmış görev kapanabilir. Sistemin son çalışma zamanı
panelde gösterilir. GitHub cron sürekli açık sunucu değildir.

## Gizlilik sınırı

Public: kaynak kod, test kuralları, görev adları, çalışma saatleri ve başarı/başarısızlık.
Private: coin pozisyonları, bakiye, gerçekleşen işlemler, modelin yorumları, erişim anahtarları.

`scanner/cloud_run.py` ham prompt, yanıt, cüzdan veya exception/traceback yazdırmaz.
İş akışı artifact/cache yüklemez. Geçici tarama veritabanı iş sonunda silinir.
Cloudflare API'leri yetkisiz isteği veri tabanına gitmeden reddeder. Panel model
metnini HTML olarak çalıştırmaz. Observability otomatik kayıtları kapalıdır.

Bu, hizmet sağlayıcılarından gizlilik değildir: GitHub tarama verisini işler,
Cloudflare özel kayıtları saklar, Google gönderilen sanal portföy ve piyasa özetini
işler. Gemini Free Tier veri kullanım koşulları ayrıca geçerlidir.

Masaüstündeki uygulama ve buluttaki cüzdan otomatik eşitlenmez. Bulut cüzdanının
yeni sanal deneme başlangıcı 200 USDT'dir. Eski yerel veritabanı bu pakete alınmamıştır.

## Kurulum — hesaplar hazır olduğunda

1. Kart eklemeden Cloudflare ve GitHub Free hesapları aç. Google AI Studio'da
   faturalandırma hesabı bağlanmamış Free Tier projesi ve uygun Flash modeli seç.
   Model kimliğini arayüzde gösterilen tam API adıyla kullan; burada varsayılan yok.
2. İki ayrı, rastgele, en az 32 karakterlik anahtar oluştur:
   `DASHBOARD_TOKEN` sadece panel girişi; `INGEST_TOKEN` GitHub–Worker haberleşmesi.
   Bunları sohbete, kaynak dosyaya veya GitHub değişkenlerine yazma.
3. Cloudflare D1 içinde `spotpusula-private` oluştur. Veritabanı kimliğini
   `cloud/wrangler.jsonc` içine ekle. Bu kimlik erişim anahtarı değildir.
4. `cloud/schema.sql` dosyasını D1 üzerinde çalıştır. Örnek yerel komutlar:

   ```sh
   npx wrangler login
   npx wrangler d1 create spotpusula-private
   npx wrangler d1 execute spotpusula-private --remote --file=schema.sql
   npx wrangler secret put DASHBOARD_TOKEN
   npx wrangler secret put INGEST_TOKEN
   npx wrangler deploy
   ```

   Komutlar `cloud` klasöründe çalıştırılır. Hesap/plan Free kalmalıdır.
   Wrangler kurulumu geliştirme aracıdır; arka planda açık bir bilgisayar gerekmez.
5. Yalnız bu paketin kaynak dosyalarını yeni bir public GitHub deposuna yükle.
   `.github` ve `.gitignore` dosyalarının da yüklendiğini kontrol et. Masaüstü
   klasörünü/veritabanını olduğu gibi yükleme. Depo lisansı kullanıcı kararına bırakılmıştır.
6. GitHub Settings → Secrets and variables → Actions → Secrets:
   `SPOTPUSULA_URL` (https://...workers.dev), `INGEST_TOKEN`, `GEMINI_API_KEY`.
   Variables bölümüne yalnız `GEMINI_MODEL` ekle. API anahtarı Variables'a yazılmaz.
7. Actions → Scheduled research → Run workflow. Panel anahtarıyla giriş yap.
   Model işlemleri duraklatılmış halde ilk gerçek raporu doğrula. Public günlüklerde
   kişisel veri olmadığını, D1 kaydını ve Worker CPU kullanımını kontrol et.
8. Testler ve kotaya uyum onaylandıktan sonra panelde “Sanal yönetimi başlat”.

Kurulum, gerçek model veya borsa erişimi başarısızsa ücretli plana otomatik geçilmez.
Cloudflare 10 ms ücretsiz CPU sınırı bu ortamda ölçülemez; aşılırsa başlatmadan önce
işler küçültülmeli. Gemini ücretsiz kota hesabında 6 günlük isteğe yetmeyebilir.

## İşlem kuralları

- 200 USDT sanal başlangıçta işlem başına en çok 2, toplam 4 USDT planlanan risk.
- En fazla 2 açık pozisyon; masraflar dahil pozisyon başına 50 USDT.
- BTC 4 saatlik kapanışı EMA20/50 altında olduğunda yalnızca bir güçlü aday:
  puanı en az 70, kendi EMA20'si EMA50'sinin üzerinde; en çok 1 USDT risk
  ve 30 USDT harcama.
- Masraflar: %0,1 komisyon ve %0,1 kayma, her yönde.
- Alışta aday filtresi ve adayın kapanmış 4 saatlik mumunun EMA20/50 üzerinde olması.
- Model fiyatına göre %2'den fazla hareket, eski kotasyon ve uygunsuz stop/hedef reddedilir.
- Masraflar sonrası hedef kazanç / planlanan stop kaybı en az 1,5.
- Aynı pozisyona ekleme yok. Model SELL veya stop/hedef pozisyonun tamamını kapatır.
- Miktar modelden alınmaz. Stop tetiklenmesi kapanış beklemez, ama bir dakikalık
  gözlem aralığı ve boşluklar nedeniyle kayıp planlanan 1–2 USDT'yi aşabilir.
- Duraklatma modelin alım/satımını durdurur; mevcut koruyucu stop/hedef takibi sürer.
- Yeterli piyasa verisi yoksa yeni işlem açılmaz. Kota dolması stop takibini de
  kesebilir; panelde son kontrol zamanını takip et.
- Cloudflare anlık bid/ask için önce Bybit spotu, dakikalık takipte gerekirse Binance
  spotu kullanır. Analiz sırasında sanal BUY için bu kaynaklara erişilemezse,
  yalnız kimliği doğrulanmış analiz görevinin hemen önce aldığı Binance kotasyonu
  en çok 30 saniye geçerli yedek olabilir. Stop takibi ve SELL bu yedeği kullanmaz.
  Modelin tarama fiyatından %2'den fazla ayrılan kotasyon ve geniş spread reddedilir.

Bunlar ölçülebilir başlangıç kurallarıdır; istatistiksel olarak doğrulanmış strateji değildir.

## Kayıt saklama ve yedek

D1 kayıtları kod deposundan bağımsızdır. Başlangıç sürümünde otomatik harici yedek
yoktur. Cloudflare üzerinden düzenli D1 export alınmalı ve özel yerde saklanmalıdır;
public GitHub deposuna yüklenmemelidir. Panel son 20 rapor ve 100 olayı gösterir,
veritabanındaki eski kayıtları silmez. 200 USDT'ye sıfırlama öncesi raporlar
veritabanında kalır ancak yeni denemenin panelinde gösterilmez. Depolama kotası izlenmelidir.

## Testler

```sh
python -m unittest discover -s tests -p "test_*.py" -v
node --test tests/privacy.test.mjs tests/paper.test.mjs
```

Testler kimlik doğrulama, kişisel hata sızıntısı, aynı raporun tekrar uygulanması,
eşzamanlı eski cüzdan yazımı, maliyet/risk sınırı ve stop boşluğu davranışını kapsar.
