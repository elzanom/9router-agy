#!/usr/bin/env node
/**
 * 9router Agy Bot — Automasi register akun Antigravity (Google OAuth)
 *
 * MODE:
 *   browser  → buka browser, login Google, ambil code OAuth, exchange token
 *   inject   → inject langsung Google OAuth token ke SQLite 9router
 *
 * Usage:
 *   node bot.js browser <email> <password>                    # satu akun
 *   node bot.js browser accounts.json                         # batch dari file
 *   node bot.js inject --email <email> --access-token <tok>   # inject token langsung
 *   node bot.js inject --email <email> --refresh-token <tok>  # inject refresh token
 *   node bot.js inspect                                       # lihat existing accounts
 *   node bot.js list-accounts                                 # lihat akun yg sudah terdaftar
 *
 * File accounts.json:
 *   [{ "email": "...", "password": "..." }, ...]
 */

const puppeteer = require("puppeteer-core");
const { addExtra } = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const puppeteerExtra = addExtra(puppeteer);
puppeteerExtra.use(StealthPlugin());
const crypto = require("crypto");
const sqlite3 = require("sqlite3");
const fs = require("fs");

const { loadConfig, parseCliFlags } = require("./config");
const { resolveAuthHeaders } = require("./auth");
const { request } = require("./http-client");

// ============================================================
// 9ROUTER API
// ============================================================
async function apiCall(config, method, reqPath, body = null) {
  const headers = await resolveAuthHeaders(config);
  const res = await request(config, { method, path: reqPath, body, headers });
  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    parsed = res.body;
  }
  if (res.statusCode >= 400) {
    const msg = parsed && parsed.error ? parsed.error : `HTTP ${res.statusCode}`;
    throw new Error(`${msg} (at ${method} ${reqPath})`);
  }
  return parsed;
}

function buildCallbackUrl(config) {
  return `${config.proto === "https" ? "https" : "http"}://${config.host}${config.port === 443 && config.proto === "https" ? "" : ":" + config.port}${config.callbackPath}`;
}

function safePageUrl(page) {
  try {
    return page.url() || "";
  } catch {
    return "";
  }
}

async function getAuthorizeUrl(config) {
  return apiCall(
    config,
    "GET",
    `/api/oauth/antigravity/authorize?redirect_uri=${encodeURIComponent(buildCallbackUrl(config))}`,
  );
}

async function exchangeOAuthCode(config, { code, redirectUri, codeVerifier, state }) {
  return apiCall(config, "POST", "/api/oauth/antigravity/exchange", {
    code,
    redirectUri,
    codeVerifier,
    state,
  });
}

// ============================================================
// DATABASE HELPERS
// ============================================================
function openDb(config) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(config.dbPath, (err) => (err ? reject(err) : resolve(db)));
  });
}

async function listAccounts(config) {
  const db = await openDb(config);
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT id, name, email, provider, isActive, data, createdAt, updatedAt
       FROM providerConnections WHERE provider = 'antigravity' ORDER BY createdAt DESC`,
      (err, rows) => {
        db.close();
        if (err) reject(err);
        else resolve(rows.map((r) => ({ ...r, parsedData: r.data ? JSON.parse(r.data) : null })));
      },
    );
  });
}

async function injectToken(config, { email, name, accessToken, refreshToken, expiresIn }) {
  const db = await openDb(config);

  const projectId = `agy-${email
    .split("@")[0]
    .replace(/[^a-z0-9]/gi, "-")
    .toLowerCase()}`;

  const expiresInSec = expiresIn || 3599;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresInSec * 1000);

  const data = {
    accessToken,
    refreshToken,
    expiresAt: expiresAt.toISOString(),
    scope:
      "https://www.googleapis.com/auth/experimentsandconfigs https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/userinfo.profile openid https://www.googleapis.com/auth/cloud-platform",
    projectId,
    testStatus: "active",
    expiresIn: expiresInSec,
    lastUsedAt: now.toISOString(),
    lastRefreshAt: now.toISOString(),
    consecutiveUseCount: 0,
    backoffLevel: 0,
  };

  const id = crypto.randomUUID();
  const nowISO = now.toISOString();

  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO providerConnections (id, provider, authType, name, email, isActive, data, createdAt, updatedAt)
       VALUES (?, 'antigravity', 'oauth', ?, ?, 1, ?, ?, ?)`,
      [id, name || email, email, JSON.stringify(data), nowISO, nowISO],
      function (err) {
        db.close();
        if (err) reject(err);
        else resolve({ id, email, projectId, name: name || email });
      },
    );
  });
}

async function deleteAccount(config, id) {
  const db = await openDb(config);
  return new Promise((resolve, reject) => {
    db.run("DELETE FROM providerConnections WHERE id = ?", [id], function (err) {
      db.close();
      if (err) reject(err);
      else resolve({ deleted: this.changes });
    });
  });
}

// ============================================================
// BROWSER AUTOMATION
// ============================================================
async function automateGoogleLogin(config, email, password) {
  console.log(`\n[${email}] Memulai OAuth flow...`);

  // Step 1: Get authorization URL
  console.log(`[${email}] 1/5 Mendapatkan authorization URL...`);
  const authData = await getAuthorizeUrl(config);
  console.log(`[${email}]    Auth URL didapat`);

  // Step 2: Launch browser
  console.log(`[${email}] 2/5 Membuka browser...`);
  const browser = await puppeteerExtra.launch({
    executablePath: config.chromiumPath,
    headless: false, // Biar kelihatan — kalau mau headless ganti jadi 'new' / true
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1280,800",
    ],
  });

  let code = null;
  let state = null;
  let callbackUrl = null;

  try {
    // Step 3: Buka auth URL
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    );
    // Evade automation detection
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    // Listen for redirect to callback URL
    page.on("framenavigated", async (frame) => {
      if (
        frame.url().includes("/callback?code=") ||
        frame.url().includes("/callback?token=")
      ) {
        callbackUrl = frame.url();
        const url = new URL(callbackUrl);
        code = url.searchParams.get("code") || url.searchParams.get("token");
        state = url.searchParams.get("state");
        console.log(`[${email}]    ✅ OAuth code didapat dari redirect!`);
      }
    });

    // Also check the main page URL on navigation
    page.on("load", () => {
      const url = page.url();
      if (url.includes("/callback")) {
        callbackUrl = url;
        const urlObj = new URL(url);
        code =
          urlObj.searchParams.get("code") || urlObj.searchParams.get("token");
        state = urlObj.searchParams.get("state");
        console.log(`[${email}]    ✅ OAuth code didapat dari load event!`);
      }
    });

    // Step 4: Buka halaman Google login
    console.log(`[${email}] 3/5 Navigasi ke Google login...`);
    await page.goto(authData.authUrl, {
      waitUntil: "networkidle0",
      timeout: 30000,
    });

    // Tunggu sebentar
    await new Promise((r) => setTimeout(r, 2000));

    // === GOOGLE LOGIN AUTOMATION ===
    // Google login flow (dapat berubah, but we handle common cases)

    // Check if we're already on the consent page (already logged in)
    let currentUrl = safePageUrl(page);
    if (
      currentUrl.includes("accounts.google.com") ||
      currentUrl.includes("google.com/o/oauth2")
    ) {
      // --- GOOGLE LOGIN: Email (Google uses type="text" not type="email"!) ---
      // Google's signin page: email = input#identifierId[type="text"]
      // Password field shows only AFTER email is submitted
      const emailField = await page
        .waitForSelector("#identifierId", { timeout: 15000 })
        .catch(() => null);
      if (emailField) {
        console.log(`[${email}]    Memasukkan email...`);
        await new Promise((r) => setTimeout(r, 500));
        await emailField.type(email, { delay: 60 });
        await new Promise((r) => setTimeout(r, 1000));

        // Click Next button
        const nextBtn = await page.$(
          '#identifierNext button, button[jsname="V67aGc"], div[role="button"][jsname="V67aGc"]',
        );
        if (nextBtn) {
          try {
            await page.evaluate((el) => el.click(), nextBtn);
          } catch {
            await page.keyboard.press("Enter");
          }
        } else {
          await page.keyboard.press("Enter");
        }
        console.log(`[${email}]    Email submitted, menunggu password page...`);

        // Wait for email field to disappear (transition to password page)
        await page
          .waitForFunction(() => !document.querySelector("#identifierId"), {
            timeout: 15000,
          })
          .catch(() => {});
        await new Promise((r) => setTimeout(r, 2000));
      }

      // --- PASSWORD (after Google transitions from email step) ---
      // The real password field appears AFTER email is submitted
      // Google's hidden password field (name="hiddenPassword") is always in DOM but not visible
      // We wait for the visible password field using :not([hidden]) selector
      const pwField = await page
        .waitForSelector('input[type="password"]', { timeout: 15000 })
        .catch(() => null);
      if (pwField && password) {
        console.log(`[${email}]    Memasukkan password...`);
        await new Promise((r) => setTimeout(r, 500));
        await pwField.type(password, { delay: 40 });
        await new Promise((r) => setTimeout(r, 1000));

        // Click submit
        try {
          const pwNextBtn = await page.$(
            '#passwordNext button, button[jsname="V67aGc"], div[role="button"][jsname="V67aGc"]',
          );
          if (pwNextBtn) {
            await page.evaluate((el) => el.click(), pwNextBtn);
          } else {
            await page.keyboard.press("Enter");
          }
        } catch {
          await page.keyboard.press("Enter");
        }
        console.log(`[${email}]    Password submitted, menunggu redirect...`);
        // Wait for Google to process and redirect
        await new Promise((r) => setTimeout(r, 5000));
      }

      // --- POST-LOGIN PAGES: handle all Google redirect pages after login ---
      // Google may show: TOS speedbump, native app confirmation, consent screen
      // Loop for up to 30s to handle all of them
      const postLoginTimeout = Date.now() + 30000;
      while (Date.now() < postLoginTimeout) {
        currentUrl = safePageUrl(page);
        const pageTitle = await page.title().catch(() => "");

        if (
          currentUrl.includes("/callback?") ||
          currentUrl.includes("/callback#")
        ) {
          // We got redirected to 9router callback - success!
          break;
        }

        // Get all buttons on the page
        const buttons = await page.evaluate(() => {
          return Array.from(
            document.querySelectorAll(
              'button, div[role="button"], a[role="button"]',
            ),
          )
            .map((b) => b.innerText.trim())
            .filter((t) => t.length > 0 && t.length < 50);
        });

        const actions = [];

        // Native app confirmation: "Sign in" button
        if (
          currentUrl.includes("/firstparty/nativeapp") ||
          buttons.includes("Sign in")
        ) {
          const signInBtn = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll("button"));
            const b = btns.find((x) => x.innerText.trim() === "Sign in");
            if (b) {
              b.click();
              return true;
            }
            return false;
          });
          if (signInBtn) actions.push("Sign in (native app)");
        }

        // Consent screen: "Continue" or "Allow" or Indonesian
        if (
          currentUrl.includes("/consent") ||
          buttons.some((t) =>
            [
              "Continue",
              "Allow",
              "Izinkan",
              "Lanjutkan",
              "Setujui",
              "Konfirmasi",
            ].includes(t),
          )
        ) {
          const consentClicked = await page.evaluate(() => {
            // Try various consent button selectors
            const btns = Array.from(document.querySelectorAll("button"));
            const continueBtn = btns.find((b) =>
              [
                "Continue",
                "Allow",
                "Izinkan",
                "Lanjutkan",
                "Setujui",
                "Konfirmasi",
              ].includes(b.innerText.trim()),
            );
            if (continueBtn) {
              continueBtn.click();
              return true;
            }
            // Fallback: old Google consent button
            const oldConsent = document.querySelector("#submit_approve_access");
            if (oldConsent) {
              oldConsent.click();
              return true;
            }
            return false;
          });
          if (consentClicked) actions.push("Consent/Continue");
        }

        // Workspace TOS / speedbump: may have "Accept", "Agree", "I understand" or Indonesian
        if (
          currentUrl.includes("/speedbump/") ||
          currentUrl.includes("/terms")
        ) {
          const ssPath = `/tmp/agy-tos-${Date.now()}.png`;
          await page.screenshot({ path: ssPath }).catch(() => {});
          console.log(`[${email}]    TOS page detected, screenshot: ${ssPath}`);

          // Check for checkbox or scroll requirement
          const hasCheckbox = await page.evaluate(() => {
            const cb = document.querySelector(
              'input[type="checkbox"], div[role="checkbox"]',
            );
            if (cb && !cb.checked) {
              cb.click();
              return true;
            }
            return false;
          });
          if (hasCheckbox) {
            console.log(`[${email}]    TOS checkbox clicked`);
            await new Promise((r) => setTimeout(r, 1000));
          }

          // Try to scroll the TOS content if needed
          await page.evaluate(() => {
            const scrollContainer = document.querySelector(
              '.terms-scroll, [role="document"], .tos-scroll, .signed-out, main, article, section, div[jsname], div[jscontroller]',
            );
            if (
              scrollContainer &&
              typeof scrollContainer.scrollHeight === "number"
            ) {
              scrollContainer.scrollTop = scrollContainer.scrollHeight;
            }
            // Always scroll window too
            window.scrollTo(0, document.body.scrollHeight);
          });
          await new Promise((r) => setTimeout(r, 2000));

          const tosClicked = await page.evaluate(() => {
            const btns = Array.from(
              document.querySelectorAll(
                'button, div[role="button"], a[role="button"]',
              ),
            );
            // Prefer enabled/active buttons
            const acceptBtn = btns.find(
              (b) =>
                [
                  "Accept",
                  "Agree",
                  "I understand",
                  "Continue",
                  "Saya Setuju",
                  "Setuju",
                  "Lanjutkan",
                  "Saya mengerti",
                  "Konfirmasi",
                ].includes(b.innerText.trim()) &&
                !b.disabled &&
                b.offsetParent !== null,
            );
            if (acceptBtn) {
              acceptBtn.click();
              return true;
            }
            // Fallback: try any matching button even if disabled
            const fallbackBtn = btns.find((b) =>
              [
                "Accept",
                "Agree",
                "I understand",
                "Continue",
                "Saya Setuju",
                "Setuju",
                "Lanjutkan",
                "Saya mengerti",
                "Konfirmasi",
              ].includes(b.innerText.trim()),
            );
            if (fallbackBtn) {
              fallbackBtn.click();
              return true;
            }
            return false;
          });
          if (tosClicked) actions.push("Accept TOS");
          else console.log(`[${email}]    No TOS accept button found`);
        }

        if (actions.length > 0) {
          console.log(`[${email}]    ${actions.join(", ")}`);
        }

        if (
          actions.length === 0 &&
          currentUrl.includes("accounts.google.com")
        ) {
          // If no action taken and still on Google, check what's on the page
          // Could be security challenge, wrong password, etc.
          const bodyText = await page
            .evaluate(() => document.body.innerText.substring(0, 200))
            .catch(() => "");
          if (
            bodyText.includes("Couldn't sign you in") ||
            bodyText.includes("could not be found")
          ) {
            const ssPath = `/tmp/agy-rejected-${Date.now()}.png`;
            await page.screenshot({ path: ssPath }).catch(() => {});
            console.log(
              `[${email}]    ❌ Google rejected sign-in! Screenshot: ${ssPath}`,
            );
            throw new Error(
              "Google rejected sign-in. Mungkin password salah, CAPTCHA, atau butuh verifikasi.",
            );
          }
        }

        await new Promise((r) => setTimeout(r, 1000));
      }

      // Step 5: Tunggu redirect ke callback (max 120s)
      console.log(
        `[${email}] 4/5 Menunggu redirect ke 9router callback (max 120s)...`,
      );
      const maxWait = 120000; // 120 seconds
      const checkInterval = 2000;
      let waited = 0;
      let lastLogUrl = "";

      while (!code && waited < maxWait) {
        // Check if page changed
        try {
          currentUrl = safePageUrl(page);

          // Log URL changes
          if (currentUrl !== lastLogUrl) {
            const title = await page.title().catch(() => "?");
            console.log(
              `[${email}]    URL: ${currentUrl.substring(0, 100)}... | Title: ${title.substring(0, 60)}`,
            );
            lastLogUrl = currentUrl;
          }

          if (currentUrl.includes("/callback?")) {
            callbackUrl = currentUrl;
            const urlObj = new URL(currentUrl);
            code =
              urlObj.searchParams.get("code") ||
              urlObj.searchParams.get("token");
            state = urlObj.searchParams.get("state");
            console.log(`[${email}]    ✅ Code didapat dari URL page!`);
            break;
          }

          // Also check if we're on the 9router success page
          if (
            currentUrl.includes("/dashboard") ||
            currentUrl.includes("/settings")
          ) {
            console.log(
              `[${email}]    ✅ Sudah di dashboard 9router (sudah login sebelumnya)`,
            );
            code = "SESSION_EXISTS";
            break;
          }

          // Take screenshot every 15s for debugging
          if (waited > 0 && waited % 15000 === 0) {
            const ssPath = `/tmp/9router-agy-${Date.now()}.png`;
            await page
              .screenshot({ path: ssPath, fullPage: false })
              .catch(() => {});
            console.log(`[${email}]    📸 Screenshot: ${ssPath}`);
          }
        } catch (e) {
          // Page might have closed or navigated
        }

        await new Promise((r) => setTimeout(r, checkInterval));
        waited += checkInterval;
      }

      if (!code) {
        throw new Error(
          `Timeout: Tidak dapat redirect ke callback dalam ${maxWait / 1000}s`,
        );
      }

      if (code === "SESSION_EXISTS") {
        console.log(`[${email}] ✅ Akun sudah terhubung (session exists)`);
        return { success: true, existing: true };
      }

      // Step 6: Exchange code for tokens
      console.log(`[${email}] 5/5 Exchange OAuth code...`);

      const result = await exchangeOAuthCode(config, {
        code,
        redirectUri: buildCallbackUrl(config),
        codeVerifier: authData.codeVerifier,
        state: state || authData.state,
      });

      console.log(`[${email}] ✅ Sukses! Akun terdaftar.`);
      return { success: true, result };
    }
  } catch (err) {
    console.error(`[${email}] ❌ Gagal: ${err.message}`);
    throw err;
  } finally {
    // Pastikan browser ditutup
    try {
      const pages = await browser.pages();
      await Promise.all(pages.map((p) => p.close()));
      await browser.close();
      console.log(`[${email}]    Browser ditutup`);
    } catch (e) {
      // Ignore close errors
    }
  }
}

// ============================================================
// REMOTE HELPERS
// ============================================================
function safeParse(s) {
  try {
    return typeof s === "string" ? JSON.parse(s) : s;
  } catch {
    return null;
  }
}

// Real endpoint: GET /api/providers → { connections: [...] }
// Each antigravity item is FLAT (no nested `data` blob): top-level
// { id, provider, authType, name, email, isActive, createdAt, updatedAt,
//   testStatus, backoffLevel, errorCode, projectId, lastUsedAt, ... }
async function listAccountsRemote(config) {
  const data = await apiCall(config, "GET", "/api/providers");
  const arr = Array.isArray(data) ? data : data.connections || data.data || data.items || [];
  return arr.filter((c) => (c.provider || "").toLowerCase() === "antigravity");
}

// ============================================================
// INSPECT
// ============================================================
async function inspect(config) {
  console.log(`\n=== AKUN ANTIGRAVITY TERDAFTAR [${config.mode}@${config.host}] ===\n`);
  const accounts =
    config.mode === "remote" ? await listAccountsRemote(config) : await listAccounts(config);

  if (accounts.length === 0) {
    console.log("Belum ada akun Antigravity terdaftar.");
    return;
  }

  console.log(`Total: ${accounts.length} akun\n`);

  accounts.forEach((a, i) => {
    // Local rows: nested `data` JSON blob → parsedData. Remote items: flat fields.
    const dp = a.parsedData || safeParse(a.data) || a;
    const status = dp.testStatus === "active" || a.isActive ? "✅" : "❌";
    const email = a.email || a.name || "(no email)";
    const created = a.createdAt ? new Date(a.createdAt).toLocaleString("id-ID") : "N/A";
    const lastUsed = dp.lastUsedAt
      ? new Date(dp.lastUsedAt).toLocaleString("id-ID")
      : "N/A";
    const backoff = dp.backoffLevel || 0;
    const errorCode = dp.errorCode || "-";

    console.log(`  ${i + 1}. ${status} ${email}`);
    console.log(`     ID: ${String(a.id).substring(0, 8)}...`);
    console.log(`     Dibuat: ${created}`);
    console.log(`     Terakhir pakai: ${lastUsed}`);
    console.log(`     Backoff: ${backoff} | Error: ${errorCode}`);
    console.log(`     Status: ${a.isActive ? "Aktif" : "Nonaktif"}`);
    if (dp.projectId) console.log(`     Project: ${dp.projectId}`);
    console.log("");
  });
}

// ============================================================
// INTERACTIVE — Masukkan dari file atau manual
// ============================================================
async function batchFromFile(config, filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const accounts = JSON.parse(content);

  if (!Array.isArray(accounts) || accounts.length === 0) {
    console.log("File harus berisi array account [{email, password}, ...]");
    return;
  }

  console.log(`\nMemproses ${accounts.length} akun...\n`);

  let success = 0;
  let failed = 0;

  for (let i = 0; i < accounts.length; i++) {
    const { email, password } = accounts[i];
    console.log(`\n${"=".repeat(50)}`);
    console.log(`[${i + 1}/${accounts.length}] ${email}`);
    console.log(`${"=".repeat(50)}`);

    try {
      await automateGoogleLogin(config, email, password);
      success++;
    } catch (err) {
      console.error(`Gagal: ${err.message}`);
      failed++;
    }

    // Delay antar akun (biar Google gak curiga)
    if (i < accounts.length - 1) {
      const delay = 3000 + Math.random() * 5000;
      console.log(
        `\nMenunggu ${Math.round(delay / 1000)} detik sebelum akun berikutnya...`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`SELESAI: ${success} sukses, ${failed} gagal`);
}

// ============================================================
// CLI
// ============================================================
async function deleteAccountCmd(config, id) {
  if (config.mode === "remote") {
    try {
      await apiCall(config, "DELETE", `/api/providers/${encodeURIComponent(id)}`);
      console.log(`✅ Deleted (remote): ${id}`);
    } catch (e) {
      console.log(`❌ Remote delete failed: ${e.message}`);
      console.log("   If the endpoint differs, check 9router's API (e.g. POST /api/providers/delete with {id}).");
    }
    return;
  }
  const result = await deleteAccount(config, id);
  console.log(`✅ Deleted: ${result.deleted} account(s)`);
}

async function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseCliFlags(argv);
  const command = positional[0];

  if (!command) {
    console.log(`
9router Agy Bot — Universal Edition

Usage:
  node bot.js browser <email> <password> [flags]      # Login 1 akun via OAuth
  node bot.js browser <file.json> [flags]             # Batch dari file
  node bot.js inject --email <e> --access-token <t>   # Inject token (local mode only)
  node bot.js inspect [flags]                         # Lihat akun terdaftar
  node bot.js delete <id> [flags]                     # Hapus akun

Config flags (CLI > env > config.json > default):
  --host / NINEROUTER_HOST          default localhost
  --proto http|https                default http
  --port / NINEROUTER_PORT          default 20128 (https: 443)
  --mode auto|local|remote          default auto
  --password / NINEROUTER_PASSWORD  dashboard password (required in remote)
  --chromium / NINEROUTER_CHROMIUM  default /usr/bin/chromium

Examples:
  # Remote HTTPS VPS:
  node bot.js inspect --host <your-9router-host> --proto https --password '<dashboard-password>'
  # Local (unchanged from before):
  node bot.js inspect
`);
    return;
  }

  // Resolve config once; non-command flags (--email/--access-token for inject) stay in argv.
  const config = await loadConfig(argv);

  switch (command) {
    case "browser": {
      const arg2 = positional[1];
      const arg3 = positional[2];
      if (arg2 && arg3) {
        await automateGoogleLogin(config, arg2, arg3);
      } else if (arg2 && fs.existsSync(arg2)) {
        await batchFromFile(config, arg2);
      } else {
        console.log("Usage: node bot.js browser <email> <password> | <accounts.json>");
      }
      break;
    }
    case "inject": {
      const email = flags.email;
      const accessToken = flags["access-token"];
      const refreshToken = flags["refresh-token"];
      if (!email || (!accessToken && !refreshToken)) {
        console.log("Usage: node bot.js inject --email <email> --access-token <token> [--refresh-token <token>]");
        return;
      }
      if (config.mode === "remote") {
        console.log("inject tidak tersedia di remote mode (tidak ada endpoint API untuk token mentah). Gunakan: node bot.js browser <email> <password>");
        return;
      }
      const result = await injectToken(config, { email, name: email, accessToken, refreshToken, expiresIn: 3599 });
      console.log(`✅ Token injected! ID: ${result.id}, Email: ${result.email}, Project: ${result.projectId}`);
      break;
    }
    case "inspect":
    case "list":
    case "list-accounts":
      await inspect(config);
      break;
    case "delete": {
      const id = positional[1];
      if (!id) {
        console.log("Usage: node bot.js delete <id>");
        return;
      }
      await deleteAccountCmd(config, id);
      break;
    }
    default:
      console.log(`Unknown command: ${command}`);
  }
}

main().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
