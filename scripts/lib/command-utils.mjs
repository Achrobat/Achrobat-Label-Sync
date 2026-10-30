import { normalizeName } from "./config-utils.mjs";

// Helpers shared by the "/" commands. Every helper that talks to GitHub takes a request(method, apiPath, body)
// function that resolves with the parsed JSON (null for 204) and rejects with an Error carrying `status`.

const COMMAND_LINE_PATTERN = /^\s*\/([A-Za-z][A-Za-z0-9-]*)(?=\s|$)(.*)$/;

// Commands must start the comment. Every line of that comment that starts with "/" is read, so one comment can
// hold several commands. Returns { name, args } per command line, with the name lowercased and the arguments
// split on whitespace.
export function parseCommandLines(body, { requireLeadingCommand = true } = {}) {
  if (typeof body !== "string" || (requireLeadingCommand && !body.trimStart().startsWith("/"))) {
    return [];
  }

  const commands = [];

  for (const line of body.split(/\r?\n/)) {
    const match = COMMAND_LINE_PATTERN.exec(line);

    if (match) {
      commands.push({ name: match[1].toLowerCase(), args: match[2].trim().split(/\s+/).filter(Boolean) });
    }
  }

  return commands;
}

// Checks a login against a validated member list (users and "teams/<slug>" teams), caching each answer.
export function createMemberChecker(members, isTeamMember) {
  const cache = new Map();

  return async (login) => {
    if (typeof login !== "string" || !login) {
      return false;
    }

    const key = normalizeName(login);

    if (!cache.has(key)) {
      cache.set(key, (async () => {
        for (const member of members ?? []) {
          if (member.type === "user" && normalizeName(member.login) === key) {
            return true;
          }

          if (member.type === "team" && await isTeamMember(member.slug, login)) {
            return true;
          }
        }

        return false;
      })());
    }

    return cache.get(key);
  };
}

export function isBotUser(user) {
  return user?.type === "Bot" || /\[bot\]$/i.test(String(user?.login ?? ""));
}

export function escapeWorkflowCommand(value) {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export function warn(log, title, message) {
  log(`::warning title=${title}::${escapeWorkflowCommand(message)}`);
}

export function notice(log, title, message) {
  log(`::notice title=${title}::${escapeWorkflowCommand(message)}`);
}

// Reactions are acknowledgements only, so a failure to add one is logged and never stops a command.
export async function addReaction({ request, repository, commentId, content, log = console.log }) {
  try {
    await request("POST", `/repos/${repository}/issues/comments/${commentId}/reactions`, { content });
    return true;
  } catch (error) {
    warn(log, "Reaction failed", error.message);
    return false;
  }
}

export async function postComment({ request, repository, number, body }) {
  return request("POST", `/repos/${repository}/issues/${number}/comments`, { body });
}

export function mention(logins) {
  const unique = [];

  for (const login of logins ?? []) {
    if (login && !unique.some((item) => normalizeName(item) === normalizeName(login))) {
      unique.push(login);
    }
  }

  return unique.map((login) => `@${login}`).join(" ");
}

// The login behind the configured token: "<app-slug>[bot]" for a GitHub App (from LABEL_SYNC_TOKEN_LOGIN,
// because installation tokens cannot read /user) or the PAT owner.
export async function resolveTokenLogin(request) {
  if (process.env.LABEL_SYNC_TOKEN_LOGIN) {
    return process.env.LABEL_SYNC_TOKEN_LOGIN;
  }

  try {
    const user = await request("GET", "/user");
    return typeof user?.login === "string" ? user.login : null;
  } catch {
    return null;
  }
}

// Commits Label Sync makes are attributed to the token's identity, using GitHub's noreply address so they link
// to that account.
export async function resolveCommitIdentity(request) {
  const login = await resolveTokenLogin(request);

  if (!login) {
    return { name: "Label Sync", email: "label-sync@users.noreply.github.com" };
  }

  try {
    const user = await request("GET", `/users/${encodeURIComponent(login)}`);

    if (Number.isSafeInteger(user?.id)) {
      return { name: login, email: `${user.id}+${login}@users.noreply.github.com` };
    }
  } catch {
    // Fall through to the address without an id.
  }

  return { name: login, email: `${login}@users.noreply.github.com` };
}

// Branch patterns: "*" matches anything except "/", "**" matches anything including "/". Matching ignores
// nothing else, so "release/1.7" only matches itself or a pattern.
export function branchMatchesPattern(branch, pattern) {
  const expression = String(pattern)
    .split("**")
    .map((part) => part.split("*").map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${expression}$`).test(String(branch));
}

// Roughly git's check-ref-format rules, plus no leading "-", so a tag or branch name is safe to pass to git and
// the API.
export function isValidRefName(value) {
  const name = String(value ?? "");
  return name.length > 0
    && name.length <= 200
    && !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name)
    && !name.includes("..")
    && !name.includes("@{")
    && !name.includes("//")
    && !name.startsWith("/")
    && !name.startsWith("-")
    && !name.endsWith("/")
    && !name.endsWith(".")
    && !name.endsWith(".lock")
    && name !== "@";
}
