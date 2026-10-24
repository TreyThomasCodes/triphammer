# Triphammer status page

A read-only web page for watching the ticket runner (`bin/ticket-runner`) of every project on the machine from a
phone. It reads the shared directory and each project's state directory on every request and has no buttons: the owner
still brakes through GitHub labels and the `stop` files.

## What it shows

One "Waiting on you" list across the projects, then a section per project, headed by its name, with its Now, Log, Runs
and Queue. With one project configured the page is that list and that one section.

- **Waiting on you:** everything the pipeline cannot move without the owner, one row each, naming its project (a
  shared brake names "all projects"), linked to the project's repository on GitHub, with how long it has waited
  ("3 d", "5 h", "12 min"). The heading counts the rows listed. Brakes come first: the shared directory's `stop` file and
  `backoff` in force, listed once, then each project's own: the `stop` file and `backoff` in its state directory and
  each open `stop-agents` issue. Then, oldest first across the projects:
  - open issues labelled `needs-owner`, with the first sentence after `**Decision for the owner:**` in the body, or the
    title when the body has none;
  - open pull requests labelled `hold` or `needs-owner`;
  - open pull requests waiting for the owner's approval, with what CI said. The page does not work the tier out
    itself: it lists a pull request when the `owner-approval` status that `.github/workflows/risk-tier.yml` posted on
    its head commit is pending with an `Escalate:` description, and shows that description with a link to the
    risk-tier run the status points to, whose step summary holds the tier's reasons (the link is shown only when it is
    an http(s) URL on github.com, plain text otherwise). A head the workflow has
    not classified yet, or one it holds for another reason, is not listed as waiting for approval;
  - open pull requests that are green and not armed, with the `gh pr merge N --auto --squash` command that arms them.
    "Armed" is `bin/merge-when-ready`'s: an auto-merge request. "Green" is merge state `CLEAN`, or merge state
    `BEHIND` with every check on the head passed (the latest run of each; a check passes on success, neutral or
    skipped, a status on success, so a pending `owner-approval` is not green). merge-when-ready only updates armed
    pull requests, so an unarmed one goes `BEHIND` whenever the default branch moves. A `hold` pull request is not
    asked to be armed.

  Escalate and green rows skip drafts and pull requests into a branch other than the default. A row counts from when
  its label was last added (from the label events), from when its checks last finished for a green pull request, or
  from when it was opened when neither applies or the label events are unavailable; a row with several reasons counts
  from the earliest. An empty list reads "Nothing is waiting on you", and only when every project could be asked. When
  `gh` fails for a project, only its local brakes are listed and the page says, naming the project, that the rest of
  it is unknown. When only a project's label-event query fails, the page says so and lists none of its pull requests
  as waiting for approval, since the statuses come from the same query. A project that cannot be read is named as
  unknown here and shows its error in its own section.
- **Now:** whether a run is in progress, its ticket or pull request, attempt and running time, and any brake: the
  shared `stop` file or `backoff` (named once, as "every project is paused"), the project's own `stop` file or `backoff`, or
  an open `stop-agents` issue. The runner's flock on the project's `lock`, read from `/proc/locks`, says
  whether it is busy. It takes that lock on every timer start before logging, so the log's latest start with no end
  (which a killed run also leaves) is shown as running only if it is no older than the process that has `lock` open
  (found through `/proc/<pid>/fd`). When that start time or the lock table cannot be read, only a start within the
  runner's 6 h session limit counts.
- **Log:** the last 50 lines of `log`, newest first.
- **Runs:** every `runs/*.jsonl`, newest first, with start time, outcome from the log and a link to the transcript.
- **Queue:** the next action from `ticket-runner --plan`, and open issues and pull requests with `hold`, `needs-owner`
  and `stop-agents` highlighted. They come from `gh`, and from the runner's `issues.json` and `prs.json` only when `gh`
  fails: the runner exits on `stop-agents` before rewriting those files, so their labels can predate a brake. A failing
  `gh` loses titles and may hide a new `stop-agents` label.
- **Transcript** (`/run/<project>/<name>`): served only for a project the page shows and a run listed in that
  project's `runs/`, read from that project's state directory; any other path, including one that leaves it, is 404.
  Assistant text, tool calls with a short argument summary, collapsed and truncated tool
  results, subagent work indented, and the final cost, duration and turns.

Pages refresh every 15 s while a run is in progress; a transcript page refreshes only while its run is the active one.
`gh` answers (both lists and the label events) are cached for 60 s and the plan for 120 s. The plan is not asked for while paused, because the runner
logs a line each time it starts with `stop-agents` set, nor while a run is in progress: then it would only name the
running ticket, and `ticket-runner --plan` itself rewrites `issues.json` and `prs.json` and fetches the main checkout,
which can collide with the run. When `gh` fails, the page says `stop-agents` is unknown rather than absent.

## Run

Needs Node 24, plus `bash` and `jq` for the Triphammer config's reader, `../bin/config.sh`.

```sh
node status/server.mjs                 # http://127.0.0.1:8787/
TRIPHAMMER_CONFIG=/tmp/other.conf node status/server.mjs --port 8790
```

The projects are the project configs the runner reads (`../bin/README.md`, "Configuration" and "Several projects"): every
`<project>.conf` in `${XDG_CONFIG_HOME:-~/.config}/triphammer`, each read by `../bin/config.sh` as
`TRIPHAMMER_PROJECT=<project>` reads it (`config.mjs`), in name order. Each gives the project's repository
(`REPO`) and state directory (`STATE_DIR`), and the page runs `ticket-runner --plan` for it with
`TRIPHAMMER_PROJECT=<project>`. The shared directory is `$TRIPHAMMER_SHARED_DIR`, else
`${XDG_STATE_HOME:-~/.local/state}/triphammer`. A malformed config, or a state directory that cannot be read, is that
project's error on the page and never hides the others; a directory that cannot be listed or holds no config stops the
server with exit 2. The configs are read when the server starts, so restart it after adding, removing or changing one.

With `$TRIPHAMMER_CONFIG` or `$TRIPHAMMER_PROJECT` set, the page shows only the project they select, as the runner
selects it, and a missing or malformed config stops the server with exit 2 and a message naming the file and the
setting. The page uses none of the optional modules; the reader checks their settings like the runner does and the
page otherwise ignores them.

| Flag | Environment variable | Config setting | Default |
| --- | --- | --- | --- |
| `--host` | `STATUS_HOST` | `STATUS_HOST` | `127.0.0.1` |
| `--port` | `STATUS_PORT` | `STATUS_PORT` | `8787` |
| `--allowed-hosts` | `STATUS_ALLOWED_HOSTS` | `STATUS_ALLOWED_HOSTS` | none (comma-separated extra `Host` names, see below) |
| `--runner` | `STATUS_RUNNER` | | `ticket-runner` on `PATH` (only ever run with `--plan`) |
| `--gh` | `STATUS_GH` | | `gh` on `PATH` |

Flags win over environment variables, which win over the Triphammer config settings, which win over the defaults. The unit
sets none of the flags or variables, so on the machine the address, port and allowed names are the Triphammer config settings
(`../bin/README.md`, "Configuration"). The page reads them from every config it shows: a setting that one config gives
holds for the page, and two configs that give one setting different values stop the server with exit 2 naming the
setting and the projects, whatever a flag or variable says, so set it in one config only or the same in each. A config
that cannot be read gives none. Tests: `npm run test:tooling` from the repository root.

## Install the user unit

The owner installs it, after the runner (`bin/README.md`, whose install creates the project configs and the
`ticket-runner@<project>` and `merge-when-ready@<project>` template units); agents cannot add persistence to the machine.
One `triphammer-status.service` serves every project, whatever the number of projects: it sets no `TRIPHAMMER_PROJECT` and
finds the projects from their configs. The unit runs `~/.local/bin/triphammer-status`, a symlink to the copy in the main checkout, the same
checkout the runner uses, so the unit names no checkout. The runner keeps that checkout on `origin/main` and restarts
this unit when a merge changes `status/` or `bin/config.sh`, so nobody pulls or restarts by hand. Set `checkout` to Triphammer's
checkout.

```sh
checkout=/srv/<project>
ln -sfn "$checkout/status/server.mjs" ~/.local/bin/triphammer-status
systemctl --user link "$checkout/systemd/triphammer-status.service"
systemctl --user daemon-reload
systemctl --user enable --now triphammer-status.service
systemctl --user status triphammer-status.service
```

After adding or removing a project's config, or changing its `STATUS_*` settings, `systemctl --user restart
triphammer-status.service`. For the page to keep
running while logged out, `loginctl enable-linger` must be on (it already is if the runner timer works unattended).

## Expose it safely

**Transcripts can contain secrets that appeared in tool output, and the server has no authentication by design.** Keep it
bound to `127.0.0.1` and put an authenticated front in front of it. Never bind it to a public address.

**Host check.** Every request whose `Host` header does not name this server gets `421 Misdirected Request`, so a web
page that rebinds its own domain to this address (DNS rebinding) cannot read the page or a transcript. Names are
compared case-insensitively. Accepted are:

- the listen address with the listen port, such as `127.0.0.1:8787`;
- `localhost`, `127.0.0.1` and `[::1]` with the listen port, when listening on a loopback address or on all interfaces
  (`0.0.0.0` or `::`); the wildcard address itself is not accepted, and neither is the LAN address or machine name
  you browse to, so list those;
- each entry of `STATUS_ALLOWED_HOSTS` (the Triphammer config setting, or the variable or `--allowed-hosts`), for example
  `STATUS_ALLOWED_HOSTS=box.tailnet.ts.net,status.example:8443`. An entry without a port matches that name on any port
  or none; an entry with a port matches only that port. Write IPv6 addresses in brackets.

The listen port is always required for the listen address and the loopback names. A request with no `Host` is refused.

Tailscale, reachable only from your tailnet:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:8787
tailscale serve status
```

Use `tailscale serve`, never `tailscale funnel`: funnel publishes it to the internet. If the page answers 421 through
Tailscale, the proxy is passing on the tailnet name: add it to the Triphammer config, e.g. `STATUS_ALLOWED_HOSTS=box.tailnet.ts.net`.

The existing nginx, with basic auth over HTTPS:

```nginx
location /triphammer/ {
    auth_basic "Triphammer status";
    auth_basic_user_file /etc/nginx/triphammer-status.htpasswd;   # htpasswd -c /etc/nginx/triphammer-status.htpasswd <user>
    proxy_pass http://127.0.0.1:8787/;
}
```

nginx sends `Host: 127.0.0.1:8787` by default, which passes the check. With `proxy_set_header Host $host;` add the
public name to the Triphammer config's `STATUS_ALLOWED_HOSTS`.

Links are relative, so the page works under a sub-path like `/triphammer/` as well as at the root.
