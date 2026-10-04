# Issue tracker: GitHub

Issues and specs for this repo live in GitHub Issues for `mathbook3948/bunaway`. Use the `gh` CLI from the repository root; it infers the repository from the Git remote.

## Conventions

- Create an issue: `gh issue create --title "..." --body-file <path>`.
- Read an issue: `gh issue view <number> --comments`. Fetch labels with `gh issue view <number> --json labels` when needed.
- List issues: `gh issue list --state open --json number,title,body,labels,comments`, with appropriate label and state filters.
- Comment on an issue: `gh issue comment <number> --body-file <path>`.
- Apply or remove labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close an issue: `gh issue close <number>`.

For multiline issue bodies and comments, write the exact text to a temporary UTF-8 file and pass it with `--body-file`.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares one number space across issues and PRs. If a bare `#<number>` is ambiguous, resolve it with `gh pr view <number>` and fall back to `gh issue view <number>`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.
