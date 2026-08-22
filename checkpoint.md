CHECKPOINT — GLOBAL TRANS / NOTIFICATION + NEXT TASK

Source of truth terbaru:

- API: src-api-0153.zip
- WEB: src-web-0153.zip
  Kalau besok ada source baru, source baru itu otomatis menggantikan source of truth ini. Setiap sebelum ngoding, baca source of truth terbaru dulu dan trace flow sebenarnya dari route → service → query → frontend consumer. Jangan mengandalkan ingatan patch lama.

RULE KERJA YANG HARUS DIPEGANG:

- Jangan rename function lama kalau tidak perlu.
- Jangan hapus function lama kalau tidak perlu.
- Jangan pecah function lama kalau tidak perlu.
- Jangan ubah signature function tanpa audit semua caller.
- Jangan refactor sekadar biar “lebih rapi” kalau tidak dibutuhkan task.
- Angular pakai @if, jangan \*ngIf.
- Analisa mendalam dulu sebelum kasih code; jangan nebak flow.
- Jangan buat file baru kecuali memang itu best experience dan separation-nya jelas.
- Area session sensitif karena pernah ada regresi berat. Jangan sentuh SessionService / login / restore session / guard kalau solusi masih bisa dilakukan di luar sana. Kalau memang terpaksa sentuh session, audit flow penuh dan jelaskan dampaknya dulu.
- Hindari patch GitHub. Pernah ada bug panjang gara-gara patch. Lebih aman full-file replacement untuk file yang memang disentuh.
- Kalau kasih ZIP: hanya file yang benar-benar NEW/MODIFIED. Struktur folder tetap dipertahankan. File yang tidak berubah jangan ikut.
- Sebelum bilang file aman ditimpa, pastikan tidak ada function lama yang hilang/rename/terpecah tanpa alasan.
- Selalu sebut lokasi file dan posisi perubahan secara jelas: function mana, setelah/sebelum line/blok apa.
- Jangan lanjut ke area lain sebelum flow yang sedang dikerjakan sudah dites end-to-end.
- Prioritas: minimal change, mudah review, konsisten dengan codebase existing, kecil risiko regression.

STATUS TASK MALAM INI

1. MENU NOTIFICATION BADGE — CORE SUDAH JALAN
   DB table:
   userMenuNotifications

Requirement utama:

- Badge adalah unread notification per reference, BUKAN jumlah pending worklist.
- Contoh Approval badge 5.
- User buka 1 request → hanya notification request itu jadi read → badge 4.
- Klik menu Approval saja tidak mark semua sebagai read.
- Worklist dan notification berbeda:
  worklist = pekerjaan yang masih pending
  badge = hal baru yang belum dilihat
- Request tetap bisa pending walaupun badge sudah 0.
- Parent menu count aggregate dari child, tidak menyimpan notification parent sendiri.

Yang sudah terbukti jalan:

- Notification row tercipta.
- Contoh DB user 4:
  menuCode = EQUIPMENT_REQUEST.APPROVALS
  unreadCount = 2
- /user-session sudah mengembalikan:
  Approvals unreadCount = 2
  Equipment Request parent unreadCount = 2
- Badge sudah tampil di sidebar.
- Root cause badge sempat tidak tampil: main.component.ts punya normalizeMenus() yang membuat object baru tapi membuang unreadCount.
- Fix yang dipasang:
  di src/app/routes/main/main.component.ts
  dalam private normalizeMenus(…)
  setelah:
  icon: menu.icon ?? null,
  ditambah:
  unreadCount: Number(menu.unreadCount ?? 0),
  sebelum:
  level: menu.level ?? level,
- Template badge pakai @if.
- Warna badge tetap merah tapi soft. Prefer:
  background: #fef2f2;
  color: #ef4444;
- MainComponent sudah memanggil mainService.refreshMenus() pada jalur cached access agar unread menu fresh tanpa mengubah SessionService.
- Jangan utak-atik SessionService untuk notification ini kecuali benar-benar terpaksa.

Flow Approval notification yang sudah dibangun:

- SUBMIT → create notification untuk approver stage aktif.
- Open approval review → mark notification reference milik current user sebagai read.
- 2 → buka 1 → 1.
- Saat approval stage selesai, stale notification stage lama harus dinonaktifkan untuk approver lain agar badge basi tidak tertinggal.
- Notification tidak boleh tergantung email; user valid tanpa email tetap harus dapat badge.

Generic notification separation:

- services/menu-notification.js = generic persistence/read/unread/deactivate logic.
- equipment-request notification logic = business event/recipient/stage.
- Jangan mencampur notification menu dengan email recipient filtering.

2. SISA NOTIFICATION: POLLING
   Ini belum dikerjakan dan jadi task berikutnya.
   Tujuan:

- Badge update otomatis saat user sedang diam di page.
- Misal Approvals 2, user lain submit request baru → tanpa refresh browser count nanti jadi 3.
- Jangan polling /user-session penuh untuk solusi final kalau bisa dihindari.
  Best experience yang direncanakan:
- endpoint kecil khusus unread count, misal GET /menu-notification/unread-counts
- response map ringan per menuCode
- polling sekitar 30–60 detik
- letakkan polling di MainComponent/shell, bukan MenuComponent
- reuse lifecycle cleanup existing; jangan bikin subscription/timer bocor atau dobel.
- audit lifecycle MainComponent dulu sebelum implementasi.
- kalau memungkinkan pause/skip saat tab inactive bisa jadi enhancement, tapi bukan wajib tahap pertama.
- jangan sentuh session layer untuk polling kalau tidak diperlukan.

3. TASK BESAR BESOK: UPLOAD + DISPLAY GAMBAR EQUIPMENT
   User minta fitur upload gambar dan gambar harus ikut tampil di banyak area.

Scope awal yang sudah diketahui:

- Equipment Unit: ada fitur upload gambar.
- Gambar unit harus bisa ditampilkan.
- Equipment Request secara overall harus menampilkan gambar equipment/unit terkait.
- Saat membuat request, setelah user memilih unit/equipment, gambar unit tersebut juga ditampilkan supaya user dapat visual confirmation.
- Kemungkinan imbas banyak:
  unit list/detail/form
  equipment request create/select
  request list/card/table/detail/review
  approval
  assignment
  monitoring
  dan area lain yang menampilkan equipment unit.
- Task ini berpotensi menyentuh banyak HTML / SCSS / component / API storage/file path / response model.

RULE KHUSUS UNTUK TASK GAMBAR BESOK:

- Jangan langsung ubah CSS/HTML massal.
- Pertama audit source of truth terbaru:
  schema/model equipment unit
  create/update unit API
  file upload mechanism existing di project
  storage convention existing
  API base/static serving
  response unit yang dipakai Equipment Request
  frontend unit model
  reusable card/table/select components yang sudah ada
- Cari dulu apakah project sudah punya mekanisme upload/file/image yang bisa direuse. Jangan bikin sistem upload baru kalau existing sudah ada.
- Tentukan satu canonical image source untuk equipment unit. Jangan duplikasi penyimpanan image ke Equipment Request kalau cukup reference ke unit image.
- Pikirkan lifecycle gambar:
  upload
  validation type/size
  replace
  delete/cleanup
  fallback/no-image
  URL/path exposure
  broken image handling
- Jangan menyimpan binary image di DB kalau codebase existing tidak memang memakai itu.
- Untuk Equipment Request, idealnya request tetap reference unit; image tampil dari data unit/canonical snapshot sesuai kebutuhan bisnis. Audit dulu apakah historical request harus mempertahankan image lama jika image unit berubah. Jangan ambil keputusan sebelum baca flow.
- UI harus konsisten dan responsive. Jangan bikin satu-off CSS berbeda di tiap page kalau bisa reuse pattern existing.
- Karena perubahan besar, kerjakan bertahap:
  phase A: audit & backend unit image
  phase B: unit UI upload/display
  phase C: request create selected image
  phase D: request detail/approval/assignment/monitoring display
  setiap phase dites dulu sebelum lanjut.
- Kalau nanti kasih ZIP, tetap changed-only.

URUTAN BESOK YANG DISARANKAN:

1. Buka source of truth terbaru.
2. Selesaikan polling badge dengan endpoint ringan dan lifecycle aman.
3. Test polling:
   badge existing
   incoming notification update otomatis
   open one → count turun satu
   no duplicate polling
   no session regression
4. Setelah notification benar-benar selesai, mulai audit upload image.
5. Jangan langsung coding image sebelum flow upload/storage existing ditemukan.
6. Implement image bertahap sesuai phase di atas.

CATATAN DEPLOY:

- Web dan API malam ini sudah direncanakan naik development lalu production via Git normal, bukan patch GitHub.
- Sebelum commit selalu git status + git diff.
- Lebih aman git add explicit files daripada git add . kalau repo punya perubahan lain.
- Setelah merge production, balik ke development.
- Pastikan tabel userMenuNotifications tersedia juga di DB environment production.

NEXT START BESOK:
“Bawa source of truth terbaru, audit MainComponent + menu-notification flow, selesaikan polling unread badge tanpa menyentuh session kalau tidak perlu. Setelah polling stabil, baru audit total mekanisme upload/file existing untuk Equipment Unit sebelum menulis code image apa pun.”

Iya hu, ini penting banget dan sebaiknya kita masukin ke checkpoint juga.

Upload dokumen memang salah satu attack surface paling umum, tapi bukan berarti otomatis “jalan menuju hacking database”. Risiko utamanya biasanya datang dari file upload yang diperlakukan terlalu percaya: nama file dipakai mentah, MIME type percaya dari browser, file disimpan di folder executable/public, parser dokumen yang rentan, path traversal, overwrite file, atau file berbahaya yang nanti dibuka user lain.

Untuk best experience Global Trans, aku sarankan dokumen request dibuat dengan aturan ketat:

- Hanya izinkan tipe yang memang perlu: PDF, DOCX, XLSX. Jangan izinkan format macro seperti .docm, .xlsm kalau bisnis tidak butuh.
- Validasi extension + MIME + magic bytes/file signature di server. Jangan percaya Content-Type dari frontend saja.
- Rename file jadi UUID/random server-side. Nama asli hanya disimpan sebagai metadata untuk display.
- Simpan file di luar source code dan di luar folder yang bisa dieksekusi. Idealnya object storage/private storage; kalau local disk, jangan di web root.
- Download lewat endpoint terautentikasi, jangan kasih direct filesystem path.
- Batasi ukuran, misalnya 10–20 MB per file dan jumlah attachment per request.
- Jangan pernah pakai nama file user untuk membentuk SQL atau path.
- Semua DB operation tetap parameterized/query builder seperti sekarang.
- Jangan parse isi Word/Excel kalau tidak diperlukan. Kalau cuma upload/download, simpan sebagai opaque binary. Semakin banyak parsing, semakin besar attack surface.
- Untuk preview, PDF bisa preview inline jika aman. Word/Excel lebih baik tampil sebagai attachment dengan icon + nama + size + tombol download, bukan dipaksa render.
- Tambahkan antivirus/malware scanning kalau nanti environment memungkinkan. Minimal desain storage-nya dibuat supaya gampang ditambah scanning belakangan.
- Jangan simpan file binary ke database kecuali memang ada alasan kuat. Simpan metadata + storage key/path saja.

Untuk UX request, aku lebih suka attachment area seperti:

Attachments (2) lalu tiap item menampilkan icon file, nama asli, ukuran, uploader, waktu upload, dan tombol download/remove sesuai permission.

Untuk PDF bisa ada tombol Preview. Untuk DOCX/XLSX cukup download/open externally.

Dan satu keputusan desain yang menurutku penting: gambar equipment dan dokumen request jangan dicampur jadi satu konsep attachment. Gambar unit adalah asset master equipment. Dokumen request adalah attachment transaksi. Storage dan lifecycle-nya beda.

Jadi checkpoint besok kita tambah satu task besar lagi:

Equipment Request Attachments
→ PDF/DOCX/XLSX
→ secure upload
→ metadata table
→ private storage
→ authenticated download
→ validation server-side
→ size/count limits
→ no executable formats
→ no macro-enabled Office files unless explicitly needed
→ optional malware scan integration later

Kalau mau super ketat, aku bahkan akan default whitelist jadi cuma:

pdf, docx, xlsx

bukan doc, xls, karena format lama lebih sulit divalidasi dengan baik dan punya lebih banyak legacy parsing surface.

Besok sebelum coding upload gambar maupun dokumen, kita audit dulu apakah di source terbaru sudah ada middleware upload seperti multer, storage helper, static serving, atau attachment pattern yang bisa direuse. Jangan bikin jalur upload kedua kalau existing sebenarnya sudah ada.
