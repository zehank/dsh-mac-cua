# Fork notes — `zehank/dsh-mac-cua`

Fork of [Saunato/dsh-mac-cua](https://github.com/Saunato/dsh-mac-cua), based on commit
`85dde0f`, adding a **user-facing confirmation gate** for Computer Use write actions.

## Why

`dsh-mac-cua` lets an agent drive a real macOS desktop — it can click, type, press keys,
drag and scroll with real side effects. Upstream has no way to require human approval
before those actions run. This fork adds one, controlled from DSH's own Settings UI
rather than from a config file.

## What changed

| File | Change |
|---|---|
| `cua-repl/repl.js` | Wraps every `sky` write method in a gate. When the gate is on and the call was not explicitly approved, it throws `APPROVAL_REQUIRED` instead of acting. `js_reset` no longer re-injects the un-gated `sky`. |
| `cua-repl/server.js` | The `js` tool gains an `approve` boolean; a new `approval_mode` tool reads/toggles the gate. The gate state is read from the profile's `cordis.patch.yml` on every call, so a change takes effect without restarting the harness. |
| `lib/approval-gate.js` | **New.** A minimal cordis `Service` that exists only so Settings renders an enable/disable switch for it. That switch state *is* the gate. |
| `locale/en.json`, `locale/zh.json` | **New.** Intended Settings card title/description ("Computer Use Approval Gate"). Currently NOT read — see caveats. |
| `cordis.patch.yml` | Mounts the gate component as `./lib/approval-gate.js`. A bare package subpath would let `readPluginMeta()` pick up `locale/`, but that is unverified against the DSH loader, and a loader failure here takes the whole insert list down with it — including `mcp-cua`. |
| `package.json` | Ships the new `locale/` directory. |
| `scripts/launch-node.sh` | **New.** Machine-local wrapper; see caveats. |

## How the gate works

1. Settings → **插件 / Plugins** → **cua** → **组件 / Components** → the switch on
   **Computer Use Approval Gate**.
2. Toggling it writes `disabled:` for the `cua-approval-gate` entry in the profile's
   `cordis.patch.yml`:
   - `disabled: false` (component enabled) → **gate on**: the agent must ask you before
     every write action.
   - `disabled: true` (component disabled) → **gate off**: write actions run directly.
3. The MCP server re-reads that entry on each call, so the change is immediate — no
   app restart needed. Only the *code* changes need a restart, because the MCP server
   is spawned at boot.

## Caveats

- The Settings card falls back to showing the module path rather than `locale/`'s
  "Computer Use Approval Gate", because `readPluginMeta()` only reads locale metadata
  for **bare package specifiers** and the entry uses a relative path (see the table).
- `scripts/launch-node.sh` hardcodes the macOS app path
  (`/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness`). It exists
  because DSH's mcp-client scrubs every `DSH_*` variable from the spawned process, so
  `command: node` resolves to a wrapper that then fails. Adjust or drop it per machine.
- The plugin is installed into `~/.dsh/profiles/<profile>/node_modules/`, and
  reinstalling from git replaces these files — re-apply the fork after an upgrade.
- The gate is a **strong backstop, not a sandbox**: DSH's mcp-client does not support
  MCP elicitation, so the confirmation itself is relayed by the agent.
