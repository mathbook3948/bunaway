## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for `mathbook3948/bunaway`. See `docs/agents/issue-tracker.md`.

### Domain docs

Use a single shared context: `docs/GLOSSARY.md` and ADRs in `docs/decisions/`. See `docs/agents/domain.md`.

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

### Development priority

Read `docs/decisions/0010-windows-first-platform-model.md` before runtime, CLI,
template, or platform design work. Complete Windows first, then adapt other
platforms to the same Bun-based app model. A single app definition is the target;
the current macOS child-process implementation must not dictate separate
developer entrypoints or delay Windows work.
