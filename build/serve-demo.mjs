// Serve _site/ over HTTP for local development.
//
// A static server rather than `file://`, for one reason that matters: ES modules and
// `WebAssembly.instantiateStreaming` both need real HTTP with real content types. Opening
// index.html from disk fails in a way that looks like a code bug and is not one.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../_site", import.meta.url));
const port = Number(process.env.PORT ?? 8080);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  // A stylesheet served as anything else is ignored by the browser without an error anyone sees,
  // which is a slow way to find out about a content type.
  ".css": "text/css; charset=utf-8",
  ".pdf": "application/pdf",
  // The one that matters. GitHub Pages sets this correctly too; a server that does not is the
  // single most common way a wasm page fails in a browser but not in Node.
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".ts": "text/plain; charset=utf-8",
};

createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  const path = join(root, url === "/" ? "index.html" : normalize(url).replace(/^(\.\.[/\\])+/, ""));
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end(`not found: ${url}`);
  }
}).listen(port, () => console.log(`demo on http://localhost:${port}`));
