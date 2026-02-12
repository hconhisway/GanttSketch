"use strict";

const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const HOST = process.env.EXPORT_SERVER_HOST || "127.0.0.1";
const PORT = Number(process.env.EXPORT_SERVER_PORT || 8090);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const OUTPUT_FILE = path.resolve(PROJECT_ROOT, "gantt_anywidget.py");
const ANYWIDGET_SCRIPT = path.resolve(PROJECT_ROOT, "scripts", "build_anywidget_singlefile.py");
const BUILD_TIMEOUT_MS = Number(process.env.EXPORT_SERVER_TIMEOUT_MS || 20 * 60 * 1000);
const MAX_LOG_CHARS = 12000;
const API_KEY = (process.env.EXPORT_SERVER_API_KEY || "").trim();
const EXTRA_ORIGINS = (process.env.EXPORT_SERVER_ALLOWED_ORIGINS || "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

const allowedOrigins = new Set([
  "http://127.0.0.1:3000",
  "http://localhost:3000",
  ...EXTRA_ORIGINS
]);

if (HOST !== "127.0.0.1" && HOST !== "localhost") {
  throw new Error("For safety, EXPORT_SERVER_HOST must be 127.0.0.1 or localhost.");
}

let isJobRunning = false;

function buildSafeSpawnEnv() {
  const sourceEntries = Object.entries(process.env);
  const result = {};
  const seenKeys = new Set();

  for (const [rawKey, rawValue] of sourceEntries) {
    if (typeof rawKey !== "string" || rawKey.length === 0) continue;
    if (typeof rawValue !== "string") continue;
    if (rawKey.includes("\u0000") || rawValue.includes("\u0000")) continue;

    // Windows environment variable keys are case-insensitive.
    const normalizedKey = process.platform === "win32" ? rawKey.toLowerCase() : rawKey;
    if (seenKeys.has(normalizedKey)) continue;

    seenKeys.add(normalizedKey);
    result[rawKey] = rawValue;
  }

  return result;
}

function trimLog(text) {
  if (!text) return "";
  if (text.length <= MAX_LOG_CHARS) return text;
  return text.slice(text.length - MAX_LOG_CHARS);
}

function isOriginAllowed(origin) {
  if (!origin) return true;
  return allowedOrigins.has(origin);
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  if (!isOriginAllowed(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Export-Api-Key");
}

function readSmallBody(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve());
    req.on("error", reject);
  });
}

function quoteForCmdArg(arg) {
  const value = String(arg ?? "");
  if (!/[\s"]/g.test(value)) return value;
  // cmd.exe escaping rule for quoted arguments: " => ""
  const escaped = value.replace(/"/g, '""');
  return `"${escaped}"`;
}

function runCommand(stage, command, args) {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === "win32";
    const cmd = isWindows ? "cmd.exe" : command;
    const cmdArgs = isWindows
      ? ["/d", "/s", "/c", `${command}${args.length ? ` ${args.map(quoteForCmdArg).join(" ")}` : ""}`]
      : args;

    let child;
    try {
      child = spawn(cmd, cmdArgs, {
        cwd: PROJECT_ROOT,
        env: buildSafeSpawnEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      reject({
        stage,
        message: `Failed to start command: ${command}`,
        error: error?.message || String(error),
        stdout: "",
        stderr: ""
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, BUILD_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject({
        stage,
        message: `Failed to run command: ${command}`,
        error: error?.message || String(error),
        stdout: trimLog(stdout),
        stderr: trimLog(stderr)
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject({
          stage,
          message: `Command timed out after ${BUILD_TIMEOUT_MS}ms.`,
          stdout: trimLog(stdout),
          stderr: trimLog(stderr)
        });
        return;
      }
      if (code !== 0) {
        reject({
          stage,
          message: `Command exited with code ${code}.`,
          stdout: trimLog(stdout),
          stderr: trimLog(stderr)
        });
        return;
      }
      resolve({
        stdout: trimLog(stdout),
        stderr: trimLog(stderr)
      });
    });
  });
}

async function runPythonAnywidgetScript() {
  const scriptRelative = path.relative(PROJECT_ROOT, ANYWIDGET_SCRIPT);
  const candidates =
    process.platform === "win32"
      ? [
          ["python", [scriptRelative]],
          ["py", ["-3", scriptRelative]]
        ]
      : [
          ["python3", [scriptRelative]],
          ["python", [scriptRelative]]
        ];

  let lastError = null;
  for (const [cmd, args] of candidates) {
    try {
      return await runCommand("python_anywidget", cmd, args);
    } catch (error) {
      const message = String(error?.error || "");
      const isMissingBinary = message.includes("ENOENT");
      lastError = error;
      if (isMissingBinary) {
        continue;
      }
      throw error;
    }
  }
  throw lastError || {
    stage: "python_anywidget",
    message: "No available Python runtime found (tried python/python3/py)."
  };
}

async function runPipeline() {
  const npmCommand = "npm";
  await runCommand("npm_build", npmCommand, ["run", "build"]);
  await runPythonAnywidgetScript();
  const output = await fs.readFile(OUTPUT_FILE);
  return output;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  setCorsHeaders(req, res);
  const origin = req.headers.origin;

  if (req.method === "OPTIONS") {
    if (origin && !isOriginAllowed(origin)) {
      sendJson(res, 403, { message: "Origin not allowed." });
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }

  const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (requestUrl.pathname === "/health" && req.method === "GET") {
    sendJson(res, 200, { ok: true, running: isJobRunning });
    return;
  }

  if (requestUrl.pathname !== "/api/export-anywidget" || req.method !== "POST") {
    sendJson(res, 404, { message: "Not found." });
    return;
  }

  console.log(`[export] request from origin=${origin || "none"}`);

  if (origin && !isOriginAllowed(origin)) {
    sendJson(res, 403, { message: "Origin not allowed." });
    return;
  }

  if (API_KEY) {
    const requestKey = String(req.headers["x-export-api-key"] || "");
    if (requestKey !== API_KEY) {
      sendJson(res, 401, { message: "Unauthorized." });
      return;
    }
  }

  if (isJobRunning) {
    sendJson(res, 429, { message: "Export already in progress." });
    return;
  }

  try {
    await readSmallBody(req);
  } catch (error) {
    sendJson(res, 400, { message: error?.message || "Invalid request body." });
    return;
  }

  isJobRunning = true;
  try {
    console.log("[export] running npm build + python script");
    const output = await runPipeline();
    console.log("[export] completed successfully");
    res.writeHead(200, {
      "Content-Type": "text/x-python; charset=utf-8",
      "Content-Disposition": 'attachment; filename="gantt_anywidget.py"',
      "Cache-Control": "no-store"
    });
    res.end(output);
  } catch (error) {
    console.error("[export] failed", error);
    sendJson(res, 500, {
      message: error?.message || "Export failed.",
      stage: error?.stage || "unknown",
      stdout: error?.stdout || "",
      stderr: error?.stderr || "",
      error: error?.error || ""
    });
  } finally {
    isJobRunning = false;
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Anywidget export server listening on http://${HOST}:${PORT}`);
  console.log(`Project root: ${PROJECT_ROOT}`);
  console.log(`Allowed origins: ${Array.from(allowedOrigins).join(", ")}`);
  if (API_KEY) {
    console.log("API key protection: enabled");
  }
});
