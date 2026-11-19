import { expect, test } from "bun:test";
import { agentHandshake, generateIdentity, hubHandshake, rawPublic } from "./secure.ts";

function pair() {
  const hub = generateIdentity();
  const agent = generateIdentity();
  const a = agentHandshake(agent, rawPublic(hub.publicKey));
  const h = hubHandshake(hub, a.hs1);
  const { channel: ac, authFrame } = a.finish(h.hs2, { server: "web-1", agentVersion: "t" });
  const auth = h.channel.open(authFrame, 1e6) as { sig: string; server: string };
  return { ac, hc: h.channel, auth, h };
}

test("handshake + mutual auth + duplex", () => {
  const { ac, hc, auth, h } = pair();
  expect(auth.server).toBe("web-1");
  expect(h.verifyAgent(auth.sig)).toBe(true);
  const big = { t: "snap", x: "y".repeat(5000) };
  expect(hc.open(ac.seal(big), 1e6)).toEqual(big);
  expect(ac.open(hc.seal({ t: "config" }), 1e6)).toEqual({ t: "config" });
});

test("wrong pinned hub key is rejected", () => {
  const hub = generateIdentity(), evil = generateIdentity(), agent = generateIdentity();
  const a = agentHandshake(agent, rawPublic(hub.publicKey));
  const h = hubHandshake(evil, a.hs1);
  expect(() => a.finish(h.hs2, { server: "x", agentVersion: "t" })).toThrow();
});

test("replay / tamper rejected", () => {
  const { ac, hc } = pair();
  const f1 = ac.seal({ n: 1 });
  hc.open(f1, 1e6);
  expect(() => hc.open(f1, 1e6)).toThrow();
  const { ac: ac2, hc: hc2 } = pair();
  const f = ac2.seal({ n: 1 }) as Buffer;
  f[f.length - 1] = f[f.length - 1]! ^ 1;
  expect(() => hc2.open(f, 1e6)).toThrow();
});

test("forged agent signature rejected", () => {
  const { h } = pair();
  expect(h.verifyAgent(Buffer.alloc(64).toString("base64url"))).toBe(false);
});
