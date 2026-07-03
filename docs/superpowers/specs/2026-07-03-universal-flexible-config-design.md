# Design: Universal & Flexible Config untuk `9router-agy`

**Tanggal:** 2026-07-03
**Status:** Approved (siap untuk implementation plan)

## Konteks & Masalah

`bot.js` saat ini hardcode semua parameter koneksi:
- `host: "<your-9router-host>"`, `port: 20128`, `proto: "http"`
- `dbPath`, `machineId`, `cliSecret` dibaca dari `~/.9router/...` di mesin lokal
- `chromiumPath: "/usr/bin/chromium"`
- Auth hanya via **CLI token** (butuh file `machine-id` + `cli-secret` lokal)

Konsekuensinya, bot hanya bisa:
- Menarget 9router yang host-nya cocok dengan hardcode.
- Berjalan di mesin yang sama dengan 9router (karena butuh file lokal + akses SQLite langsung).
- Konek via `http` saja — `https://...<tunnel-host>/` tidak akan jalan karena `apiCall` pakai modul `http` secara hardcoded.

## Tujuan

Buat bot **universal & flexible** agar bisa:
1. Menarget deployment 9router manapun (host/proto/port configurable).
2. Berjalan **remote** (dari mesin lokal → VPS via HTTPS) **maupun** **local** (di mesin 9router langsung).
3. Mengautentikasi via **dashboard password** (session cookie, untuk remote) **atau** **CLI token** (untuk local).
4. Menerima konfigurasi lewat rantai prioritas: flag CLI → env var → file config → default.

## Keputusan Desain

### 1. Sistem Config (`config.js` — file baru)

Loader tunggal yang membaca nilai dengan rantai prioritas (yang pertama ditemukan menang):

```
CLI flags  >  ENV vars  >  config.json  >  defaults
```

**Field config:**

| Field | Flag CLI | Env Var | Default | Wajib |
|-------|----------|---------|---------|-------|
| `host` | `--host` | `NINEROUTER_HOST` | `localhost` | ya |
| `proto` | `--proto` | `NINEROUTER_PROTO` | `http` | — |
| `port` | `--port` | `NINEROUTER_PORT` | `20128` | — |
| `mode` | `--mode` | `NINEROUTER_MODE` | `auto` | — |
| `password` | `--password` | `NINEROUTER_PASSWORD` | — | remote |
| `chromiumPath` | `--chromium` | `NINEROUTER_CHROMIUM` | `/usr/bin/chromium` | — |
| `dbPath` | `--db-path` | — | `~/.9router/db/data.sqlite` | local |
| `machineIdPath` | `--machine-id-path` | — | `~/.9router/machine-id` | local |
| `cliSecretPath` | `--cli-secret-path` | — | `~/.9router/auth/cli-secret` | local |
| `callbackPath` | `--callback-path` | — | `/callback` | — |

**Pencarian file config:** `./config.json` (cwd) → `~/.9router-agy/config.json` (yang pertama ada dipakai, cwd menang).

**Validasi & prompt:**
- Field wajib yang masih kosong setelah seluruh rantai:
  - Mode non-interaktif (output piped / `--no-prompt`): throw error dengan pesan jelas menyebut flag/env yang dipakai.
  - Mode interaktif (default, TTY): prompt via `readline`.
- `password` wajib hanya saat mode = `remote`. Mode `auto` yang resolve ke `remote` juga wajib.

**Output:** objek config beku (resolved) berisi semua field + hasil resolusi `mode` final (`local`/`remote`, bukan `auto`).

### 2. Abstraksi Auth (`auth.js` — file baru)

Dua strategi, dipilih oleh `resolveAuth(config)`:

- **`cliToken(config)`** — mode local:
  - Baca `machineIdPath` + `cliSecretPath`.
  - Token = `SHA256(machineId + "9r-cli-auth" + cliSecret).slice(0,16)` (logika lama dipindahkan).
  - Pasang header `x-9r-cli-token: <token>`.

- **`dashboardSession(config)`** — mode remote:
  - `POST /api/auth/login` body `{"password": "<password>"}` (path relatif, lewat `apiCall` sesuai proto/host/port).
  - Tangkap header respons `Set-Cookie`, ekstrak nilai `session=...`.
  - Simpan ke object sederhana (cookie jar manual — cukup satu cookie `session`).
  - Pasang header `Cookie: session=<value>` di request berikutnya.

- **`resolveAuth(config)`** (logika pemilihan):
  - Jika `config.mode === 'local'` → `cliToken`.
  - Jika `config.mode === 'remote'` → `dashboardSession`.
  - Tidak ada mode campuran ad-hoc; mode sudah final saat masuk sini.

**Perubahan `apiCall`:**
- Menerima `config` (atau auth-headers yang sudah di-resolve), bukan hardcoded `http` + token global.
- Memilih modul `http` vs `https` berdasarkan `config.proto`. **Ini perbaikan inti agar host `https://...` jalan.**
- Menerima opsi `cookies` untuk request yang butuh session (login itself tidak bawa cookie).

### 3. Mode (`auto` | `local` | `remote`)

- `auto` (default): resolve saat `loadConfig`.
  - `local` jika `machineIdPath` ada (file exists) **dan** `host` ∈ {`localhost`, `127.0.0.1`, `::1`}.
  - `remote` otherwise.
- `local`: pakai `cliToken` + akses SQLite langsung.
- `remote`: pakai `dashboardSession` + HTTPS API.

### 4. Permukaan Command per Mode

| Command | Local (SQLite + cliToken) | Remote (HTTPS API + session) |
|---------|---------------------------|------------------------------|
| `browser` | `authorize` → Puppeteer login → `exchange` | Sama, sudah remote-capable |
| `inspect` / `list` | `SELECT` dari `providerConnections` | `GET /api/provider-connections` |
| `delete <id>` | `DELETE` dari SQLite | `DELETE /api/provider-connections/:id` |
| `inject` | `INSERT` ke SQLite | **Tidak didukung** — cetak pesan jelas: "inject tidak tersedia di remote mode; gunakan `browser`." |

Alasan `inject` remote diblok: tidak ada endpoint API aman untuk menulis token mentah; flow `browser` (OAuth natural via `exchange`) adalah padanan yang benar.

### 5. Struktur File

```
9router-agy/
  config.js              BARU  — loadConfig (rantai prioritas + validasi + prompt)
  auth.js                BARU  — cliToken, dashboardSession, resolveAuth
  bot.js                 UBAH  — pakai config+auth; apiCall proto-aware & auth-aware;
                                  command handler jadi mode-aware
  config.example.json    BARU  — template config.json
  batch-runner.js        TIDAK DIUBAH (tetap spawn bot.js)
  extract-missing.js     TIDAK DIUBAH (tool terpisah, Helius)
  test_login.js          TIDAK DIUBAH (script eksperimen)
```

### 6. Backward Compatibility

Perintah lama harus tetap jalan tanpa flag baru **selama dijalankan di mesin 9router**:
- `node bot.js browser <email> <password>` → `mode=auto` resolve ke `local` (machine-id ada, host default localhost), pakai cliToken. Sama seperti sebelumnya.
- Default `host=localhost`, `port=20128`, `proto=http` menjaga perilaku lama.

## Asumsi yang Perlu Diverifikasi (di fase implementasi)

1. **Endpoint remote list/delete ada dan menerima session-cookie:**
   - `GET /api/provider-connections` (README menyiratkan ada).
   - `DELETE /api/provider-connections/:id` (perlu konfirmasi path & method).
2. **`/api/auth/login`:** payload `{"password": "..."}` → respons `Set-Cookie: session=...`. Bentuk respons JSON (kalau ada) perlu dilihat.
3. **Bentuk data `provider-connections` via API** apakah identik dengan kolom SQLite (`id, provider, email, isActive, data, createdAt`) agar `inspect` bisa render seragam.

Verifikasi dilakukan dengan request probe ke 9router yang sedang jalan (local untuk struktur, VPS untuk path remote) menggunakan token/cookie yang valid. Kalau endpoint tidak ada, command remote bersangkutan di-fallback ke pesan "not supported in remote mode" alih-alih di-fake.

## Out of Scope (YAGNI)

- Tidak memecah `bot.js` jadi banyak modul (browser automation tetap di `bot.js`).
- Tidak menambah strategy auth ketiga (mis. API key header murni) — dua sudah cukup.
- Tidak men-support multi-deployment simultan (satu config = satu target per run).
- Tidak mengubah `extract-missing.js` / `test_login.js`.
