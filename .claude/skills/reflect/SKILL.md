---
name: reflect
description: "Mine the current session for durable learnings with three parallel reviewers, then route each to a concrete skill edit for approval. Use for /reflect, or when a long task landed and the recipe should be captured so the next run does not repeat the same mistakes."
disable-model-invocation: true
---

# Reflect

Sibling skills named in bold, such as the **how** skill, live next to this one. To run one, read `${CLAUDE_SKILL_DIR}/../<name>/SKILL.md` and follow it, and treat a `/name` in these steps the same way. Principles are `${CLAUDE_SKILL_DIR}/../principles/<name>.md`. Do not call siblings through the `Skill` tool, because they are user-invoked only.

Mine the current conversation for durable learnings, then route them into skill edits.

Invoke when the user says "reflect" or "/reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## 1. Locate the active transcript

Before fanning out, find this conversation's transcript in this workspace's Claude Code project folder, `~/.claude/projects/<slug>/`, where `<slug>` is the workspace path with each `/` and `.` changed to `-` (so `/Users/you/proj` is `-Users-you-proj`). Read only this workspace's folder. Globbing across `~/.claude/projects/*/` crosses workspace boundaries and reads private chats from unrelated projects.

```bash
ls -t ~/.claude/projects/<slug>/*.jsonl | head -5
```

The newest `.jsonl` directly in that folder is usually the current session, and `<session>/subagents/` holds its subagent transcripts. Confirm the pick by checking that the file contains the conversation's opening user prompt. If none matches, pass a tight digest of the session instead.

## 2. Spawn three reviewers in parallel

One message, three subagents, `subagent_type: "general-purpose"`, `model: "sonnet"`. Reviewers need MCP access to look up the tickets, chat threads, and observability traces the transcript references, and the read-only `Explore` type lacks it. Each brief says not to edit files. Pick each subagent's model per the Subagents section of the **rigor-mode** skill.

| Lens | Prompt template |
|---|---|
| Judgment | `references/judgment-reviewer.md` |
| Tooling | `references/tooling-reviewer.md` |
| Divergent | `references/divergent-reviewer.md` |

Pass each template verbatim, substituting the transcript path or digest where marked. Reviewers return findings in their final reply.

## 3. Synthesize

One subagent, `subagent_type: "general-purpose"`, `model: "sonnet"`. It spot-verifies citations through MCP, which the `Explore` type lacks. Pass `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. It returns an Accepted / Rejected / Backlog list.

## 4. Structural enforcement check

Move any Accepted item that a lint rule, script, metadata flag, or runtime check would enforce more reliably to Backlog. See the **encode-lessons-in-structure** principle.

## 5. Apply

Present the synthesizer's full Accepted / Rejected / Backlog output and wait for explicit approval before applying any Accepted edit. The user picks the subset and may redirect routings. Skill changes affect every future agent that loads them. Do not auto-apply.

File each Backlog item to your backlog tracker without waiting, or list it for the user when there is none. Only the Accepted list waits for approval.

Follow each approved row's Routing exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): the parent does it directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): run the authoring playbook (`${CLAUDE_SKILL_DIR}/../rigor-mode/playbooks/authoring-a-skill.md`): draft, test, iterate.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): rewrite the description per that playbook so the trigger leads, then check it against the transcript's wording.
- `new skill: <kebab-name>`: create it through that playbook. Do not invent the shape ad hoc.

If your environment ships a SKILL.md validator, run it on every touched skill before declaring done.

## 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
