## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for `mathbook3948/bunaway`. See `docs/agents/issue-tracker.md`.

### Domain docs

Use a single shared context: `docs/GLOSSARY.md` and ADRs in `docs/decisions/`. See `docs/agents/domain.md`.

### Native change verification

Before changing `native/` or `plugins/*/src/platforms/`, read
`.claude/skills/native-change-verification/SKILL.md` and work through its checklist: resource
lifetime, shared FFI signatures, apartments, bounds, cancellation, tests and verified-only docs.

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
  before finishing code changes. When platform or distribution paths change, run the checks the
  change-type table in `tests/README.md` names; `tests/NOTES.md` records what individual fixtures
  verify when that detail is needed. Distinguish static, contract and actual native execution
  results; report failures and checks not run with reasons. Follow Documentation maintenance
  below for documentation checks.

#### Review and refactoring discipline

- Trace callers and observable behavior before refactoring. Preserve public contracts, error
  behavior, permissions and lifecycle ordering; distinguish intentional behavior changes from
  mechanical cleanup in the diff and validation results.
- Review names, control flow, duplication, types, errors, resource use and tests as well as module
  structure. Ground findings in concrete locations and effects on behavior or understanding and
  change effort; distinguish defects, maintainability improvements and style preferences.
- Make the smallest coherent change addressing the underlying problem. Explain necessary exceptions
  locally without introducing general-purpose mechanisms.

### Rules and what enforces them

Every rule above is paired here with the check that fails when an agent skips it. A rule whose
enforcement reads "review" relies on judgment: when a review catches it twice, move it up a level
in the same change and update this table. Drop a row once the mistake cannot happen.

| Rule | Enforced by |
| --- | --- |
| Lint and format, kebab-case filenames, no nested ternary, no non-null assertion, template literals | `mise run lint` (Biome, warnings fail), `mise run format:check` |
| Functions stay under cognitive complexity 25; the exemption list never grows | Biome rule plus `tests/conformance/lint-config.test.ts` (length cap, existence, still violating) |
| Unhandled promises are marked `void`; in-flight promise fields compare with `!== undefined` | Biome `noFloatingPromises`, `noMisusedPromises` |
| WebView-reachable modules (plugin `src/*.ts`, protocol, plugin-api, client, plugin SDK neutral files) use no `Buffer`, `Bun`, `process` or `node:` module | Biome override in `biome.json` plus `tests/conformance/browser-boundary.test.ts` (bundles loaded with those globals undefined) |
| Workspace tsconfigs extend the base and never restate strictness; the client SDK sees no Bun types | `tests/conformance/lint-config.test.ts` |
| `framework.json` and root `devDependencies` match the `packages/*` and `plugins/*` workspaces | `tests/conformance/workspace.test.ts` |
| A library symbol has one FFI signature across the repository; known conflicts only shrink | `tests/conformance/ffi-signatures.test.ts` |
| New native host files are listed in `frameworkPaths`; listed entries exist | `tests/cli/framework-paths.test.ts` |
| Public exports and plugin operations are documented | `docs/site/scripts/check-reference.mjs` through `mise run typecheck` |
| Protocol schema exports match the generated native schemas | CI `protocol:generate` diff |
| No em dash or middle dot in text or commit messages | `scripts/check-text-style.ts` in `bun test tests/docs` and the commit-msg hook |
| Native changes run the OS checks in `tests/README.md` and report what did not run | Review, and the `windows-native` and `macos-native` CI jobs |
| Shared FFI tables, `ResourceOwner` and `attemptAll`, `int32Schema` and `base64Schema` are used instead of local copies | Review; the FFI ratchet above blocks new conflicting copies only |
| A test names its waits: `setDefaultTimeout(deadline("build"))` once per file, `killAfter(child, "childStep")` for child kill timers, `waitFor(probe, { deadline, what })` for polling, all from `tests/fixtures/deadlines.ts`; literal deadlines and hand-rolled pollers only shrink | `tests/conformance/test-deadlines.test.ts` (per-file ratchet); `BUNAWAY_TEST_TIME_SCALE` scales every deadline on a slow runner |
| Limits are named constants; events are compared as sets | Review |
| Docs change in the same commit as code, and claim only what tests verified | Review |

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
- Do not use em dashes (U+2014) or middle dots (U+00B7) in documentation, source text or commit
  messages. Use sentences, commas, colons or conjunctions instead. `scripts/check-text-style.ts`
  enforces this in the contract tests and the commit-msg hook.
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
template, or platform design work. Preserve the Windows Bun-based app model
and public contracts while adapting macOS in parallel under the approved rollout. A single app definition is the target;
the current macOS child-process implementation must not dictate separate
developer entrypoints or delay Windows work.
