GLOBAL TRANS – PERFORMANCE INVESTIGATION CHECKPOINT

F1 auth/access/session sudah selesai dan production. Jangan mulai F2 dulu.

Masalah: popup Add Request loading sekitar 4–5 detik, padahal data master kecil.

Yang sudah terbukti:

- Node/Express business endpoint: 7–25 ms
- MySQL query: 2–11 ms
- /health-perf: 1–2 ms di Express
- Test curl dari cPanel cepat
- 10 curl paralel dari cPanel juga cepat, sekitar 0.016–0.044 s
- Dari Chrome, 10 request /health-perf HTTP/2 selesai bertahap:
  - sekitar 145 ms
  - 1.1 s
  - 2.06 s
  - 3.17 s
  - 4.04 s
- Semua Chrome request:
  - Status 200
  - Protocol h2
  - Connection ID sama: 1938257
- performance.log menunjukkan Node menerima request 2 + 2 + 2 + 2 + 2, sekitar tiap 1 detik.
- Setelah request sampai Node, prosesnya cuma 1–2 ms.

Kesimpulan sementara: bottleneck sangat mungkin terjadi sebelum Express, mengarah ke layer LiteSpeed/cPanel/lsnode/hosting ingress. Belum menyimpulkan konfigurasi persisnya.

Yang diminta hosting cek:
SETTINGS_MAX_CONCURRENT_STREAMS, HTTP/2 stream concurrency, LiteSpeed→lsnode concurrency, External App Max Connections, lsnode queue, per-user/per-vhost throttling, WAF/security/rate limit.

Bukti sudah dibuat:

- Word lampiran screenshot
- Chrome Console test
- Chrome Network h2 + same Connection ID
- Node performance.log
- cPanel curl tests
- video test real popup Add Request dengan endpoint asli aplikasi juga dilampirkan terpisah

Tiket Exabytes: Case ID #12321758. Status terakhir: sedang dicek Technical Support, belum ada hasil teknis.

NEXT ACTION: begitu Exabytes membalas, paste seluruh jawaban mereka ke chat. Evaluasi apakah mereka benar-benar mengecek HTTP/2/lsnode/concurrency atau hanya memberikan jawaban umum.

Sementara jangan hapus /health-perf, instrumentation, atau performance.log, dan jangan ubah DB pool/query/config yang bisa mengubah kondisi test.

GLOBAL TRANS PERF CHECKPOINT
F1 selesai production, F2 belum mulai.
Bottleneck diduga sebelum Express: Chrome h2 same Connection ID, request masuk Node 2+2+2+2+2 tiap ±1 detik. Express 1–2 ms, MySQL 2–11 ms, cPanel curl cepat.
Exabytes Case #12321758 sedang investigasi HTTP/2/LiteSpeed/lsnode/concurrency.
Jangan ubah /health-perf, instrumentation, performance.log, DB pool/query/config sampai ada hasil hosting.
