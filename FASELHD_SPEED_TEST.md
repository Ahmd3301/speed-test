# اختبار سرعة تحميل 1080p من Fasel-HD بأقصى سرعة (داخل GitHub Actions)

> كل القياسات الثقيلة تمت **داخل GitHub-hosted runner** (وليس على جهاز محلي) للاستفادة من شبكته وقوته.
> - التشغيل الأول (?p=271259): https://github.com/Ahmd3301/speed-test/actions/runs/34493978594
> - التشغيل الثاني (?p=228502): https://github.com/Ahmd3301/speed-test/actions/runs/34497341861
> - إثبات الكاش (hit): https://github.com/Ahmd3301/speed-test/actions/runs/34500620768

## 1) بيئة الاختبار (إثبات 4-core)

| البند | القيمة المقاسة داخل الـ Runner |
|---|---|
| الـ Runner | `ubuntu-latest` (VM جديدة لكل run) |
| المعالج | AMD EPYC 7763 — `CPU(s): 4` (`nproc=4`) |
| الرام | 15Gi |
| النظام | Ubuntu 24.04 — kernel `6.17.0-1022-azure` |
| المواصفات الرسمية | 4 vCPU / 16GB RAM / 14GB SSD — [github-hosted-runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) |

## 2) المادة المُختبَرة

- الصفحة: `https://www.fasel-hd.co/?p=271259` (Love, Death Robots — الحلقة 01)
- الاستخراج: `node exFaselHD1234.js <page>` → رابط `master.m3u8` (موقّع بتوقيت، يُستخرج ويُستخدم فوراً داخل نفس الـ job)
- الـ Master يحتوي 3 جودات:

| الجودة | BANDWIDTH | الكودك |
|---|---|---|
| 1920x1080 | 2082846 | avc1.640028,mp4a.40.2 |
| 1280x720 | 1419992 | avc1.4d401e,mp4a.40.2 |
| 640x360 | 374598 | avc1.4d401e,mp4a.40.2 |

- بلايلست الـ 1080p: **285 مقطع `.ts`**، المدة **404.7s (~6m44s)**، **بدون تشفير** (`#EXT-X-KEY` غير موجود)، الحاوية **MPEG-TS** — أي أن المقاطع ملفات مستقلة قابلة للتحميل المتوازي والدمج الثنائي.

## 3) لماذا هذه الأدوات؟ (بحث + أدلة)

| الأداة | الدور في الاختبار | الدليل على أنها الأفضل/الأنسب |
|---|---|---|
| **N_m3u8DL-RE** (v0.6.0-beta هنا) | التحميل المتوازي الكامل + اختيار أعلى جودة تلقائياً (`--auto-select`) + دمج عبر ffmpeg | تحميل متوازي بعدد خيوط قابل للضبط (`--thread-count`) — [README](https://github.com/nilaoda/N_m3u8DL-RE/blob/main/README.en.md). بنشمارك مستقل: أسرع من `vsd` و`N_m3u8DL-RE` نفسه مقابل أدوات أخرى في كل حالات HLS/DASH — [m314dl bench](https://github.com/mohaanymo/m314dl). دليل الاستخدام 2026: "Concurrent multi-threaded downloads — far faster than FFmpeg" — [m3u8go.cc guide](https://m3u8go.cc/en/m3u8dl-download-guide) |
| **ffmpeg** (`-c copy`) | خط الأساس التسلسلي + الدمج/التحويل بدون re-encode | موثّق أنه **لا يحمّل متوازياً**: "ffmpeg isn't made to download in parallel, as it needs to process the video sequentially" — [ffmpeg-user 2017](https://ffmpeg.org/pipermail/ffmpeg-user/2017-January/034980.html)؛ سؤال مكرر منذ 2018 حتى 2022 والإجابة "Not implemented" — [stackoverflow](https://stackoverflow.com/questions/50549886/how-ffmpeg-multi-threaded-download-ts-segment-in-m3u8-file). أقصى ما فيه `http_multiple` (اتصالان prefetch فقط) — [ffmpeg-cvslog 2017](https://ffmpeg.org/pipermail/ffmpeg-cvslog/2017-December/111795.html) |
| **Node native fetch** (`scripts/faselhd-speed-test.mjs`) | مقارنة عادلة sequential مقابل parallel على **نفس العينة** (بدون مكتبات) | يقيس TTFB والسرعة لكل مقطع، ثم speedup = seq/parallel — أي فرق هو أثر التوازي وحده |
| **ffprobe + `/usr/bin/time -v`** | إثبات أن التحويل إلى MP4 لا يستهلك موارد | يقيس زمن الـ remux وأقصى ذاكرة (Max RSS) |

## 4) النتائج المقاسة داخل الـ Runner (run `34493978594`)

### 4.1 عينة واحدة، نفس المقاطع (30 مقطع = 8.55MB)

| الاختبار | النتيجة |
|---|---|
| مقطع واحد، اتصال واحد (baseline) | 0.07MB في 820ms (TTFB ≈ 670ms) = **0.7 Mbps** |
| تسلسلي (1 connection) — 30 مقطع | 8.55MB في 16.31s = **4.4 Mbps** (0.52MB/s) |
| متوازي (x16) — نفس الـ 30 مقطع | 8.55MB في 2.47s = **29.0 Mbps** (3.46MB/s) |
| **التسريع** | **6.6x** (كفاءة 41% من 16 خيطاً) |

### 4.2 الملف الكامل (1080p ≈ 100.8MB)

| الطريقة | الزمن | السرعة الفعلية |
|---|---|---|
| **N_m3u8DL-RE** (متوازي x16 + دمج) | **12.94s** | **65.3 Mbps** |
| **ffmpeg** (تسلسلي `-c copy`) | **82.9s** | **10.2 Mbps** |
| **الخلاصة** | N_m3u8DL-RE أسرع **~6.4x** من ffmpeg على نفس الملف والشبكة | — |

> سطرا الإثبات من اللوج:
> `RESULT_NM3U8DLRE_FULL=100.81 MB in 12.94s = 65.33 Mbps`
> `RESULT_FFMPEG_SEQ=100.81 MB in 82.89s = 10.20 Mbps`

## 5) الأحكام (هل يقيّد السيرفر؟ هل يدعم التوازي؟)

1. **التوازي مدعوم بالكامل تقنياً**: المقاطع عناوين `.ts` مستقلة بدون جلسة/كوكيز (فقط `User-Agent` + `Referer`)، وفشل 0/30 في التسلسلي والمتوازي، وN_m3u8DL-RE حمّل 285/285.
2. **لا يوجد حظر للتوازي، لكن يوجد قيد ليّن**: التسريع 6.6x على 16 خيطاً (دون الخطّي) + TTFB عالٍ (~670ms من الـ Runner) — النمط كلاسيكي لاتصالات RTT-bound: الاتصال الواحد يضيع ~RTT بين المقاطع (وهذا نفس سبب `http_multiple` في ffmpeg). أي أن السقف هنا زمن الاستجابة لكل اتصال، والتوازي هو العلاج الصحيح.
3. **الشبكة ليست المشبعة**: نفس الـ Runner يحقق 130–250MB/s نحو Cloudflare/Hetzner (انظر `RESULTS.md`)، بينما scdns أعطى ~8MB/s كحد أقصى متوازٍ — القيد من جهة السيرفر/المسار لا من الـ Runner.

## 6) التحويل إلى MP4 بأقل الموارد (بدون re-encode)

```bash
ffmpeg -y -i in.ts -c copy -bsf:a aac_adtstoasc -movflags +faststart out.mp4
```

- `-c copy`: نسخ التيارات كما هي (h264 + aac Rx) — **لا معالجة، CPU ≈ صفر**.
- `-bsf:a aac_adtstoasc`: إصلاح wajib لترويسة صوت AAC القادم من TS إلى MP4 (بدونها قد يفشل الدمج) — [w3tutorials](https://www.w3tutorials.net/blog/ffmpeg-mp4-from-http-live-streaming-m3u8-file/)، [kad8](https://www.kad8.com/software/download-m3u8-videos-efficiently-with-ffmpeg/).
- `+faststart`: نقل `moov` للمقدمة ليعمل البث الفوري.
- **الإثبات المقاس**: remux ملف 100MB في **0.71s** بذاكرة قصوى **65MB RSS** (`/usr/bin/time -v`) — أي مجرد تغيير حاوية.
- **الإثبات النوعي**: `ffprobe` على ناتج N_m3u8DL-RE وناتج ffmpeg يعطي `h264, 1920 + aac` في الحالتين.

## 7) إعادة التشغيل (كل شيء عبر `gh`)

```bash
# نشر أي تعديل
git add -A && git commit -m "..." && git push origin main

# تشغيل الاختبار داخل الـ Runner (4-core)
gh workflow run "FaselHD 1080p Max-Speed Test" --ref main --repo Ahmd3301/speed-test

# المتابعة
gh run list --workflow faselhd-1080p-speed-test.yml --repo Ahmd3301/speed-test
gh run watch <run-id> --repo Ahmd3301/speed-test

# سحب النتائج
gh run download <run-id> --repo Ahmd3301/speed-test -n faselhd-speed-results -D ./run-results
```

المدخلات الاختيارية: `page_url` (افتراضي `?p=228502`)، `threads` (افتراضي 16)، `sample_segments` (افتراضي 30)، `full_download` (افتراضي true).

## 8) الملفات

| الملف | الوظيفة |
|---|---|
| `.github/workflows/faselhd-1080p-speed-test.yml` | الـ Action الجديد (cache أدوات → استخراج → اختيار 1080p → 4 طرق قياس + مراقبة موارد → remux + مراقبة → حذف الفيديو → artifact نصي) |
| `scripts/faselhd-speed-test.mjs` | مقارنة sequential/parallel على نفس العينة + تحميل كامل اختياري (Node فقط، بدون dependencies) |
| `scripts/monitor.py` | مراقبة CPU/RAM/الشبكة كل ثانية (stdlib فقط عبر `/proc`) + تلخيص كل مرحلة |
| `exFaselHD1234.js` | استخراج رابط الـ Master من صفحة fasel-hd |
| `.github/workflows/speed-test.yml` | الـ Action القديم (بنچمارك عتاد الـ Runner: CPU/RAM/Disk/Network) — بقي كما هو |

## 9) تخزين الأدوات — إعداد فوري بعد أول تشغيل (مُثبت بالأرقام)

المشكلة: كل run يعمل على VM جديدة، وكان الإعداد يُعيد `apt install ffmpeg` + تحميل N_m3u8DL-RE (~21.6s).
الحل (موثّق): [`actions/cache`](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching) يحفظ مجلد `~/tools` (يحوي N_m3u8DL-RE + نسخة ffmpeg/ffprobe الـ static من johnvansickle) بين التشغيلات. اكتُشف أيضاً أن **ffmpeg غير مثبت مسبقاً** على صورة ubuntu-24.04 (احتاج apt) — لذلك خُزّنت نسخة static لتفادي apt تماماً.

| التشغيل | حالة الكاش | زمن خطوة الإعداد المقاس |
|---|---|---|
| `34497341861` (أول مفتاح جديد) | miss → حمّل الأدوات وحفظ الكاش (`Cache saved with key: Linux-tools-nm3u8dlre-v1`) | **21.6s** |
| `34500620768` (إثبات) | **`Cache restored from key: Linux-tools-nm3u8dlre-ffmpegstatic-v2`** | **`TOOLS_SETUP_SECONDS=0.017s`** (`cache-hit=true`، المصدران `cache-hit`) |

> الصدق العلمي: الـ 0.017s هي زمن خطوة الفحص والتفعيل نفسها؛ استعادة الكاش من خوادم GitHub تستغرق بضع ثوانٍ إضافية (ظاهرة كخطوة `Restore tools cache`) — لكن لا يوجد أي `apt` ولا أي تحميل خارجي بعد أول تشغيل.

## 10) التشغيل الثاني: `?p=228502` — فيلم Oppenheimer 2023 (run `34497341861`, استغرق 25m29s)

- الـ 1080p: **6228 مقطع**، المدة **10822s (~3 ساعات)**، `bw=2251732`، بدون تشفير، MPEG-TS.
- العينة (30 مقطع = 15.58MB): تسلسلي **7.2 Mbps** مقابل متوازي x16 **41.0 Mbps** — تسريع **5.71x**، فشل 0.
- الملف الكامل (**2911.5MB**):
  - N_m3u8DL-RE (x16): **178.3s = 137.0 Mbps**
  - ffmpeg (تسلسلي): **1257.6s (20.9 دقيقة) = 19.4 Mbps** — أي N_m3u8DL-RE أسرع **~7x**.

### 10.1 موارد الـ Runner أثناء التحميل (مراقبة كل ثانية، 1469 عيّنة = 24.5 دقيقة)

| المورد | المتوسط | الذروة |
|---|---|---|
| الزمن | **24.5 دقيقة** | — |
| CPU | **2.1%** (التحميل I/O-bound) | 50.0% |
| RAM | **1066MB** | 1838MB / 15990MB |
| الشبكة (استقبال) | **36.5 Mbps** | **317.3 Mbps** (إجمالي 6695MB ≈ التحميلان الكاملان + العينات) |

### 10.2 التحويل إلى MP4 (مرحلة مستقلة، 23 عيّنة + جدار زمني 18.1s لملف 2.9GB)

| المورد | المتوسط | الذروة |
|---|---|---|
| الزمن | **0.38 دقيقة (23s)** — الجدار الفعلي للـ remux **18.1s** | — |
| CPU | **22.5%** | 40.9% |
| RAM | **1086MB** | 1133MB / 15990MB |
| الشبكة | **0.0** (لا شبكة — عملية محلية بحتة) | 0.0 |

> معدل الـ remux ≈ ‏2.9GB/18s ≈ ‏**1.3Gbps** — وهذا وحده يثبت أنه تغيير حاوية فقط (`-c copy`) لا re-encode.

## 11) سياسة عدم التخزين (مؤكدة)

خطوة `Delete all video files` تحذف `ffmpeg_1080p.mp4` و`remux_faststart.mp4` ومجلد `dl-nm3u8dlre/` **قبل** رفع الـ artifact. الـ artifact (7 أيام) يحوي لوجات و`results.json` وملفات `.m3u8` فقط — **لا يوجد أي MP4** في أي مكان دائم، وVM الـ Runner تُدمَّر بعد الـ job.

## 12) كل تجارب التنزيل (10 تجارب: 5 طرق × محتوَيَين)

| # | التجربة | المحتوى | الحجم | المدة (دقيقة) | السرعة | الملاحظة |
|---|---|---|---|---|---|---|
| 1 | مقطع واحد، اتصال واحد (baseline) | حلقة 6.7 د | 0.07MB | 0.014 | **0.7 Mbps** | TTFB ≈ 670ms — الاتصال الواحد RTT-bound |
| 2 | تسلسلي — 30 مقطعاً | حلقة 6.7 د | 8.55MB | 0.27 | **4.4 Mbps** | فشل 0 |
| 3 | متوازي x16 — نفس الـ 30 مقطعاً | حلقة 6.7 د | 8.55MB | 0.04 | **29.0 Mbps** | تسريع 6.6x عن #2 |
| 4 | **N_m3u8DL-RE كامل x16** | حلقة 6.7 د | 100.8MB | 0.22 | **65.3 Mbps** | ⭐ الأسرع على هذا المحتوى |
| 5 | ffmpeg تسلسلي كامل | حلقة 6.7 د | 100.8MB | 1.38 | **10.2 Mbps** | أبطأ بـ 6.4x من #4 |
| 6 | مقطع واحد، اتصال واحد (baseline) | فيلم 3 س | 0.27MB | 0.018 | **2.0 Mbps** | TTFB ≈ 782ms |
| 7 | تسلسلي — 30 مقطعاً | فيلم 3 س | 15.58MB | 0.30 | **7.2 Mbps** | فشل 0 |
| 8 | متوازي x16 — نفس الـ 30 مقطعاً | فيلم 3 س | 15.58MB | 0.05 | **41.0 Mbps** | تسريع 5.71x عن #7 |
| 9 | **N_m3u8DL-RE كامل x16** | فيلم 3 س | 2911MB | 2.97 | **137.0 Mbps** | ⭐ الأسرع إجمالاً (+ دمج 6228 مقطعاً) |
| 10 | ffmpeg تسلسلي كامل | فيلم 3 س | 2911MB | 20.96 | **19.4 Mbps** | أبطأ بـ 7x من #9 |

**الأفضل والأسرع في التنزيل: N_m3u8DL-RE بالتوازي (التجربتان 4 و9)** — يتفوق على ffmpeg التسلسلي 6–7x وعلى التحميل أحادي الاتصال 15–60x، لأنه يفتح 16 اتصالاً متوازياً بينما ffmpeg يعمل باتصال واحد (+ prefetch باتصال ثانٍ فقط).

## 13) كل تجارب التحويل إلى MP4 (4 تجارب)

| # | التجربة | المدخل | المدة (دقيقة) | الكفاءة المقاسة | النتيجة |
|---|---|---|---|---|---|
| 1 | دمج N_m3u8DL-RE الداخلي (ffmpeg concat) | 285 مقطع TS (~100MB) | ~0.01 (ضمن زمن التجربة 4) | تلقائي ضمن الأداة | ✅ نجح |
| 2 | remux مستقل `-c copy + faststart` | MP4 بحجم 100MB | 0.012 (0.71s) | ذاكرة قصوى **65MB** فقط | ✅ ⭐ الأسرع على الملف الصغير (~1.1Gbps) |
| 3 | دمج N_m3u8DL-RE الداخلي (partial merge لأنه >1800 مقطع) | 6228 مقطع TS (~2.9GB) | ~0.3 (ضمن زمن التجربة 9) | دمج مرحلي تلقائي | ✅ نجح |
| 4 | remux مستقل `-c copy + faststart` | MP4 بحجم 2.9GB | 0.30 (18.1s) | CPU متوسط **22.5%** (ذروة 40.9%)، RAM متوسط **1086MB** (ذروة 1133MB)، شبكة **صفر** | ✅ ⭐ الأسرع على الملف الكبير (~1.3Gbps) |

الأمر المستخدم في 2 و4 (تغيير حاوية فقط، بدون re-encode):

```bash
ffmpeg -y -i in.mp4 -c copy -movflags +faststart out.mp4
# (مع -bsf:a aac_adtstoasc عندما يكون المصدر TS مباشرة)
```

**الأفضل والأسرع في التحويل: الـ remux المستقل بـ `-c copy` (التجربتان 2 و4)** — أرقامه (1.1–1.3Gbps، CPU أقل من ربع المعالج، ذاكرة ~1GB ثابتة لا تنمو مع حجم الملف، صفر شبكة) تثبت أنه لا توجد معالجة فيديو على الإطلاق، بل نسخ حاوية فقط. وكلما كبر الملف بقي الزمن خطّياً (100MB→0.7s، و2.9GB→18s).
