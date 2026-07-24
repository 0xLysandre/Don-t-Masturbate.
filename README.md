# Accountability & Site-Blocking Companion (MVP)

A personal, self-installed tool for staying away from specific sites and search
terms for a period you commit to in advance, with a daily check-in to keep score.

Two pieces:

- **`extension/`** — a Chrome (Manifest V3) extension that does the blocking.
- **`companion/`** — a small local Node.js app that owns the lists, the
  time-locked password vault, and the check-in history.

Everything lives on your machine. There are no accounts, no servers, no
telemetry, and no network calls beyond `127.0.0.1`.

---

## How it works

```
  ┌──────────────────────────────┐        http://127.0.0.1:7373       ┌────────────────────────┐
  │ Chrome extension             │ ─────────── loopback only ───────▶ │ companion (Node.js)    │
  │                              │                                    │                        │
  │ declarativeNetRequest ─▶ domains                                   │ blocklist + keywords   │
  │ content script ───────▶ search boxes                               │ time-locked vault      │
  │ webNavigation ────────▶ ?q= backstop                               │ check-ins & streaks    │
  └──────────────────────────────┘                                    │ AES-256-GCM at rest    │
                                                                      └────────────────────────┘
```

The extension holds no configuration of its own. It mirrors the companion's
lists every 30 seconds and caches the last copy it saw, so quitting the
companion cannot quietly switch protection off.

Three independent layers do the blocking:

1. **Domains** — `declarativeNetRequest` dynamic rules redirect any request to a
   blocklisted domain (and its subdomains) to a local blocked page.
2. **Search boxes** — a content script on Google, Bing, DuckDuckGo and YouTube
   watches the search field, debounced at 250 ms, and checks Enter and form
   submission synchronously so a match never gets sent.
3. **Search URLs** — `webNavigation.onBeforeNavigate` (and
   `onHistoryStateUpdated`, for YouTube's SPA navigation) inspects the `q=` /
   `search_query=` / `search=` parameter of any navigation to those engines.
   This catches a pasted URL, where no content script has run yet.

---

## Setup

Requires Node.js 18 or newer. No npm dependencies.

### 1. Set up the companion

```bash
cd companion
node bin/cli.js setup --cooldown 12
```

This generates a random 24-character password, encrypts it, and stores it. **It
is never displayed** — not at setup, not on demand. `--cooldown` is how many
hours you must wait after asking for it before it is released.

Add what you want blocked:

```bash
node bin/cli.js domains  add example.com another-site.net
node bin/cli.js keywords add "some phrase" "another term"
node bin/cli.js domains  list
```

### 2. Start the local server

```bash
node bin/cli.js serve      # or: npm run serve
```

Leave it running. It listens on `127.0.0.1:7373` only, and serves the check-in
dashboard at <http://127.0.0.1:7373>.

### 3. Load the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked** → select the `extension/` folder.

The toolbar badge tells you where you stand:

| Badge          | Meaning                                                        |
| -------------- | -------------------------------------------------------------- |
| green **ON**   | Session active, companion reachable, rules installed.           |
| amber **OFF**  | Companion reachable, but no session is running.                 |
| red **!**      | Companion not reachable — protection is unverified.             |

### 4. Commit to a session

From the extension's options page, or:

```bash
node bin/cli.js start --hours 24
```

Starting a session generates a **fresh** password and seals it. From that
moment, editing the lists or ending the session early requires that password.

---

## The unlock flow

You can always ask to be let out. You cannot be let out *immediately*.

```bash
node bin/cli.js unlock request      # starts the cooldown; logged with a timestamp
node bin/cli.js unlock status       # how much is left
node bin/cli.js unlock reveal       # only works once the cooldown has elapsed
node bin/cli.js unlock history      # every request you have ever made
node bin/cli.js stop --password <the revealed password>
```

- Requesting reveals nothing. It starts the clock you configured.
- Once revealed, the password stays viewable for 10 minutes, then seals. If you
  need it again after that, request a new unlock and wait again.
- Starting a new session rotates the password, so an old reveal is worthless.
- Every request is timestamped and listed in the options page and dashboard.
  Seeing your own pattern of requests is part of the point.

---

## Daily check-in

```bash
node bin/cli.js checkin        # prompts yes/no
node bin/cli.js checkin yes
```

Or use the dashboard at <http://127.0.0.1:7373>, or the options page.

A streak is consecutive on-track days. A "no", or a day with no answer at all,
resets it. Today's streak survives until the end of tomorrow, so it does not
break simply because you have not checked in yet. The longest streak you have
ever reached is kept alongside the current one.

---

## Data and encryption

Everything lives in `~/.accountability-companion/` (override with
`ACCOUNTABILITY_HOME`):

- `key.bin` — 32-byte random master key, mode `0600`.
- `data.enc.json` — the entire state as a single AES-256-GCM envelope: lists,
  vault, unlock log, check-ins. Written atomically.

Encryption is Node's built-in `crypto` (OpenSSL) throughout — AES-256-GCM with a
fresh 96-bit IV per write and an authentication tag, plus `randomInt` for
password generation and `timingSafeEqual` for verification. Nothing is
hand-rolled. The password is kept as ciphertext even in memory, so a stray
serialisation of the state cannot leak it; a test asserts this.

### Threat model — read this

This is a **commitment device, not a security product.** It is designed to make
a moment of impulse cost you a deliberate wait. It is not designed to stop a
determined attacker, and the determined attacker here is you:

- The master key sits next to the encrypted data. Anyone who can read your files
  can decrypt them. The encryption protects the vault from a backup, a synced
  folder, or another account on the machine — not from its owner.
- Nothing prevents uninstalling the extension, stopping the companion, using a
  different browser, or deleting the data directory. Tamper resistance is
  explicitly out of scope for this MVP.
- The value is in the friction and in the honest log of your own requests, not
  in being unbreakable.

### Network

- The companion binds to `127.0.0.1` and rejects non-loopback connections.
- CORS is restricted to `chrome-extension://` origins and the dashboard's own
  origin, so a web page cannot read your lists by fetching localhost.
- No outbound requests are made by either half of this project, ever.

---

## Scope

**In:** Chrome MV3 only; manual domain blocklist; keyword matching on Google,
Bing, DuckDuckGo and YouTube; a time-locked password vault; a yes/no check-in
with streaks; local-only encrypted storage.

**Deliberately not built:** OS-level or system-wide keystroke logging of any
kind; omnibox/address-bar monitoring (extensions cannot read it, and no
workaround is attempted); incognito blocking or detection; Firefox and Safari;
tamper resistance or anti-uninstall; friend-held password recovery; any
AI/LLM-based classification (matching is plain substrings); any conversational
"buddy" chat.

The content script reads **only** the value of a search field, **only** on the
search-engine pages listed in `manifest.json`. It touches no other input, page,
or field.

---

## Development

```bash
cd companion
npm test          # node --test, no dependencies
```

Covers the streak rules (including reset on a missed day), the time-lock
(request reveals nothing, cooldown blocks the reveal, password rotation voids
old ones), the password-required-while-locked rule, the search-URL backstop for
every supported engine, the CORS origin policy, and that neither the state file
nor any API response contains the plaintext password.

### Layout

```
extension/
  manifest.json        MV3 manifest
  background.js        companion sync, DNR rules, webNavigation backstop
  content-script.js    search-box listener
  shared/matcher.js    keyword + search-URL matching (shared by both)
  options.html/.js     lists, session, unlock, check-in
  blocked.html/.js     the local blocked page
companion/
  bin/cli.js           setup, serve, status, lists, session, unlock, checkin
  lib/app.js           all operations and the locking rules
  lib/secure.js        encryption, password generation, constant-time compare
  lib/store.js         encrypted, atomic persistence
  lib/server.js        loopback HTTP API + dashboard
  lib/streak.js        streak arithmetic
  public/index.html    dashboard
```

### Adding a search engine

Add a `test`/`params` entry to `ENGINES` in `extension/shared/matcher.js` (that
alone enables the navigation backstop everywhere), then add the host to
`content_scripts.matches` in `manifest.json` for in-page typing detection.

## Licence

MIT.
