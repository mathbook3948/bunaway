---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
disable-model-invocation: true
---

# Swarm

Sibling skills named in bold, such as the **how** skill, live next to this one. To run one, read `${CLAUDE_SKILL_DIR}/../<name>/SKILL.md` and follow it, and treat a `/name` in these steps the same way. Principles are `${CLAUDE_SKILL_DIR}/../principles/<name>.md`. Do not call siblings through the `Skill` tool, because they are user-invoked only.

## Start

Open a todo list (TodoWrite) with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
3. Run workers on Sonnet (`model: "sonnet"`). Use `model: "opus"` only for a lane that reviews security-sensitive code. For a race between approaches, name each arm up front. Pick each subagent's model per the Subagents section of the **rigor-mode** skill.
4. Give each worker its own writable output when it writes. When workers verify or measure commits, each brief names the exact SHAs. A measurement brief also names the method (sample count, what one sample is, order). The worker records both in its result.

## Phase B: Fan out

Spawn all N workers in one message so they run in parallel, with `subagent_type: "general-purpose"` and the step 3 model. A worker that writes, builds, or runs the app gets `isolation: "worktree"` so workers never share a checkout, ports, or data dir. A read-only worker uses `subagent_type: "Explore"` and is told not to edit files.

When a worker must start from a non-default branch or commit, name it in the brief and tell the worker to check it out first.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. Drop a result that does not record the SHAs and method its brief names, and respawn that worker once. After a second miss, record a gap. A gap does not count as a pass. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

## Phase D: Report

Return one consolidated in-chat report with the table, issue one-liners, gaps or dropouts, and the race rule when used.
