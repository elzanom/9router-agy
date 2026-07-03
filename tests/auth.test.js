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

test("dashboardSession truncates long error bodies in the message", async () => {
  const longBody = "X".repeat(2000);
  const server = http.createServer((req, res) => res.writeHead(500).end(longBody));
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    await assert.rejects(
      () => dashboardSession({ host: "127.0.0.1", port, proto: "http", password: "pw" }),
      (err) => {
        assert.match(err.message, /500/);
        assert.ok(
          err.message.length < longBody.length,
          "error message must be truncated, not the full body",
        );
        return true;
      },
    );
  } finally {
    server.close();
  }
});
