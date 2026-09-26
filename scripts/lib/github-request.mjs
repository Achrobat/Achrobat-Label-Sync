import { setTimeout as sleepTimer } from "node:timers/promises";

const mutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const maxRateLimitRetries = 5;

function retryAfterMilliseconds(value, now) {
  if (!value?.trim()) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

// Keep one client per transfer and call it serially so all label mutations share
// the same pacing window. Only explicit rate-limit rejections are safe to retry.
export function createGithubRequest(token, { sleep = sleepTimer, now = Date.now } = {}) {
  let nextWriteAt = 0;

  return async (method, apiPath, body) => {
    const isMutation = mutationMethods.has(method);
    for (let retry = 0; ; retry += 1) {
      const pacingDelay = nextWriteAt - now();
      if (isMutation && pacingDelay > 0) await sleep(pacingDelay);

      const response = await fetch(`https://api.github.com${apiPath}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "label-sync",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (isMutation) nextWriteAt = now() + 1000;
      if (response.ok) return response.status === 204 ? null : response.json();

      const message = await response.text();
      const primaryLimitExhausted = response.headers.get("x-ratelimit-remaining") === "0";
      const rateLimited = response.status === 429 || (response.status === 403 && (
        primaryLimitExhausted
        || response.headers.has("retry-after")
        || /rate limit|abuse detection/i.test(message)
      ));
      if (!rateLimited || retry === maxRateLimitRetries) {
        const exhausted = rateLimited ? ` (rate limit persisted after ${maxRateLimitRetries} retries)` : "";
        throw new Error(`${method} ${apiPath} failed with ${response.status}: ${message}${exhausted}`);
      }

      const currentTime = now();
      const resetSeconds = Number(response.headers.get("x-ratelimit-reset"));
      const resetDelay = primaryLimitExhausted && Number.isFinite(resetSeconds) && resetSeconds > 0
        ? Math.max(0, resetSeconds * 1000 - currentTime + 1000)
        : 0;
      const waitMilliseconds = Math.max(
        60000 * (2 ** retry),
        retryAfterMilliseconds(response.headers.get("retry-after"), currentTime),
        resetDelay,
      );
      console.warn(`GitHub rate limit on ${method} ${apiPath}. Waiting ${Math.ceil(waitMilliseconds / 1000)}s before retry ${retry + 1}/${maxRateLimitRetries}.`);
      await sleep(waitMilliseconds);
    }
  };
}
