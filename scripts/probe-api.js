#!/usr/bin/env node
/**
 * Probe a running 9router to discover the real GET /api/providers shape.
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
  // Real endpoint discovered: GET /api/providers → { connections: [...] }
  const res = await request(config, { method: "GET", path: "/api/providers", headers });
  console.log(`=== GET /api/providers → HTTP ${res.statusCode} ===`);
  const parsed = JSON.parse(res.body);
  const arr = parsed.connections || [];
  console.log(`wrapper: { connections: [...] }, total items: ${arr.length}`);
  const providers = {};
  for (const c of arr) providers[c.provider] = (providers[c.provider] || 0) + 1;
  console.log("providers:", providers);
  const agy = arr.find((c) => (c.provider || "").toLowerCase() === "antigravity");
  console.log("\n=== ONE ANTIGRAVITY ITEM (redacted) ===");
  if (agy) {
    const redacted = JSON.parse(JSON.stringify(agy));
    // redact token-like fields
    if (redacted.accessToken) redacted.accessToken = "<redacted>";
    if (redacted.refreshToken) redacted.refreshToken = "<redacted>";
    if (redacted.apiKey) redacted.apiKey = "<redacted>";
    if (redacted.providerSpecificData && redacted.providerSpecificData.accessToken) redacted.providerSpecificData.accessToken = "<redacted>";
    if (redacted.providerSpecificData && redacted.providerSpecificData.refreshToken) redacted.providerSpecificData.refreshToken = "<redacted>";
    console.log(JSON.stringify(redacted, null, 2).substring(0, 2500));
  } else {
    console.log("(no antigravity item found)");
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
