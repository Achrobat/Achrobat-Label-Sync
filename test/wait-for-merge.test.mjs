import assert from "node:assert/strict";
import test from "node:test";

import { validateCommandsConfig, validateLabelTestWorkflowConfig } from "../scripts/lib/config-validation.mjs";
import {
  findCommandLines,
  parsePullRequestReference,
  parseWaitForMergeLinks,
  readNoteKind,
  renderCommentBody,
} from "../scripts/lib/wait-for-merge.mjs";
import { isPullRequestApproved, reconcileWaitForMerge } from "../scripts/lib/wait-for-merge-runner.mjs";

// Validates a Label Test config and a commands config together, the way Label Sync loads them.
function validateConfigs({ waitForMerge, ...labelTest } = {}) {
  const labelTestWorkflowConfig = validateLabelTestWorkflowConfig(labelTest);
  return {
    ...labelTestWorkflowConfig,
    ...validateCommandsConfig(waitForMerge === undefined ? {} : { waitForMerge }, { labelTestWorkflowConfig }),
  };
}

const LABEL = "Waiting on PR";
const config = validateConfigs({
  failingLabels: [LABEL],
  waitForMerge: { label: LABEL, allowedUsers: "teams/maintainers, Alice, Bob" },
});
const BOT = "label-sync[bot]";
const PR = "Org/repo#5";

test("parsePullRequestReference accepts URLs, owner/repo#n and #n", () => {
  assert.deepEqual(parsePullRequestReference("https://github.com/Org/lib/pull/42/files", "Org/repo"), { owner: "Org", repo: "lib", number: 42 });
  assert.deepEqual(parsePullRequestReference("<https://github.com/Org/lib/pull/42>", "Org/repo"), { owner: "Org", repo: "lib", number: 42 });
  assert.deepEqual(parsePullRequestReference("Org/lib#7", "Org/repo"), { owner: "Org", repo: "lib", number: 7 });
  assert.deepEqual(parsePullRequestReference("#9", "Org/repo"), { owner: "Org", repo: "repo", number: 9 });
  assert.ok(parsePullRequestReference("https://github.com/Org/lib/issues/42", "Org/repo").error);
  assert.ok(parsePullRequestReference("", "Org/repo").error);
  assert.ok(parsePullRequestReference("#0", "Org/repo").error);
});

test("waitForMerge config must be a failing label, not sticky, and list allowed users", () => {
  assert.equal(validateConfigs({}).waitForMerge, null);
  assert.equal(validateConfigs({ waitForMerge: {} }).waitForMerge, null);
  assert.equal(config.waitForMerge.allowExternalRepositories, false);
  assert.deepEqual(config.waitForMerge.allowedUsers.map((member) => member.value), ["teams/maintainers", "Alice", "Bob"]);
  assert.throws(
    () => validateConfigs({ waitForMerge: { label: LABEL, allowedUsers: "Alice" } }),
    /must also be listed in "failingLabels"/,
  );
  assert.throws(
    () => validateConfigs({
      failingLabels: [LABEL],
      stickyLabels: [{ label: LABEL, remover: "Alice" }],
      waitForMerge: { label: LABEL, allowedUsers: "Alice" },
    }),
    /cannot also be a sticky label/,
  );
  assert.throws(
    () => validateConfigs({ failingLabels: [LABEL], waitForMerge: { label: LABEL } }),
    /allowedUsers must be/,
  );
  assert.throws(
    () => validateConfigs({ waitForMerge: { allowedUsers: "Alice" } }),
    /needs a "label"/,
  );
  assert.throws(
    () => validateConfigs({ failingLabels: [LABEL], waitForMerge: { label: LABEL, allowedUsers: "Alice, alice" } }),
    /more than once/,
  );
  assert.throws(
    () => validateConfigs({ failingLabels: [LABEL], waitForMerge: { label: LABEL, allowedUsers: "Alice", allowExternalRepositories: "yes" } }),
    /allowExternalRepositories must be true or false/,
  );
});


// ---------------------------------------------------------------------------------------------------------
// An in-memory GitHub with several pull requests. Label changes made through the API are recorded as label
// events by BOT; people's actions go through the world helpers. Every action moves the clock forward a minute.

function createWorld({ pulls = {}, permissions = {} } = {}) {
  let clock = Date.parse("2026-10-01T00:00:00Z");
  let nextId = 1;
  const tick = () => {
    clock += 60_000;
    return new Date(clock).toISOString();
  };
  const prs = new Map();
  const reactions = new Map();
  const writes = [];
  const hooks = { beforeCommentRead: null };

  const pr = (key) => {
    if (!prs.has(key)) {
      prs.set(key, { state: "open", merged: false, labels: [], comments: [], events: [], reviews: [] });
    }
    return prs.get(key);
  };

  for (const [key, value] of Object.entries(pulls)) {
    Object.assign(pr(key), value);
  }

  const findComment = (id) => {
    for (const item of prs.values()) {
      const found = item.comments.find((comment) => String(comment.id) === String(id));
      if (found) {
        return found;
      }
    }
    return null;
  };

  const notFound = () => {
    const error = new Error("Not Found");
    error.status = 404;
    return error;
  };

  const world = {
    prs,
    reactions,
    writes,
    hooks,
    pr,
    comment(key, login, body, type = "User") {
      const comment = { id: nextId++, body, created_at: tick(), user: { login, type } };
      pr(key).comments.push(comment);
      return comment;
    },
    edit(id, body) {
      tick();
      findComment(id).body = body;
    },
    remove(key, id) {
      tick();
      const item = pr(key);
      item.comments = item.comments.filter((comment) => comment.id !== id);
    },
    label(key, login, action) {
      const item = pr(key);
      if (action === "labeled") {
        item.labels.push({ name: LABEL });
      } else {
        item.labels = item.labels.filter((label) => label.name !== LABEL);
      }
      item.events.push({ id: nextId++, event: action, label: { name: LABEL }, actor: { login }, created_at: tick() });
    },
    merge(key) {
      Object.assign(pr(key), { state: "closed", merged: true });
    },
    close(key) {
      Object.assign(pr(key), { state: "closed", merged: false });
    },
    review(key, login, state) {
      pr(key).reviews.push({ id: nextId++, user: { login }, state });
    },
    reactionsOn(id) {
      return (reactions.get(String(id)) ?? []).map((reaction) => reaction.content);
    },
    commentBody(id) {
      return findComment(id)?.body;
    },
    labels(key) {
      return pr(key).labels.map((label) => label.name);
    },
    botComments(key) {
      return pr(key).comments.filter((comment) => comment.user.login === BOT);
    },
    writeCount() {
      return writes.length;
    },
  };

  world.request = async (method, apiPath, body) => {
    const [pathOnly, query = ""] = apiPath.split("?");
    const page = Number(new URLSearchParams(query).get("page") ?? 1);
    const list = (items) => (page === 1 ? items : []);
    let match;

    if (method !== "GET") {
      writes.push(`${method} ${pathOnly}`);
    }

    if ((match = /^\/repos\/([^/]+)\/([^/]+)\/issues\/comments\/(\d+)\/reactions(?:\/(\d+))?$/.exec(pathOnly))) {
      const items = reactions.get(match[3]) ?? [];
      reactions.set(match[3], items);
      if (method === "GET") {
        return list(items);
      }
      if (method === "POST") {
        items.push({ id: nextId++, content: body.content, user: { login: BOT } });
        return {};
      }
      if (method === "DELETE") {
        reactions.set(match[3], items.filter((reaction) => String(reaction.id) !== match[4]));
        return null;
      }
    }

    if ((match = /^\/repos\/([^/]+)\/([^/]+)\/issues\/comments\/(\d+)$/.exec(pathOnly))) {
      if (method === "GET" && hooks.beforeCommentRead) {
        const hook = hooks.beforeCommentRead;
        hooks.beforeCommentRead = null;
        hook(Number(match[3]));
      }
      const found = findComment(match[3]);
      if (!found) {
        throw notFound();
      }
      if (method === "GET") {
        return { ...found };
      }
      if (method === "PATCH") {
        found.body = body.body;
        return { ...found };
      }
    }

    if ((match = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)(\/.*)?$/.exec(pathOnly))) {
      const key = `${match[1]}/${match[2]}#${match[3]}`;
      const rest = match[4] ?? "";
      if (!prs.has(key)) {
        throw notFound();
      }
      const item = pr(key);

      if (method === "GET" && rest === "") {
        return { number: Number(match[3]), state: item.state, pull_request: {}, user: { login: "Author" }, labels: [...item.labels] };
      }
      if (method === "GET" && rest === "/comments") {
        return list(item.comments.map((comment) => ({ ...comment })));
      }
      if (method === "GET" && rest === "/events") {
        return list(item.events);
      }
      if (method === "POST" && rest === "/comments") {
        world.comment(key, BOT, body.body, "Bot");
        return {};
      }
      if (method === "POST" && rest === "/labels") {
        world.label(key, BOT, "labeled");
        return [...item.labels];
      }
      if (method === "DELETE" && rest.startsWith("/labels/")) {
        if (!item.labels.some((label) => label.name === decodeURIComponent(rest.slice("/labels/".length)))) {
          throw notFound();
        }
        world.label(key, BOT, "unlabeled");
        return [...item.labels];
      }
    }

    if (method === "GET" && (match = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)(\/reviews)?$/.exec(pathOnly))) {
      const key = `${match[1]}/${match[2]}#${match[3]}`;
      if (!prs.has(key)) {
        throw notFound();
      }
      const item = pr(key);
      if (match[4]) {
        return list(item.reviews);
      }
      return { state: item.state, merged_at: item.merged ? "2026-10-01T00:00:00Z" : null };
    }

    if (method === "GET" && (match = /^\/repos\/([^/]+)\/([^/]+)\/collaborators\/([^/]+)\/permission$/.exec(pathOnly))) {
      const permission = permissions[decodeURIComponent(match[3])];
      if (!permission) {
        throw notFound();
      }
      return { permission: permission === "maintain" ? "write" : permission, role_name: permission };
    }

    throw new Error(`Unexpected ${method} ${apiPath}`);
  };

  return world;
}

function reconcile(world, key, options = {}) {
  const [repository, number] = key.split("#");
  return reconcileWaitForMerge({
    request: world.request,
    config,
    repository,
    pullRequestNumber: Number(number),
    isTeamMember: async () => false,
    isAutomationActor: async (login) => login === BOT,
    log: () => {},
    ...options,
  });
}

const runCommand = (world, key, comment) => reconcile(world, key, { mode: "command", triggeringCommentId: comment?.id ?? null });
const runCheck = (world, key) => reconcile(world, key, { mode: "check" });

function noteOf(body) {
  return body.split("\n").at(-1);
}

// ---------------------------------------------------------------------------------------------------------
// Parsing and rendering

test("command lines take one or many links, with or without commas, and ignore plain words", () => {
  assert.deepEqual(findCommandLines("/wait-for-merge #12\n/WAIT-FOR-MERGE Org/other#3 extra\nthanks"), [" #12", " Org/other#3 extra"]);
  assert.deepEqual(findCommandLines("please /wait-for-merge #12"), []);
  assert.deepEqual(findCommandLines("/wait-for-merged #12"), []);
  assert.deepEqual(findCommandLines(null), []);

  const links = (args) => parseWaitForMergeLinks(args, "Org/repo").map((link) => link.reference
    ? `${link.reference.owner}/${link.reference.repo}#${link.reference.number}`
    : `error:${link.text}`);

  assert.deepEqual(links(" #12, #14 needs the new API"), ["Org/repo#12", "Org/repo#14"]);
  assert.deepEqual(links(" #12,#14,https://github.com/Org/lib/pull/42/files"), ["Org/repo#12", "Org/repo#14", "Org/lib#42"]);
  assert.deepEqual(links(" (#12). Org/lib#7;"), ["Org/repo#12", "Org/lib#7"]);
  assert.deepEqual(links(" ⏳ #12, ✅ Org/lib#7 ❓ #12x"), ["Org/repo#12", "Org/lib#7", "error:#12x"]);
  assert.deepEqual(links(" https://github.com/Org/lib/issues/4 see https://example.com"), ["error:https://github.com/Org/lib/issues/4"]);
  assert.deepEqual(links(" because"), []);
  assert.deepEqual(links(" `#12`, `Org/lib#7`"), ["Org/repo#12", "Org/lib#7"]);
});

test("rendering puts icons before links and one note at the end, keeping everything else", () => {
  const body = "/wait-for-merge #12, Org/lib#7 needs the API\r\nThanks!\r\n";
  const rendered = renderCommentBody(body, [["⏳", "✅"]], "_Waiting._ <!-- wait-for-merge:waiting -->");

  assert.equal(rendered, "/wait-for-merge ⏳ #12, ✅ Org/lib#7 needs the API\r\nThanks!\r\n\r\n_Waiting._ <!-- wait-for-merge:waiting -->");
  assert.equal(readNoteKind(rendered), "waiting");
  assert.deepEqual(findCommandLines(rendered), [" ⏳ #12, ✅ Org/lib#7 needs the API"]);

  // Rendering again with new icons replaces the old icons and note instead of adding more.
  const again = renderCommentBody(rendered, [["✅", "✅"]], "_Done._ <!-- wait-for-merge:done -->");
  assert.equal(again, "/wait-for-merge ✅ #12, ✅ Org/lib#7 needs the API\r\nThanks!\r\n\r\n_Done._ <!-- wait-for-merge:done -->");
  assert.equal(renderCommentBody(again, [["✅", "✅"]], "_Done._ <!-- wait-for-merge:done -->"), again);
});


// ---------------------------------------------------------------------------------------------------------
// Starting a wait

test("a valid command gets a thumbs up, status icons and a note, and then the label", async () => {
  const world = createWorld({ pulls: { [PR]: {}, "Org/lib#42": {}, "Org/lib#43": { state: "closed", merged: true } } });
  const command = world.comment(PR, "Alice", "/wait-for-merge https://github.com/Org/lib/pull/42, Org/lib#43 because of the API");

  const outcome = await runCommand(world, PR, command);

  assert.equal(outcome.labelAdded, true);
  assert.deepEqual(world.labels(PR), [LABEL]);
  assert.deepEqual(world.reactionsOn(command.id), ["+1"]);
  assert.equal(
    world.commentBody(command.id),
    `/wait-for-merge ⏳ https://github.com/Org/lib/pull/42, ✅ Org/lib#43 because of the API\n\n_Waiting. Remove the **${LABEL}** label to cancel._ <!-- wait-for-merge:waiting -->`,
  );
  assert.deepEqual(world.botComments(PR), [], "no separate tracking comment");

  // The comment is marked waiting before the label appears, so a Label Test run on the label sees it.
  const patch = world.writes.findIndex((write) => write.startsWith("PATCH"));
  const label = world.writes.findIndex((write) => write.endsWith("/labels"));
  assert.ok(patch >= 0 && patch < label);

  // Running again changes nothing.
  const before = world.writeCount();
  await runCheck(world, PR);
  await runCommand(world, PR, command);
  assert.equal(world.writeCount(), before);
});

test("any bad link rejects the whole command with a thumbs down and no label", async () => {
  const world = createWorld({ pulls: { [PR]: {}, "Org/lib#42": {} } });
  const cases = [
    ["/wait-for-merge Org/lib#42 #12x", /`#12x` is not a pull request link/],
    ["/wait-for-merge Org/lib#42 #5", /`Org\/repo#5` is this pull request/],
    ["/wait-for-merge Org/lib#42 Other/lib#1", /`Other\/lib#1` is outside this organization/],
    ["/wait-for-merge Org/lib#42 Org/lib#999", /`Org\/lib#999` does not exist/],
    ["/wait-for-merge", /no pull request link was given/],
  ];

  const commands = [];

  for (const [text, reason] of cases) {
    const command = world.comment(PR, "Alice", text);
    commands.push(command);
    const outcome = await runCommand(world, PR, command);

    assert.equal(outcome.labelAdded, false, text);
    assert.deepEqual(world.reactionsOn(command.id), ["-1"], text);
    assert.match(noteOf(world.commentBody(command.id)), /^_Not started: .*_ <!-- wait-for-merge:rejected -->$/, text);
    assert.match(world.commentBody(command.id), reason, text);
  }

  assert.deepEqual(world.labels(PR), []);
  assert.match(world.commentBody(commands[0].id), /⏳ Org\/lib#42 ❓ #12x/);

  for (const command of commands) {
    assert.doesNotMatch(world.commentBody(command.id), /@/);
  }
});

test("a command whose linked pull requests are all closed already is rejected", async () => {
  const world = createWorld({ pulls: { [PR]: {}, "Org/lib#42": { state: "closed", merged: true }, "Org/lib#43": { state: "closed" } } });
  const command = world.comment(PR, "Alice", "/wait-for-merge Org/lib#42 Org/lib#43");

  const outcome = await runCommand(world, PR, command);

  assert.equal(outcome.labelAdded, false);
  assert.deepEqual(world.reactionsOn(command.id), ["-1"]);
  assert.match(world.commentBody(command.id), /✅ Org\/lib#42 ❌ Org\/lib#43/);
  assert.match(world.commentBody(command.id), /every linked pull request is already merged or closed/);
});

test("fixing a rejected command by editing it starts the wait and swaps the reaction", async () => {
  const world = createWorld({ pulls: { [PR]: {}, "Org/lib#42": {} } });
  const command = world.comment(PR, "Alice", "/wait-for-merge Org/lib#42x");
  await runCommand(world, PR, command);
  assert.deepEqual(world.reactionsOn(command.id), ["-1"]);

  world.edit(command.id, world.commentBody(command.id).replace("Org/lib#42x", "Org/lib#42"));
  const outcome = await runCommand(world, PR, command);

  assert.equal(outcome.labelAdded, true);
  assert.deepEqual(world.reactionsOn(command.id), ["+1"]);
  assert.match(world.commentBody(command.id), /^\/wait-for-merge ⏳ Org\/lib#42\n\n_Waiting\./);
});

test("commands from people who are not allowed only get a thumbs down, and bots are ignored", async () => {
  const world = createWorld({ pulls: { [PR]: {}, "Org/lib#42": {} } });
  const mallory = world.comment(PR, "Mallory", "/wait-for-merge Org/lib#42");
  const bot = world.comment(PR, "dependabot[bot]", "/wait-for-merge Org/lib#42", "Bot");

  await runCommand(world, PR, mallory);
  await runCommand(world, PR, bot);

  assert.deepEqual(world.labels(PR), []);
  assert.deepEqual(world.reactionsOn(mallory.id), ["-1"]);
  assert.deepEqual(world.reactionsOn(bot.id), []);
  assert.equal(world.commentBody(mallory.id), "/wait-for-merge Org/lib#42");
});

test("a command that changes while the run works on it is left for the run its edit starts", async () => {
  const world = createWorld({ pulls: { [PR]: {}, "Org/lib#42": {} } });
  const command = world.comment(PR, "Alice", "/wait-for-merge Org/lib#42");
  world.hooks.beforeCommentRead = (id) => world.edit(id, "/wait-for-merge Org/lib#42 Org/lib#43");

  const outcome = await runCommand(world, PR, command);

  assert.equal(outcome.labelAdded, false);
  assert.deepEqual(world.labels(PR), []);
  assert.equal(world.commentBody(command.id), "/wait-for-merge Org/lib#42 Org/lib#43");
});

// ---------------------------------------------------------------------------------------------------------
// Updates and completion

test("icons follow the linked pull requests, and the user's own edits are kept", async () => {
  const world = createWorld({ pulls: { [PR]: {}, "Org/lib#42": {}, "Org/lib#43": {} } });
  const command = world.comment(PR, "Alice", "/wait-for-merge Org/lib#42 Org/lib#43\nThe API changes first.");
  await runCommand(world, PR, command);

  world.close("Org/lib#42");
  await runCheck(world, PR);
  assert.match(world.commentBody(command.id), /^\/wait-for-merge ❌ Org\/lib#42 ⏳ Org\/lib#43\nThe API changes first\.\n\n_Waiting/);
  assert.deepEqual(world.labels(PR), [LABEL]);

  // The user strips the icons and rewrites their text: the icons come back, the text stays.
  world.edit(command.id, "/wait-for-merge Org/lib#42 Org/lib#43\nThe new API lands first.");
  await runCommand(world, PR, command);
  assert.match(world.commentBody(command.id), /^\/wait-for-merge ❌ Org\/lib#42 ⏳ Org\/lib#43\nThe new API lands first\.\n\n_Waiting/);
  assert.deepEqual(world.reactionsOn(command.id), ["+1"]);
});

test("an approved pull request gets one ready-to-merge ping for the people who ran the command", async () => {
  const world = createWorld({
    pulls: { [PR]: {}, "Org/lib#42": {}, "Org/lib#43": {} },
    permissions: { Carol: "write" },
  });
  const first = world.comment(PR, "Alice", "/wait-for-merge Org/lib#42");
  await runCommand(world, PR, first);
  const second = world.comment(PR, "Bob", "/wait-for-merge Org/lib#43, Org/lib#42");
  await runCommand(world, PR, second);
  world.review(PR, "Carol", "APPROVED");

  world.merge("Org/lib#42");
  world.close("Org/lib#43");
  const outcome = await runCheck(world, PR);

  assert.equal(outcome.labelRemoved, true);
  assert.deepEqual(world.labels(PR), []);
  assert.equal(world.botComments(PR).length, 1);
  assert.equal(world.botComments(PR)[0].body, "@Alice @Bob This pull request is ready to merge: every pull request it was waiting on is now merged or closed.");
  assert.doesNotMatch(world.botComments(PR)[0].body, /@Author/);
  assert.match(world.commentBody(first.id), /^\/wait-for-merge ✅ Org\/lib#42\n\n_Done\._ <!-- wait-for-merge:done -->$/);
  assert.match(world.commentBody(second.id), /❌ Org\/lib#43, ✅ Org\/lib#42\n\n_Done\._/);

  const before = world.writeCount();
  await runCheck(world, PR);
  assert.equal(world.writeCount(), before);
});

test("without an approval the label is removed with no ping", async () => {
  const world = createWorld({ pulls: { [PR]: {}, "Org/lib#42": {} }, permissions: { Reader: "read" } });
  const command = world.comment(PR, "Alice", "/wait-for-merge Org/lib#42");
  await runCommand(world, PR, command);
  world.review(PR, "Reader", "APPROVED");

  world.merge("Org/lib#42");
  await runCheck(world, PR);

  assert.deepEqual(world.labels(PR), []);
  assert.deepEqual(world.botComments(PR), []);
  assert.match(noteOf(world.commentBody(command.id)), /_Done\._/);
});

test("approval means someone with write access whose latest review approves", async () => {
  const world = createWorld({
    pulls: { [PR]: {} },
    permissions: { Writer: "write", Maintainer: "maintain", Reader: "read" },
  });
  const approved = () => isPullRequestApproved(world.request, "Org/repo", 5);

  assert.equal(await approved(), false);
  world.review(PR, "Reader", "APPROVED");
  world.review(PR, "Outsider", "APPROVED");
  assert.equal(await approved(), false);
  world.review(PR, "Writer", "APPROVED");
  world.review(PR, "Writer", "COMMENTED");
  assert.equal(await approved(), true);
  world.review(PR, "Writer", "CHANGES_REQUESTED");
  assert.equal(await approved(), false);
  world.review(PR, "Maintainer", "APPROVED");
  world.review(PR, "Writer", "CHANGES_REQUESTED");
  assert.equal(await approved(), true, "another reviewer's change request does not block");
});

// ---------------------------------------------------------------------------------------------------------
// Cancelling and the label

test("removing the label by hand cancels the wait, and editing the old command does nothing", async () => {
  const world = createWorld({ pulls: { [PR]: {}, "Org/lib#42": {} } });
  const command = world.comment(PR, "Alice", "/wait-for-merge Org/lib#42");
  await runCommand(world, PR, command);

  world.label(PR, "Bob", "unlabeled");
  await runCheck(world, PR);
  assert.match(world.commentBody(command.id), /^\/wait-for-merge ⏳ Org\/lib#42\n\n_Cancelled by Bob\._ <!-- wait-for-merge:cancelled -->$/);

  world.edit(command.id, "/wait-for-merge Org/lib#42 Org/lib#42");
  const before = world.writeCount();
  const outcome = await runCommand(world, PR, command);
  assert.equal(outcome.labelAdded, false);
  assert.equal(world.writeCount(), before);

  // A fresh command starts a new wait.
  const fresh = world.comment(PR, "Alice", "/wait-for-merge Org/lib#42");
  assert.equal((await runCommand(world, PR, fresh)).labelAdded, true);
});

test("a label added by hand is taken back, and a later command still works", async () => {
  const world = createWorld({ pulls: { [PR]: {}, "Org/lib#42": {} } });
  world.label(PR, "Bob", "labeled");

  const outcome = await runCheck(world, PR);
  assert.equal(outcome.labelRemoved, true);
  assert.deepEqual(world.labels(PR), []);
  assert.deepEqual(world.botComments(PR), []);

  const command = world.comment(PR, "Alice", "/wait-for-merge Org/lib#42");
  assert.equal((await runCommand(world, PR, command)).labelAdded, true);
  assert.deepEqual(world.labels(PR), [LABEL]);
});

test("a command while a hand-added label is present replaces it with Label Sync's own", async () => {
  const world = createWorld({ pulls: { [PR]: {}, "Org/lib#42": {} } });
  world.label(PR, "Bob", "labeled");
  const command = world.comment(PR, "Alice", "/wait-for-merge Org/lib#42");

  const outcome = await runCommand(world, PR, command);
  assert.equal(outcome.labelRemoved, true);
  assert.equal(outcome.labelAdded, true);
  assert.deepEqual(world.labels(PR), [LABEL]);

  // Label Test running on the new label leaves the wait alone.
  const before = world.writeCount();
  await runCheck(world, PR);
  assert.equal(world.writeCount(), before);
  assert.match(noteOf(world.commentBody(command.id)), /_Waiting\./);
});

test("an edit that breaks the only command ends the wait", async () => {
  const world = createWorld({ pulls: { [PR]: {}, "Org/lib#42": {} } });
  const command = world.comment(PR, "Alice", "/wait-for-merge Org/lib#42");
  await runCommand(world, PR, command);

  world.edit(command.id, world.commentBody(command.id).replace("Org/lib#42", "Org/lib#42x"));
  const outcome = await runCommand(world, PR, command);

  assert.equal(outcome.labelRemoved, true);
  assert.deepEqual(world.labels(PR), []);
  assert.deepEqual(world.reactionsOn(command.id), ["-1"]);
  assert.match(noteOf(world.commentBody(command.id)), /^_Cancelled: `Org\/lib#42x` is not a pull request link\._ <!-- wait-for-merge:rejected -->$/);

  // The wait has ended, so fixing the comment now does nothing.
  world.edit(command.id, world.commentBody(command.id).replace("Org/lib#42x", "Org/lib#42"));
  assert.equal((await runCommand(world, PR, command)).labelAdded, false);
  assert.deepEqual(world.labels(PR), []);
});

test("with several commands, a broken one only drops its own links", async () => {
  const world = createWorld({ pulls: { [PR]: {}, "Org/lib#42": {}, "Org/lib#43": {} } });
  const first = world.comment(PR, "Alice", "/wait-for-merge Org/lib#42");
  await runCommand(world, PR, first);
  const second = world.comment(PR, "Bob", "/wait-for-merge Org/lib#43");
  await runCommand(world, PR, second);

  // The user deletes the link but leaves Label Sync's note line alone, as an edit usually does.
  world.edit(second.id, world.commentBody(second.id).replace(" ⏳ Org/lib#43", ""));
  await runCommand(world, PR, second);

  assert.deepEqual(world.labels(PR), [LABEL]);
  assert.deepEqual(world.reactionsOn(second.id), ["-1"]);
  assert.match(noteOf(world.commentBody(second.id)), /^_Stopped waiting: no pull request link was given\._/);
  assert.match(noteOf(world.commentBody(first.id)), /_Waiting\./);
});

test("deleting the only command ends the wait", async () => {
  const world = createWorld({ pulls: { [PR]: {}, "Org/lib#42": {} } });
  const command = world.comment(PR, "Alice", "/wait-for-merge Org/lib#42");
  await runCommand(world, PR, command);

  world.remove(PR, command.id);
  const outcome = await runCommand(world, PR, null);

  assert.equal(outcome.labelRemoved, true);
  assert.deepEqual(world.labels(PR), []);
});

test("a linked pull request that disappears during a wait breaks its command", async () => {
  const world = createWorld({ pulls: { [PR]: {}, "Org/lib#42": {} } });
  const command = world.comment(PR, "Alice", "/wait-for-merge Org/lib#42");
  await runCommand(world, PR, command);

  world.prs.delete("Org/lib#42");
  await runCheck(world, PR);

  assert.deepEqual(world.labels(PR), []);
  assert.deepEqual(world.reactionsOn(command.id), ["-1"]);
  assert.match(world.commentBody(command.id), /❓ Org\/lib#42/);
  assert.match(noteOf(world.commentBody(command.id)), /_Cancelled: `Org\/lib#42` does not exist\._/);
});

test("a linked pull request Label Sync may not read keeps the wait going", async () => {
  const world = createWorld({ pulls: { [PR]: {}, "Org/lib#42": {} } });
  const command = world.comment(PR, "Alice", "/wait-for-merge Org/lib#42");
  const request = world.request;
  world.request = async (method, apiPath, body) => {
    if (apiPath === "/repos/Org/lib/pulls/42") {
      const error = new Error("Forbidden");
      error.status = 403;
      throw error;
    }
    return request(method, apiPath, body);
  };

  assert.equal((await runCommand(world, PR, command)).labelAdded, true);
  assert.match(world.commentBody(command.id), /⏳ Org\/lib#42/);
});

// ---------------------------------------------------------------------------------------------------------
// Loops

test("a wait that would loop back to this pull request is rejected", async () => {
  const world = createWorld({ pulls: { [PR]: {}, "Org/b#1": {}, "Org/c#2": {}, "Org/d#3": {}, "Org/e#4": {} } });

  // Org/b#1 waits on this pull request, so this one may not wait on Org/b#1.
  await runCommand(world, "Org/b#1", world.comment("Org/b#1", "Alice", "/wait-for-merge Org/repo#5"));
  const direct = world.comment(PR, "Bob", "/wait-for-merge Org/b#1");
  assert.equal((await runCommand(world, PR, direct)).labelAdded, false);
  assert.deepEqual(world.reactionsOn(direct.id), ["-1"]);
  assert.match(world.commentBody(direct.id), /❓ Org\/b#1/);
  assert.match(noteOf(world.commentBody(direct.id)), /`Org\/b#1` already waits on this pull request\./);

  // Org/d#3 waits on Org/c#2, which waits on Org/b#1: still a loop, three pull requests deep.
  await runCommand(world, "Org/c#2", world.comment("Org/c#2", "Alice", "/wait-for-merge Org/b#1"));
  await runCommand(world, "Org/d#3", world.comment("Org/d#3", "Alice", "/wait-for-merge Org/c#2"));
  const chained = world.comment(PR, "Bob", "/wait-for-merge Org/d#3");
  assert.equal((await runCommand(world, PR, chained)).labelAdded, false);
  assert.match(noteOf(world.commentBody(chained.id)), /`Org\/d#3` already waits on this pull request through `Org\/c#2` → `Org\/b#1`/);

  // Org/e#4 is waiting on nothing, so waiting on it is fine.
  const fine = world.comment(PR, "Bob", "/wait-for-merge Org/e#4");
  assert.equal((await runCommand(world, PR, fine)).labelAdded, true);
});

test("a wait on a pull request whose own wait has ended is not a loop", async () => {
  const world = createWorld({ pulls: { [PR]: {}, "Org/b#1": {} } });
  await runCommand(world, "Org/b#1", world.comment("Org/b#1", "Alice", "/wait-for-merge Org/repo#5"));
  world.label("Org/b#1", "Bob", "unlabeled");

  const command = world.comment(PR, "Bob", "/wait-for-merge Org/b#1");
  assert.equal((await runCommand(world, PR, command)).labelAdded, true);
});
