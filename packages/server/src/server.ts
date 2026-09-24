import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { AgentSession, createAgent } from "./session.ts";

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "127.0.0.1";
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
    if (!filePath.startsWith(webDist + sep) && filePath !== webDist) {
      response.writeHead(404, {
        "content-type": "text/plain; charset=utf-8",
      });
      response.end("Not found");
      return;
    }
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

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use`);
  } else {
    console.error(error.message);
  }
  process.exit(1);
});

const wss = new WebSocketServer({ server, path: "/ws" });
const session = new AgentSession(createAgent());
session.attach(wss);

server.listen(PORT, HOST, () => {
  console.log(`mini-agent server listening on http://${HOST}:${PORT}`);
});
