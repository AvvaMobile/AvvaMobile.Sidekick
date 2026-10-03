# Security Policy

## Reporting a vulnerability

Please report security issues privately: on this repository, open **Security → Report a vulnerability** (GitHub private vulnerability reporting). Do not open a public issue, pull request or discussion for them.

Include what you found, the steps to reproduce it, the affected version and platform (macOS or Windows), and the impact you expect. We will acknowledge the report, keep you updated while we investigate, and credit you in the release notes if you wish.

## Supported versions

Only the latest release on [GitHub Releases](https://github.com/AvvaMobile/AvvaMobile.Sidekick/releases) receives security fixes. Installed apps update themselves to it.

## Scope

In scope: the Avva Mobile Sidekick app and its release pipeline in this repository, in particular

- the isolation of the embedded ChatGPT page (anything that lets web content reach local files, processes, Claude Code or Sidekick's IPC),
- the handoff between ChatGPT and Claude Code (anything that starts or types into Claude without the user's explicit action),
- what the review packet sends back to ChatGPT (secrets leaking past the filters),
- the update channel and the release workflow.

Out of scope: vulnerabilities in ChatGPT, Claude Code, Electron or Git themselves (report those to their vendors), and actions Claude Code takes within the permissions you granted it.

The security design is described in [docs/SECURITY.md](../docs/SECURITY.md).
