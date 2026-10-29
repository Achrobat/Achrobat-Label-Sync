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
  "waitForMerge": {
    // "label": "Waiting on PR",
    // "allowedUsers": "teams/maintainers, UltraProdigy",
    // "allowExternalRepositories": false
  },
  "commandDelivery": "workflow",
  "workflowDistribution": {
    "filterMode": "whitelist",
    "whitelist": [],
    "blacklist": [],
    "customProperties": {
      "logic": "AND",
      "rules": []
    }
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
- Restoring labels and posting the optional notice use the configured PAT or GitHub App token, which needs pull request (or issue) write access to the target repository; the `Remove-Labels` token already has this. Pull request labels and comments go through GitHub's issues API, since every pull request is also an issue.

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

## Wait for merge

`waitForMerge` lets a maintainer hold a pull request until other pull requests are merged. They comment:

```text
/wait-for-merge https://github.com/your-org/other-repo/pull/42
```

The link can be a pull request URL, `owner/repo#42`, or `#42` for a pull request in the same repository. Label Sync adds the configured label, which keeps Label Test failing, and posts one tracking comment listing what the pull request is waiting on. When every linked pull request is merged or closed, the label is removed and Label Sync comments once, mentioning the pull request author and everyone who ran the command, to say the pull request is ready to merge.

```jsonc
"failingLabels": ["Waiting on PR"],
"waitForMerge": {
  "label": "Waiting on PR",
  "allowedUsers": "teams/maintainers, UltraProdigy",
  "allowExternalRepositories": false
}
```

- `label` must also be listed in `failingLabels`, otherwise it would not block merging, and it cannot be a sticky label. Leave `label` out (the default) to turn the command off. Add the label to `config/labels.jsonc` too, so it exists with the intended color in every repository; GitHub otherwise creates it with a default color the first time it is added.
- `allowedUsers` lists who may run the command: users, `teams/<slug>` teams, a comma-separated list, or an array. A command from anyone else is ignored and gets a 👎 reaction. Commands written by bots are ignored.
- `allowExternalRepositories` (default `false`) allows links to pull requests outside the organization. Label Sync must be able to read them; public repositories always work.
- The command must start the comment. One comment can hold several commands, one per line, and later commands add to the wait instead of replacing it. The label stays until every linked pull request is merged or closed.
- Comments are kept to two. The tracking comment is created by the first command and then edited: when another command is added, when a linked pull request merges, and when one is closed without merging while others are still open. The second comment is the ready-to-merge notice. If a linked pull request was closed without merging, the notice says so, and the label is still removed.
- Removing the label by hand cancels the wait. Commands posted before the removal no longer count, and the tracking comment is edited to say who cancelled it. Running the command again starts a new wait with a new tracking comment.
- Links to the pull request itself, links that are not pull requests, and links outside the organization (unless allowed) are listed in the tracking comment as ignored. If none of the linked pull requests are open, the label is not added. A linked pull request that Label Sync cannot read keeps the wait going, so nothing is lifted by mistake.
- Editing a command changes what the pull request waits on, and deleting the comment removes its links. If no valid links are left, the label is left in place for someone to remove. An edit that removes the leading `/` is not seen until the next check.
- Nothing is stored outside the pull request. Every run works the state out again from the comments, the label history, and the live state of each linked pull request.

### How the merge is noticed

The pull request that merges is usually in another repository, so the waiting pull request gets no event of its own. Three things check waits:

- **The central `Wait-For-Merge` workflow** in this repository finds every open pull request in the organization with the label and completes the waits that are done. It runs every three hours as a backstop, can be run by hand, and also runs on a `repository_dispatch` of type `pull-request-closed`. Send that dispatch whenever a pull request in the organization closes, and waits finish within moments:

  ```http
  POST /repos/<org>/<label-sync-repo>/dispatches
  {"event_type": "pull-request-closed", "client_payload": {"repository": "owner/name", "number": 123}}
  ```

  Any service that sees the organization's `pull_request` `closed` webhook can send it. The sender's token needs Contents write access to this repository; nothing else. The payload is only logged; every pull request is read again from the API, so a wrong or forged dispatch cannot lift a label. Without a sender, the schedule alone still works, only more slowly. This workflow needs the configured PAT or GitHub App token, because it works across repositories. Scheduled workflows are off by default in forks until Actions is enabled for them.
- **Label Test** completes the wait when it runs on the waiting pull request and every linked pull request is already closed, then evaluates the policy without the label.
- **The command itself** completes the wait right away if the label is present and nothing is left open.

### How commands arrive

`commandDelivery` picks one of two paths for every `/` command in the organization. Only one is active at a time: a command that arrives the other way is ignored, so a comment is never handled twice, even while you switch between them.

| | `"workflow"` (default) | `"dispatch"` |
| --- | --- | --- |
| What notices the comment | A caller workflow in each repository | Something you run that watches the organization, such as a GitHub App's webhook handler |
| Files in each repository | `.github/workflows/label-test-commands.yml` | None; `05` removes the caller where it exists |
| Where the command runs | `Label Test Command`, called from the target repository | `Label Test Command Dispatch`, in this repository |
| Token | Configured PAT or GitHub App token | Configured PAT or GitHub App token |

Both paths run the same script, so commands behave the same way. Use `"workflow"` for an organization with nothing watching its webhooks, and `"dispatch"` where something already does. After changing it, run `05 - Distribute-Label-Workflow` so the caller is installed or removed.

#### Caller workflow and tokens

Commands arrive through a third caller workflow, `.github/workflows/label-test-commands.yml`, installed by `05 - Distribute-Label-Workflow`. It runs on `issue_comment` and only starts a runner for comments on pull requests that start with `/` and were not written by a bot. Every other comment in the repository still appears in the Actions tab as a skipped run. Commands are handled by the central `Label Test Command` reusable workflow, so new commands will not need the callers to be redistributed again. Like the review continuation, it runs from the target repository's default branch with the configured authentication and never checks out pull request code.

Commands act only with the configured PAT or GitHub App token, read from the secrets the caller inherits. The run happens in the target repository, so the secrets named in `properties.authentication` must be organization secrets that every target repository can read; Label Test and its review refresh read them the same way. There is no `GITHUB_TOKEN` fallback: without the secrets, the run fails at the token step. What a command can do is set by that token's permissions; the caller grants the workflow's own `GITHUB_TOKEN` nothing beyond reading contents. A label added or removed with the configured token starts Label Test by itself, which updates the required check. Teams in `allowedUsers` need a token that can read team membership.

#### Dispatch

With `"commandDelivery": "dispatch"`, the sender posts one `repository_dispatch` of type `pull-request-comment` to this repository for each `issue_comment` webhook it receives:

```http
POST /repos/<org>/<label-sync-repo>/dispatches
{
  "event_type": "pull-request-comment",
  "client_payload": {
    "repository": "owner/name",
    "number": 123,
    "comment_id": 456,
    "action": "created"
  }
}
```

- `repository` is the webhook's `repository.full_name`, `number` is `issue.number`, `comment_id` is `comment.id`, and `action` is the webhook's `action`: `created`, `edited` or `deleted`.
- The sender may forward every comment event, but it saves runner time to forward only comments on pull requests (`issue.pull_request` is present) whose `comment.body` starts with `/` and whose `comment.user.type` is not `Bot`. That matches what the caller workflow lets through.
- The sender's token needs Contents write access to this repository and nothing else, the same as for `pull-request-closed`. One service can send both.

The payload only says where to look. `Label Test Command Dispatch` ignores repositories outside the organization, reads the comment again from the API, and ignores it if it is on a different pull request, was written by a bot, or does not start with `/`. A deleted comment cannot be read, so its pull request is reconciled without one: that can update the tracking comment or finish a wait whose linked pull requests are all closed, but it never adds the label or starts a wait. A wrong or forged dispatch can therefore only make Label Sync look at a pull request again. Like the caller path, it acts only with the configured PAT or GitHub App token.

Repository-specific rules are resolved centrally from the calling workflow's existing `github.repository` context. Adding or changing these rules does not require changes to the caller workflows.

For team approval checks, the workflow token must be able to read the configured organization team membership. The same `properties.authentication` setup used by the label sync workflows is used for the reusable Label Test workflow.

The policy job runs on `pull_request_target` only. Review submissions, edits, and dismissals are recorded by a separate unprivileged workflow, then the existing Label Test workflow handles its completion through `workflow_run` and reruns the latest completed policy run for that pull request. This lets a new approval replace an earlier failed result on the same required check. If GitHub suppressed the initial run because an ignored author created the pull request with `GITHUB_TOKEN`, the review continuation posts the required successful `label-test / label-test` commit status instead. This fallback occurs only after a human review event and only when no run exists for the pull request's exact head commit; it never reuses an older run from a recycled bot branch.

Fork `pull_request_review` runs cannot access repository secrets or an `actions: write` token. The review workflow therefore only uploads the pull request number as a short-lived artifact. Its `workflow_run` continuation executes from the target repository's default branch with the configured authentication, downloads the artifact outside the workspace, and verifies the referenced pull request still has the head SHA recorded by GitHub for the review run before calling the Actions rerun API. Neither stage checks out or executes pull request code.

A pull request shows one check until someone submits a review, and two afterwards. The refresh workflow reacts to every review regardless of labels, because GitHub cannot filter a workflow trigger by pull request label, and narrowing it with a job-level condition would publish a permanently skipped check instead. Reducing this to a single check in all cases would require a GitHub App posting a check run through the Checks API rather than distributed workflows.

## 05 - Distribute-Label-Workflow

Run `05 - Distribute-Label-Workflow` manually to install or update the Label Test workflows in selected repositories. It writes these files in each selected target repository:

- `.github/workflows/label-test.yml`: the required policy check on `pull_request_target` and its privileged `workflow_run` continuation
- `.github/workflows/label-test-review-refresh.yml`: records review context without secrets for the privileged continuation
- `.github/workflows/label-test-commands.yml`: hands pull request comments that start with `/` to the central `Label Test Command` workflow. Only with `"commandDelivery": "workflow"`; with `"dispatch"` it is not written and is removed if present.

The refresh implementation remains in the central Label-Sync repository as the reusable `Refresh Label Test` workflow. Distribution also removes the obsolete `.github/workflows/label-test-review-signal.yml` filename if a target received that earlier layout; the signal now lives at `.github/workflows/label-test-review-refresh.yml`. The generated workflows call back to the repository and default branch that ran the distributor, so forks distribute callers that point to the fork.

Inputs:

- `dry_run`: preview without writing
- `delivery_mode`: choose `Direct Commit` or `Pull Request`
- `repositories`: optional comma-separated repository override, such as `repo-one, org/repo-two`

Target repositories are chosen by `workflowDistribution` in `config/label-test-workflow-config.jsonc`. Set its `filterMode` to `whitelist`, `blacklist`, or `customProperty`; the format matches `config/repository-filter.jsonc` and is described in [Configuration](configuration.md#repository-filter). It defaults to `whitelist` when `filterMode` is omitted.

When `repositories` is provided, it takes priority over `workflowDistribution.filterMode` and runs only on the listed non-source repositories.

`Pull Request` mode reuses the stable branch `label-sync/update-label-test-workflow` in each target repository and opens a PR if one does not already exist. Re-running the distributor updates the existing branch and PR.

The distributor skips archived repositories, empty repositories with no default-branch commit, and repositories whose available token permissions cannot perform the selected delivery mode. It then completes the branch, workflow commit, and pull request for one repository before starting the next. The first unexpected operational failure stops the run; rerunning it reuses any branch, commit, or pull request already created and continues without requiring branch cleanup.

In `Direct Commit` mode, a repository whose default branch is protected is recorded as a failure and the run continues to the next repository. Branch protection is a property of the target repository rather than an operational fault, so it says nothing about whether the remaining repositories will succeed. Rerun those repositories in `Pull Request` mode. The distributor does not attempt to bypass branch protection, and the token it uses is not granted the rights to do so.

After the workflows are merged into a target repository, make only `Label Test / label-test / label-test` required in that repository's branch protection rules. Do not require `Refresh Label Test`; it is an operational helper. The target repository's Actions policy must allow the refresher's requested `actions: write` permission so it can rerun the policy workflow.
