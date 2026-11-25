# Claude Auto-switch for Orca

An [Orca](https://github.com/stablyai/orca) plugin for people with more than one Claude seat. When the active Claude account nears its 5-hour or weekly limit, it switches Orca to another account you added in Orca that still has room, and tells you.

It never sees a token. Orca already keeps your accounts, reads their usage and switches between them. The plugin only asks Orca, through its own CLI, for the usage of each account (`orca account list --json`) and to switch (`orca account select`).

## Requirements

- Orca 1.4.248 or later, with plugins turned on (Settings › Plugins). Tested on Orca 1.4.274 on macOS, including a real automatic switch between two seats of the same email in different organizations. Not tried on Linux or Windows.
- At least two Claude accounts in Orca. Your normal `claude` login is the `system` account; add the others with `orca account add` (or Settings › AI Provider Accounts). Two seats of the same email in different organizations count as two accounts: pick the other organization when you sign in.
- Orca's **Claude usage polling** on, in the same settings page. That is how Orca reads the accounts you are not using; with it off there is nothing to compare, and the plugin never switches.

## Install

```sh
orca plugin install ivanmunozruiz/orca-claude-autoswitch
```

Orca does not install it yet. Because the plugin runs code, the command stops with `approval_required` and lists what it would get. Read that list, then run the command it prints, with `--approve <fingerprint>`. You can also install it from Settings › Plugins with this repository's URL.

## What you see

- **Status bar:** the active account and the highest share it has used of its 5-hour or weekly window, for example `Org A 81%`. It turns amber 15 points before the threshold and red at it. Hover for every account; press it to check now.
- **Notifications:** one when it switches, and one when every account is over the threshold, which is when you start spending extra usage or hit the limit.
- **Command:** `Claude Auto-switch: Check now`.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Switch at (% used) | 90 | Switch when the active account has used this share of its 5-hour or weekly window and another account is under it. |
| Name of your default account | empty | The name shown for your normal `claude` login, which otherwise reads "System default": Orca does not report that account's organization. |

## Running sessions

The switch applies to the Claude agents you start after it. Whether the ones already running move too is up to Orca's own setting: Settings › AI Provider Accounts, "When you switch accounts while Claude is running in terminals".

- **Ask** (Orca's default): Orca asks you at each switch.
- **Always restart:** each running conversation continues on the new account. Busy sessions stop their current work.
- **Never restart:** running sessions stay on the old account until you restart them.

## How it decides

Every minute, and when you press the status bar item:

1. It reads `orca account list --json`.
2. It trusts the active account's reading only when Orca took it with that account's credentials. Right after a switch Orca can still hold the previous account's figures, and the plugin waits.
3. A window whose reset time has passed counts as empty.
4. If the active account is at or over the threshold, it switches to the other account with the lowest usage, as long as it has a reading and is under the threshold. It never switches twice within 10 minutes.

Only the 5-hour and weekly windows count, not per-model limits. Only accounts on this machine count, not WSL ones.

## Limits

- The figures are Orca's, and Orca refreshes them on its own schedule: every one to two minutes in a test with Orca's window in front. Orca polls less while it is in the background, so readings can lag until you come back to it. The plugin reacts within minutes, not to the second.
- It does not stop a session that crosses the limit mid-run: that session keeps its account unless Orca restarts it (see [Running sessions](#running-sessions)).

## Development

```sh
orca plugin test . --json      # unit tests, with Orca's mock host: they never reach the real CLI
orca plugin validate . --json
```

The decision logic is in `decide.mjs`, with no I/O. The worker, `main.mjs`, polls, calls the Orca CLI and updates the status bar.

## License

[MIT](LICENSE)
