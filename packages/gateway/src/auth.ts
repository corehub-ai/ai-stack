import type { Context, Next } from "hono";
import { ipInAnyCidr } from "./cidr.js";

export type AuthEnv = {
  Bindings: { ip?: string };
  Variables: { injectedAuthHeader?: string };
};

const LOOPBACK_IPS = new Set(["127.0.0.1", "::1"]);

export function createAuthMiddleware(opts: { trustedCidrs: string[]; defaultKey: string }) {
  return async (c: Context<AuthEnv>, next: Next) => {
    const hasCredential =
      c.req.header("authorization") !== undefined || c.req.header("x-api-key") !== undefined;
    if (hasCredential) {
      await next();
      return;
    }

    const ip = c.env?.ip;
    const trusted =
      ip !== undefined && (LOOPBACK_IPS.has(ip) || ipInAnyCidr(ip, opts.trustedCidrs));
    if (!trusted) {
      return c.json(
        {
          error: {
            message:
              "Missing Authorization/x-api-key header, and the caller is not loopback or in GATEWAY_TRUSTED_CIDRS.",
            type: "auth_error",
            code: "gateway_auth",
          },
        },
        401,
      );
    }

    c.set("injectedAuthHeader", `Bearer ${opts.defaultKey}`);
    await next();
  };
}
