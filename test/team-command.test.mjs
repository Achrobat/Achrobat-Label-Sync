import assert from "node:assert/strict";
import test from "node:test";

import { validateCommandsConfig } from "../scripts/lib/config-validation.mjs";
import { parseTeamCommand, runTeamCommands } from "../scripts/lib/team-command.mjs";
import { comment, createFakeGithub, firstPage, httpError } from "./helpers/fake-github.mjs";

const config = validateCommandsConfig({
  team: {
    rules: [
      { teams: ["testers", "teams/translators"], allowedUsers: "teams/contributors, Carol", adminUsers: "Admin" },
      { teams: "artists", adminUsers: "teams/art-leads" },
    ],
  },
}, { labelTestWorkflowConfig: {} });

// Org members: Alice, Bob, Carol, Admin, Lead. Team memberships start from `memberships`.
function createGithub({ memberships = {}, failPut = false } = {}) {
  const teams = new Map(Object.entries(memberships).map(([slug, members]) => [slug, new Map(Object.entries(members))]));
  const state = { teams, posted: [], reactions: [] };
  const fake = createFakeGithub([
    ["GET", /^\/orgs\/Org\/teams$/, firstPage([
      { slug: "testers", name: "Quest Testers" },
      { slug: "translators", name: "Translators" },
      { slug: "admins", name: "Admins" },
    ])],
    ["GET", /^\/orgs\/Org\/teams\/([\w-]+)\/memberships\/(\w+)$/, ({ match }) => {
      const found = teams.get(match[1])?.get(match[2]);
      if (!found) {
        throw httpError(404);
      }
      return { state: "active", role: found };
    }],
    ["GET", /^\/orgs\/Org\/members\/(\w+)$/, ({ match }) => {
      if (!["Alice", "Bob", "Carol", "Admin", "Lead"].includes(match[1])) {
        throw httpError(404);
      }
      return null;
    }],
    ["PUT", /^\/orgs\/Org\/teams\/([\w-]+)\/memberships\/(\w+)$/, ({ match, body }) => {
      if (failPut) {
        throw httpError(403, "Resource not accessible by integration");
      }
      if (!teams.has(match[1])) {
        teams.set(match[1], new Map());
      }
      teams.get(match[1]).set(match[2], body.role);
      return { state: "active" };
    }],
    ["DELETE", /^\/orgs\/Org\/teams\/([\w-]+)\/memberships\/(\w+)$/, ({ match }) => {
      teams.get(match[1])?.delete(match[2]);
      return null;
    }],
    ["POST", /^\/repos\/Org\/repo\/issues\/comments\/1\/reactions$/, ({ body }) => {
      state.reactions.push(body.content);
      return {};
    }],
    ["POST", /^\/repos\/Org\/repo\/issues\/5\/comments$/, ({ body }) => {
      state.posted.push(body.body);
      return {};
    }],
  ]);
  return { ...fake, state };
}

const teamMembers = { contributors: ["Alice", "Bob"], "art-leads": ["Lead"] };

async function run(github, login, body) {
  const commands = body.split("\n").map((line) => ({ name: "team", args: line.trim().split(/\s+/).slice(1) }));
  return runTeamCommands({
    request: github.request,
    config,
    organization: "Org",
    repository: "Org/repo",
    number: 5,
    comment: comment(1, login, body),
    commands,
    isTeamMember: async (slug, member) => (teamMembers[slug] ?? []).includes(member),
    log: () => {},
  });
}

function members(github, slug) {
  return [...(github.state.teams.get(slug)?.keys() ?? [])];
}

test("team rules are validated", () => {
  assert.deepEqual(config.team.rules[0].teams, ["testers", "translators"]);
  assert.deepEqual(config.team.rules[1].allowedUsers, []);
  assert.equal(validateCommandsConfig({ team: { rules: [] } }, { labelTestWorkflowConfig: {} }).team, null);
  assert.throws(() => validateCommandsConfig({ team: { rules: [{ teams: ["a"] }] } }, { labelTestWorkflowConfig: {} }), /needs "allowedUsers", "adminUsers", or both/);
  assert.throws(() => validateCommandsConfig({ team: { rules: [{ allowedUsers: "A" }] } }, { labelTestWorkflowConfig: {} }), /needs "teams"/);
  assert.throws(() => validateCommandsConfig({ team: { rules: [{ teams: ["a b"], allowedUsers: "A" }] } }, { labelTestWorkflowConfig: {} }), /invalid characters/);
  assert.throws(() => validateCommandsConfig({ team: { rules: [{ teams: ["a", "A"], allowedUsers: "A" }] } }, { labelTestWorkflowConfig: {} }), /more than once/);
});

test("parseTeamCommand reads the action, a team name with spaces, and mentioned users", () => {
  assert.deepEqual(parseTeamCommand(["add", "Quest", "Testers", "@Bob"]), { action: "add", team: "Quest Testers", users: ["Bob"] });
  assert.deepEqual(parseTeamCommand(["REMOVE", "testers"]), { action: "remove", team: "testers", users: [] });
  assert.ok(parseTeamCommand(["join", "testers"]).error);
  assert.ok(parseTeamCommand(["add"]).error);
  assert.ok(parseTeamCommand(["add", "testers", "@bad_name!"]).error);
});

test("an allowed person adds and removes themselves", async () => {
  const github = createGithub();

  await run(github, "Alice", "/team add testers");
  assert.deepEqual(members(github, "testers"), ["Alice"]);
  assert.equal(github.state.teams.get("testers").get("Alice"), "member");

  await run(github, "Alice", "/team remove testers");
  assert.deepEqual(members(github, "testers"), []);
  assert.deepEqual(github.state.reactions, ["+1", "+1"]);
  assert.deepEqual(github.state.posted, []);
});

test("a team can be named by its display name", async () => {
  const github = createGithub();

  await run(github, "Carol", "/team add Quest Testers");

  assert.deepEqual(members(github, "testers"), ["Carol"]);
});

test("someone no rule covers only gets a thumbs down", async () => {
  const github = createGithub();

  await run(github, "Mallory", "/team add testers");

  assert.deepEqual(members(github, "testers"), []);
  assert.deepEqual(github.state.reactions, ["-1"]);
  assert.deepEqual(github.state.posted, []);
});

test("only admins change other people's membership", async () => {
  const github = createGithub();

  await run(github, "Alice", "/team add testers @Bob");
  assert.deepEqual(members(github, "testers"), []);
  assert.deepEqual(github.state.reactions, ["-1"]);
  assert.match(github.state.posted[0], /@Alice .*not carried out[\s\S]*not allowed to change other people's membership of testers/);

  await run(github, "Admin", "/team add testers @Bob @Carol");
  assert.deepEqual(members(github, "testers"), ["Bob", "Carol"]);

  // An admin-only rule: team leads manage artists, but nobody can add themselves through allowedUsers.
  await run(github, "Lead", "/team add artists @Alice");
  assert.deepEqual(members(github, "artists"), ["Alice"]);
  await run(github, "Alice", "/team remove artists");
  assert.deepEqual(members(github, "artists"), ["Alice"]);
});

test("teams no rule covers are refused, and covered people are told why", async () => {
  const github = createGithub();

  await run(github, "Alice", "/team add admins");

  assert.deepEqual(members(github, "admins"), []);
  assert.deepEqual(github.state.reactions, ["-1"]);
  assert.match(github.state.posted[0], /"admins" is not a team the \/team command manages/);
});

test("existing membership is left alone, so a maintainer is never demoted", async () => {
  const github = createGithub({ memberships: { testers: { Alice: "maintainer" } } });

  const outcome = await run(github, "Alice", "/team add testers");

  assert.equal(github.state.teams.get("testers").get("Alice"), "maintainer");
  assert.equal(outcome.unchanged.length, 1);
  assert.ok(!github.writes.some((write) => write.method === "PUT"));
  assert.deepEqual(github.state.reactions, ["+1"]);
});

test("only organization members are added, so no invitation is sent", async () => {
  const github = createGithub();

  await run(github, "Admin", "/team add testers @Stranger");

  assert.deepEqual(members(github, "testers"), []);
  assert.match(github.state.posted[0], /Stranger is not a member of the Org organization/);
});

test("a membership change GitHub refuses is reported and fails the run", async () => {
  const github = createGithub({ failPut: true });

  await assert.rejects(run(github, "Alice", "/team add testers"), /Resource not accessible by integration/);

  assert.deepEqual(github.state.reactions, ["-1"]);
  assert.match(github.state.posted[0], /@Alice[\s\S]*could not change the membership/);
});
