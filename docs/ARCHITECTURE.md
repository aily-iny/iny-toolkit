# Iny Toolkit Architecture

Iny Toolkit is a personal, modular VS Code extension rather than a single-purpose commit-message tool.

## Current shell

- **Activity Bar home** (`iny.home`) is the personal command hub.
- **Workflow commands** use the `iny.<domain>.<action>` namespace.
- **Configuration** is grouped by domain, currently `iny.profile.*` and `iny.commit.*`.
- **Sensitive values** remain in VS Code Secret Storage; user settings only contain non-secret preferences.

## Adding a workflow

1. Add the feature implementation under `src/` using a narrow domain boundary.
2. Register it as `iny.<domain>.<action>` in `package.json` and `activate`.
3. Add its configuration under `iny.<domain>.*` when necessary.
4. Add an action card to `InyHomeViewProvider` so personal tools remain discoverable.

This structure keeps workflows independent: adding a future note, release, code-review, or workspace automation tool should not change the commit assistant's behavior.
