## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for `mathbook3948/bunaway`. See `docs/agents/issue-tracker.md`.

### Domain docs

Use a single shared context: `docs/GLOSSARY.md` and ADRs in `docs/decisions/`. See `docs/agents/domain.md`.

### Development priority

Read `docs/decisions/0010-windows-first-platform-model.md` before runtime, CLI,
template, or platform design work. Complete Windows first, then adapt other
platforms to the same Bun-based app model. A single app definition is the target;
the current macOS child-process implementation must not dictate separate
developer entrypoints or delay Windows work.
