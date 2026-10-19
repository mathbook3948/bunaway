---
name: principles
description: "Index of 24 short engineering principles (core, architecture, verification, delegation, meta), one file each. Use for /principles, to look up a principle by name, or to steer work with one (\"apply prove it works\", \"subtract before you add\")."
disable-model-invocation: true
---

# Principles

Each principle is one file in this folder, `${CLAUDE_SKILL_DIR}/<name>.md`. Each entry below names when it applies. Read the file in full before you apply a principle, and when you apply one, name the decision it changed. A citation with no decision behind it means the rule was named, not applied.

Use the names to steer. "Apply prove it works, run the real import flow" redirects work more precisely than a paragraph of instructions.

**Core**

- [**Laziness Protocol**](laziness-protocol.md). Refactoring, sizing a diff, or tempted to add abstractions, layers, or signal threading. Bias to deletion and the smallest change that solves the problem.
- [**Foundational Thinking**](foundational-thinking.md). Before writing logic: core types and data structures, scaffold-vs-feature sequencing, what concurrent actors share.
- [**Redesign from First Principles**](redesign-from-first-principles.md). Integrating a new requirement into an existing design. Redesign as if it had been foundational from day one.
- [**Attack the Premise**](attack-the-premise.md). Two or more fixes that share one premise have failed the same gate. Write the premise down and test it directly before you write another fix that assumes it.
- [**Subtract Before You Add**](subtract-before-you-add.md). Sequencing an addition, refactor, or rewrite. Remove dead weight first, then build on the simpler base.
- [**Minimize Reader Load**](minimize-reader-load.md). Reviewing or shaping code that's hard to trace. Count layers and hidden state, collapse one-caller wrappers, shrink mutable scope.
- [**Outcome-Oriented Execution**](outcome-oriented-execution.md). Planned rewrites and migrations with explicit phase boundaries. Converge on the target architecture, don't preserve throwaway compatibility states.
- [**Experience First**](experience-first.md). Product, UX, or feature-scope tradeoffs. Choose user delight over implementation convenience.
- [**Exhaust the Design Space**](exhaust-the-design-space.md). A novel interaction or architectural decision with no precedent. Build 2-3 competing prototypes and compare before committing.
- [**Build the Lever**](build-the-lever.md). Any non-trivial work. Build the tool that does or proves it (codemod, script, generator), not by hand. The tool is the artifact a reviewer reruns.

**Architecture**

- [**Model the Domain**](model-the-domain.md). Writing stateful logic, or code that branches a lot or repeats a shape assumption across files. Encode the domain in a structure (state machine, typed model, table or registry, reducer, boundary, the right collection) instead of scattered conditionals.
- [**Boundary Discipline**](boundary-discipline.md). Wiring validation, error handling, or framework adapters. Guards at system boundaries, trust internal types, keep business logic pure.
- [**Type System Discipline**](type-system-discipline.md). Designing types or a signature in any typed language. Make illegal states unrepresentable, brand primitives, parse external data at boundaries.
- [**Make Operations Idempotent**](make-operations-idempotent.md). Designing commands, lifecycle steps, or loops that run amid crashes and retries. Converge to the same end state.
- [**Migrate Callers Then Delete Legacy APIs**](migrate-callers-then-delete-legacy-apis.md). Introducing a new internal API while old callers exist. Migrate and delete in one wave.
- [**Separate Before Serializing Shared State**](separate-before-serializing-shared-state.md). Concurrent actors might write the same file, branch, key, or object. Eliminate the sharing first.

**Verification**

- [**Prove It Works**](prove-it-works.md). After a task, before declaring done. Verify against the real artifact, not a proxy or "it compiles".
- [**Fix Root Causes**](fix-root-causes.md). Debugging. Trace each symptom back to the first place the system went wrong and fix it there. A guard is a fix only when the state it handles is legitimate.
- **Sequence Work into Verifiable Units** (the **sequence-verifiable-units** principle). Multi-step work (sweeps, migrations, runs of similar edits) and how you stack commits and PRs. Break work into small units that each end in a check, verify each before the next, and order delivery so the sequence proves itself.
- [**Test Behavior, Not Implementation**](test-behavior-not-implementation.md). Writing, changing, or keeping a test. Assert what the code's users can observe, so the test fails when that behavior breaks and keeps passing when only the internals change.
- [**Explain the Number**](explain-the-number.md). Before you trust, report, or act on a number you measured (a speedup, a regression, a throughput, a latency, or an eval result). Find what limits it, and rule out that it measured something other than the work you think.

**Delegation**

- [**Guard the Context Window**](guard-the-context-window.md). Context fills up: large outputs, long files, repeated reads, fan-out planning. Route bulk to subagents, keep summaries in the main thread.
- [**Never Block on the Human**](never-block-on-the-human.md). Tempted to ask "should I do X?" on reversible work. Proceed, present the result, let the human course-correct.

**Meta**

- [**Encode Lessons in Structure**](encode-lessons-in-structure.md). You catch yourself writing the same instruction a second time. Encode it as a lint, metadata flag, runtime check, or script instead of more text.
