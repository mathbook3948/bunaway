## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for `mathbook3948/bunaway`. See `docs/agents/issue-tracker.md`.

### Domain docs

Use a single shared context: `docs/GLOSSARY.md` and ADRs in `docs/decisions/`. See `docs/agents/domain.md`.

### Code quality

Assess readability, maintainability, reliability, reuse and efficiency alongside correctness.
Passing tests and static checks is necessary but insufficient. Stay within requested scope;
existing debt allows no unrelated rewrites.

#### Naming and readability

- Use camelCase for TypeScript variables and functions, PascalCase for types and classes,
  UPPER_SNAKE_CASE for named limits and native flags, and kebab-case for new TypeScript source
  filenames. Follow script-language conventions and preserve external contract and FFI spelling.
  Name values by role, states by what is true, and ambiguous quantities with units.
- Give functions one coherent task; prefer guard clauses and simple branches. Name complex
  conditions when useful. Avoid nested ternaries and unrelated decisions in one condition; split by
  responsibility and reading flow, not line count.
- Name non-obvious literals, domain limits and native flags; ordinary indices and obvious literals
  need no constants. Follow `biome.json` for formatting, and `mise run format:java`
  (google-java-format, AOSP style) for Java.

#### JSDoc and inline comments

- Write comments so a first-time reader can follow the code's purpose and flow.
- Use JSDoc for public APIs and important internal functions: explain their role and any non-obvious
  inputs, results, failures and cleanup responsibilities. Do not repeat TypeScript types.
- Use inline comments to explain processing stages, important ordering, invariants and external
  constraints.
- Skip obvious helpers and line-by-line narration. Missing explanations in complex code are a
  readability issue even when names and types are clear.
- Keep comments accurate when changing code, and document contracts at their original declaration
  instead of copying them into implementations and re-exports.

#### Responsibility and reuse

- Give files coherent responsibilities. Separate contracts and reusable low-level bindings from
  application state and resource ownership when callers and reasons to change differ. Keep dependent
  lifecycle transitions together instead of splitting by size.
- Keep constants with their owning feature, policy or binding; share cross-module contract values
  from one side-effect-free definition. Do not collect unrelated constants globally or initialize
  native resources when importing shared values.
- Search before duplicating and reuse implementations with matching meaning and failure behavior.
  Prefer standard library or native functionality before dependencies or custom infrastructure.
- Keep shared policy or lifecycle procedures in one implementation; similar syntax with different
  semantics is insufficient. Add abstractions to reduce repeated changes or caller knowledge,
  without speculative factories, configuration or generic utility layers.
- Expose what callers need without requiring knowledge of internal execution steps or file layout.
  Ordinary consumers use declared package dependencies and exports. Localize source inclusion and
  special resolution required by accepted ADRs to build and distribution code; preserve documented
  package ownership and portable, browser and Bun environments.

#### Types and contracts

- Validate external input at each trust boundary, then carry concrete types and resolved defaults
  internally. Type assertions are not validation.
- Do not weaken strict TypeScript settings or use `any`, broad casts or suppressions merely to
  silence errors. Localize unavoidable assertions for FFI, dynamic keys or external typings and
  explain their invariant unless apparent nearby.
- Use explicit phase types when they simplify lifecycle transitions obscured by mutually exclusive
  flags. Keep independent facts separate. Public contracts must expose actual inputs, results and
  failure behavior.

#### Errors and resource lifetime

- Catch to recover, add context, clean up or contain failure; ignoring errors needs an evident
  reason and defined outcome. Preserve causes for trusted diagnostics without exposing secrets or
  internal details in public errors.
- Give every resource an owner for completion, failure and cancellation. Share cleanup with matching
  semantics and make it safe to repeat when multiple paths can invoke it.
- Await asynchronous work or identify who observes failures and completes cleanup. Propagate
  cancellation and deadlines through supported owned operations; define outcomes for uncancellable
  work.

#### Efficiency

- Inspect repeated work, intermediate allocations, I/O and data bounds in actual execution paths.
  Remove clear waste while preserving semantics and simplicity; keep copies needed for isolation or
  safe iteration.
- Support performance claims with reproducible workloads and measurements. Profile before caches,
  polling or concurrency changes, or algorithmic tradeoffs that add complexity; record input scale
  and tradeoffs.

#### Tests and verification

- Test observable behavior and contracts. Cover affected normal flows and relevant failures or
  boundaries for behavior changes. Refactors reuse coverage and add focused tests only for unprotected
  behavior. Do not add tests per function or chase coverage numbers alone.
- Prefer explicit inputs and existing dependency interfaces for isolation. Avoid mutating shared
  production state or rewriting source merely to test ordinary logic. Retain real process,
  filesystem and packaged-artifact checks when those mechanisms are the behavior under test.
- Use the Bun version pinned in `mise.toml`, focused checks while working, and `mise run check`
  before finishing code changes. When platform or distribution paths change, run relevant checks
  selected from `tests/README.md` and `mise.toml`. Distinguish static, contract and actual native
  execution results; report failures and checks not run with reasons. Follow Documentation
  maintenance below for documentation checks.

#### Review and refactoring discipline

- Trace callers and observable behavior before refactoring. Preserve public contracts, error
  behavior, permissions and lifecycle ordering; distinguish intentional behavior changes from
  mechanical cleanup in the diff and validation results.
- Review names, control flow, duplication, types, errors, resource use and tests as well as module
  structure. Ground findings in concrete locations and effects on behavior or understanding and
  change effort; distinguish defects, maintainability improvements and style preferences.
- Make the smallest coherent change addressing the underlying problem. Explain necessary exceptions
  locally without introducing general-purpose mechanisms.

### Documentation maintenance

Update related documentation in the same change as code: affected guides and references in
`docs/site/src/content/docs/` and relevant READMEs, architecture docs, glossary or ADRs. Keep
examples, API signatures, defaults, permissions, errors, lifecycle behavior and platform support
aligned with the implementation.

Update `docs/site/src/reference-map.json` when adding, removing or renaming a public API.
After documentation changes, run `bun run docs:check` and `bun run docs:build` for coverage,
types, rendering and internal links. Also review explanations and examples for accuracy.

### Writing style

- State general principles without listing specific templates or frameworks; name the currently
  supported choices when explaining them. Distinguish recommendations, required inputs and runtime
  constraints.
- Do not use em dashes (U+2014) or middle dots (U+00B7) in documentation or user-facing text. Use
  sentences, commas, colons or conjunctions instead.
- Write natural, direct Korean with explicit behavior, inputs, results and failures. Avoid
  translationese, noun chains and repeated cautions; state limits once where they affect the task.
  Preserve API names, examples, values and technical meaning.
- Keep app-development docs focused on tasks, public APIs, inputs, results, permissions, errors,
  lifecycle and required configuration names. Put SDK, protocol, runtime and adapter internals in
  framework-contribution or architecture docs, outside the main app-development navigation.

### UI client usage

Recommend clients typed from the app definition with `CommandsOf` and `EventsOf`
to check command and event contracts. This is not an SDK requirement.
UI initialization is the recommended place to create a client and handle failures.
The default WebView client requires an available host bridge.
Component cleanup disposes its subscriptions and keeps the shared client open.
Direct function APIs remain supported and must still be covered by SDK tests.

### Development priority

Read `docs/decisions/0010-windows-first-platform-model.md` before runtime, CLI,
template, or platform design work. Complete Windows first, then adapt other
platforms to the same Bun-based app model. A single app definition is the target;
the current macOS child-process implementation must not dictate separate
developer entrypoints or delay Windows work.
