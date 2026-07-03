# 9router-agy

Tool CLI (Node.js) untuk **otomatisasi registrasi akun Google Antigravity ke 9router** lewat alur OAuth Google. Bisa jalan **local** (di mesin yang sama dengan 9router) atau **remote** (dari manapun, ke 9router di VPS/host lain via HTTPS).

> ⚠️ **Etika & ToS:** Tool ini mengotomatiskan login OAuth untuk akun yang kamu punya kredensialnya, ke 9router milikmu sendiri. Otomatisasi login Google beruntun berisiko di-challenge/diblokir Google — gunakan dengan jeda yang wajar. Hormati Terms of Service pihak terkait.

---

## Isi

- [Apa yang dilakukan](#apa-yang-dilakukan)
- [Command](#command)
- [Mode: local vs remote](#mode-local-vs-remote)
- [Prasyarat](#prasyarat)
- [Install](#install)
- [Setup Linux](#setup-linux)
- [Setup Windows](#setup-windows)
- [Config](#config)
- [Contoh pakai](#contoh-pakai)
- [Keamanan](#keamanan)
- [Test](#test)
- [Troubleshooting](#troubleshooting)

---

## Apa yang dilakukan

Untuk satu akun Google (punya email + password), bot akan:

1. Meminta *authorization URL* OAuth Antigravity dari 9router.
2. Membuka Chromium, login Google otomatis (email → password → consent/TOS).
3. Menangkap `code` OAuth dari redirect callback.
4. Menukar `code` tersebut dengan token di 9router (`/api/oauth/antigravity/exchange`).
5. Akun terdaftar sebagai provider connection di 9router.

Tersedia juga operasi baca/hapus (`inspect`, `delete`) baik via SQLite lokal maupun via API remote.

---

## Command

```
node bot.js browser <email> <password> [flags]     # daftarkan 1 akun via OAuth
node bot.js browser <accounts.json> [flags]        # batch dari file JSON
node bot.js inspect [flags]                        # lihat akun Antigravity terdaftar
node bot.js delete <id> [flags]                    # hapus akun berdasarkan ID
node bot.js inject --email <e> --access-token <t>  # inject token mentah (LOCAL only)
```

`accounts.json` berformat array:

```json
[
  { "email": "user1@example.com", "password": "theirpassword" },
  { "email": "user2@example.com", "password": "theirpassword" }
]
```

---

## Mode: local vs remote

| | Local | Remote |
|---|---|---|
| Bot jalan di | mesin yang sama dengan 9router | manapun (laptop, server lain) |
| Auth ke 9router | CLI token (dari `~/.9router/machine-id` + `cli-secret`) | dashboard password → session cookie |
| Akses data | SQLite langsung (`~/.9router/db/data.sqlite`) | HTTPS API (`/api/providers`) |
| `browser` | ✅ | ✅ |
| `inspect` / `delete` | ✅ | ✅ |
| `inject` | ✅ | ⛔ diblokir (pakai `browser`) |

Mode diatur via `--mode auto|local|remote`. Default `auto`: **local** kalau `~/.9router/machine-id` ada **dan** host = localhost; selain itu **remote**.

**Catatan OAuth (remote):** redirect_uri yang terdaftar di Google adalah `http://localhost:20128/callback` (fixed), terpisah dari host API. Saat mode remote, browser akan redirect ke `localhost` lokal kamu — ini aman karena PKCE: hanya bot yang memegang `code_verifier`, sehingga instance 9router lokal tidak bisa mengonsumsi code tersebut; bot menangkapnya lalu menukar di host target.

---

## Prasyarat

- **Node.js 18+** (untuk `node:test` bawaan).
- **Browser Chromium/Chrome/Edge** (bot memakai Puppeteer, `headless: false` — window akan terbuka).
- **Mode local:** 9router terpasang di mesin yang sama (`~/.9router/`).
- **Mode remote:** akses ke host 9router (HTTPS) + dashboard password.

---

## Install

```bash
git clone git@github.com:elzanom/9router-agy.git
cd 9router-agy
npm install
```

Tidak ada dependency runtime baru selain yang sudah ada (`puppeteer-core`, `puppeteer-extra`, `puppeteer-extra-plugin-stealth`, `sqlite3`).

---

## Setup Linux

1. Pastikan Chromium terpasang (mis. `/usr/bin/chromium`). Cek: `which chromium`.
2. **Remote (paling umum):** salin contoh config lalu edit:
   ```bash
   cp config.example.json config.json
   $EDITOR config.json   # isi host, password dashboard, chromiumPath bila perlu
   ```
3. **(Opsional) Local:** pastikan 9router jalan di `localhost:20128` dan `~/.9router/machine-id` ada. Tanpa flag, mode otomatis `local`.
4. Tes: `node bot.js inspect`

---

## Setup Windows

1. Install [Node.js 18+](https://nodejs.org/) (centang "Add to PATH").
2. `git clone` lalu `npm install` di folder proyek (pakai Git Bash / PowerShell / CMD).
3. Path Chromium default (`/usr/bin/chromium`) tidak ada di Windows — **set `chromiumPath`** di `config.json` ke path Chrome/Edge kamu, contoh:
   ```json
   {
     "host": "<your-9router-host>",
     "proto": "https",
     "mode": "remote",
     "password": "<your-dashboard-password>",
     "chromiumPath": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
   }
   ```
   Path Edge: `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`.
   (Tanda `\` harus dobel `\\` dalam JSON.)
4. Jalankan dari folder proyek:
   ```powershell
   node bot.js inspect
   ```
5. **Mode local di Windows:** hanya berlaku jika 9router terpasang di mesin yang sama dengan struktur path `%USERPROFILE%\.9router\...` (logika path memakai `os.homedir()`, jadi cross-platform). Untuk sekadar mendaftar ke 9router di tempat lain, pakai mode remote (tidak butuh 9router lokal).

> Tips cross-platform: taruh semua konfigurasi di `config.json` agar terhindar dari perbedaan quoting shell (cmd vs PowerShell vs bash), terutama untuk password.

---

## Config

Prioritas (yang pertama menang): **flag CLI → env var → `config.json` → default**.

| Field | Flag | Env | Default | Wajib |
|-------|------|-----|---------|-------|
| `host` | `--host` | `NINEROUTER_HOST` | `localhost` | ya |
| `proto` | `--proto` | `NINEROUTER_PROTO` | `http` | — |
| `port` | `--port` | `NINEROUTER_PORT` | `20128` (`443` untuk https) | — |
| `mode` | `--mode` | `NINEROUTER_MODE` | `auto` | — |
| `password` | `--password` | `NINEROUTER_PASSWORD` | — | remote |
| `chromiumPath` | `--chromium` | `NINEROUTER_CHROMIUM` | `/usr/bin/chromium` | — |
| `oauthCallbackUrl` | `--oauth-callback-url` | `NINEROUTER_OAUTH_CALLBACK_URL` | `http://localhost:20128/callback` | — |

File `config.json` dicari di cwd dulu, lalu `~/.9router-agy/config.json`.

---

## Contoh pakai

```bash
# Remote via HTTPS (VPS) — pakai config.json:
node bot.js inspect
node bot.js browser user@example.com 'theirpassword'

# Remote via flag:
node bot.js inspect --host <your-9router-host> --proto https --password '<dashboard-password>'

# Batch dari file:
node bot.js browser accounts.json

# Local (di mesin 9router, tanpa flag):
node bot.js inspect
node bot.js browser user@example.com 'theirpassword'

# Hapus akun:
node bot.js delete <id>
```

---

## Keamanan

- **`config.json`, `batch-accounts.json`, `*.zip`, `node_modules/` di-gitignore** — kredensial tidak ikut ter-commit. Jangan commit password asli.
- **TLS selalu aktif.** Tidak ada opsi menonaktifkan verifikasi TLS. Untuk sertifikat self-signed, set env `NODE_EXTRA_CA_CERTS=/path/to/rootCA.pem` (percaya satu CA spesifik), bukan mematikan verifikasi.
- **Guard password cleartext:** mode `remote` + `proto=http` + host non-localhost akan ditolak (mencegah password dashboard dikirim plaintext). Gunakan `--proto https` untuk remote.
- Password akun Google tidak di-log; hanya email yang tampil di log proses.

---

## Test

Unit test memakai runner bawaan (`node:test`), tanpa dependency tambahan:

```bash
npm test
# atau: node --test
```

Mencakup `http-client`, `config` (rantai prioritas, mode, guard), dan `auth` (cliToken, dashboardSession).

---

## Troubleshooting

- **`redirect_uri_mismatch`** — redirect_uri OAuth harus persis `http://localhost:20128/callback` (terdaftar di Google). Jangan diubah ke host koneksi kecuali kamu tahu itu juga terdaftar di Google. Atur via `oauthCallbackUrl` bila perlu.
- **`Dashboard login failed (HTTP 401)`** — password dashboard salah.
- **Google CAPTCHA / challenge** — login otomatis beruntun memicu challenge. Bot menycreenshot ke `/tmp` (Linux) atau `%TEMP%` (Windows) lalu berhenti; lanjutkan manual atau beri jeda antar akun.
- **`Execution context was destroyed`** — race Puppeteer saat halaman TOS/consent (jarang, transient). Coba ulang akun tersebut.
- **Port salah** — kalau tunnel VPS memakai port lain, tambahkan `--port` (mis. `--port 443`).
- **Browser tidak terbuka (Windows)** — cek `chromiumPath` di `config.json` mengarah ke Chrome/Edge yang ada.

---

## Struktur proyek

```
bot.js                 # entry CLI + automasi Google OAuth (puppeteer)
config.js              # loadConfig (rantai prioritas, mode, validasi)
auth.js                # cliToken + dashboardSession
http-client.js         # request() proto-aware (http/https)
scripts/probe-api.js   # util cek endpoint 9router
tests/                 # unit test (node:test)
config.example.json    # template config
```

## Lisensi

Personal project. Gunakan secara bertanggung jawab dan sesuai ToS pihak terkait.
