import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { AgentSession, createAgent } from "./session.ts";

const PORT = Number(process.env.PORT ?? 3001);
const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

const server = createServer((request, response) => {
  void (async () => {
    const urlPath = new URL(request.url ?? "/", "http://localhost").pathname;
    const relative = normalize(
      urlPath === "/" ? "/index.html" : urlPath,
    ).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(webDist, relative);
    try {
      const content = await readFile(filePath);
      response.writeHead(200, {
        "content-type":
          contentTypes[extname(filePath)] ?? "application/octet-stream",
      });
      response.end(content);
    } catch {
      response.writeHead(404, {
        "content-type": "text/plain; charset=utf-8",
      });
      response.end("Not found");
    }
  })();
});

const wss = new WebSocketServer({ server, path: "/ws" });
const session = new AgentSession(createAgent());
session.attach(wss);

server.listen(PORT, () => {
  console.log(`mini-agent server listening on http://localhost:${PORT}`);
});
