---
name: interrogate
description: "Use for \"interrogate\", \"adversarial review\", \"multi-reviewer review\", \"challenge this\", \"stress test this code\", \"find blind spots\", or \"tear this apart\". Independent reviewers in fresh contexts challenge changes from independent angles."
disable-model-invocation: true
---

# Interrogate

Sibling skills named in bold, such as the **how** skill, live next to this one. To run one, read `${CLAUDE_SKILL_DIR}/../<name>/SKILL.md` and follow it, and treat a `/name` in these steps the same way. Principles are `${CLAUDE_SKILL_DIR}/../principles/<name>.md`. Do not call siblings through the `Skill` tool, because they are user-invoked only.

Spawn independent reviewers in fresh contexts to adversarially review code changes. The adversarial signal comes from independent contexts that never saw the author's reasoning, not from assigned personas. The deliverable is a synthesized verdict. Do NOT auto-apply changes.

## Step 1, Scope

Identify what to review from context:

- If the user points at specific files or a diff, use that.
- If on a feature branch, run `git diff main...HEAD` (or the appropriate base branch) for the full changeset.
- If the user's message references recent work, gather the relevant files.

Package the diff or file contents with any surrounding context files the reviewers need to understand the code.

## Step 2, Intent

Before spawning reviewers, state the intent in one clear paragraph from the user's message, commit messages, the PR description if one exists, and the code. If you're unsure about the intent, ask the user before proceeding.

## Step 3, Spawn Reviewers

Launch two reviewers in a single message, labeled Reviewer A and Reviewer B. Neither wrote the code, and neither sees the other's output.

| Subagent | Model |
|----------|-------|
| Reviewer A | Sonnet. Opus when the change is security-sensitive (auth, permissions, secrets, crypto, input handling at a trust boundary, migrations of user data) or settles a major design decision. |
| Reviewer B | Sonnet |

Each reviewer gets `subagent_type: "Explore"` (read-only), a brief that says not to edit files, and `model` set per the table.

Read `references/reviewer-prompt.md` and fill in the same template for every reviewer with the stated intent, the diff or file contents, the rubric from `references/rubric.md`, and the code-quality lens from `references/code-quality-review.md`. Pick each subagent's model per the Subagents section of the **rigor-mode** skill.

## Step 4, Synthesize

As results come back, build a unified picture. Parse every reviewer's findings. Merge findings that describe the same issue differently, and note which reviewers raised each one. Findings two or more reviewers raised independently are the highest signal. Read a lone reviewer's finding, but weight it accordingly. Note disagreements. If one reviewer flags something and another explicitly says the opposite, that is context for the verdict.

## Step 5, Lead Judgment

You are the lead reviewer, a pragmatic senior engineer, not a neutral aggregator. Read `references/lead-judgment.md` for the full framework. Put every finding in one of four buckets, with the reviewer(s) that raised it and a one-line rationale.

- **Act on**. Real issues affecting correctness, security, or maintainability given the actual goals. They would block a real PR.
- **Consider**. Legitimate, but you're not sure they outweigh the cost of addressing them now. Worth the user's attention.
- **Noted**. Technically valid but not actionable. Context-dependent, premature optimization, or low-impact at this stage.
- **Dismissed**. Wrong, nitpicky, or missing context, with a brief reason.

## Output Format

### Intent
> [The stated intent paragraph from Step 2]

### Reviewers
- Reviewer [label]: [model], [N findings] (one bullet per reviewer)

### Act On
[Each: description, which reviewers raised it, why it matters.]

### Consider
[Each: description, which reviewers raised it, the tradeoff.]

### Noted
[Brief list.]

### Dismissed
[Each with a brief rationale.]

### Agreement Map
[Where reviewers agreed and diverged, and what that pattern tells us.]
