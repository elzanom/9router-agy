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
    () => loadConfig(["--mode", "remote", "--host", "x", "--proto", "https"], { interactive: false }),
    /password/i
  );
});

test("remote + http + non-localhost throws (cleartext password guard)", async () => {
  await assert.rejects(
    () => loadConfig(["--mode", "remote", "--host", "<your-9router-host>", "--proto", "http", "--password", "p"], { interactive: false }),
    /cleartext/i
  );
});

test("remote + https + non-localhost + password resolves (the intended case)", async () => {
  const cfg = await loadConfig(["--mode", "remote", "--host", "<your-9router-host>", "--proto", "https", "--password", "p"], { interactive: false });
  assert.equal(cfg.mode, "remote");
  assert.equal(cfg.proto, "https");
  assert.equal(cfg.port, 443);
});
