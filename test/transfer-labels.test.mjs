import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { transferLabels } from "../scripts/transfer-labels.mjs";

const label = (name, color = "abcdef", description = "") => ({ name, color, description });

test("command-line entry point validates inputs and fails visibly through workspace aliases", async () => {
  await assert.rejects(
    promisify(execFile)(process.execPath, [path.resolve("scripts/transfer-labels.mjs")], {
      env: { ...process.env, SOURCE_REPOSITORY: "", TARGET_REPOSITORY: "", LABEL_SYNC_TOKEN: "", LABEL_SYNC_TOKEN_PERMISSIONS: "", GITHUB_STEP_SUMMARY: "" },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Source repository is required/);
      assert.match(error.stdout, /## Workflow Failure/);
      return true;
    },
  );
});

async function setup(t, {
  source = [label("Bug", "ff0000", "Source description"), label("New / 🚀", "123456", null)],
  target = [label("bug", "000000", "Keep this"), label("Extra")],
  failRequest = () => false,
  sourceId = 1,
  targetId = 2,
  archived = false,
  writable = true,
} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "label-transfer-"));
  const summaryPath = path.join(directory, "summary.md");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const previousSummary = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = summaryPath;
  t.after(() => {
    if (previousSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = previousSummary;
  });
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const parsed = new URL(url);
    const request = {
      method: options.method,
      path: parsed.pathname,
      query: parsed.searchParams,
      body: options.body ? JSON.parse(options.body) : undefined,
    };
    requests.push(request);
    assert.equal(parsed.origin, "https://api.github.com");
    assert.equal(options.headers.Authorization, "Bearer test-token");
    if (failRequest(request)) return new Response("Simulated failure", { status: 403 });
    if (request.method === "GET") {
      if (request.path === "/repos/example/source") {
        return Response.json({ id: sourceId, full_name: "example/source" });
      }
      if (request.path === "/repos/example/target") {
        return Response.json({ id: targetId, full_name: "example/target", archived, permissions: { push: writable } });
      }
      const labels = request.path === "/repos/example/source/labels" ? source
        : request.path === "/repos/example/target/labels" ? target : null;
      assert.ok(labels, `Unexpected GET: ${url}`);
      assert.equal(request.query.get("per_page"), "100");
      const start = (Number(request.query.get("page")) - 1) * 100;
      return Response.json(labels.slice(start, start + 100));
    }
    assert.ok(request.path.startsWith("/repos/example/target/labels"), "Only the target may be modified");
    return request.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(request.body);
  });
  return {
    requests,
    writes: () => requests.filter(({ method }) => method !== "GET"),
    summary: () => fs.readFile(summaryPath, "utf8"),
    run: (options = {}) => transferLabels({
      token: "test-token", organization: "example",
      sourceRepository: "source", targetRepository: "target", ...options,
    }),
  };
}

test("default transfer only adds missing labels and preserves same-name target specs", async (t) => {
  const fixture = await setup(t);
  await fixture.run();
  assert.deepEqual(fixture.writes().map(({ method, path, body }) => ({ method, path, body })), [
    { method: "POST", path: "/repos/example/target/labels", body: label("New / 🚀", "123456") },
  ]);
  const summary = await fixture.summary();
  assert.match(summary, /# Transfer-Labels Changelog/);
  assert.match(summary, /\*\*Test Mode:\*\* False/);
  assert.match(summary, /\*\*Override Existing Labels:\*\* False/);
  assert.match(summary, /\*\*Created Labels:\*\* 1/);
  assert.match(summary, /\*\*Retained Labels:\*\* 2/);
  assert.match(summary, /\*\*Source Repository:\*\* \[example\/source\]/);
  assert.match(summary, /\*\*Receiving Repository:\*\* \[example\/target\]/);
});

test("override updates matching labels, adds missing labels, then deletes extras", async (t) => {
  const fixture = await setup(t);
  await fixture.run({ overrideExisting: true });
  assert.deepEqual(fixture.writes().map(({ method, path, body }) => ({ method, path, body })), [
    { method: "PATCH", path: "/repos/example/target/labels/bug", body: { new_name: "Bug", color: "ff0000", description: "Source description" } },
    { method: "POST", path: "/repos/example/target/labels", body: label("New / 🚀", "123456") },
    { method: "DELETE", path: "/repos/example/target/labels/Extra", body: undefined },
  ]);
  const summary = await fixture.summary();
  assert.match(summary, /\*\*Updated Labels:\*\* 1/);
  assert.match(summary, /\*\*Deleted Labels:\*\* 1/);
  assert.match(summary, /`bug` -> `Bug`/);
  assert.match(summary, /Deleted `Extra`/);
});

for (const overrideExisting of [false, true]) {
  test(`test mode previews ${overrideExisting ? "override" : "additive"} changes without any writes`, async (t) => {
    const fixture = await setup(t);
    await fixture.run({ dryRun: true, overrideExisting });
    assert.deepEqual(fixture.writes(), []);
    const summary = await fixture.summary();
    assert.match(summary, /# Transfer-Labels Fake Changelog/);
    assert.match(summary, /\*\*Test Mode:\*\* True/);
    assert.match(summary, /\*\*Created Labels:\*\* 1/);
    assert.match(summary, new RegExp(`\\*\\*Deleted Labels:\\*\\* ${overrideExisting ? 1 : 0}`));
  });
}

test("reads every page from both repositories before transferring", async (t) => {
  const source = Array.from({ length: 101 }, (_, index) => label(`Source ${index}`));
  const target = Array.from({ length: 100 }, (_, index) => label(`Source ${index}`));
  target.push(label("Extra / # ?"));
  const fixture = await setup(t, { source, target });
  await fixture.run({ overrideExisting: true });
  assert.deepEqual(fixture.writes().map(({ method, path, body }) => ({ method, path, body })), [
    { method: "POST", path: "/repos/example/target/labels", body: label("Source 100") },
    { method: "DELETE", path: "/repos/example/target/labels/Extra%20%2F%20%23%20%3F", body: undefined },
  ]);
  assert.match(await fixture.summary(), /\*\*Source Labels:\*\* 101/);
});

test("override is a no-op when the receiving repository already matches", async (t) => {
  const fixture = await setup(t, { source: [label("Bug")], target: [label("Bug")] });
  await fixture.run({ overrideExisting: true });
  assert.deepEqual(fixture.writes(), []);
  assert.match(await fixture.summary(), /No repository changes detected/);
});

for (const overrideExisting of [false, true]) {
  test(`empty source ${overrideExisting ? "clears receiving labels in override mode" : "leaves receiving labels in additive mode"}`, async (t) => {
    const fixture = await setup(t, { source: [], target: [label("Extra")] });
    await fixture.run({ overrideExisting });
    assert.deepEqual(fixture.writes().map(({ method }) => method), overrideExisting ? ["DELETE"] : []);
  });
}

test("stops before deletion on a failed copy and records only completed writes", async (t) => {
  const fixture = await setup(t, { failRequest: ({ method }) => method === "POST" });
  await assert.rejects(fixture.run({ overrideExisting: true }), /403/);
  assert.deepEqual(fixture.writes().map(({ method }) => method), ["PATCH", "POST"]);
  const summary = await fixture.summary();
  assert.match(summary, /\*\*Updated Labels:\*\* 1/);
  assert.match(summary, /\*\*Created Labels:\*\* 0/);
  assert.match(summary, /\*\*Deleted Labels:\*\* 0/);
  assert.match(summary, /## Workflow Failure/);
});

test("a failed later source page prevents all writes and produces a failure summary", async (t) => {
  const fixture = await setup(t, {
    source: Array.from({ length: 100 }, (_, index) => label(`Label ${index}`)),
    failRequest: ({ path, query }) => path === "/repos/example/source/labels" && query.get("page") === "2",
  });
  await assert.rejects(fixture.run({ overrideExisting: true }), /403/);
  assert.deepEqual(fixture.writes(), []);
  assert.match(await fixture.summary(), /## Workflow Failure/);
});

for (const name of [".", ".."]) {
  test(`override rejects target label ${JSON.stringify(name)} before a URL can resolve outside the labels endpoint`, async (t) => {
    const fixture = await setup(t, { target: [label(name)] });
    await assert.rejects(fixture.run({ overrideExisting: true }), /cannot be safely addressed/);
    assert.deepEqual(fixture.writes(), []);
    assert.match(await fixture.summary(), /## Workflow Failure/);
  });
}

test("accepts full repository names without an organization", async (t) => {
  const fixture = await setup(t);
  await fixture.run({ sourceRepository: " example/source ", targetRepository: "example/target", organization: "" });
  assert.equal(fixture.writes().length, 1);
});

for (const sourceRepository of ["", "https://github.com/example/source", "../source", "example/source?x=1", "repo,other", "example/repo/extra", "EXAMPLE/TARGET"]) {
  test(`rejects invalid or identical source ${JSON.stringify(sourceRepository)} before API access`, async (t) => {
    const fixture = await setup(t);
    await assert.rejects(fixture.run({ sourceRepository }));
    assert.deepEqual(fixture.requests, []);
    assert.match(await fixture.summary(), /## Workflow Failure/);
  });
}

test("rejects different repository aliases that resolve to the same repository ID", async (t) => {
  const fixture = await setup(t, { sourceId: 1, targetId: 1 });
  await assert.rejects(fixture.run({ overrideExisting: true }), /different repositories/);
  assert.deepEqual(fixture.writes(), []);
});

for (const options of [{ archived: true }, { writable: false }]) {
  test(`skips a receiving repository that is ${options.archived ? "archived" : "read-only"}`, async (t) => {
    const fixture = await setup(t, options);
    await fixture.run({ overrideExisting: true });
    assert.deepEqual(fixture.writes(), []);
    assert.match(await fixture.summary(), /## Skipped Repositories/);
  });
}

test("test mode can preview a read-only receiving repository", async (t) => {
  const fixture = await setup(t, { writable: false });
  await fixture.run({ dryRun: true, overrideExisting: true });
  assert.deepEqual(fixture.writes(), []);
  assert.match(await fixture.summary(), /\*\*Created Labels:\*\* 1/);
});
