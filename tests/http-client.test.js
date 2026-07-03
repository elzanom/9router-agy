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
