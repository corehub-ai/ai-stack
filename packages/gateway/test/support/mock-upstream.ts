import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");

function parseStatus(headersText: string): number {
  const firstLine = headersText.split("\r\n")[0] ?? headersText.split("\n")[0] ?? "";
  const match = /HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(firstLine);
  return match ? Number(match[1]) : 200;
}

function parseHeaders(headersText: string): Headers {
  const headers = new Headers();
  const skip = new Set(["content-length", "connection", "keep-alive", "transfer-encoding"]);
  for (const line of headersText.split(/\r?\n/).slice(1)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!name || skip.has(name)) continue;
    headers.append(name, value);
  }
  return headers;
}

export function startMockUpstream(fixtureBaseName: string): { url: string; stop(): void } {
  const headersText = readFileSync(join(FIXTURES_DIR, `${fixtureBaseName}.headers.txt`), "utf8");
  const isText = fixtureBaseName.endsWith("-stream");
  const bodyPath = join(FIXTURES_DIR, `${fixtureBaseName}.body.${isText ? "txt" : "json"}`);
  const body = readFileSync(bodyPath);
  const status = parseStatus(headersText);
  const headers = parseHeaders(headersText);

  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(body, { status, headers });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}
