// A tiny in-memory GitHub for command tests. Routes are [method, anchored RegExp, handler]; the first match
// answers. Every non-GET call is recorded in `writes`. Unknown calls throw, so a test notices any request it
// did not expect.

export function httpError(status, message = `HTTP ${status}`) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function firstPage(items) {
  return ({ page }) => (page === 1 ? items : []);
}

export function createFakeGithub(routes) {
  const writes = [];

  const request = async (method, apiPath, body) => {
    const [pathOnly, queryString = ""] = apiPath.split("?");
    const query = new URLSearchParams(queryString);

    if (method !== "GET") {
      writes.push({ method, path: pathOnly, body });
    }

    for (const [routeMethod, pattern, handler] of routes) {
      if (routeMethod !== method) {
        continue;
      }

      const match = pattern.exec(pathOnly);

      if (match) {
        return handler({ match, body, query, page: Number(query.get("page") ?? 1) });
      }
    }

    throw new Error(`Unexpected ${method} ${apiPath}`);
  };

  return { request, writes };
}

export function comment(id, login, body, { type = "User", issue = "Org/repo/issues/5", createdAt = "2026-10-01T00:00:00Z" } = {}) {
  return {
    id,
    body,
    created_at: createdAt,
    issue_url: `https://api.github.com/repos/${issue}`,
    user: { login, type },
  };
}
