import type { Context } from "hono";
import type { AuthEnv } from "./auth.js";

// Hop-by-hop / credential headers the gateway itself controls. Always
// deleted from the client's copy before deciding what to send upstream --
// never trust the spread-and-overwrite pattern (a differently-cased or
// unexpected client header could otherwise ride along unmodified).
const STRIPPED_HEADERS = ["host", "authorization", "x-api-key"];

export function proxyHeaders(c: Context<AuthEnv>): Record<string, string> {
  const headers: Record<string, string> = { ...c.req.header() };
  for (const name of STRIPPED_HEADERS) delete headers[name];

  const injected = c.get("injectedAuthHeader");
  if (injected) {
    // Untrusted-but-allowed caller (loopback/GATEWAY_TRUSTED_CIDRS) with no
    // credential of its own: forward the gateway's own default key.
    headers.authorization = injected;
  } else {
    // Caller presented a credential; forward it exactly as sent, on
    // whichever header it used (manifest is the source of truth for
    // whether it's valid — the gateway doesn't validate keys itself).
    const authorization = c.req.header("authorization");
    const apiKey = c.req.header("x-api-key");
    if (authorization !== undefined) headers.authorization = authorization;
    if (apiKey !== undefined) headers["x-api-key"] = apiKey;
  }

  return headers;
}
