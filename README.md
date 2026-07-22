# welcome

Sends a custom-generated image card and configurable text messages whenever someone joins a
monitored WhatsApp group. Everything is configured through chat — no editing config files by
hand.

## Features

- **Image welcome card**: name, avatar, and community name rendered on a themed gradient/image
  background, with selectable avatar frame (circle, neon, square) and font (sans, serif, mono)
- **Font fallback stack**: registers bundled TTFs (if present in `fonts/`) with graceful
  degradation to system fonts — same pattern as the `quote` plugin, avoids missing-glyph boxes
  for accented names and emoji
- **Avatar fallback chain**: real profile picture → per-group custom fallback image
  (`!welcome set avatar` + an image) → bundled default (`fallback-profile.png`) → initials, if
  none of those load
- **Guided setup wizard**: `!welcome config` walks an admin through every option step by step
- **Per-field quick edit**: `!welcome set <field> <value>` to change one thing without redoing
  the whole wizard
- **Test/preview command**: `!welcome test` simulates a join using your own contact data,
  entirely in the current chat — no message touches the real groups. `!welcome test grupo` runs
  the full real pipeline (including auto-add) against the actual configured groups, with every
  message clearly marked as a test
- **Extra plain-text welcome** in other groups (no image), independent message
- **Auto-add to a second group**: serialized queue with randomized delay and a circuit breaker
  that disables auto-add temporarily after repeated failures, to protect the account
- **DM welcome message** with fallback invite links when auto-add isn't possible
- **Multiple groups supported**: each monitored group keeps its own independent configuration
- **i18n**: all bot-sent text goes through `ctx.i18n` (`locale/pt.json`, `locale/en.json`).
  Command syntax (field names, keywords like `pular`/`pronto`, theme/frame/font names) stays in
  Portuguese in both locales, since it's parsed literally, not just displayed

## Requirements

- `@napi-rs/canvas` for card rendering — **this is a native addon** (prebuilt binary per
  OS/architecture). It works out of the box on Linux/Windows/macOS servers and desktops. On
  **Android (Termux)** there is no prebuilt binary for Bionic libc, so `npm install` falls back
  to compiling from source, which commonly fails or requires a full native toolchain
  (`clang`, `make`, `python`). If you plan to run ManyBot on Termux, test the install first —
  the welcome card feature may not be available there.
- `fallback-profile.png` in the plugin root — the image used when a new member has no profile
  picture and no custom fallback was set for the group. Not bundled by default; drop your own
  square-ish PNG there (the card crops it to a circle/square same as a real avatar).
- Optional `fonts/` folder for the font-fallback stack — same TTFs used by the `quote` plugin
  work here too (just copy that folder over): `DejaVuSans.ttf` / `DejaVuSans-Bold.ttf` (sans),
  `LiberationSerif-Regular.ttf` / `LiberationSerif-Bold.ttf` (serif), `DejaVuSansMono.ttf`
  (monospace), `NotoColorEmoji.ttf` (color emoji), `unifont.otf` (last-resort Unicode coverage).
  Entirely optional — any file that's missing is just skipped, and the plugin falls back to
  whatever sans-serif/serif/monospace fonts are installed on the system.

## Usage

    !welcome config          — guided setup for a new group (or reconfigure an existing one)
    !welcome status          — show the current configuration for this group
    !welcome test            — preview in the current chat only, no side effects
    !welcome test grupo      — real test in the configured groups, marked as a test
    !welcome set <field> <value> — edit a single field
    !welcome reset           — delete this group's configuration

Available `set` fields: `fundo`, `moldura`, `fonte`, `avatar`, `comunidade`, `card`, `simples`,
`pv`, `pvfalha`, `addgroup`.

- `fonte`: `padrao` (sans-serif), `serifa` (serif), or `monoespacada` (monospace)
- `avatar`: send an image with the caption `!welcome set avatar` to use as the group's fallback
  photo, or `!welcome set avatar padrão` to go back to the bundled default

## Configuration

No `manybot.toml` keys required — everything (watched group, target group, card background,
messages, etc.) is stored per-group via `ctx.settings.global` and set through the
`!welcome config` chat wizard.

## License

MIT
