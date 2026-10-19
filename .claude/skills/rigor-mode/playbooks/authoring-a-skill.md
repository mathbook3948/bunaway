### Authoring or modifying a skill

**You own the skill's voice.**

1. Write the skill as a folder with a `SKILL.md`. Frontmatter carries `name` (the folder name, kebab case) and a `description` written as a trigger: what it does and when to use it, key use case first, one YAML scalar (quote it when it has punctuation). Add `disable-model-invocation: true` when only the user should start it. Keep the body to what changes a decision, and move long reference material into files beside it that the body points to by relative path.
2. Validate the skill: frontmatter has `name` and `description`, referenced files exist, cross-skill links resolve.
3. Test cases if structural. Skip if subjective.
4. Run **Opening a PR**.

When in doubt, delete. Keep only prose that changes a decision. Tell it to do the thing and skip the reason. Explain only when the rule is confusing without one. Match tone to scope. Point at structural sources (types, READMEs, config) per the **encode-lessons-in-structure** principle. Delegate to other skills by path. Don't restate. A workflow you keep hitting but isn't captured → propose a new skill.

**Reply:** summary of the skill, key design decisions, validation notes.
