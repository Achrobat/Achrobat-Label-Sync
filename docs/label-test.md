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

## Commands

People can run "/" commands in comments. Each command has its own block in `config/commands.jsonc`; leave a block empty to turn that command off.

```jsonc
{
  "waitForMerge": { "label": "Waiting on PR", "allowedUsers": "teams/maintainers, UltraProdigy" },
  "cherryPick": { "label": "Backport", "branches": ["release/**"], "allowedUsers": "teams/maintainers" },
  "release": { "allowedUsers": "teams/maintainers" },
  "team": {
    "rules": [
      { "teams": ["testers", "translators"], "allowedUsers": "teams/contributors", "adminUsers": "teams/maintainers" }
    ]
  }
}
```

These rules apply to every command:

- Who may run a command uses the same format as the other member fields: users, `teams/<slug>` teams, a comma-separated list, or an array. Teams need a token that can read team membership.
- A command must start the comment. One comment can hold several commands, one per line, including different commands.
- A command from someone who is not allowed gets a 👎 reaction and nothing else. Comments written by bots are ignored.
- Unknown commands, and commands that are turned off, are ignored without a reaction, so typos and other tools' commands are left alone.
- Nothing is stored outside the pull request or issue. Every run works out the state again from comments, the description, labels and the live state on GitHub.
- Commands act only with the configured PAT or GitHub App token. See [Authentication](authentication.md) for the extra permissions `/team` and `/cherry-pick` need.

### Wait for merge

`/wait-for-merge` lets a maintainer hold a pull request until other pull requests are merged. They comment:

```text
/wait-for-merge https://github.com/your-org/other-repo/pull/42
```

The link can be a pull request URL, `owner/repo#42`, or `#42` for a pull request in the same repository. Label Sync adds the configured label, which keeps Label Test failing, and posts one tracking comment listing what the pull request is waiting on. When every linked pull request is merged or closed, the label is removed and Label Sync comments once, mentioning the pull request author and everyone who ran the command, to say the pull request is ready to merge.

```jsonc
// config/label-test-workflow-config.jsonc
"failingLabels": ["Waiting on PR"],

// config/commands.jsonc
"waitForMerge": {
  "label": "Waiting on PR",
  "allowedUsers": "teams/maintainers, UltraProdigy",
  "allowExternalRepositories": false
}
```

- `label` must also be listed in `failingLabels` in `config/label-test-workflow-config.jsonc`, otherwise it would not block merging, and it cannot be a sticky label. Leave `label` out (the default) to turn the command off. Add the label to `config/labels.jsonc` too, so it exists with the intended color in every repository; GitHub otherwise creates it with a default color the first time it is added.
- `allowedUsers` lists who may run the command.
- `allowExternalRepositories` (default `false`) allows links to pull requests outside the organization. Label Sync must be able to read them; public repositories always work.
- Later commands add to the wait instead of replacing it. The label stays until every linked pull request is merged or closed.
- Comments are kept to two. The tracking comment is created by the first command and then edited: when another command is added, when a linked pull request merges, and when one is closed without merging while others are still open. The second comment is the ready-to-merge notice. If a linked pull request was closed without merging, the notice says so, and the label is still removed.
- Removing the label by hand cancels the wait. Commands posted before the removal no longer count, and the tracking comment is edited to say who cancelled it. Running the command again starts a new wait with a new tracking comment.
- Links to the pull request itself, links that are not pull requests, and links outside the organization (unless allowed) are listed in the tracking comment as ignored. If none of the linked pull requests are open, the label is not added. A linked pull request that Label Sync cannot read keeps the wait going, so nothing is lifted by mistake.
- Editing a command changes what the pull request waits on, and deleting the comment removes its links. If no valid links are left, the label is left in place for someone to remove. An edit that removes the leading `/` is not seen until the next check.

#### How the merge is noticed

The pull request that merges is usually in another repository, so the waiting pull request gets no event of its own. Three things check waits:

- **The central `Wait-For-Merge` workflow** in this repository finds every open pull request in the organization with the label and completes the waits that are done. It runs every three hours as a backstop, can be run by hand, and also runs on the `pull-request-closed` dispatch (see [How commands arrive](#how-commands-arrive)), so waits finish within moments. This workflow needs the configured PAT or GitHub App token, because it works across repositories. Scheduled workflows are off by default in forks until Actions is enabled for them.
- **Label Test** completes the wait when it runs on the waiting pull request and every linked pull request is already closed, then evaluates the policy without the label.
- **The command itself** completes the wait right away if the label is present and nothing is left open.

### Cherry-pick

`/cherry-pick <branch>` asks Label Sync to apply a pull request to another branch once it merges:

```text
/cherry-pick release/1.7
```

```jsonc
"cherryPick": {
  "label": "Backport",
  "branches": ["release/**"],
  "allowedUsers": "teams/maintainers"
}
```

- `branches` lists the branches you can cherry-pick into, by name or pattern. `*` matches anything except `/`, and `**` matches anything, so `release/**` matches `release/1.7` and `release/2/hotfix`.
- When the command is posted, it gets 👍 if it is valid: the branch matches `branches`, exists, and is not the branch the pull request already targets. Otherwise it gets 👎, and someone in `allowedUsers` also gets a reply saying what is wrong.
- When the pull request merges, Label Sync checks that it still has `label`. Without it nothing is cherry-picked, and the people who asked are told. The label is only checked at merge time, so it can be added after the command.
- Label Sync then opens one pull request per requested branch, from the branch `cherry-pick/<number>-to-<branch>`, titled `[<branch>] <original title>`. It carries the original labels except `label` and is assigned to the people who asked. A comment on the original pull request links to it.
- The merged changes are picked with `git cherry-pick -x` on the runner: the squashed commit for a squash merge, the merge commit against its first parent for a merge commit, or every commit of the pull request for a rebase merge. The new pull request still needs its own review and merge.
- If the changes conflict, are already on the branch, or anything else goes wrong, nothing is opened, the run fails, and the people who asked are mentioned so they can cherry-pick it by hand.
- Several people can ask for the same branch; it is cherry-picked once and they are all mentioned. A command posted after the pull request merged runs straight away. Running `Merge Commands` again does not open a second pull request.

### Release

`/release <tag>` creates a release when the pull request merges. It works in a comment or anywhere in the pull request description, on its own line:

```text
/release v2.8.0
```

```jsonc
"release": {
  "allowedUsers": "teams/maintainers"
}
```

- The release is created on the merge commit, named `<tag>`, with GitHub's generated release notes, not a draft or prerelease, and marked as the latest release. Because it is created with the configured token, workflows that run on new tags or releases start as usual.
- Only pull requests into the default branch are released.
- If the tag already exists, no release is created, the run fails, and the person who asked is mentioned. Tags are not compared or ordered, so any naming scheme works.
- In the description, the person who last edited it (or its author, if nobody has) must be in `allowedUsers`. A description last edited by a bot is ignored.
- If several releases are asked for, the latest request wins. Edit or delete it to change or cancel it before the merge.
- A comment command gets 👍 when posted, or 👎 with a reply if the tag already exists or the pull request does not target the default branch. A command posted after the merge runs straight away.

### Team

`/team add <team>` and `/team remove <team>` change team membership in the organization. They work in pull request and issue comments.

```text
/team add testers
/team remove Quest Testers
/team add testers @someone
```

```jsonc
"team": {
  "rules": [
    { "teams": ["testers", "translators"], "allowedUsers": "teams/contributors", "adminUsers": "teams/maintainers" }
  ]
}
```

- Each rule names the teams it covers by slug. `<team>` in the command can be the slug or the team's display name.
- People in `allowedUsers` can add or remove themselves. People in `adminUsers` can also add or remove anyone in the organization by mentioning them. A rule needs at least one of the two.
- Only organization members can be added, so the command never sends an organization invitation. Someone already on the team, including a team maintainer, is left as they are.
- The comment gets 👍 when every line was carried out and 👎 when any line was not. Someone covered by a rule also gets a reply saying what was wrong. If GitHub refuses a change, the person is told and the run fails.
- Edits and deletions of `/team` comments do nothing; post a new comment instead.

### How commands arrive

Commands only arrive by `repository_dispatch`. Run something that watches the organization's webhooks, such as a GitHub App's webhook handler, and have it send these to this repository:

| Webhook | Dispatch type | Handled by |
| --- | --- | --- |
| `issue_comment` on a pull request | `pull-request-comment` | `Label Test Command Dispatch` |
| `issue_comment` on an issue | `issue-comment` | `Label Test Command Dispatch` |
| `pull_request` `closed` | `pull-request-closed` | `Merge Commands` and `Wait-For-Merge` |

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

```http
POST /repos/<org>/<label-sync-repo>/dispatches
{"event_type": "pull-request-closed", "client_payload": {"repository": "owner/name", "number": 123}}
```

- For comments, `repository` is the webhook's `repository.full_name`, `number` is `issue.number`, `comment_id` is `comment.id`, and `action` is the webhook's `action`: `created`, `edited` or `deleted`. Both comment types are handled the same way.
- The sender may forward every comment event, but it saves runner time to forward only comments whose `comment.body` starts with `/` and whose `comment.user.type` is not `Bot`. Issue comments are only needed for `/team`.
- For closed pull requests, `repository` is `repository.full_name` and `number` is `pull_request.number`. Send it for every closed pull request, merged or not.
- The sender's token needs Contents write access to this repository and nothing else. One service can send all three.

The payload only says where to look. A repository outside the organization is ignored. A comment is read again from the API and ignored if it is on a different issue or pull request, was written by a bot, or does not start with `/`. A deleted comment cannot be read, so wait-for-merge reconciles its pull request without one: that can update the tracking comment or finish a wait, but it never adds the label or starts a wait. A closed pull request is read again too, and nothing happens unless it merged. A wrong or forged dispatch can therefore only make Label Sync look at something again.

Run `Merge Commands` by hand, with the repository and pull request number, to retry `/cherry-pick` and `/release` for a merged pull request.

Earlier versions could also deliver commands through a caller workflow in every repository (`"commandDelivery": "workflow"`). That is gone: `05 - Distribute-Label-Workflow` removes `.github/workflows/label-test-commands.yml` wherever it finds it, and `commandDelivery` must be deleted from `config/label-test-workflow-config.jsonc`.

## How Label Test runs

Repository-specific rules are resolved centrally from the calling workflow's existing `github.repository` context. Adding or changing these rules does not require changes to the caller workflows.

For team approval checks, the workflow token must be able to read the configured organization team membership. The same `properties.authentication` setup used by the label sync workflows is used for the reusable Label Test workflow.

The policy job runs on `pull_request_target` only. Review submissions, edits, and dismissals are recorded by a separate unprivileged workflow, then the existing Label Test workflow handles its completion through `workflow_run` and reruns the latest completed policy run for that pull request. This lets a new approval replace an earlier failed result on the same required check. If GitHub suppressed the initial run because an ignored author created the pull request with `GITHUB_TOKEN`, the review continuation posts the required successful `label-test / label-test` commit status instead. This fallback occurs only after a human review event and only when no run exists for the pull request's exact head commit; it never reuses an older run from a recycled bot branch.

Fork `pull_request_review` runs cannot access repository secrets or an `actions: write` token. The review workflow therefore only uploads the pull request number as a short-lived artifact. Its `workflow_run` continuation executes from the target repository's default branch with the configured authentication, downloads the artifact outside the workspace, and verifies the referenced pull request still has the head SHA recorded by GitHub for the review run before calling the Actions rerun API. Neither stage checks out or executes pull request code.

A pull request shows one check until someone submits a review, and two afterwards. The refresh workflow reacts to every review regardless of labels, because GitHub cannot filter a workflow trigger by pull request label, and narrowing it with a job-level condition would publish a permanently skipped check instead. Reducing this to a single check in all cases would require a GitHub App posting a check run through the Checks API rather than distributed workflows.

## 05 - Distribute-Label-Workflow

Run `05 - Distribute-Label-Workflow` manually to install or update the Label Test workflows in selected repositories. It writes these files in each selected target repository:

- `.github/workflows/label-test.yml`: the required policy check on `pull_request_target` and its privileged `workflow_run` continuation
- `.github/workflows/label-test-review-refresh.yml`: records review context without secrets for the privileged continuation

The refresh implementation remains in the central Label-Sync repository as the reusable `Refresh Label Test` workflow. Distribution also removes files from earlier layouts: `.github/workflows/label-test-review-signal.yml` (the signal now lives at `.github/workflows/label-test-review-refresh.yml`) and `.github/workflows/label-test-commands.yml` (commands now arrive by dispatch). The generated workflows call back to the repository and default branch that ran the distributor, so forks distribute callers that point to the fork.

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
