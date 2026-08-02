# Single Label Test Check Design

## Problem

The generated Label Test caller currently runs the same required job for both
`pull_request_target` and `pull_request_review`. GitHub creates an independent
check suite for each event, so a successful review-triggered run does not
replace an earlier failed label-triggered run. Both checks remain required and
the stale failure blocks merging.

## Selected Design

Keep `pull_request_target` as the only event that executes the required Label
Test. Distribute a second workflow whose sole responsibility is responding to
`pull_request_review` events and rerunning the latest completed
`pull_request_target` Label Test run associated with the same pull request.

The rerun uses the original workflow run, event, commit association, and check
identity. The policy script already reads the current labels and reviews from
the GitHub API, so the new attempt evaluates the latest review state and
updates the one authoritative required check.

The review refresher is an operational helper rather than a policy check. It
has a distinct workflow and job name and must not be configured as required.

## Components and Data Flow

1. The distributed `.github/workflows/label-test.yml` listens only to
   `pull_request_target` and calls the existing central reusable Label Test.
2. The distributed `.github/workflows/label-test-review-refresh.yml` listens to
   submitted, edited, and dismissed `pull_request_review` events.
3. The review workflow grants `actions: write` and calls a new central reusable
   workflow with the target repository and pull request number.
4. The central refresher checks out the Label Sync repository and runs a
   focused Node script.
5. The script lists `pull_request_target` runs for the distributed Label Test
   workflow, selects the newest completed run associated with the pull request,
   and requests a rerun through the Actions API.

## Failure Handling

The refresher fails with a clear message when no completed authoritative run
exists for the pull request. GitHub API failures include the request method,
path, response status, and response body. The script never logs tokens.

## Distribution

The distributor manages both generated workflow files as one logical delivery.
Direct-commit, pull-request, dry-run, unchanged, and failure reporting behavior
remain consistent with the existing distributor. Existing target repositories
receive the review refresher the next time the distribution workflow runs.

## Testing

- Unit-test the rerun selector against runs for other PRs, other events, and
  incomplete runs.
- Unit-test the rerun request and the no-matching-run error.
- Update generator tests to prove that the required caller no longer listens
  for reviews and that the review refresher has a distinct name and
  `actions: write` permission.
- Extend distribution tests to cover writing and comparing both generated
  files without regressing direct-commit, pull-request, or dry-run behavior.
- Run the full Node test suite and config validation.

## Alternatives Considered

- A custom Checks API integration could expose literally one custom check, but
  it requires new GitHub App permissions and branch-protection migration.
- A long-running job could poll for reviews, but it wastes runner time, has a
  finite timeout, and would not respond cleanly to later label or review
  changes.
- Keeping both event-triggered policy jobs preserves the current merge blocker
  and is therefore rejected.
