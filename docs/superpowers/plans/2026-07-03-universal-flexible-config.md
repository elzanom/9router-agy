# Universal & Flexible Config — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `bot.js` target any 9router deployment (host/proto/port configurable) and run either locally (CLI token + SQLite) or remotely (dashboard-password session + HTTPS API).

**Architecture:** Extract three focused modules — `http-client.js` (proto-aware request, the core HTTPS fix), `config.js` (priority-chain loader: CLI flags > env > config.json > defaults, with mode auto-resolution), `auth.js` (`cliToken` for local, `dashboardSession` for remote). Refactor `bot.js` to thread a resolved `config` object through every function and branch commands by `config.mode`.

**Tech Stack:** Node.js (CommonJS), built-in `http`/`https`/`crypto`, `node:test` (zero-dependency testing), existing `puppeteer-core`/`sqlite3`.

**Spec:** `docs/superpowers/specs/2026-07-03-universal-flexible-config-design.md`

## Global Constraints

- **CommonJS** (`"type": "commonjs"` in package.json) — use `require`/`module.exports`, no ESM import syntax.
- **Testing:** built-in `node:test` + `node:assert`. No new dependencies. Test files live in `tests/`, named `*.test.js`.
- **Backward compatibility is mandatory:** running `node bot.js browser <email> <password>` or `node bot.js inspect` with **no flags** on the 9router machine must behave exactly as before (mode auto-resolves to `local`, cliToken auth, `localhost:20128:http`, SQLite paths from `~/.9router/`).
- **Proto-aware port default:** if `proto` is `https` and no `--port`/env given, default port = `443`; else `20128`.
- **TLS verification stays ON.** Do NOT add a "disable TLS verification" flag (`rejectUnauthorized:false`). If a self-signed cert is ever needed, the proper fix is Node's `NODE_EXTRA_CA_CERTS=/path/to/rootCA.pem` env var (trusts one specific CA) — never blanket-disable verification.
- **`inject` is remote-blocked:** in remote mode it must print a clear message pointing to `browser`, never silently fail or fake a DB write.
- **Git:** the project is NOT currently a git repo. The first task initializes it so commit steps work. If the user declines `git init`, treat each "Commit" step as a manual checkpoint and skip the `git` commands.
- **No placeholders:** every code step contains complete, runnable code.

---

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `http-client.js` | NEW | `request(config, opts)` — picks `http`/`https` from `config.proto`, sets Cookie/Content-Length, returns `{statusCode, headers, body}`. No auth logic. |
| `config.js` | NEW | `loadConfig(argv)` — merges CLI flags > env > config.json > defaults; resolves `mode`; validates required fields; interactive prompt when TTY. Also exports `parseCliFlags` (returns `{flags, positional}`). |
| `auth.js` | NEW | `cliToken(config)`, `dashboardSession(config)`, `resolveAuthHeaders(config)`, plus `parseSetCookie`/`sessionHeaders` helpers. |
| `bot.js` | MODIFY | Remove global `CONFIG` + `getCliToken`; `main()` calls `loadConfig()` once; every function takes `config`; `apiCall` delegates to `http-client` + `resolveAuthHeaders`; commands branch on `config.mode`. |
| `config.example.json` | NEW | Documented template. |
| `tests/http-client.test.js` | NEW | Unit tests for proto selection + real http round-trip. |
| `tests/config.test.js` | NEW | Unit tests for priority chain, defaults, mode resolution, validation. |
| `tests/auth.test.js` | NEW | Unit tests for cliToken (deterministic crypto) + parseSetCookie. |
| `scripts/probe-api.js` | NEW (temp, kept) | Discovers real `/api/provider-connections` GET shape against a running 9router. |

---

### Task 1: Proto-aware HTTP client + test infrastructure

**Files:**
- Create: `http-client.js`
- Create: `tests/http-client.test.js`
- Modify: `package.json` (add `test` script)

**Interfaces:**
- Produces: `request(config, { method, path, body, cookies, headers })` → `Promise<{ statusCode, headers, body }>`. `config` shape requires `{ host, port, proto }`. `body` may be object (JSON-stringified) or string. `cookies` may be `{k:v}` or raw string.

- [ ] **Step 1: Initialize git + add test script**

```bash
git init && printf 'node_modules/\n*.zip\nbatch-accounts.json\nconfig.json\n' > .gitignore
```

Edit `package.json` `"scripts"` to:
```json
"scripts": {
  "test": "node --test"
}
```

- [ ] **Step 2: Write the failing test**

`tests/http-client.test.js`:
```js
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const { request } = require("../http-client");

test("request sends method/path and parses JSON response over http", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", "X-Echo": req.method + " " + req.url });
    res.end(JSON.stringify({ ok: true, auth: req.headers["x-test"] || null }));
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    const res = await request(
      { host: "127.0.0.1", port, proto: "http" },
      { method: "POST", path: "/foo", body: { a: 1 }, headers: { "x-test": "abc" } }
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["x-echo"], "POST /foo");
    assert.deepEqual(JSON.parse(res.body), { ok: true, auth: "abc" });
  } finally {
    server.close();
  }
});

test("request sends cookies from object", async () => {
  const server = http.createServer((req, res) => res.end(req.headers["cookie"] || ""));
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    const res = await request(
      { host: "127.0.0.1", port, proto: "http" },
      { method: "GET", path: "/", cookies: { session: "xyz", other: "1" } }
    );
    assert.match(res.body, /session=xyz/);
    assert.match(res.body, /other=1/);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/http-client.test.js`
Expected: FAIL — `Cannot find module '../http-client'`.

- [ ] **Step 4: Implement http-client.js**

`http-client.js`:
```js
const http = require("http");
const https = require("https");

function toCookieString(cookies) {
  if (!cookies) return "";
  if (typeof cookies === "string") return cookies;
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function request(config, { method = "GET", path: reqPath, body = null, cookies = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const lib = config.proto === "https" ? https : http;
    const opts = {
      hostname: config.host,
      port: config.port,
      path: reqPath,
      method,
      headers: { ...headers },
    };
    let payload = null;
    if (body !== null && body !== undefined) {
      payload = typeof body === "string" ? body : JSON.stringify(body);
      opts.headers["Content-Type"] = opts.headers["Content-Type"] || "application/json";
      opts.headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const cookieStr = toCookieString(cookies);
    if (cookieStr) opts.headers["Cookie"] = cookieStr;
    const req = lib.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () =>
        resolve({ statusCode: res.statusCode, headers: res.headers, body: data })
      );
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { request };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/http-client.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add http-client.js tests/http-client.test.js package.json .gitignore
git commit -m "feat: add proto-aware http-client with tests"
```

---

### Task 2: Config loader (priority chain + mode resolution + validation)

**Files:**
- Create: `config.js`
- Create: `tests/config.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks (standalone).
- Produces: `loadConfig(argv, opts)` → `Promise<config>`; `parseCliFlags(argv)` → `{ flags, positional }`; also exports `resolveMode`, `isLocalHost`, `DEFAULTS`. Resolved `config` always has a final `mode` of `"local"` or `"remote"` (never `"auto"`).

- [ ] **Step 1: Write the failing test**

`tests/config.test.js`:
```js
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { loadConfig, parseCliFlags, resolveMode, isLocalHost, DEFAULTS } = require("../config");

test("parseCliFlags splits flags and positionals", () => {
  const { flags, positional } = parseCliFlags(["browser", "--host", "h", "email", "--port=9", "pass"]);
  assert.equal(flags.host, "h");
  assert.equal(flags.port, "9");
  assert.deepEqual(positional, ["browser", "email", "pass"]);
});

test("flag beats env beats file beats default", async () => {
  process.env.NINEROUTER_HOST = "fromenv";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
  const cfgPath = path.join(tmp, "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ host: "fromfile", proto: "https" }));
  const cwd = process.cwd();
  try {
    process.chdir(tmp);
    // flag wins over env
    let cfg = await loadConfig(["--host", "fromflag", "--mode", "local"], { interactive: false });
    assert.equal(cfg.host, "fromflag");
    assert.equal(cfg.proto, "https"); // from file
    // env wins over file when no flag
    cfg = await loadConfig(["--mode", "local"], { interactive: false });
    assert.equal(cfg.host, "fromenv");
  } finally {
    process.chdir(cwd);
    delete process.env.NINEROUTER_HOST;
  }
});

test("https without explicit port defaults to 443", async () => {
  const cfg = await loadConfig(["--proto", "https", "--host", "x", "--mode", "remote", "--password", "p"], { interactive: false });
  assert.equal(cfg.port, 443);
});

test("isLocalHost + resolveMode", () => {
  assert.ok(isLocalHost("127.0.0.1"));
  assert.ok(!isLocalHost("example.com"));
  // auto + localhost + machineIdPath that does not exist -> remote
  assert.equal(resolveMode("auto", { host: "localhost", machineIdPath: "/no/such/file" }), "remote");
  assert.equal(resolveMode("remote", { host: "localhost", machineIdPath: "/no/such/file" }), "remote");
});

test("remote without password throws in non-interactive", async () => {
  await assert.rejects(
    () => loadConfig(["--mode", "remote", "--host", "x"], { interactive: false }),
    /password/i
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/config.test.js`
Expected: FAIL — `Cannot find module '../config'`.

- [ ] **Step 3: Implement config.js**

`config.js`:
```js
const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");

const DEFAULTS = {
  host: "localhost",
  proto: "http",
  port: 20128,
  mode: "auto",
  chromiumPath: "/usr/bin/chromium",
  callbackPath: "/callback",
};

const CONFIG_FILE_CANDIDATES = [
  path.join(process.cwd(), "config.json"),
  path.join(os.homedir(), ".9router-agy", "config.json"),
];

function parseCliFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function readConfigFile() {
  for (const p of CONFIG_FILE_CANDIDATES) {
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, "utf8"));
      } catch (e) {
        throw new Error(`Config file ${p} is invalid JSON: ${e.message}`);
      }
    }
  }
  return {};
}

function isLocalHost(host) {
  return ["localhost", "127.0.0.1", "::1"].includes(String(host).toLowerCase());
}

function resolveMode(mode, cfg) {
  if (mode === "local" || mode === "remote") return mode;
  return fs.existsSync(cfg.machineIdPath) && isLocalHost(cfg.host) ? "local" : "remote";
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

async function loadConfig(argv = process.argv.slice(2), { interactive = process.stdout.isTTY } = {}) {
  const { flags } = parseCliFlags(argv);
  const file = readConfigFile();

  const pick = (flagKey, envKey) => {
    if (flags[flagKey] !== undefined && flags[flagKey] !== true) return String(flags[flagKey]);
    if (process.env[envKey] !== undefined) return process.env[envKey];
    if (file[flagKey] !== undefined) return String(file[flagKey]);
    return undefined;
  };

  const home = os.homedir();
  const proto = pick("proto", "NINEROUTER_PROTO") || DEFAULTS.proto;
  const userPort = pick("port", "NINEROUTER_PORT");
  const port = userPort ? Number(userPort) : proto === "https" ? 443 : DEFAULTS.port;

  const cfg = {
    host: pick("host", "NINEROUTER_HOST") || DEFAULTS.host,
    proto,
    port,
    mode: pick("mode", "NINEROUTER_MODE") || DEFAULTS.mode,
    chromiumPath: pick("chromium", "NINEROUTER_CHROMIUM") || DEFAULTS.chromiumPath,
    callbackPath: pick("callback-path", "NINEROUTER_CALLBACK_PATH") || DEFAULTS.callbackPath,
    dbPath: pick("db-path", "NINEROUTER_DB_PATH") || path.join(home, ".9router", "db", "data.sqlite"),
    machineIdPath: pick("machine-id-path", "NINEROUTER_MACHINE_ID_PATH") || path.join(home, ".9router", "machine-id"),
    cliSecretPath: pick("cli-secret-path", "NINEROUTER_CLI_SECRET_PATH") || path.join(home, ".9router", "auth", "cli-secret"),
    password: pick("password", "NINEROUTER_PASSWORD"),
  };

  cfg.mode = resolveMode(cfg.mode, cfg);

  const missing = [];
  if (cfg.mode === "remote" && !cfg.password) {
    missing.push({ key: "password", msg: "Dashboard password (required in remote mode)" });
  }
  if (missing.length) {
    if (interactive) {
      for (const m of missing) cfg[m.key] = await prompt(`${m.msg}: `);
    } else {
      throw new Error(
        `Missing required config: ${missing.map((m) => m.msg).join("; ")}. Provide via flag (e.g. --${missing[0].key}) or env var.`
      );
    }
  }
  return cfg;
}

module.exports = { loadConfig, parseCliFlags, resolveMode, isLocalHost, DEFAULTS, readConfigFile };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/config.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add config.js tests/config.test.js
git commit -m "feat: add config loader with priority chain and mode resolution"
```

---

### Task 3: Auth abstraction (cliToken + dashboardSession)

**Files:**
- Create: `auth.js`
- Create: `tests/auth.test.js`

**Interfaces:**
- Consumes: `request` from `./http-client`; `config` shape from `config.js`.
- Produces: `cliToken(config)` → string; `cliTokenHeaders(config)` → `{ "x-9r-cli-token": ... }`; `dashboardSession(config)` → `Promise<{ session: "..." }>`; `resolveAuthHeaders(config)` → `Promise<headersObj>`; `parseSetCookie(setCookie)` → `{name: value}`.

- [ ] **Step 1: Write the failing test**

`tests/auth.test.js`:
```js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { cliToken, parseSetCookie, dashboardSession, resolveAuthHeaders } = require("../auth");

test("cliToken is deterministic SHA256[:16] of machineId+9r-cli-auth+cliSecret", () => {
  const crypto = require("crypto");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth-"));
  const mid = path.join(tmp, "mid");
  const sec = path.join(tmp, "sec");
  fs.writeFileSync(mid, "MACHINE123");
  fs.writeFileSync(sec, "SECRET456");
  const expected = crypto.createHash("sha256").update("MACHINE123" + "9r-cli-auth" + "SECRET456").digest("hex").substring(0, 16);
  const cfg = { mode: "local", machineIdPath: mid, cliSecretPath: sec };
  assert.equal(cliToken(cfg), expected);
});

test("parseSetCookie handles string and array forms", () => {
  assert.deepEqual(parseSetCookie("session=abc; Path=/; HttpOnly"), { session: "abc" });
  assert.deepEqual(parseSetCookie(["session=abc; HttpOnly", "other=1; Path=/"]), { session: "abc", other: "1" });
  assert.deepEqual(parseSetCookie(undefined), {});
});

test("dashboardSession extracts session cookie from Set-Cookie", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Set-Cookie": ["session=cook123; Path=/", "csrf=x; Path=/"] });
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    const cookies = await dashboardSession({ host: "127.0.0.1", port, proto: "http", password: "pw" });
    assert.equal(cookies.session, "cook123");
  } finally {
    server.close();
  }
});

test("dashboardSession throws on HTTP error", async () => {
  const server = http.createServer((req, res) => res.writeHead(401).end("bad password"));
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    await assert.rejects(
      () => dashboardSession({ host: "127.0.0.1", port, proto: "http", password: "pw" }),
      /401/
    );
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/auth.test.js`
Expected: FAIL — `Cannot find module '../auth'`.

- [ ] **Step 3: Implement auth.js**

`auth.js`:
```js
const crypto = require("crypto");
const fs = require("fs");
const { request } = require("./http-client");

function cliToken(config) {
  const machineId = fs.readFileSync(config.machineIdPath, "utf8").trim();
  const cliSecret = fs.readFileSync(config.cliSecretPath, "utf8").trim();
  return crypto
    .createHash("sha256")
    .update(machineId + "9r-cli-auth" + cliSecret)
    .digest("hex")
    .substring(0, 16);
}

function cliTokenHeaders(config) {
  return { "x-9r-cli-token": cliToken(config) };
}

function parseSetCookie(setCookie) {
  const cookies = {};
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const entry of list) {
    const pair = entry.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq !== -1) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return cookies;
}

function sessionHeaders(cookies) {
  const cookieStr = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  return cookieStr ? { Cookie: cookieStr } : {};
}

async function dashboardSession(config) {
  const res = await request(config, {
    method: "POST",
    path: "/api/auth/login",
    body: { password: config.password },
    headers: { "Content-Type": "application/json" },
  });
  if (res.statusCode >= 400) {
    throw new Error(`Dashboard login failed (HTTP ${res.statusCode}): ${res.body}`);
  }
  const cookies = parseSetCookie(res.headers["set-cookie"]);
  if (!cookies.session) {
    throw new Error("Dashboard login succeeded but no session cookie was returned");
  }
  return cookies;
}

async function resolveAuthHeaders(config) {
  if (config.mode === "local") return cliTokenHeaders(config);
  if (config.mode === "remote") return sessionHeaders(await dashboardSession(config));
  throw new Error(`Unknown auth mode: ${config.mode}`);
}

module.exports = {
  cliToken,
  cliTokenHeaders,
  parseSetCookie,
  sessionHeaders,
  dashboardSession,
  resolveAuthHeaders,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/auth.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full suite**

Run: `node --test`
Expected: PASS (all tests across files).

- [ ] **Step 6: Commit**

```bash
git add auth.js tests/auth.test.js
git commit -m "feat: add auth strategies (cliToken, dashboardSession)"
```

---

### Task 4: Refactor bot.js to thread `config` and use the new modules

**Goal of this task:** every existing function accepts `config`; `apiCall` delegates to `http-client` + `resolveAuthHeaders`; `main()` calls `loadConfig()` once. Behavior with no flags is unchanged (local mode, cliToken, SQLite). Remote-mode command branches are added in Task 5.

**Files:**
- Modify: `bot.js` (large refactor — sections: imports, remove CONFIG/getCliToken, apiCall, API helpers, DB helpers, browser, inspect, main)

**Interfaces:**
- Consumes: `loadConfig`/`parseCliFlags` from `./config`; `resolveAuthHeaders` from `./auth`; `request` from `./http-client`.
- Produces: all `bot.js` functions take `config` as first arg; `main()` resolves config once and dispatches.

- [ ] **Step 1: Replace imports + remove global CONFIG/getCliToken**

Top of `bot.js` — replace lines 21–64 (the require block, CONFIG object, and `getCliToken`) with:

```js
const puppeteer = require("puppeteer-core");
const { addExtra } = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const puppeteerExtra = addExtra(puppeteer);
puppeteerExtra.use(StealthPlugin());
const crypto = require("crypto");
const sqlite3 = require("sqlite3");
const path = require("path");
const fs = require("fs");

const { loadConfig, parseCliFlags } = require("./config");
const { resolveAuthHeaders } = require("./auth");
const { request } = require("./http-client");
```

- [ ] **Step 2: Rewrite apiCall + 9router API helpers**

Replace the old `apiCall`, `getAuthorizeUrl`, `exchangeOAuthCode` block (was lines 69–129) with:

```js
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

function callbackUrl(config) {
  return `${config.proto === "https" ? "https" : "http"}://${config.host}${config.port === 443 && config.proto === "https" ? "" : ":" + config.port}${config.callbackPath}`;
}

async function getAuthorizeUrl(config) {
  return apiCall(
    config,
    "GET",
    `/api/oauth/antigravity/authorize?redirect_uri=${encodeURIComponent(callbackUrl(config))}`,
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
```

- [ ] **Step 3: Thread config through DB helpers**

Replace `openDb`/`listAccounts`/`injectToken`/`deleteAccount` (was lines 134–232) so each opens DB at `config.dbPath`:

```js
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
  const projectId = `agy-${email.split("@")[0].replace(/[^a-z0-9]/gi, "-").toLowerCase()}`;
  const expiresInSec = expiresIn || 3599;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresInSec * 1000);
  const data = {
    accessToken, refreshToken,
    expiresAt: expiresAt.toISOString(),
    scope: "https://www.googleapis.com/auth/experimentsandconfigs https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/userinfo.profile openid https://www.googleapis.com/auth/cloud-platform",
    projectId, testStatus: "active", expiresIn: expiresInSec,
    lastUsedAt: now.toISOString(), lastRefreshAt: now.toISOString(),
    consecutiveUseCount: 0, backoffLevel: 0,
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
```

- [ ] **Step 4: Thread config through browser automation**

In `automateGoogleLogin`, change signature to `async function automateGoogleLogin(config, email, password)`. Replace the three internal call sites:
- `const authData = await getAuthorizeUrl();` → `const authData = await getAuthorizeUrl(config);`
- `headless: false` launch arg — change `executablePath: CONFIG.chromiumPath` → `executablePath: config.chromiumPath`.
- `const result = await exchangeOAuthCode("antigravity", { ... redirectUri: \`http://${CONFIG.host}:${CONFIG.port}${CONFIG.callbackPath}\`, ... });` → `const result = await exchangeOAuthCode(config, { code, redirectUri: callbackUrl(config), codeVerifier: authData.codeVerifier, state: state || authData.state });`

(Use Edit to make these targeted replacements — do not rewrite the whole function.)

- [ ] **Step 5: Thread config through inspect**

Change `async function inspect()` → `async function inspect(config)` and `const accounts = await listAccounts();` → `const accounts = await listAccounts(config);`. (Remote-mode rendering is handled in Task 5; for now this preserves local behavior.)

- [ ] **Step 6: Rewrite main() to resolve config once and dispatch**

Replace the entire `main()` function (was lines 783–871) with:

```js
async function main() {
  const argv = process.argv.slice(2);
  const { positional } = parseCliFlags(argv);
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
      const email = positional[positional.indexOf("--email") + 1] ?? argv[argv.indexOf("--email") + 1];
      const accessToken = argv[argv.indexOf("--access-token") + 1];
      const refreshToken = argv[argv.indexOf("--refresh-token") + 1];
      if (!email || (!accessToken && !refreshToken)) {
        console.log("Usage: node bot.js inject --email <email> --access-token <token> [--refresh-token <token>]");
        return;
      }
      // Remote block lives in Task 5; local path:
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
```

Also change `batchFromFile(filePath)` → `batchFromFile(config, filePath)` and update its internal `await automateGoogleLogin(email, password)` → `await automateGoogleLogin(config, email, password)`.

Add `deleteAccountCmd` (mode-aware, implemented fully in Task 5; for now local-only stub that calls SQLite):

```js
async function deleteAccountCmd(config, id) {
  if (config.mode === "remote") {
    console.log("delete remote: implemented in Task 5");
    return;
  }
  const result = await deleteAccount(config, id);
  console.log(`✅ Deleted: ${result.deleted} account(s)`);
}
```

- [ ] **Step 7: Verify local behavior is unchanged**

Run: `node bot.js` (no args)
Expected: prints the new help text.

Run: `node bot.js inspect`
Expected: same output as before the refactor (lists antigravity accounts from local SQLite). If the local 9router DB has accounts, they should appear identically.

Run: `node --test`
Expected: all unit tests still PASS (bot.js itself is not unit-tested, but the modules it depends on are).

- [ ] **Step 8: Commit**

```bash
git add bot.js
git commit -m "refactor: thread resolved config through bot.js; configurable host/proto/auth"
```

---

### Task 5: Remote mode — probe endpoints, then implement inspect/delete (inject stays blocked)

**Files:**
- Create: `scripts/probe-api.js`
- Modify: `bot.js` (implement remote branches in `inspect` and `deleteAccountCmd`)

**Interfaces:**
- Consumes: `apiCall(config, ...)`, `config.mode`.
- Produces: `inspect` works in both modes; `deleteAccountCmd` works in both modes; `inject` remote prints the blocked message (already added in Task 4, verified here).

- [ ] **Step 1: Write the probe script**

`scripts/probe-api.js`:
```js
#!/usr/bin/env node
/**
 * Probe a running 9router to discover the real GET /api/provider-connections shape.
 * Uses CLI-token auth (local) by default. Run on the 9router machine:
 *   node scripts/probe-api.js
 * Or against remote with dashboard auth:
 *   node scripts/probe-api.js --host h --proto https --password p
 */
const { loadConfig } = require("../config");
const { request } = require("../http-client");
const { resolveAuthHeaders } = require("../auth");

(async () => {
  const config = await loadConfig();
  const headers = await resolveAuthHeaders(config);
  for (const p of ["/api/provider-connections", "/api/provider-connections/antigravity"]) {
    const res = await request(config, { method: "GET", path: p, headers });
    console.log(`\n=== GET ${p} → HTTP ${res.statusCode} ===`);
    console.log(res.body.substring(0, 1500));
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
```

- [ ] **Step 2: Run the probe against the local 9router**

Run: `node scripts/probe-api.js`
Expected: prints the real JSON of `/api/provider-connections`. **Record the field names** (e.g. does each item have `id`, `email`, `isActive`, `data`/`config`, `provider`?). This determines how `inspect` renders remote rows.

- [ ] **Step 3: Implement remote inspect**

In `bot.js`, replace `inspect(config)` with a version that branches on `config.mode`. Use the field names confirmed by the probe; if the API field names differ from the SQLite columns, map them. General shape:

```js
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
    // Normalize: both local (parsedData) and remote shapes expose email/name/data/isActive
    const dp = a.parsedData || safeParse(a.data) || {};
    const status = dp.testStatus === "active" || a.isActive ? "✅" : "❌";
    const email = a.email || a.name || "(no email)";
    console.log(`  ${i + 1}. ${status} ${email}`);
    console.log(`     ID: ${String(a.id).substring(0, 8)}...`);
    console.log(`     Status: ${a.isActive ? "Aktif" : "Nonaktif"}`);
    if (dp.projectId) console.log(`     Project: ${dp.projectId}`);
    console.log("");
  });
}

function safeParse(s) {
  try {
    return typeof s === "string" ? JSON.parse(s) : s;
  } catch {
    return null;
  }
}

async function listAccountsRemote(config) {
  const data = await apiCall(config, "GET", "/api/provider-connections");
  // API may return an array or { data: [...] } or { connections: [...] }
  const arr = Array.isArray(data) ? data : data.data || data.connections || data.items || [];
  return arr.filter((c) => (c.provider || "").toLowerCase() === "antigravity");
}
```

Adjust the `arr` extraction line if the probe in Step 2 shows a different wrapper key. If the probe reveals the antigravity items are NOT filterable by `provider` (e.g., the endpoint returns all providers), keep the filter; if the endpoint already scopes to antigravity, the filter is a harmless no-op.

- [ ] **Step 4: Implement remote delete**

Replace the Task-4 stub `deleteAccountCmd` with the full mode-aware version:

```js
async function deleteAccountCmd(config, id) {
  if (config.mode === "remote") {
    try {
      await apiCall(config, "DELETE", `/api/provider-connections/${encodeURIComponent(id)}`);
      console.log(`✅ Deleted (remote): ${id}`);
    } catch (e) {
      console.log(`❌ Remote delete failed: ${e.message}`);
      console.log("   If the endpoint differs, check 9router's API (e.g. POST /api/provider-connections/delete with {id}).");
    }
    return;
  }
  const result = await deleteAccount(config, id);
  console.log(`✅ Deleted: ${result.deleted} account(s)`);
}
```

- [ ] **Step 5: Verify inject remote is blocked**

Run: `node bot.js inject --email x@y.z --access-token t --host <your-9router-host> --proto https --password <dashboard-password>`
Expected: prints the "inject tidak tersedia di remote mode … Gunakan: node bot.js browser" message and exits without writing anything.

- [ ] **Step 6: Verify local inspect still works**

Run: `node bot.js inspect`
Expected: same list as before, now with `[local@localhost]` header.

- [ ] **Step 7: Commit**

```bash
git add scripts/probe-api.js bot.js
git commit -m "feat: remote mode inspect/delete via API; inject remote-blocked"
```

---

### Task 6: Polish — config.example.json, README, end-to-end verification

**Files:**
- Create: `config.example.json`
- Modify: `README.md` (add a "Remote VPS usage" section)

- [ ] **Step 1: Create config.example.json**

`config.example.json`:
```json
{
  "host": "<your-9router-host>",
  "proto": "https",
  "port": 443,
  "mode": "remote",
  "password": "REPLACE_WITH_DASHBOARD_PASSWORD",
  "chromiumPath": "/usr/bin/chromium"
}
```

- [ ] **Step 2: Add a Remote VPS section to README.md**

Append after the existing setup sections:

```markdown
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
```

- [ ] **Step 3: E2E — local mode unchanged**

Run: `node bot.js inspect`
Expected: works exactly as the pre-refactor tool (local SQLite, cliToken).

Run: `node bot.js`
Expected: prints help listing all config flags.

- [ ] **Step 4: E2E — remote mode against the VPS**

Run: `node bot.js inspect --host <your-9router-host> --proto https --password '<dashboard-password>'`
Expected: connects over HTTPS, logs in with the dashboard password, lists antigravity accounts from the VPS. If the VPS isn't reachable from this machine, note that and verify once reachable.

If the login or list fails, read the error, and either fix it (e.g. wrong port → add `--port`; self-signed cert → re-run with `NODE_EXTRA_CA_CERTS=/path/to/rootCA.pem node bot.js ...`) or record the real endpoint shape and adjust `listAccountsRemote` accordingly.

- [ ] **Step 5: Run full test suite one more time**

Run: `node --test`
Expected: PASS (all unit tests).

- [ ] **Step 6: Commit**

```bash
git add config.example.json README.md
git commit -m "docs: config.example.json + remote VPS usage; e2e verified"
```

---

## Self-Review Notes

- **Spec coverage:** §1 config table → Task 2; §2 auth → Task 3; §3 mode → Task 2 (resolveMode) + Task 4 (threading); §4 command/mode matrix → Task 4 (inject block + local) + Task 5 (remote inspect/delete); §5 file structure → all tasks; §6 verification assumptions → Task 5 Step 2 (probe) + Task 6 Step 4 (e2e). Backward compat → Task 4 Step 7 + Task 6 Step 3. Proto/port → Task 1 + Task 2 (TLS verification stays on; no insecure flag). No spec gap.
- **Type/signature consistency:** `request(config, {method, path, body, cookies, headers})` used identically in Task 1, Task 3 (`dashboardSession`), Task 5 (probe). `resolveAuthHeaders(config)` used in Task 3, Task 4 (`apiCall`), Task 5 (probe). `apiCall(config, method, path, body)` used in Task 4 + Task 5. `loadConfig(argv, {interactive})` used in Task 4 + Task 5. `parseCliFlags(argv)` → `{flags, positional}` in Task 2 + Task 4. No `insecure`/`rejectUnauthorized` anywhere (TLS stays verified).
