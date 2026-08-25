// scripts/dev-server.js — `npm run dev`, then open http://localhost:8888
//
// Serves site/ and routes /api/* to the same function modules Netlify runs, so
// local development needs no netlify-cli and no global install. Reads .env if
// present (no dependency — the file is three lines of KEY=VALUE).

import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(ROOT, "site");
const PORT = Number(process.env.PORT) || 8888;

// .env, minimally: KEY=VALUE per line, # comments, optional surrounding quotes.
const envPath = path.join(ROOT, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!match) continue;
    const value = match[2].replace(/^["']|["']$/g, "");
    if (!(match[1] in process.env)) process.env[match[1]] = value;
  }
  console.log("loaded .env");
} else {
  console.log("no .env found — copy .env.example to .env and fill in your Jira token");
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/** Call a function module the way Netlify would. */
async function invokeFunction(name, request) {
  const modulePath = path.join(ROOT, "netlify", "functions", `${name}.js`);
  if (!existsSync(modulePath)) return { statusCode: 404, headers: {}, body: JSON.stringify({ error: `No function named ${name}` }) };
  // Keyed on the file's mtime, not the clock: a fresh key on every request would
  // re-instantiate the module each time, throwing away the in-memory response
  // cache that lives in its module scope — which made local dev re-fetch all 853
  // tickets on every single call. This still picks up edits without a restart.
  const { mtimeMs } = await stat(modulePath);
  const module = await import(`${modulePath}?v=${mtimeMs}`);
  return module.handler(request);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/.netlify/functions/")) {
    const name = url.pathname.replace(/^\/api\//, "").replace(/^\/\.netlify\/functions\//, "");

    // Demo mode: with DEMO_INDEX pointing at a fixture (see
    // scripts/make-fixture.js), the index endpoint is served from disk. Lets the
    // UI be worked on without a Jira token. Everything else still hits Jira, so
    // opening a ticket in demo mode will report the missing credentials — which
    // is the honest outcome rather than a fabricated thread.
    if ((name === "ops-issues" || name === "ops-issue") && process.env.DEMO_INDEX) {
      try {
        const fixture = JSON.parse(await readFile(path.resolve(ROOT, process.env.DEMO_INDEX), "utf8"));
        if (name === "ops-issues") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(fixture));
          return;
        }
        // A fixture only holds threads for the tickets whose export included
        // them, so say plainly when one is absent instead of inventing a thread.
        const detail = fixture.details?.[url.searchParams.get("key")];
        res.writeHead(detail ? 200 : 404, { "Content-Type": "application/json" });
        res.end(JSON.stringify(detail || { error: "This ticket's thread is not in the demo fixture. Add real credentials to load it from Jira." }));
        return;
      } catch (error) {
        console.error("DEMO_INDEX could not be read:", error.message);
      }
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);

    try {
      const result = await invokeFunction(name, {
        httpMethod: req.method,
        queryStringParameters: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: chunks.length ? Buffer.concat(chunks).toString("utf8") : null,
      });
      res.writeHead(result.statusCode, result.headers || {});
      res.end(result.body || "");
    } catch (error) {
      console.error(`${name} threw:`, error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  // Keep the path inside site/ — a dev server still should not serve .env.
  const filePath = path.join(SITE, relative);
  if (!filePath.startsWith(SITE)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
});

// If the port is taken — almost always another copy of this server still
// running from an earlier session — step up to the next one rather than dying
// with EADDRINUSE. The chosen port is printed prominently, because the failure
// mode of quietly moving is somebody staring at a stale tab on 8888.
const MAX_PORT_ATTEMPTS = 10;

function start(port, attempt = 0) {
  const onError = (error) => {
    server.removeListener("listening", onListening);

    if (error.code !== "EADDRINUSE") {
      console.error(
        error.code === "EACCES"
          ? `Not allowed to bind port ${port}. Ports below 1024 need elevated privileges — try PORT=8888.`
          : `Could not start the server: ${error.message}`
      );
      process.exit(1);
    }

    if (attempt >= MAX_PORT_ATTEMPTS - 1) {
      console.error(
        `Ports ${PORT}–${port} are all in use. Stop whatever is holding them, ` +
          `or pick one explicitly with PORT=9000 npm run dev.`
      );
      process.exit(1);
    }

    console.log(`port ${port} is in use — trying ${port + 1}`);
    start(port + 1, attempt + 1);
  };

  const onListening = () => {
    server.removeListener("error", onError);
    if (port !== PORT) {
      console.log(`\n  ⚠  ${PORT} was busy — this server is on ${port}, not ${PORT}.`);
    }
    console.log(`\nOPSTracker dev server: http://localhost:${port}\n`);
  };

  // once() rather than on(): each attempt installs its own pair and the losing
  // handler is removed above, so retries cannot accumulate listeners.
  server.once("error", onError);
  server.once("listening", onListening);
  server.listen(port);
}

start(PORT);
