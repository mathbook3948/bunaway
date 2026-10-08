## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for `mathbook3948/bunaway`. See `docs/agents/issue-tracker.md`.

### Domain docs

Use a single shared context: `docs/GLOSSARY.md` and ADRs in `docs/decisions/`. See `docs/agents/domain.md`.

### Code quality

Assess readability, maintainability, reliability, reuse and efficiency as well as
correctness. Passing tests and static checks is necessary but does not establish
all of these qualities. Apply these rules within the requested scope; existing
debt does not authorize unrelated rewrites.

#### Naming and readability

- Use camelCase for TypeScript variables and functions, PascalCase for types
  and classes, UPPER_SNAKE_CASE for named limits and native flags, and kebab-case
  for new TypeScript source filenames. Follow each script language's conventions.
  Preserve external contract and FFI symbol spelling. Name values for their role,
  states for what is actually true, and quantities with units when ambiguous.
- Keep each function focused on one coherent task. Prefer guard clauses and
  straightforward branches. Name complex conditions when that explains their
  meaning; avoid nested ternaries and conditions that mix unrelated decisions.
  Split by responsibility and reading flow, not by a fixed line count.
- Give domain limits, native flags and other non-obvious literals meaningful
  names. Ordinary loop indices and self-explanatory literals need no constants.
- Comments explain reasons, invariants, ordering or external constraints.
  Update them with the code and remove comments that merely restate it.
  Follow `biome.json` for formatting instead of adding competing style rules.

#### Responsibility and reuse

- Search for an existing implementation before writing another. Reuse it when
  its meaning and failure behavior match. Prefer standard library or native
  functionality before adding dependencies or custom infrastructure.
- Keep a shared policy or lifecycle procedure in one implementation. Similar
  syntax alone is not a reason to combine code with different semantics. Add a
  helper or abstraction when it reduces repeated changes or caller knowledge;
  do not add speculative factories, configuration or generic utility layers.
- Expose what callers need without requiring them to know internal execution
  steps or file layout. Use declared package dependencies and exports for ordinary
  consumers. Keep source inclusion and special resolution required by accepted
  ADRs localized to build and distribution code. Preserve the documented package
  ownership and portable, browser and Bun environments.

#### Types and contracts

- Validate external input at trust boundaries, then carry concrete types and
  resolved defaults through internal code. Type assertions are not validation.
  Preserve validation when data crosses another trust boundary.
- Do not weaken strict TypeScript settings or use `any`, broad casts or error
  suppressions merely to silence type errors. Localize unavoidable assertions
  for FFI, dynamic keys or external typings and explain the invariant that
  makes them valid when it is not apparent from nearby code.
- Use an explicit phase type when mutually exclusive flags obscure valid
  lifecycle transitions and the type makes them simpler. Keep independent facts
  separate instead of forcing them into a single state machine.
  Public contracts must expose the actual inputs, results and failure behavior.

#### Errors and resource lifetime

- Catch errors to recover, add context, clean up or deliberately contain a
  failure. An ignored error needs an evident reason and a defined outcome.
  Preserve useful causes for trusted diagnostics without exposing secrets or
  internal details through public errors.
- Give each resource an owner that handles normal completion, failure and
  cancellation. Share cleanup where its semantics match, and make repeated
  cleanup safe where multiple paths can invoke it.
- Await asynchronous work or identify who observes its failure and completes
  its cleanup. Propagate cancellation and deadlines through owned operations
  that support them. State what happens to work that cannot be cancelled.

#### Efficiency

- Inspect repeated work, intermediate allocations, I/O and data bounds in the
  actual execution path. Remove clear waste when doing so preserves semantics
  and keeps the code simple; retain copies needed for isolation or safe iteration.
- Support performance claims with a reproducible workload and measurements.
  Profile before adding caches, changing polling or concurrency, or making
  algorithmic tradeoffs that increase complexity. For these changes, record the
  relevant input scale and tradeoff.

#### Tests and verification

- Test observable behavior and contracts. For behavioral changes, cover the
  affected normal flow and relevant failure or boundary case. For refactoring,
  reuse existing coverage and add a focused test only where a behavior is not
  protected. Do not add tests per function or chase coverage numbers alone.
- Prefer explicit inputs and existing dependency interfaces for isolation.
  Avoid mutating shared production state or rewriting source merely to test
  ordinary logic. Keep real process, filesystem and packaged-artifact checks
  where those mechanisms are the behavior under test.
- Use the Bun version pinned in `mise.toml`. Run focused checks while working
  and `mise run check` before completing code changes. Also run the relevant
  platform or distribution checks when those paths change; use `tests/README.md`
  and `mise.toml` to select them. Distinguish static, contract and actual native
  execution results. Report failures and checks not run, including the reason.
  Documentation checks follow the documentation maintenance section below.

#### Review and refactoring discipline

- Trace callers and observable behavior before refactoring. Preserve public
  contracts, error behavior, permissions and lifecycle ordering. Keep intentional
  behavior changes distinguishable from mechanical cleanup in the diff and
  validation results.
- Review names, control flow, duplication, types, errors, resource use and tests
  in addition to module structure. Ground each finding in a concrete location
  and its effect on behavior or the work needed to understand and change it.
  Distinguish defects, maintainability improvements and style preferences.
- Make the smallest coherent change that addresses the underlying problem.
  Explain necessary exceptions to these rules locally without turning them
  into new general-purpose mechanisms.

### Documentation maintenance

After changing code, update the related documentation in the same change before
considering the work complete. Keep usage examples, API signatures, defaults,
permissions, errors, lifecycle behavior and platform support aligned with the
implementation.

Update the affected guides and references in `docs/site/src/content/docs/` and
any relevant README, architecture document, glossary or ADR. When adding,
removing or renaming a public API, also update `docs/site/src/reference-map.json`.
Run `bun run docs:check` and `bun run docs:build` after documentation changes to
verify coverage, types, rendering and internal links. Automated coverage checks
do not replace reviewing the accuracy of the explanations and examples.

### Writing style

State general principles without enumerating specific templates or frameworks.
List names when explaining the currently supported choices.
Distinguish recommendations from required inputs and runtime constraints.

Do not use em dashes (U+2014) or middle dots (U+00B7) in documentation or
user-facing text. Use sentences, commas, colons or conjunctions instead.

Write Korean documentation in natural, direct sentences. Describe supported
behavior, inputs, results and failure conditions explicitly. Avoid translationese,
long chains of nouns and repetitive cautions such as asking readers not to assume
support. State current limits once where they affect the task, and preserve API
names, examples, values and technical meaning when editing prose.

Keep app-development documentation focused on tasks, public API usage, inputs,
results, required permissions, errors and lifecycle behavior the app must handle.
Do not narrate SDK internals, message forwarding, worker layout, internal IDs or
validation-layer sequences in these pages. Explain required configuration names
where users must write them, without describing their implementation. Put
protocol, runtime and adapter implementation details in the framework-contribution
section or architecture documents, and keep them out of the main app-development
navigation.

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
