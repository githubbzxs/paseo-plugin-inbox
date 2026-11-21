# Inbox for Paseo

A [Paseo](https://paseo.sh) plugin that replaces the sidebar with an email-style inbox of agents: what needs you stays in the inbox, archive it when you are done, snooze or pin the rest. See [OVERVIEW.md](OVERVIEW.md) for how it behaves.

## Install

```bash
paseo plugin add git:githubbzxs/paseo-plugin-inbox
```

Then pick **Inbox** under Settings → Sidebar view.

Requires Paseo 0.16.2 or later. The plugin uses only libraries Paseo provides, so there is no build step.

## Development

```bash
npm install
npm run typecheck
npm test
```

Install a local checkout with `paseo plugin install <path>` and reload after edits with `paseo plugin reload paseo-inbox`.
