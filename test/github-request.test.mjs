import assert from "node:assert/strict";
import test from "node:test";
import { createGithubRequest } from "../scripts/lib/github-request.mjs";

function setup(t, responses) {
  let time = 1_700_000_000_000;
  const waits = [];
  const requests = [];
  const request = createGithubRequest("test-token", {
    now: () => time,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      time += milliseconds;
    },
  });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, ...options, time });
    assert.ok(responses.length, "Unexpected extra request");
    return responses.shift();
  });
  return { request, waits, requests };
}

test("paces successive label writes by one second without slowing reads", async (t) => {
  const fixture = setup(t, [Response.json([]), Response.json({}), Response.json([]), Response.json({}), new Response(null, { status: 204 })]);
  await fixture.request("GET", "/repos/example/repo/labels");
  await fixture.request("POST", "/repos/example/repo/labels", { name: "Bug" });
  await fixture.request("GET", "/repos/example/repo/labels");
  await fixture.request("PATCH", "/repos/example/repo/labels/Bug", { color: "000000" });
  assert.equal(await fixture.request("DELETE", "/repos/example/repo/labels/Old"), null);
  assert.deepEqual(fixture.waits, [1000, 1000]);
  assert.deepEqual(fixture.requests.map(({ time }) => time - 1_700_000_000_000), [0, 0, 0, 1000, 2000]);
});

test("secondary 403 retries the rejected write with the same URL, body and auth", async (t) => {
  const fixture = setup(t, [
    Response.json({ message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." }, { status: 403 }),
    Response.json({ name: "Bug" }),
  ]);
  assert.deepEqual(await fixture.request("POST", "/repos/example/repo/labels", { name: "Bug" }), { name: "Bug" });
  assert.deepEqual(fixture.waits, [60000]);
  assert.equal(fixture.requests.length, 2);
  for (const request of fixture.requests) {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "https://api.github.com/repos/example/repo/labels");
    assert.equal(request.body, '{"name":"Bug"}');
    assert.equal(request.headers.Authorization, "Bearer test-token");
  }
});

for (const [name, headers, expectedWait] of [
  ["Retry-After seconds", { "retry-after": "180" }, 180000],
  ["Retry-After HTTP date", { "retry-after": "Tue, 14 Nov 2023 22:16:20 GMT" }, 180000],
  ["primary reset time", { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000180" }, 181000],
  ["both headers", { "retry-after": "90", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000180" }, 181000],
  ["invalid headers", { "retry-after": "invalid", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "invalid" }, 60000],
]) {
  test(`rate-limit recovery honors ${name}`, async (t) => {
    const fixture = setup(t, [new Response("Throttled", { status: 429, headers }), Response.json([])]);
    await fixture.request("GET", "/repos/example/repo/labels");
    assert.deepEqual(fixture.waits, [expectedWait]);
    assert.equal(fixture.requests.length, 2);
  });
}

test("primary-limit 403 is retried even without a secondary-limit message", async (t) => {
  const fixture = setup(t, [
    new Response("Forbidden", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000180" } }),
    Response.json([]),
  ]);
  await fixture.request("GET", "/repos/example/repo/labels");
  assert.deepEqual(fixture.waits, [181000]);
});

test("persistent rate limits stop after five retries with exponential backoff", async (t) => {
  const fixture = setup(t, Array.from({ length: 6 }, () => new Response("Secondary rate limit", { status: 403 })));
  await assert.rejects(fixture.request("GET", "/repos/example/repo/labels"), /403.*after 5 retries/);
  assert.deepEqual(fixture.waits, [60000, 120000, 240000, 480000, 960000]);
  assert.equal(fixture.requests.length, 6);
});

for (const status of [401, 403, 404, 422, 500]) {
  test(`ordinary ${status} errors fail immediately without retrying writes`, async (t) => {
    const fixture = setup(t, [new Response("Request failed", { status, headers: { "x-ratelimit-remaining": "100" } })]);
    await assert.rejects(fixture.request("POST", "/repos/example/repo/labels", { name: "Bug" }), new RegExp(`${status}: Request failed`));
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(fixture.waits, []);
  });
}

test("network failures are not retried because a write may already have been applied", async (t) => {
  const fixture = setup(t, []);
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    attempts += 1;
    throw new Error("Connection lost");
  });
  await assert.rejects(fixture.request("POST", "/repos/example/repo/labels", { name: "Bug" }), /Connection lost/);
  assert.equal(attempts, 1);
  assert.deepEqual(fixture.waits, []);
});
