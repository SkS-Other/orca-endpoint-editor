# Server endpoints

[Русская версия](README.ru.md)

Editing the address and port of saved Orca remote environments from a panel in the right sidebar
(globe icon → «Server endpoints»), with presets and a reachability check.

## What it does

- A tab per saved environment; inside — the current address, Host/Port fields, a `ws://`/`wss://`
  toggle and `Применить`. An unsaved draft is marked `изменено` and survives
  «Обновить»/«Проверить порты»; «Применить» is active only when there is something to apply.
- **The scheme is part of the address, not of the environment.** `wss://` is only appropriate where
  TLS really runs on that port: a public domain on 443 — yes, a ZeroTier/LAN address on 40455 — no.
  A preset stores the scheme together with host/port, so switching from a domain to the overlay does
  not drag in someone else's `wss://`. Old presets without a scheme get one on load: 443/8443 → `wss`,
  private and overlay addresses → `ws`, everything else → `wss`.
- **Switching to a local workspace.** The helper shell has to run on this machine, so when a remote
  workspace is active the panel activates a local one itself and says so in a line under the
  heading. It cannot bring the previous remote one back — in that state Orca does not expose its id.
- **Presets** — named host/port pairs (with the scheme) per environment. «Сохранить как пресет»
  remembers the current draft, clicking a preset switches the environment right away (one click
  instead of typing the address). The pencil icon renames a preset in place (Enter — save, «Отмена» —
  cancel), the trash icon deletes it. Presets live in the plugin storage (`storage:own`), not in the
  Orca config; presets of environments that no longer exist in Orca are cleaned out when the list is
  refreshed.
- **Проверить порты** — TCP check of all addresses (current and preset ones) in a single request:
  green `отвечает`, red `не отвечает`. The list of addresses goes to a python script, the answer
  comes back as a bit string.
- **Проверить подключение** — a two-stage check of the address from the fields (a draft can be
  checked before it is applied): a WebSocket handshake, and for an already saved address also a real
  Orca connection.
- Endpoints managed by Orca (SSH tunnel, `127.0.0.1`) are marked `managed by Orca` and locked for
  editing.

## Why it works this way

Orca's plugin API gives neither access to files, nor methods for environments, nor a tab in Settings.
So the panel goes around it: the plugin worker (trusted-worker) prints a command into the real shell
via `terminal.sendText` and reads the answer via `terminal.read`, while the shell itself edits
`~/Library/Application Support/orca/orca-environments.json` with a python3 script.

The terminal is a poor channel, so there are four rules in it (all covered by tests):

- **one command at a time**: `run()` is wrapped in a queue, because two simultaneous `sendText`
  calls get glued into a single line and leave the shell in an unclosed quote (`dquote>`), after
  which it hangs silently;
- **short lines** (< 180 characters): the PTY may truncate a long line, and the quotes drift apart
  again. The script travels in base64 chunks of 120 characters into `/tmp`, is decoded and launched
  by a separate short command;
- **markers are printed as two literals** (`printf '%s%s' 'A' 'B'`), so that the echo of the command
  itself does not contain the marker and cannot be taken for its output;
- **the helper terminal opens in the active worktree**: `terminal.sendText` refuses any terminal
  outside the active worktree, and `terminal.create` accepts any workspace. Therefore "the first
  local workspace" is not good enough — the terminal is created in the active one, and its presence
  there is verified via `workspace.readContext` before the first input. If a workspace on a remote
  server is active (or none is active), the panel switches Orca to a local one itself via
  `workspace.open`: the shell has to be on this machine, otherwise it would be editing the
  environments file of another host.

On top of that: before starting, `shellReady` checks that the shell responds to an empty command, and
waits up to 6 s. A failed terminal is reused by the next attempt instead of being recreated every
time — otherwise one hung shell left tab after tab behind it. Input the host did not accept
(`accepted: false`) is retried three times, after which the panel names the real cause instead of
"the shell is not responding".

Limitations that remain:

- at least one **local** workspace is required: if a remote one is active, the panel switches Orca to
  a local one itself — the last used, otherwise the folder, otherwise the first in the list. It
  cannot return the previous remote workspace: in that state its id is unavailable
  (`workspace.readContext` returns null). Switching requires the `workspace:write` capability, so on
  the first launch after an Orca update it will ask for `--approve`;
- `python3` is required in the PATH of that terminal;
- output is read from rendered lines, so the list travels in base64 chunks with length control and
  up to three attempts; the parser tolerates the echo being glued to the output, but not a lost line;
- the reachability check is a plain TCP connect with a 2 s timeout, not an Orca handshake: `reachable`
  means "the port answers", not "the runtime authorizes this token";
- the local `orca-environments.json` is what gets edited; on paired servers and in WSL the file lives
  somewhere else.

## How to check that the connection will work

Three levels, from the weak one to the real one:

1. **The port answers** («Проверить порты», TCP connect with a 2 s timeout). Cheap and covers all
   addresses at once, but it only proves that someone is listening on the port. For "the VPN is up /
   the machine is on the network" that is enough.
2. **The WebSocket answers** («Проверить подключение» on the draft). Sends a real upgrade request
   (`GET / HTTP/1.1`, `Upgrade: websocket`, `Sec-WebSocket-Key`) and waits for `101 Switching
   Protocols`. This filters out "the port is open, but it is not Orca" — a database or someone else's
   HTTP service, for example. It works before the address is applied, because it does not touch the
   config.
3. **Orca connected** («Проверить подключение» on a saved address). Additionally runs
   `orca repo list --environment <имя> --json` in the same shell. This is the only check that proves
   everything at once: the address, the reachability, and that the runtime accepted this
   environment's token. A `remote_runtime_unavailable` response means Orca did not connect over that
   address.

What is important to understand: a `101` from the handshake does not mean "Orca authorizes this
token" — the token is only checked by level 3. And conversely, level 3 is only possible after
«Применить»: Orca connects over the saved address, not over what is typed in the fields. That is why
for a draft the panel honestly says «сначала примени адрес».

## Worker requests

- `endpoints.list` — all environments and their endpoints (host, port, dependency).
- `endpoints.set` — writes `<схема>://host:port` into the file; the scheme is sent by the panel rather
  than inherited from the saved one (otherwise switching from `wss://домен:443` to the overlay gives
  `wss://10.x:40455`), keeps the last 10 backups `orca-environments.json.bak.<epoch>`, then checks the
  port. Orca picks up the change without a restart; the token and the device key are not touched.
- `endpoints.probe` — TCP connect over a list of addresses (up to 64), the answer in input order.
- `endpoints.test` — WebSocket handshake to the address, then (if the address is already saved)
  `orca repo list --environment <имя> --json`; answers with the handshake verdict, a detail and Orca's
  response, or the reason why the second half was skipped.

## Development

There is no build: Orca transpiles `src/*.ts(x)` itself. There are no dependencies and no
`package.json` either — only `python3` in the PATH of the terminal where the shell runs.

```sh
orca plugin validate .        # манифест и типы запросов
orca plugin dev load .        # approval: workspace:read, workspace:write, terminal:send, terminal:read, storage:own
orca plugin test .            # 28 тестов: панель (13) + worker (15)
orca plugin check .           # 4 сценария: empty, unreachable, presets, managed (src/panel.check.ts)
npx tsc -p .                  # типы рантайм-кода; нужны .orca/types, их создаёт dev load
orca plugin dev request . endpoints.list --data '{}' --json
orca plugin dev request . endpoints.probe --data '{"targets":[{"host":"127.0.0.1","port":"5433"}]}' --json
orca plugin shot local.endpoint-editor --panel endpoints --out /tmp/panel.png --json
orca plugin dev reload        # после правок в dev-папке
orca plugin dev unload .
```

What the tests cover: saving a preset and switching with one click, renaming in place and cancelling
a rename, deleting a preset,
the success message after the refresh it caused, keeping the draft on Refresh, locking a
managed endpoint, showing the cause of a list error; in the worker — no interleaving of two commands,
the length of typed lines, refusal on a dangerous host and on an invalid port, an empty probe without
a shell, writing the sent scheme instead of the inherited one, switching to a local workspace from a
remote one, replacing a `terminalId` from a foreign worktree, the shell refusing input;
the connection check — a working connection, skipping the Orca half for a draft and "this is not a
WebSocket"; cleaning out presets of removed environments.

`npx tsc -p .` checks runtime code only: the tests are excluded in `tsconfig.json`, because
`find()` returns `TestElement | null` and they would have to be sprinkled with `!`. Types for `orca`,
`orca-host` and the other Orca modules live in `.orca/types` and are regenerated on
`orca plugin dev load` (they are not in git).

The project rules are in [AGENTS.md](AGENTS.md): the four rules of the terminal channel, the
capabilities model, where storage and backups live.

## Pitfalls we have already stepped on

- **Glued commands.** Two parallel `sendText` calls produced a line with an unclosed quote and an
  eternal `dquote>`: the shell echoes the input, `terminal.read` keeps working, so the plugin
  considered the terminal alive and timed out on every command. Fixed by the queue + a liveness
  check.
- **Long lines.** A single 2 KB line (two base64 scripts in `endpoints.set`) — the same effect.
  Now every line is short, and a test guards it.
- **Echo as output.** Markers printed as a single literal were present in the command echo, so
  `lastIndexOf` could take the echo for the result. Now the marker is printed in two parts.
- **Echo glued to output.** The terminal draws the echo of the last typed line and the program's first
  output on one line (`...py__LEN__ 1264`), which made the strict parser "the line starts with
  `__LEN__`" fail. Now the length is found with a regex, and chunks are only lines of pure base64 of
  length ≥ 32 (the echo always contains spaces, slashes, dots or hyphens).
- **An atom with `persist: 'storage'`.** After `update` the value in the atom changed, but storage and
  the render went back to the previous one (a race between two consecutive writes). Presets are read
  and written explicitly via `storage.get`/`storage.set`, the atom is a plain one.
