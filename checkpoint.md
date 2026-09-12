Siap hu. Ini saya buat checkpoint terbaru sampai request terakhir hu, format plain text supaya gampang dicopas ke page baru.

GLOBAL TRANS — CHECKPOINT TERBARU SETELAH CORE FLOW + BATCH 2

SOURCE OF TRUTH

Di page baru nanti user akan upload:

- ZIP WEB terbaru
- ZIP API terbaru
- jika ada dump DB terbaru, upload juga

RULE SOURCE OF TRUTH:

- ZIP terbaru yang diupload di page baru otomatis menjadi source of truth utama.
- Jangan kembali ke ZIP lama.
- Semua patch manual yang sudah diaplikasikan user dianggap baseline aktif.
- Checkpoint ini dipakai sebagai business intent / reference.
- Kalau source terbaru berbeda dengan checkpoint ini, audit source dulu dan ikuti source aktual untuk implementasi.
- Jangan mengandalkan ingatan patch lama tanpa inspect source terbaru.

==================================================
RULES KERJA — WAJIB DIBAWA

- Selalu mulai dari source of truth terbaru.
- Sebelum coding, trace flow nyata:
  route → service → query → DB/state → frontend consumer.
- Minimal change.
- Prioritaskan regression risk paling kecil.
- Konsisten dengan codebase existing.
- Jangan rename function lama kalau tidak perlu.
- Jangan hapus function lama kalau tidak perlu.
- Jangan split function lama kalau tidak perlu.
- Jangan ubah signature tanpa audit seluruh caller.
- Jangan refactor hanya demi “lebih rapi”.
- Angular:
  - gunakan @if untuk blok baru/refactor
  - jangan tambah \*ngIf baru.
- Jangan buat file baru kecuali separation-nya memang jelas.
- Session area sangat sensitif:
  - jangan sentuh SessionService
  - jangan sentuh login
  - jangan sentuh restore session
  - jangan sentuh guard
  - kecuali benar-benar tidak ada solusi lain.
- Kalau terpaksa menyentuh Session flow:
  - audit penuh
  - jelaskan impact dulu.
- Hindari GitHub-style patch.
- Full-file replacement untuk file yang disentuh lebih aman.
- Kalau kasih ZIP:
  - changed-only
  - hanya NEW/MODIFIED
  - struktur folder asli
  - untouched jangan ikut.
- Kalau rename/delete file:
  - ZIP overwrite tidak bisa menghapus file lama
  - wajib beri DELETE_OLD_PATHS_AFTER_OVERWRITE.txt atau instruksi delete eksplisit.
- Sebelum bilang aman overwrite:
  - pastikan function lama tidak hilang
  - tidak rename sembarangan
  - tidak split tanpa alasan.
- Selalu sebut:
  - file path
  - function/blok yang berubah.
- Jangan lompat ke flow lain sebelum flow saat ini dites end-to-end.
- Sebelum commit:
  - git status
  - git diff
  - git diff –cached
  - prefer git add explicit files.
- Browser 100% zoom = baseline UI.
- Jangan design seolah 90% target.
- Visual tweak manual dari user menjadi baseline terbaru.
- Legacy/historical data jangan dihapus hanya karena flow baru sudah ada.
- Deactivate dulu.
- Delete/cleanup hanya setelah flow benar-benar smooth dan seluruh dependency diaudit.

==================================================
BUSINESS FLOW BARU — FINAL

Flow lama:

Draft
→ Client Review
→ Global/GTSI Review
→ Approved
→ Assigned
→ In Progress
→ Completed

Flow baru:

Draft
→ Submit
→ Exxon Approval
→ Approved / Authorized
→ Operations berdasarkan planned period
→ Completed

GLOBAL TRANS TIDAK LAGI MENJADI APPROVAL STEP.

Global hanya:

- dapat notification/badge
- bisa melihat request
- bisa membuka halaman review
- schedule read-only
- approval notes read-only
- tidak ada approve
- tidak ada reject
- tidak membuat state transition
- tidak menjadi gate approval.

Prinsip bisnis final:

“Kalau Exxon sudah approve, Global dianggap setuju.”

Global adalah reviewer/observer penting, bukan approver.

==================================================
EXXON APPROVAL

Exxon adalah FINAL APPROVER.

Exxon:

- bisa approve
- bisa reject
- boleh edit planned schedule sebelum final approval
- availability wajib direcheck berdasarkan planned schedule hasil edit
- planned schedule hasil Exxon menjadi schedule final operation
- Review Notes Exxon harus disimpan
- Review Notes Exxon harus bisa dilihat Global secara read-only.

Contoh:

Exxon approve tanggal 1.
Planned operation tanggal 20–21.

Artinya:

- unit tidak dianggap digunakan tanggal 1–19
- unit hanya reserved/active tanggal 20–21
- request lain tetap boleh pakai unit yang sama tanggal 1–19 jika tidak overlap.

Approval time ≠ operation start time.

JANGAN isi actualStartDate dengan waktu klik approval.

==================================================
OPERATION TIMING

Operation ditentukan berdasarkan planned period.

Setelah Exxon approve:
request domain tetap:

APPROVED

Tidak dipaksa jadi:

ASSIGNED
atau
IN_PROGRESS

karena tidak mau scheduler state-machine palsu.

Derived operational status:

Scheduled
= plannedStart masih jauh.

Starting Soon
= plannedStart masuk reminder window.

Default reminder window:
H-3.

In Operation
= now antara plannedStart sampai plannedEnd.

Attention / Overdue
= plannedEnd sudah lewat tetapi belum complete.

Completed
= operation sudah selesai.

Derived status hanya presentation/operations/monitoring.

DB request state tidak perlu berubah mengikuti waktu.

==================================================
OPERATIONS — FINAL BEHAVIOR SAAT INI

Manual step Assignment dan Start Operation sudah tidak menjadi business flow.

Menu aktif:

Requests
Review & Approval
Operations
Monitoring
Reports

Operations adalah authorized operational work queue Global.

Operations time-aware:

- Scheduled
- Starting Soon
- In Operation
- Attention
- Completed

Sort final:

1. Attention
2. In Operation
3. Starting Soon
4. Scheduled
5. Completed

Di dalam kategori yang sama:
planned start ascending.

Planned start yang dipakai adalah final planned start hasil Exxon approval.

Operations KPI:

- Scheduled
- Starting Soon
- In Operation
- Attention
- Completed

Operations pagination terbaru:

- 4 request per page
- bukan 5
- 4 dipilih karena 5 sudah membuat internal scroll di worklist pada browser 100%.

Search/filter reset ke page 1.

==================================================
OPERATIONS BADGE / NOTIFICATION

Badge Operations tidak hanya unread notification.

Badge juga menghitung operational attention:

- Starting Soon
- In Operation
- Attention / Overdue

Jadi kalau approval sudah lama dibaca:
badge boleh bersih.

Saat masuk H-3:
request kembali jadi perhatian di Operations badge.

Belum ada cron/job scheduler.

Future enhancement:

- H-3/H-1 email reminder
- starts today
- overdue reminder

Kalau nanti dibuat:
reminder days idealnya dari appConfigs, bukan hardcode.

==================================================
OPERATIONS COMPLETE — RULE TERBARU

Manual Start Operation tidak diperlukan.

Complete masih diperlukan.

Complete button:

- tidak pakai icon centang
- icon action yang dipilih: flag
- wording action bisa “Complete Request” / “Complete This Request”
- jangan pakai btn-sm
- button dibuat lebih proper/besar.

Early completion:

- BOLEH complete sebelum planned end
- tapi wajib warning kontekstual
- title:
  Early Completion
- info:
  planned end masih di masa depan
  operation akan ditandai selesai lebih awal
  user harus Confirm.

Overdue completion:

- tetap boleh complete
- confirmation memberi info planned end sudah lewat
- setelah sukses:
  status menjadi Completed
  tidak lagi Attention/Overdue.

Rule final:
early completion boleh, tapi harus explicit confirmation.

==================================================
REVIEW & APPROVAL MENU

Display wording:

Review & Approval

Reason:

- Exxon approve
- Global review.

Untuk Global:

- tombol Review tetap clickable
- bisa buka detail
- schedule read-only
- Review Notes read-only
- tidak ada Approve
- tidak ada Reject
- bottom action:
  Back to Review & Approval
- top back button konsisten.

Untuk Exxon:

- schedule editable
- Review Notes editable
- Approve Request
- Reject Request
- Cancel tetap relevan.

Bug yang sudah diperbaiki:
Review Notes Exxon sebelumnya tersimpan tapi Global review endpoint/consumer tidak menampilkannya.

Final behavior:
Global harus bisa melihat Review Notes Exxon read-only.

==================================================
LIFTING WORDING

Final wording:

Lifting Estimation

Jangan rename backend/database technical fields.

Technical tetap seperti:
requiredCapacityValue
requiredCapacityUnit

Hanya presentation layer.

==================================================
MODEL CODE

Requirement:

hapus Model Code dari consumer/detail Equipment Request yang relevan.

Jangan hapus Model Number/Model Code dari Equipment Master.

Operations sudah tidak menampilkan Model Code yang tidak relevan.

==================================================
RENAME ASSIGNMENT → OPERATIONS

Active business domain = Operations.

Frontend active naming:

- folder operations
- OperationsComponent
- OperationsService
- operations.service.ts
- selector operations
- route:
  /equipment-request/operations

Legacy /assignments tidak boleh jadi user-facing utama.

Kalau ada:
hanya redirect/fallback.

API active domain:

- operations.js
- endpoint:
  /equipment-request/operations/…

Active permission:

EQUIPMENT_OPERATION.VIEW

Active menu code:

EQUIPMENT_REQUEST.OPERATIONS

Jangan pakai active naming:

EQUIPMENT_ASSIGNMENT.VIEW
EQUIPMENT_REQUEST.ASSIGNMENTS

kecuali legacy/historical compatibility.

==================================================
DATABASE TABLE

equipmentAssignments
→ equipmentOperations

Rename dilakukan rename-in-place.

Data existing tetap utuh.

Active query technical operation harus ke:

equipmentOperations

Area yang selalu perlu dicek jika source baru berubah:

- approval.js
- request.js
- monitoring.js
- operations.js
- dashboard/home query
- email helper
- notification helper
- availability/conflict query
- completion query.

==================================================
LEGACY YANG TIDAK BOLEH DIBERSIHKAN SEMBARANGAN

Masih boleh ada legacy:

- ASSIGN
- START_OPERATION
- COMPLETE_ASSIGNMENT
- ASSIGN_EQUIPMENT
- assignedAt
- assignedBy
- ASSIGNED
- raw audit title seperti:
  Auto Assign Equipment
  Complete Assignment
  Approve Client

Reason:
historical truth.

Jangan delete hanya karena flow aktif sudah berubah.

State transition legacy:
deactivate dulu.

==================================================
STATE TRANSITION TARGET

SUBMIT
DRAFT → CLIENT_REVIEW
ACTIVE

APPROVE_CLIENT
CLIENT_REVIEW → APPROVED
ACTIVE

REJECT_CLIENT
CLIENT_REVIEW → REJECTED
ACTIVE

APPROVE_GTSI
GTSI_REVIEW → APPROVED
INACTIVE

REJECT_GTSI
GTSI_REVIEW → REJECTED
INACTIVE

ASSIGN
APPROVED → ASSIGNED
INACTIVE

START_OPERATION
ASSIGNED → IN_PROGRESS
INACTIVE

COMPLETE_ASSIGNMENT legacy:
jangan delete dulu.

Catatan:
CLIENT_REVIEW masih legacy-ish secara nama.
Jangan buru-buru rename DB status saat stabilisasi.

==================================================
GLOBAL APPROVAL FLOW DB

equipmentApprovalFlows untuk Global/GTSI:
inactive sebagai approval gate.

Global review visibility datang dari:

- permission
- menu
- notification

Tidak perlu approval row/action Global hanya demi tampilan.

==================================================
TECHNICAL OPERATION RECORD

Saat Exxon final approve:

- request validated/locked sesuai existing flow
- final planned start/end digunakan
- availability direcheck
- operation record dibuat otomatis
- linkage:
  request
  request detail
  unit
  planned period
  completion
- tidak ada manual Assign
- tidak ada manual Start Operation
- actualStartDate tidak diisi dengan approval time.

==================================================
COMPLETION

Technical operation boleh complete tanpa manual START_OPERATION.

Jika actualStartDate legacy kosong:
fallback logic harus konsisten dengan planned period.

Jangan isi actualStartDate dengan approval time.

==================================================
MONITORING — FINAL ARAH

Monitoring sekarang memahami:

Approved / Authorized
→ Scheduled
→ Starting Soon
→ In Operation
→ Attention/Overdue
→ Completed

Tidak bergantung manual Start Operation.

Status derived dari planned period.

Monitoring yang sudah dipertahankan:

Equipment Assignment Worklist

dan wording:

Assignment-level operational visibility and SLA monitoring.

Ini sengaja masih boleh karena dalam konteks Monitoring, “assignment-level” masih masuk akal sebagai level unit/resource.

Wording aktif lain yang lama sudah diarahkan ke Operations terminology, misalnya:

- Monitor equipment operations…
- Units currently available
- Show overdue operations only
- Planned operational schedule
- no equipment operations…

Completed request yang dites:
sudah masuk Completed Today dengan benar.

==================================================
REQUEST DETAIL POPUP — FINAL BASELINE TERBARU

Tab final sekarang:

- Information
- Equipment Details
- Activity

Tab Request Journey terpisah sudah dihapus untuk menghindari duplikasi.

TAPI:
isi Activity sekarang harus mempertahankan FULL BUSINESS LIFECYCLE seperti Journey yang dulu disukai user.

Artinya Activity bukan hanya raw event yang sudah terjadi.

Untuk request Starting Soon harus tetap tampil:

- Request Submitted — completed
- Exxon Approved — completed
- Scheduled — completed
- Starting Soon — current
- In Operation — upcoming
- Completed — upcoming

Visual state:

Completed stage:

- icon hijau
- badge COMPLETED

Current stage:

- highlight biru
- badge CURRENT

Future stage:

- abu / disabled
- badge UPCOMING

Reject/attention boleh merah bila relevan.

Audit info tetap bisa muncul di stage terkait:

- performed by
- timestamp
- Review Notes

Global bukan approval node.

Raw historical audit data di backend/DB jangan dihapus.

==================================================
REQUEST DETAIL ACTIVITY — PRESENTATION

Business-friendly label aktif:

CREATE
→ Request Created

SUBMIT
→ Request Submitted

APPROVE_CLIENT
→ Exxon Approved

REJECT_CLIENT
→ Exxon Rejected

AUTO_ASSIGN_EQUIPMENT
→ Scheduled

COMPLETE_ASSIGNMENT
→ Completed

Tapi raw historical event tetap tersimpan di DB/API.

Jangan delete / rewrite history source.

==================================================
REQUEST DETAIL SCROLL / MODAL

Final UX terbaru:

- hanya 1 scrollbar di content area
- header tetap terlihat
- footer tetap terlihat
- tombol Close selalu terlihat
- tidak ada double-scroll dialog
- dialog height sekitar 94vh
- footer berisi:
  Viewing REQUEST_NO
  Close

Browser 100% adalah baseline.

==================================================
REQUEST DETAIL ACTIVITY VISUAL

Card sudah dibuat lebih compact:

- padding diperkecil
- actor footer lebih pendek
- timestamp lebih compact
- spacing antar event lebih rapat
- icon event divariasikan supaya tidak monoton

TAPI:
state color harus konsisten:

- hijau = completed
- biru = current
- abu = upcoming

Icon completed hijau yang ada di Journey sebelumnya wajib dipertahankan dalam lifecycle Activity.

==================================================
HISTORY UUID CLEANUP

Jika activity/history menampilkan technical UUID seperti:

Operation 88dd36de-… selesai beroperasi

jangan tampilkan UUID ke user.

Karena request number sudah jelas di header.

Presentation cukup:

Operation selesai beroperasi.

==================================================
EMAIL — FIX YANG SUDAH DILAKUKAN

Bug sempat terjadi saat Submit:

TEMPLATE_ASSIGNED is not defined

Root cause:
email fallback masih refer TEMPLATE_ASSIGNED setelah rename ke Operations.

Sudah diperbaiki ke:

TEMPLATE_OPERATION_READY

Wording operation-ready diarahkan ke:

Operation scheduled

statusCode:
APPROVED

statusName:
Scheduled

SUBMIT sekarang sudah berhasil.

Target email flow tetap:

SUBMIT:

- Exxon approver → action-required email
- Global reviewer → visibility/review email

APPROVE_CLIENT / REJECT_CLIENT:

- requester → final status email
- Global → final decision visibility email

APPROVE_CLIENT:
JANGAN mencari next GTSI approver.

==================================================
NOTIFICATION FLOW

SUBMIT:

- Exxon final approver mendapat action-required badge/notification
- Global mendapat visibility/review badge

GLOBAL:

- badge review tetap penting
- notification Global tidak bergantung next approver logic

EXXON APPROVE:

- requester status update
- Global final decision visibility
- Operations mendapat item baru

Tidak boleh ada active notification:

Assignment Required

sebagai manual step.

Operations mark-as-read active permission harus:

EQUIPMENT_OPERATION.VIEW

bukan legacy EQUIPMENT_REQUEST.ASSIGN.

==================================================
UNIT IMAGE — CHECKPOINT LAMA YANG SUDAH MATANG

Equipment Unit image existing:

- canonical Equipment Unit image
- private/authenticated Blob
- fallback category SVG
- Unit List thumbnail
- Unit image preview
- enterprise full overlay
- image centered
- title centered
- backdrop closes
- image click does not close
- focus-visible fix
- no public image duplication
- manage permission tetap EQUIPMENT_UNIT.UPDATE.

Equipment Request existing:

- selected unit image
- authenticated Blob
- fallback icon
- object URL cleanup
- preview Add/Edit
- preview Detail
- enterprise overlay.

==================================================
UNIT IMAGE — REQUEST TERBARU / NEXT TASK

User Exxon memberi feedback:

gambar unit belum tersedia konsisten sampai step Complete.

Requirement baru:

SETIAP informasi unit yang pantas di seluruh flow aktif harus menampilkan unit image.

Image harus:

- reuse canonical Equipment Unit image
- private/authenticated Blob
- fallback category icon/SVG
- clickable
- buka preview overlay yang sama seperti Request Detail existing
- jangan buat mekanisme storage kedua
- jangan duplicate image ke request/operation jika tidak perlu.

Area yang wajib diaudit di ZIP terbaru:

- Exxon Approval / Review
- Global Review
- Operations
- Monitoring
- Completed state
- Request Detail Information / Equipment Details
- mungkin list cards/unit rows lain yang masih hanya icon generik.

Goal:

gambar unit tetap tersedia dan konsisten dari request sampai operation selesai.

Jangan desain berdasarkan Assignment flow lama.

Task image berikutnya sekarang:

- Approval/Review Unit Image
- Operations Unit Image
- Monitoring Unit Image
- Completed Unit Image

Reuse implementasi existing sebelum buat helper baru.

==================================================
ATTACHMENT — NEXT BATCH UTAMA

Setelah image propagation diaudit/diterapkan, lanjut Batch 3 Attachment.

Requirement:

Equipment Request bisa upload:

- PDF
- image

Reuse existing:

fileAttachments

Security/storage rule:

- private storage
- authenticated download
- jangan public URL
- random/UUID stored filename
- original filename hanya metadata
- whitelist extension
- validate MIME
- idealnya magic bytes
- file size limit
- file count limit
- no executable / dangerous file
- hanya image/PDF sesuai requirement meeting terbaru.

Request attachment metadata:

- moduleCode
- referenceUuid
- documentType

harus konsisten dengan architecture existing.

==================================================
ATTACHMENT CREATE FLOW

Challenge:
request UUID baru tersedia setelah create sukses.

Pola aman:

create request
→ request UUID tersedia
→ upload attachment
→ selesai

Jangan memaksa attachment upload sebelum request entity ada kecuali architecture existing memang sudah mendukung temp upload.

==================================================
ATTACHMENT UI — REQUEST TERBARU

Attachment boleh disisipkan di tempat-tempat yang pantas, informatif, tetapi:

- jangan mengganggu info utama
- jangan mengalahkan schedule/unit/status/request identity
- jangan bikin page terlalu padat
- jangan duplikasi attachment presentation di terlalu banyak tempat.

Candidate placement:

Request Add/Edit:

- section kecil “Attachments”
- secondary to main form
- support drag/drop atau file picker jika existing style cocok
- show filename/type/size/remove sebelum submit bila flow memungkinkan.

Request Detail:

- attachment section/tab ringan
- image thumbnail untuk image
- PDF icon/card untuk PDF
- click untuk authenticated preview/download
- jangan tampilkan public URL.

Approval/Review:

- attachment reference sebaiknya visible read-only
- agar approver Exxon punya context dokumen pendukung
- jangan terlalu dominan.

Global Review:

- attachment visible read-only
- tetap secondary.

Operations:

- hanya kalau memang relevan secara operasional
- idealnya tampil sebagai compact “Attachments (n)” action/section
- jangan memenuhi worklist.

Monitoring:

- tidak perlu attachment jadi primary
- boleh tersedia dari detail/modal jika user perlu referensi.

Completed:

- attachment tetap accessible dari request detail/history
- jangan hilang setelah complete.

==================================================
ATTACHMENT PREVIEW

Untuk image:

- gunakan preview overlay existing jika memungkinkan
- jangan buat overlay kedua kalau tidak perlu.

Untuk PDF:

- authenticated open/download
- kalau existing architecture punya preview PDF, reuse
- kalau tidak, authenticated download/new tab yang aman lebih baik daripada custom heavy viewer.

==================================================
SECURITY / STORAGE FINAL RULE

Tetap:

- private storage
- authenticated access
- binary jangan disimpan DB kecuali architecture existing memang begitu
- canonical Equipment Unit image hanya di Unit
- Request hanya refer Unit
- jangan duplicate/snapshot unit image tanpa requirement
- Request attachment terpisah dari Unit image
- validate extension + MIME + magic bytes
- UUID/random stored filename
- original filename metadata only
- size/count limit
- malware scan optional future.

==================================================
REPORT EXCEL — BELUM DIKERJAKAN

Menu Reports masih placeholder.

Permission existing:

EQUIPMENT_REPORT.VIEW

Rencana:

API report endpoint + Excel.

Filter kandidat:

- date range
- company
- division
- status
- equipment/category

Recommended row:
1 row per request equipment detail/unit.

Kolom kandidat:

- Request No
- Request Date
- Company
- Division
- Requester
- Equipment Category
- Unit Code
- Unit Name
- Lifting Estimation
- Planned Start
- Planned End
- Current/Operational Status
- Exxon Approved By
- Exxon Approval Date
- Completion Date
- Remarks

Report dikerjakan setelah flow final + attachment stabil.

==================================================
BATCH STATUS TERBARU

Batch 1 — Core Flow

STATUS:
DONE / STABILIZED secara mayor.

Sudah:

- Exxon final approval
- Global review-only
- planned period operation
- auto technical operation
- no manual Assignment
- no manual Start Operation
- notification rewire
- email rewire
- Operations
- Monitoring derived-time
- transition legacy inactive
- Complete flow
- early completion warning.

Batch 2 — Consumer/UI Cleanup

STATUS:
PRAKTIS DONE.

Sudah:

- Model Code removal
- Lifting Estimation wording
- Review & Approval UX
- Review Notes Exxon read-only di Global
- Operations UI
- Operations pagination 4/page
- Monitoring wording
- Request Detail single scroll
- Request Journey digabung ke Activity
- lifecycle Activity lengkap
- historical raw activity tetap dijaga
- UUID technical tidak ditampilkan.

Remaining kecil:
audit visual final jika source ZIP terbaru punya perbedaan.

Batch 3 — Attachment + Unit Image Propagation

STATUS:
NEXT.

Order rekomendasi:

A. Audit dan propagasikan Unit Image ke consumer yang masih kosong:

- Approval
- Global Review
- Operations
- Monitoring
- Completed/detail.

B. Reuse existing authenticated image preview.

C. Implement attachment PDF/Image:

- create lifecycle
- validation
- storage
- authenticated access
- Request Detail display
- Approval/Review visibility
- optional compact access di Operations.

Batch 4 — Excel Report

STATUS:
BELUM.

==================================================
TEST FLOW YANG SUDAH BERHASIL

End-to-end terbaru sudah dites sampai:

Requester
→ Draft
→ Submit
→ Exxon Approval
→ Global Review visibility
→ Operations
→ Early Complete
→ Completed
→ Monitoring Completed Today

Submit issue TEMPLATE_ASSIGNED sudah fixed.

Review Notes issue sudah fixed.

Complete early warning sudah working.

Operations pagination 4/page sudah diterapkan.

==================================================
NEXT STEP DI PAGE BARU

Begitu pindah page:

1. Upload ZIP WEB terbaru.
2. Upload ZIP API terbaru.
3. Jika ada dump DB terbaru, upload juga.
4. ZIP terbaru = source of truth.
5. Audit cepat bahwa seluruh patch terakhir benar-benar ada.
6. Jangan langsung coding Attachment.
7. Pertama audit implementasi Unit Image existing:
   - service/blob loader
   - object URL cleanup
   - overlay preview
   - fallback icon
   - authenticated endpoint.
8. Mapping semua consumer unit yang masih belum punya image:
   - Approval
   - Global Review
   - Operations
   - Monitoring
   - Completed
   - Request Detail.
9. Reuse existing implementation, jangan bikin duplicate mechanism.
10. Baru lanjut Attachment.
11. Audit fileAttachments existing:

- schema
- route
- service/helper
- permission
- storage convention.

12. Design attachment sekunder dan informatif, jangan mengganggu info utama.
13. Test end-to-end:
    create request + attachment
    → Submit
    → Exxon sees attachment
    → Global sees attachment
    → Operations still clean
    → Monitoring/detail can access
    → authenticated download/preview works
    → Completed tetap bisa akses attachment.

==================================================
KALIMAT PEMBUKA PAGE BARU

Ini checkpoint terakhir Global Trans. Source terbaru saya upload setelah ini. Jadikan ZIP terbaru source of truth. Audit dulu apakah semua patch terakhir sudah applied, terutama Operations pagination 4/page, early completion warning, Review Notes Exxon, Monitoring wording, Request Detail single-scroll dan full lifecycle Activity.

Next batch fokus dua hal: pertama audit dan propagasikan Unit Image ke seluruh consumer aktif sampai Completed dengan reuse authenticated Blob + preview existing; kedua implement Attachment PDF/Image memakai fileAttachments, private/authenticated storage, validasi aman, dan UI sekunder yang informatif tanpa mengganggu info utama.

Jangan lupa seluruh rules kerja, Exxon final approval, Global review-only, planned-period Operations, legacy transition/history jangan dihapus, Session area jangan disentuh, dan selalu trace source terbaru sebelum coding.
