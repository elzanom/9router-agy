# 9router-agy

Setup dan konfigurasi **Antigravity (agy)** sebagai provider di **9router**.

## 📋 Status Saat Ini

| Item | Status |
|------|--------|
| 9router | ✅ Running (PID 871, port 20128, tray mode) |
| Dashboard | http://localhost:20128 |
| Akun Antigravity terdaftar | **17 akun** (16 aktif, 1 nonaktif) |
| Database | `~/.9router/db/data.sqlite` |
| API Key 9router | `<9router-api-key>-***` |

## 🔑 Cara Menambah Akun Antigravity Baru

### Via Dashboard (Browser)

1. Buka http://localhost:20128
2. Login menggunakan password dashboard
3. Navigasi ke menu **Providers** atau **Connections**
4. Pilih **Antigravity** → **Add Connection**
5. Login via Google OAuth
6. Akun akan muncul di daftar provider connections

### Via REST API

```bash
# Login dulu untuk dapat session cookie
curl -X POST http://localhost:20128/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password":"YOUR_PASSWORD"}'

# Lihat daftar provider connections (butuh auth)
curl http://localhost:20128/api/provider-connections \
  -H "Cookie: session=YOUR_SESSION"
```

## 🚀 Setup MITM Proxy (Antigravity IDE → 9router)

Antigravity (Google Cloud Code IDE) menggunakan mode **MITM** (Man-in-the-Middle) untuk routing traffic ke 9router.

### Cara Kerja

1. 9router membuat **Root CA certificate** (untuk HTTPS interception)
2. Menambahkan **DNS entry** di `/etc/hosts`: `daily-cloudcode-pa.googleapis.com` → `127.0.0.1`
3. Menjalankan **MITM proxy server** di port **443** (butuh sudo)
4. Antigravity IDE yang asli tetap connect ke domain yang sama tapi traffic-nya di-intercept
5. 9router meneruskan request ke salah satu akun Antigravity yang terdaftar (round-robin/quota-based)

### Prasyarat

- 9router sudah running (✅ sdh jalan)
- Akun Antigravity sudah didaftarkan di 9router (✅ 17 akun sdh)
- **sudo password** (untuk DNS entry + port 443)

### Langkah Setup

#### 1. Generate Root CA Certificate

```bash
# Otomatis dilakukan oleh MITM server saat pertama kali start
# Certificate disimpan di:
ls -la ~/.9router/mitm/
# rootCA.key + rootCA.crt
```

#### 2. Start MITM Server

Via Dashboard:
- Buka http://localhost:20128
- Pilih menu **CLI Tools** → **Antigravity**
- Klik "Start MITM Server"
- Masukkan sudo password jika diminta
- Pilih API Key 9router

Atau via API:

```bash
# Cek status MITM
curl http://localhost:20128/api/cli-tools/antigravity-mitm \
  -H "x-cli-token: $(python3 -c "import hashlib; jwt=open('~/.9router/jwt-secret').read().strip(); cli=open('~/.9router/auth/cli-secret').read().strip(); print(hashlib.sha256(f'{jwt}:{cli}'.encode()).hexdigest())")"

# Start MITM
curl -X POST http://localhost:20128/api/cli-tools/antigravity-mitm \
  -H "x-cli-token: $(...)" \
  -H "Content-Type: application/json" \
  -d '{"apiKey":"sk-***","sudoPassword":"***","action":"start"}'
```

#### 3. Trust the Certificate

Install rootCA.crt ke sistem trust store:

```bash
# Linux
sudo cp ~/.9router/mitm/rootCA.crt /usr/local/share/ca-certificates/9router-mitm.crt
sudo update-ca-certificates

# Atau trust secara interaktif via dashboard
```

#### 4. Verify MITM Active

- DNS entry aktif: `daily-cloudcode-pa.googleapis.com` → `127.0.0.1`
- Port 443 listening: `sudo lsof -i :443`
- Antigravity IDE bisa connect dan request diarahkan ke 9router

## 🔄 Model Aliases

Saat request dari Antigravity di-intercept, model name diremapping:

| Original Model | 9router Alias |
|---------------|---------------|
| gemini-default | gemini-3.5-flash-low |
| gemini-3.5-flash-high | gemini-3-flash-agent |
| gemini-3.5-flash-medium | gemini-3.5-flash-low |
| gemini-3.5-flash-extra-low | gemini-3.5-flash-extra-low |
| gemini-3.1-pro-high | gemini-pro-agent |
| gemini-3-pro-high | gemini-pro-agent |
| gemini-3-pro-low | gemini-3.1-pro-low |

## 📦 Daftar Akun Antigravity

| # | Email | Auth | Active | Created |
|---|-------|------|--------|---------|
| 1 | <email> | oauth | ❌ | 2026-06-26 |
| 2 | <email> | oauth | ✅ | 2026-07-01 |
| 3-17 | user1-15@example.com | oauth | ✅ | 2026-07-02 |

## 🛠 Troubleshooting

**MITM server can't start - port 443 busy**
```bash
# Cek apa yang pakai port 443
sudo lsof -i :443
# Jika dipakai service lain, stop dulu
sudo systemctl stop nginx  # atau apache/caddy dll
```

**DNS entry tidak terdaftar**
```bash
# Cek /etc/hosts
grep "daily-cloudcode-pa" /etc/hosts
# Harusnya ada: 127.0.0.1 daily-cloudcode-pa.googleapis.com
```

**Certificate tidak trusted**
```bash
# Cek apakah cert terinstall
openssl verify ~/.9router/mitm/rootCA.crt
# Install ulang jika perlu
```

---

## 🌐 Remote VPS Usage (Universal Config)

Bot sekarang bisa konek ke 9router di mana saja (host/proto/port configurable) dan jalan **local** atau **remote**.

### Mode
- `auto` (default): `local` kalau `~/.9router/machine-id` ada & host=localhost; selain itu `remote`.
- `local`: CLI token + SQLite langsung (perlu jalan di mesin 9router).
- `remote`: dashboard password → session cookie + HTTPS API (bisa dari mesin manapun).

### Config sources (prioritas): flag CLI > env var > config.json > default

Contoh `config.json` (lihat `config.example.json`):
```json
{ "host": "<your-9router-host>", "proto": "https", "port": 443, "mode": "remote", "password": "<dashboard-password>" }
```

### Contoh remote (VPS HTTPS)
```bash
node bot.js inspect --host <your-9router-host> --proto https --password '<dashboard-password>'
node bot.js browser user@gmail.com 'gpw' --host <your-9router-host> --proto https --password '<dashboard-password>'
```

### Catatan
- `inject` tidak tersedia di remote (pakai `browser`).
- TLS diverifikasi penuh. Untuk self-signed cert, set `NODE_EXTRA_CA_CERTS=/path/to/rootCA.pem` (jangan disable verification).

---

Dibuat: 2026-07-02
