"use strict";

const http = require("http");
const https = require("https");
const path = require("path");
const fs = require("fs");

// Load .env from project root so OPENAI_API_KEY can be set there (env still overrides)
const envPath = path.resolve(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\"/g, '"');
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/\\'/g, "'");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const HOST = process.env.LLM_PROXY_HOST || "127.0.0.1";
const PORT = Number(process.env.LLM_PROXY_PORT || 8091);
const OPENAI_API_KEY = (
  process.env.OPENAI_API_KEY ||
  process.env.LLM_PROXY_OPENAI_API_KEY ||
  process.env.REACT_APP_LLM_API_KEY ||
  ""
).trim();
const OPENAI_BASE = process.env.LLM_PROXY_OPENAI_BASE || "https://api.openai.com";

const MAX_BODY_BYTES = Number(process.env.LLM_PROXY_MAX_BODY_BYTES || 512 * 1024); // 512KB
const REQUEST_TIMEOUT_MS = Number(process.env.LLM_PROXY_TIMEOUT_MS || 120000); // 2 min
const MAX_OUTPUT_TOKENS = Number(process.env.LLM_PROXY_MAX_OUTPUT_TOKENS || 8192);

// Allowed model IDs for server proxy (avoid abuse with expensive models)
const MODEL_WHITELIST = new Set(
  (process.env.LLM_PROXY_MODEL_WHITELIST || "gpt-4o,gpt-4o-mini,gpt-4,gpt-4-turbo,gpt-3.5-turbo,gpt-5.2-codex,o1,o1-mini")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

if (HOST !== "127.0.0.1" && HOST !== "localhost") {
  throw new Error("For safety, LLM_PROXY_HOST must be 127.0.0.1 or localhost.");
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error("Request body too large."));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const DEFAULT_MODEL = "gpt-4o-mini";

function proxyToOpenAI(body, stream, res) {
  const url = new URL("/v1/responses", OPENAI_BASE);
  let bodyObj;
  try {
    const raw =
      typeof body === "string" ? body : Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
    bodyObj = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body." });
    return;
  }

  let model = bodyObj?.model;
  if (!model || typeof model !== "string" || model.trim().length === 0) {
    model = DEFAULT_MODEL;
    bodyObj.model = model;
  }
  if (!MODEL_WHITELIST.has(model)) {
    sendJson(res, 400, {
      error: `Model '${model}' is not allowed. Allowed: ${Array.from(MODEL_WHITELIST).join(", ")}.`
    });
    return;
  }

  let maxOut = bodyObj.max_output_tokens;
  if (typeof maxOut === "number" && maxOut > MAX_OUTPUT_TOKENS) {
    bodyObj.max_output_tokens = MAX_OUTPUT_TOKENS;
  }

  const outBody = JSON.stringify(bodyObj);
  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === "https:" ? 443 : 80),
    path: url.pathname + url.search,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(stream ? { Accept: "text/event-stream" } : {}),
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Length": Buffer.byteLength(outBody)
    }
  };

  const client = url.protocol === "https:" ? https : http;
  const proxyReq = client.request(options, (proxyRes) => {
    if (stream && proxyRes.headers["content-type"]?.includes("text/event-stream")) {
      res.writeHead(proxyRes.statusCode, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive"
      });
      proxyRes.pipe(res, { end: true });
    } else {
      const chunks = [];
      proxyRes.on("data", (c) => chunks.push(c));
      proxyRes.on("end", () => {
        const buf = Buffer.concat(chunks);
        res.writeHead(proxyRes.statusCode, {
          "Content-Type": proxyRes.headers["content-type"] || "application/json",
          "Cache-Control": "no-store"
        });
        res.end(buf);
      });
    }
  });

  proxyReq.on("error", (err) => {
    console.error("[llm-proxy] upstream error:", err.message);
    if (!res.headersSent) {
      sendJson(res, 502, { error: "Upstream request failed.", message: err.message });
    }
  });
  proxyReq.setTimeout(REQUEST_TIMEOUT_MS, () => {
    proxyReq.destroy();
    if (!res.headersSent) {
      sendJson(res, 504, { error: "Upstream timeout." });
    }
  });
  proxyReq.write(outBody);
  proxyReq.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/health" && req.method === "GET") {
    sendJson(res, 200, {
      ok: true,
      hasKey: Boolean(OPENAI_API_KEY),
      models: Array.from(MODEL_WHITELIST)
    });
    return;
  }

  if (url.pathname !== "/api/llm/v1/responses" || req.method !== "POST") {
    sendJson(res, 404, { error: "Not found." });
    return;
  }

  if (!OPENAI_API_KEY) {
    sendJson(res, 503, { error: "LLM proxy is not configured (missing OPENAI_API_KEY)." });
    return;
  }

  let body;
  try {
    body = await readBody(req, MAX_BODY_BYTES);
  } catch (e) {
    sendJson(res, 400, { error: e?.message || "Invalid request body." });
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch (e) {
    sendJson(res, 400, { error: "Invalid JSON body." });
    return;
  }

  const stream = Boolean(parsed.stream);
  proxyToOpenAI(body, stream, res);
});

server.listen(PORT, HOST, () => {
  console.log(`LLM proxy listening on http://${HOST}:${PORT}`);
  console.log(`  POST /api/llm/v1/responses (stream or non-stream)`);
  console.log(`  GET  /health`);
  if (!OPENAI_API_KEY) {
    console.warn("  WARNING: OPENAI_API_KEY (or LLM_PROXY_OPENAI_API_KEY) not set; proxy will return 503.");
  }
});
