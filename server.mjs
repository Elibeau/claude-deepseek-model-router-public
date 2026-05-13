import http from "node:http";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { configFromObject, handleRequest } from "./src/router-core.js";

const configPath = process.argv[2] || "router.config.json";
const rawConfig = JSON.parse(await readFile(configPath, "utf8"));
const config = configFromObject(rawConfig);
const host = rawConfig.listen?.host || "127.0.0.1";
const port = Number(rawConfig.listen?.port || 8787);

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);

    const url = `http://${req.headers.host || `${host}:${port}`}${req.url}`;
    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined
    });

    const response = await handleRequest(request, config);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (response.body) {
      Readable.fromWeb(response.body).pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { message: error.message, type: "router_error" } }));
  }
});

server.listen(port, host, () => {
  console.log(`Claude DeepSeek model router listening on http://${host}:${port}`);
  console.log("Claude Desktop gateway mode requires an HTTPS base URL; use this Node server behind HTTPS or deploy src/worker.js to Cloudflare Workers.");
});
