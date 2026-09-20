# Iny Toolkit

Iny's personal VS Code toolkit. It starts with an AI commit assistant and provides a modular home for the focused workflows you add over time.

Open the **Iny** icon in the Activity Bar to access the personal toolkit home.

## Features

- `Iny: Generate Commit Message` automatically uses the repository for the active file, reads `git diff --cached`, asks an OpenAI-compatible model for one subject line, and places it directly in VS Code's Source Control message box (with clipboard fallback).
- `Iny: Generate and Commit` lets you review the generated text and then runs `git commit -m`.
- Commands are available from the Source Control title bar and Command Palette.
- API keys entered through the extension are stored in VS Code Secret Storage, not workspace settings.
- Supports OpenAI-compatible Chat Completions endpoints, so it can be used with compatible hosted or local models.
- Includes a built-in configuration page for endpoint, model, API key, language, diff limit, and a fully custom system prompt.
- Uses the `iny.<domain>.<action>` command and `iny.<domain>.*` setting namespaces, so new personal workflows stay independent.

## Setup

1. Run **Iny: Configure Commit Assistant** from the Command Palette.
2. Configure your endpoint, model, API key, and custom prompt, then save. The key is stored in VS Code Secret Storage.
3. Stage your changes in Source Control.
4. Select the sparkle action in Source Control, or run **Iny: Generate Commit Message**.
5. The generated message is placed directly in the SCM message box. Choose **Generate and Commit** when you want to review the message before committing.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `iny.profile.displayName` | `iny` | Name shown in the personal toolkit |
| `iny.commit.apiEndpoint` | OpenAI Chat Completions URL | AI provider endpoint |
| `iny.commit.model` | `gpt-4o-mini` | Model identifier |
| `iny.commit.prompt` | Conventional Commit prompt | System prompt sent to the model |
| `iny.commit.language` | `Auto` | Commit subject language |
| `iny.commit.maxDiffChars` | `12000` | Largest staged diff forwarded to the provider |

`iny.commit.apiKey` remains available for automation, but Secret Storage is recommended.

## Development

```bash
npm install
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host. To produce a VSIX, run `npm run package`.

## Release

The GitHub Actions workflow at `.github/workflows/publish.yml` publishes tagged releases to the Visual Studio Marketplace and creates a GitHub release with the generated VSIX.

Before the first release, add a repository Actions secret named `VSCE_PAT`. Its value must be a Visual Studio Marketplace personal access token authorized to manage extensions for the `iny` publisher.

1. Update `version` in `package.json` and `CHANGELOG.md`, then commit the release.
2. Create a matching annotated tag, for example `git tag -a v0.2.1 -m "v0.2.1"`.
3. Push the commit and tag with `git push origin main --follow-tags`.

The workflow rejects a tag that does not exactly match `v<package.json version>`, preventing a package from being published under an unintended version.
