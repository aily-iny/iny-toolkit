# Changelog

## 0.2.3

- Retry commit-generation requests with `curl` when the Remote SSH extension host cannot open a network socket. API keys are passed over private file descriptors rather than command-line arguments.

## 0.2.2

- Explain which execution host cannot reach the configured AI endpoint, including the underlying connection error.

## 0.2.1

- Avoid reading binary Git patch literals when generating a commit subject, so staged image assets do not exceed the diff reader buffer.

## 0.1.0

- Initial release with staged-diff commit message generation and optional direct commit.
