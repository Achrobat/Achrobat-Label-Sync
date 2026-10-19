# Label Test

`Label Test` is a reusable workflow that target repositories call from a small caller workflow. The single authoritative pull request check is `Label Test / label-test / label-test`; make only that check required in branch protection.

The rules live only in `config/label-test-workflow-config.jsonc` in this repository:

```jsonc
{
  "requiredLabels": [
    // "Bug",
    // "Feature"
  ],
  "failingLabels": [
    // "Blocked",
    // "Do Not Merge"
  ],
  "ignoredPullRequestAuthors": [
    // "github-actions[bot]"
  ],
  "repositoryLabels": {
    // "your-org-name/special-repo": {
    //   "requiredLabels": ["Repo Feature"],
    //   "failingLabels": ["Repo: Do Not Merge"]
    // }
  },
  "protectedLabelApprovals": [
    // { "label": "Affects Balance", "approver": "teams/admin, UltraProdigy" }
  ],
  "stickyLabels": [
    // { "label": "Affects Balance", "remover": "teams/admin, UltraProdigy" }
  ],
  "stickyLabelComment": false,
  "reviewRequests": [
    // { "label": "Requires Admin", "reviewer": "teams/admin" },
    // { "label": "Affects Balance", "reviewer": "teams/balance-team", "when": "afterApproval" }
  ],
  "workflowDistribution": {
    "whitelist": [],
    "blacklist": []
  }
}
```

Behavior:

- If `requiredLabels` is empty, the required-label gate is disabled and the check can pass with any labels or no labels.
- If `requiredLabels` has entries, a PR must have at least one matching label.
- Any matching `failingLabels` entry fails the check.
- Pull requests opened by a login in `ignoredPullRequestAuthors` pass without applying label or protected-approval rules. Login matching is case-insensitive.
- `repositoryLabels` keys must use the full, case-insensitive `owner/repository` name. Their required and failing labels are added to the organization-wide lists only for that repository.
- A repository-specific required label enables the required-label gate for that repository even when the organization-wide `requiredLabels` list is empty.
- Failing labels override required labels.
- If a protected label is present, at least one configured approver for that label must have latest effective review state `APPROVED`.
- Plain approvers such as `UltraProdigy` are GitHub users.
- Approvers prefixed with `teams/`, such as `teams/admin`, are GitHub team slugs in the configured organization.
- One entry can list several approvers separated by commas, such as `"approver": "teams/admin, UltraProdigy"`; an array of names also works. Any one of them can approve. Separate entries per approver still work.

## Sticky labels

`stickyLabels` keeps a label on a pull request once it has been applied. Anyone can add a sticky label, but only a configured `remover` can take it off. If anyone else removes it, the next Label Test run puts it back before evaluating the policy, and adds a `Sticky label restored` warning to the run naming who removed it. When `stickyLabelComment` is `true` (default `false`), the first time a label is restored on a pull request, Label Test also comments, for example: "The **Affects Balance** label is sticky and can only be removed by the admin team or UltraProdigy." Later restorations of the same label on that pull request do not comment again. The comment names removers without `@`, so it does not notify them.

- `remover` uses the same syntax as protected label approvers: a GitHub user such as `UltraProdigy`, or a team such as `teams/admin`. GitHub App bot logins such as `label-sync-app[bot]` are also accepted, so an automation identity can be allowed to remove the label.
- List several removers in one entry separated by commas, such as `"remover": "teams/admin, UltraProdigy"`, or repeat an entry with the same label. Any one of them can remove it.
- Pair a sticky label with a `protectedLabelApprovals` entry to stop authors from removing a label to skip its required approval. The label is restored in the same run that evaluates the policy, so the required check stays failing until an approver approves.
- The pull request's label history decides whether a missing sticky label was removed and by whom, using the most recent add or remove event for that label. Label Test only restores a label that was applied and then removed by someone who is not a remover. Sticky labels that were never applied to a pull request are not added.
- Pull requests opened by an `ignoredPullRequestAuthors` login are skipped, like the other label rules.
- Sticky labels are enforced on pull requests that call the Label Test workflow. Labels on issues are not affected.
- Removals made with the configured Label Sync token always take precedence, so `Remove-Labels` can remove sticky labels. Only Label Sync admins can run those workflows, so the token's identity is treated as an allowed remover: the GitHub App's `<app-slug>[bot]` login, or the PAT owner's account in PAT mode. In PAT mode, this also means the PAT owner can remove sticky labels by hand.
- Restoring labels and posting the optional notice use the configured PAT or GitHub App token, which needs pull request (or issue) write access to the target repository; the `Remove-Labels` token already has this. Pull request labels and comments go through GitHub's issues API, since every pull request is also an issue. Without a configured token, the reusable workflow's `GITHUB_TOKEN` with `pull-requests: write` is used instead; a label restored with `GITHUB_TOKEN` does not start another Label Test run.

## Review requests

`reviewRequests` asks a user or team to review a pull request that has a label. Each entry pairs one label with one `reviewer`, using the same user or `teams/<slug>` syntax as protected label approvers. Bot logins cannot be reviewers. Repeat an entry with the same label to request several reviewers.

```jsonc
"reviewRequests": [
  { "label": "Requires Admin", "reviewer": "teams/admin" },
  { "label": "Affects Balance", "reviewer": "teams/balance-team", "when": "afterApproval" },
  { "label": "Needs Art Review", "reviewer": "teams/art", "when": "afterApproval", "approvedBy": "teams/developers, UltraProdigy" }
]
```

- `"when": "labeled"` (the default) requests the reviewer as soon as the label is on the pull request.
- `"when": "afterApproval"` waits until someone with write access to the repository, who is not the reviewer and not on the reviewer team, has a current approval, then requests the reviewer. Approvals from people without write access, such as contributors from outside the organization or members with only read or triage access, never trigger the request. This fits a code review followed by a specialist review: a developer approves, then the Balance Team is requested. If a Balance Team member approves first, nothing is requested, because the team has already signed off.
- `approvedBy` (optional, only with `afterApproval`) sets which approvals count in order to trigger the request. Only approvals from the listed users or team members trigger it; for example, with `"approvedBy": "teams/developers"`, an approval from a random contributor does not request the Balance Team, but one from a developer does. It accepts one value, a comma-separated list, or an array. Listed users and team members still need write access. Without it, any approval from someone with write access outside the reviewer team triggers the request.
- `approvedBy` only affects when the review is requested. It does not affect whether Label Test passes; use `protectedLabelApprovals` to require the reviewer team's approval.
- Nothing is requested once the reviewer (or a member of the reviewer team) has a current approval, on draft pull requests (the `ready_for_review` run picks them up), for the pull request author, or for pull requests opened by an `ignoredPullRequestAuthors` login.
- Each reviewer is requested once per label application, and for `afterApproval` once per new triggering approval. If the pull request timeline already shows a review request for that reviewer since then, Label Test does not request again. GitHub clears a team request when a team member reviews, and a person may remove a request by hand; neither is undone. A new approval after a push, or removing and re-adding the label, requests the reviewer again.
- When the label is removed, a still-pending request for that reviewer is withdrawn, but only if Label Sync made the request and no other label still on the pull request maps to the same reviewer. Requests made by people are left alone.
- Write access is checked with GitHub's repository permission API (`admin`, `maintain` and `write` count; `triage` and `read` do not), once per approver per run. Reviewers who are not an owner, organization member or collaborator are rejected without an API call, using the relationship GitHub records on the review.
- Review requests never change the Label Test result. Requests and withdrawals add a `Review requested` or `Review request withdrawn` notice to the run, and failures add a `Review request failed` warning.
- Approvals reach Label Test through the review refresh rerun described below, so `afterApproval` works for fork pull requests and needs no changes to the caller workflows.
- Requests use the configured PAT or GitHub App token. GitHub does not let the default `GITHUB_TOKEN` request team reviews, so team reviewers need the configured token, which needs pull request write access. The team must also have access to the repository, or GitHub rejects the request; the warning names the team. User reviewers must be able to access the repository.
- Combine `afterApproval` with a matching `protectedLabelApprovals` entry (and optionally `stickyLabels`) to require the team's approval as well as request it.

Repository-specific rules are resolved centrally from the calling workflow's existing `github.repository` context. Adding or changing these rules does not require changes to the caller workflows.

For team approval checks, the workflow token must be able to read the configured organization team membership. The same `properties.authentication` setup used by the label sync workflows is used for the reusable Label Test workflow.

The policy job runs on `pull_request_target` only. Review submissions, edits, and dismissals are recorded by a separate unprivileged workflow, then the existing Label Test workflow handles its completion through `workflow_run` and reruns the latest completed policy run for that pull request. This lets a new approval replace an earlier failed result on the same required check. If GitHub suppressed the initial run because an ignored author created the pull request with `GITHUB_TOKEN`, the review continuation posts the required successful `label-test / label-test` commit status instead. This fallback occurs only after a human review event and only when no run exists for the pull request's exact head commit; it never reuses an older run from a recycled bot branch.

Fork `pull_request_review` runs cannot access repository secrets or an `actions: write` token. The review workflow therefore only uploads the pull request number as a short-lived artifact. Its `workflow_run` continuation executes from the target repository's default branch with the configured authentication, downloads the artifact outside the workspace, and verifies the referenced pull request still has the head SHA recorded by GitHub for the review run before calling the Actions rerun API. Neither stage checks out or executes pull request code.

A pull request shows one check until someone submits a review, and two afterwards. The refresh workflow reacts to every review regardless of labels, because GitHub cannot filter a workflow trigger by pull request label, and narrowing it with a job-level condition would publish a permanently skipped check instead. Reducing this to a single check in all cases would require a GitHub App posting a check run through the Checks API rather than distributed workflows.

## 05 - Distribute-Label-Workflow

Run `05 - Distribute-Label-Workflow` manually to install or update the Label Test workflows in selected repositories. It writes these files in each selected target repository:

- `.github/workflows/label-test.yml`: the required policy check on `pull_request_target` and its privileged `workflow_run` continuation
- `.github/workflows/label-test-review-refresh.yml`: records review context without secrets for the privileged continuation

The refresh implementation remains in the central Label-Sync repository as the reusable `Refresh Label Test` workflow. Distribution also removes the obsolete `.github/workflows/label-test-review-signal.yml` filename if a target received that earlier layout; the signal now lives at `.github/workflows/label-test-review-refresh.yml`. The generated workflows call back to the repository and default branch that ran the distributor, so forks distribute callers that point to the fork.

Inputs:

- `dry_run`: preview without writing
- `repository_selection_mode`: choose `whitelist` or `blacklist` from `config/label-test-workflow-config.jsonc`
- `delivery_mode`: choose `Direct Commit` or `Pull Request`
- `repositories`: optional comma-separated repository override, such as `repo-one, org/repo-two`

When `repositories` is provided, it takes priority over `repository_selection_mode` and runs only on the listed non-source repositories.

`Pull Request` mode reuses the stable branch `label-sync/update-label-test-workflow` in each target repository and opens a PR if one does not already exist. Re-running the distributor updates the existing branch and PR.

The distributor skips archived repositories, empty repositories with no default-branch commit, and repositories whose available token permissions cannot perform the selected delivery mode. It then completes the branch, workflow commit, and pull request for one repository before starting the next. The first unexpected operational failure stops the run; rerunning it reuses any branch, commit, or pull request already created and continues without requiring branch cleanup.

In `Direct Commit` mode, a repository whose default branch is protected is recorded as a failure and the run continues to the next repository. Branch protection is a property of the target repository rather than an operational fault, so it says nothing about whether the remaining repositories will succeed. Rerun those repositories in `Pull Request` mode. The distributor does not attempt to bypass branch protection, and the token it uses is not granted the rights to do so.

After the workflows are merged into a target repository, make only `Label Test / label-test / label-test` required in that repository's branch protection rules. Do not require `Refresh Label Test`; it is an operational helper. The target repository's Actions policy must allow the refresher's requested `actions: write` permission so it can rerun the policy workflow.
