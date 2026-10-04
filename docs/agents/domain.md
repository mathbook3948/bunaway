# Domain docs

Use one shared domain context across this repository's packages. All paths below are relative to the repository root.

## Before exploring, read these

- `docs/GLOSSARY.md`: shared domain terms.
- `docs/decisions/`: ADRs relevant to the area being explored.
- `docs/PRD.md`: product requirements and scope.

If the glossary or ADRs do not exist, proceed silently. Do not flag their absence or suggest creating them upfront. The `domain-modeling` skill creates them when terms or decisions are actually resolved.

## File structure

```text
docs/
├── PRD.md
├── GLOSSARY.md              # Created when terms are resolved
├── decisions/              # ADRs, created when decisions are resolved
│   └── 0001-<decision>.md
└── agents/
    ├── issue-tracker.md
    └── domain.md
```

Use these paths instead of the generic skill defaults of root-level `GLOSSARY.md` and `docs/adr/`. Do not create a root-level glossary, a glossary map, or per-package domain docs for this setup.

## Use the glossary's vocabulary

Use terms defined in `docs/GLOSSARY.md` in issue titles, proposals, hypotheses, and test names. Do not substitute synonyms the glossary explicitly avoids.

If a needed concept is missing, check whether the project already uses another term. Note real gaps for `domain-modeling`.

## Flag ADR conflicts

If a proposal contradicts an existing ADR, identify the decision and explain why it should be reconsidered rather than silently overriding it.
