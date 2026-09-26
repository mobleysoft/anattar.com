// Real tests for the lead-capture read path fix (2026-09-26 depth audit):
// handleInterest() had written real submissions to env.LEADS since it was
// added, but there was no way to read them back except a raw `wrangler kv
// key list`/`get` CLI call. These exercise the real worker.js default
// export's fetch() handler against a fake KV namespace, not a
// reimplementation of the logic under test.

import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";

function makeFakeKV() {
  const store = new Map();
  return {
    store,
    async put(key, value) {
      store.set(key, value);
    },
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async list({ prefix } = {}) {
      const keys = [...store.keys()]
        .filter((k) => !prefix || k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys };
    },
  };
}

function makeEnv() {
  return { LEADS: makeFakeKV(), ASSETS: { fetch: async () => new Response("ok", { status: 200 }) } };
}

test("GET /api/leads with no ANATTAR_ADMIN_SECRET configured returns 404, not the real leads", async () => {
  const env = makeEnv();
  env.LEADS.store.set("lead:a@b.com", JSON.stringify({ email: "a@b.com" }));
  const res = await worker.fetch(new Request("https://anattar.com/api/leads?secret=anything"), env);
  assert.equal(res.status, 404);
});

test("GET /api/leads with the WRONG secret returns the identical 404, not a distinguishable error", async () => {
  const env = makeEnv();
  env.ANATTAR_ADMIN_SECRET = "real-secret";
  const res = await worker.fetch(new Request("https://anattar.com/api/leads?secret=wrong"), env);
  assert.equal(res.status, 404);
});

test("GET /api/leads with the correct secret returns real, previously-submitted leads", async () => {
  const env = makeEnv();
  env.ANATTAR_ADMIN_SECRET = "real-secret";
  await worker.fetch(
    new Request("https://anattar.com/api/interest", {
      method: "POST",
      body: JSON.stringify({ email: "compliance@bank.example", institution: "Example Bank" }),
    }),
    env
  );
  const res = await worker.fetch(new Request("https://anattar.com/api/leads?secret=real-secret"), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.count, 1);
  assert.equal(body.leads[0].email, "compliance@bank.example");
  assert.equal(body.leads[0].institution, "Example Bank");
});

test("GET /api/leads returns leads from multiple real submissions, not just the last one", async () => {
  const env = makeEnv();
  env.ANATTAR_ADMIN_SECRET = "real-secret";
  await worker.fetch(
    new Request("https://anattar.com/api/interest", {
      method: "POST",
      body: JSON.stringify({ email: "one@bank.example" }),
    }),
    env
  );
  await worker.fetch(
    new Request("https://anattar.com/api/interest", {
      method: "POST",
      body: JSON.stringify({ email: "two@bank.example" }),
    }),
    env
  );
  const res = await worker.fetch(new Request("https://anattar.com/api/leads?secret=real-secret"), env);
  const body = await res.json();
  assert.equal(body.count, 2);
});
