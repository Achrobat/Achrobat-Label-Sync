import { normalizeName } from "./config-utils.mjs";
import { getAllPages } from "./wait-for-merge-runner.mjs";
import { addReaction, createMemberChecker, mention, notice, postComment, warn } from "./command-utils.mjs";

// /team add <team> and /team remove <team> change team membership in the organization. Each rule in
// config/commands.jsonc "team" names the teams it covers: people in its "allowedUsers" may add or remove
// themselves, and people in its "adminUsers" may also name others with "@login". <team> is a team slug or its
// display name. Works in pull request and issue comments. Only organization members can be added, so the
// command never sends an organization invitation.
//
// The comment gets 👍 when every line was carried out and 👎 when any line was not allowed or could not be
// done. Someone covered by a rule also gets a reply saying what was wrong; anyone else only sees the 👎.

export const TEAM_COMMAND = "team";
const ACTIONS = ["add", "remove"];

export function isTeamCommandEnabled(config) {
  return Boolean(config?.team?.rules?.length);
}

export function parseTeamCommand(args) {
  const [action, ...rest] = args ?? [];
  const users = rest.filter((item) => item.startsWith("@")).map((item) => item.slice(1)).filter(Boolean);
  const team = rest.filter((item) => !item.startsWith("@")).join(" ").trim();

  if (!ACTIONS.includes(String(action ?? "").toLowerCase())) {
    return { error: 'the first word after /team must be "add" or "remove"' };
  }

  if (!team) {
    return { error: "no team was named" };
  }

  if (users.some((login) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login))) {
    return { error: "a mentioned user is not a valid GitHub username" };
  }

  return { action: action.toLowerCase(), team, users };
}

function createTeamResolver(request, organization) {
  let teamsPromise = null;

  // Matches a configured slug first, so the common case needs no API call. Otherwise the organization's teams
  // are listed once to match a display name.
  return async (name, configuredSlugs) => {
    const direct = configuredSlugs.find((slug) => normalizeName(slug) === normalizeName(name));

    if (direct) {
      return direct;
    }

    teamsPromise ??= getAllPages(request, `/orgs/${encodeURIComponent(organization)}/teams`);
    const teams = await teamsPromise;
    const found = teams.find((team) => normalizeName(team?.name ?? "") === normalizeName(name)
      || normalizeName(team?.slug ?? "") === normalizeName(name));

    return found && configuredSlugs.find((slug) => normalizeName(slug) === normalizeName(found.slug)) || null;
  };
}

async function isOrganizationMember(request, organization, login) {
  try {
    await request("GET", `/orgs/${encodeURIComponent(organization)}/members/${encodeURIComponent(login)}`);
    return true;
  } catch (error) {
    if (error.status === 404 || error.status === 302) {
      return false;
    }
    throw error;
  }
}

async function getTeamMembershipState(request, organization, slug, login) {
  try {
    const membership = await request(
      "GET",
      `/orgs/${encodeURIComponent(organization)}/teams/${encodeURIComponent(slug)}/memberships/${encodeURIComponent(login)}`,
    );
    return membership?.state ?? "active";
  } catch (error) {
    if (error.status === 404) {
      return null;
    }
    throw error;
  }
}

export async function runTeamCommands({
  request,
  config,
  organization,
  repository,
  number,
  comment,
  commands,
  isTeamMember,
  log = console.log,
}) {
  const rules = config.team.rules;
  const commenter = comment.user.login;
  const configuredSlugs = [...new Set(rules.flatMap((rule) => rule.teams))];
  const resolveTeam = createTeamResolver(request, organization);
  const checkers = rules.map((rule) => ({
    rule,
    isAllowed: createMemberChecker(rule.allowedUsers, isTeamMember),
    isAdmin: createMemberChecker(rule.adminUsers, isTeamMember),
  }));
  const outcome = { applied: [], unchanged: [], rejected: [], failed: [] };
  let coveredByAnyRule = false;

  for (const checker of checkers) {
    if (await checker.isAllowed(commenter) || await checker.isAdmin(commenter)) {
      coveredByAnyRule = true;
      break;
    }
  }

  for (const { args } of commands) {
    const line = `/team ${args.join(" ")}`.trim();
    const parsed = parseTeamCommand(args);

    if (parsed.error) {
      outcome.rejected.push({ line, reason: parsed.error });
      continue;
    }

    let slug;

    try {
      slug = await resolveTeam(parsed.team, configuredSlugs);
    } catch (error) {
      outcome.failed.push({ line, reason: error.message });
      continue;
    }

    if (!slug) {
      outcome.rejected.push({ line, reason: `"${parsed.team}" is not a team the /team command manages` });
      continue;
    }

    const covering = checkers.filter((checker) => checker.rule.teams.some((team) => normalizeName(team) === normalizeName(slug)));
    const targets = parsed.users.length > 0 ? parsed.users : [commenter];

    for (const target of targets) {
      const isSelf = normalizeName(target) === normalizeName(commenter);
      let allowed = false;

      for (const checker of covering) {
        if (await checker.isAdmin(commenter) || (isSelf && await checker.isAllowed(commenter))) {
          allowed = true;
          break;
        }
      }

      const description = `${parsed.action} ${target} ${parsed.action === "add" ? "to" : "from"} ${slug}`;

      if (!allowed) {
        outcome.rejected.push({
          line,
          reason: isSelf
            ? `you are not allowed to ${parsed.action} yourself ${parsed.action === "add" ? "to" : "from"} ${slug}`
            : `you are not allowed to change other people's membership of ${slug}`,
          notAllowed: true,
        });
        continue;
      }

      try {
        const state = await getTeamMembershipState(request, organization, slug, target);
        const membershipPath = `/orgs/${encodeURIComponent(organization)}/teams/${encodeURIComponent(slug)}/memberships/${encodeURIComponent(target)}`;

        if (parsed.action === "add") {
          if (state) {
            outcome.unchanged.push({ line, description });
            continue;
          }

          if (!(await isOrganizationMember(request, organization, target))) {
            outcome.rejected.push({ line, reason: `${target} is not a member of the ${organization} organization` });
            continue;
          }

          await request("PUT", membershipPath, { role: "member" });
        } else {
          if (!state) {
            outcome.unchanged.push({ line, description });
            continue;
          }

          await request("DELETE", membershipPath);
        }

        outcome.applied.push({ line, description });
        notice(log, "Team membership changed", `${commenter} ran ${line}: ${description}.`);
      } catch (error) {
        outcome.failed.push({ line, reason: error.message });
      }
    }
  }

  const problems = [...outcome.rejected, ...outcome.failed];
  await addReaction({ request, repository, commentId: comment.id, content: problems.length > 0 ? "-1" : "+1", log });

  for (const problem of outcome.rejected) {
    notice(log, "Team command ignored", `${commenter} ran ${problem.line}: ${problem.reason}.`);
  }

  // A reply explains mistakes to people the command is meant for. Failures always get one, because something
  // went wrong on Label Sync's side and the person should know nothing happened.
  if (outcome.failed.length > 0 || (coveredByAnyRule && outcome.rejected.length > 0)) {
    const lines = [
      `${mention([commenter])} some of your \`/team\` commands were not carried out:`,
      "",
      ...outcome.rejected.filter((problem) => coveredByAnyRule || !problem.notAllowed)
        .map((problem) => `- \`${problem.line}\`: ${problem.reason}.`),
      ...outcome.failed.map((problem) => `- \`${problem.line}\`: Label Sync could not change the membership. Please ask an organization owner to do it.`),
    ];

    try {
      await postComment({ request, repository, number, body: lines.join("\n") });
    } catch (error) {
      warn(log, "Team command reply failed", error.message);
    }
  }

  if (outcome.failed.length > 0) {
    const error = new Error(`Team command failed: ${outcome.failed.map((problem) => `${problem.line}: ${problem.reason}`).join("; ")}`);
    error.outcome = outcome;
    throw error;
  }

  return outcome;
}
