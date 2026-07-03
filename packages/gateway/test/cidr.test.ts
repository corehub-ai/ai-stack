import { describe, expect, it } from "bun:test";
import { ipInAnyCidr, ipInCidr } from "../src/cidr.js";

describe("ipInCidr", () => {
  it("matches an address inside a /24", () => {
    expect(ipInCidr("172.28.1.42", "172.28.1.0/24")).toBe(true);
  });
  it("rejects an address outside the /24", () => {
    expect(ipInCidr("172.28.2.1", "172.28.1.0/24")).toBe(false);
  });
  it("treats a bare IP (no prefix) as /32", () => {
    expect(ipInCidr("10.0.0.5", "10.0.0.5")).toBe(true);
    expect(ipInCidr("10.0.0.6", "10.0.0.5")).toBe(false);
  });
  it("0.0.0.0/0 matches everything", () => {
    expect(ipInCidr("8.8.8.8", "0.0.0.0/0")).toBe(true);
  });
  it("rejects malformed input instead of throwing", () => {
    expect(ipInCidr("not-an-ip", "10.0.0.0/8")).toBe(false);
    expect(ipInCidr("10.0.0.1", "not-a-cidr/8")).toBe(false);
  });
});

describe("ipInAnyCidr", () => {
  it("matches if any CIDR in the list matches", () => {
    expect(ipInAnyCidr("192.168.1.5", ["10.0.0.0/8", "192.168.1.0/24"])).toBe(true);
  });
  it("returns false for an empty list", () => {
    expect(ipInAnyCidr("192.168.1.5", [])).toBe(false);
  });
});
