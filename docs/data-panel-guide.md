# Data panel — operator / designer guide

How to use the **Editor → Data** tab: bind a text/JSON file inside a template, pick a row with a designer-owned rule, and map columns into variables (including media). Control operators do **not** choose the row — the template does.

## Mental model

```
Source (file / inline)
  → Parse (lines | delimited | kv | json)
  → Select row (first / last / index / byKey / match / all)
  → Map columns → variables (text / number / time / image / video / …)
  → TAKE / load runs the pipeline and fills variables
```

Layers bind to those variables as usual (`{ }` in Properties for Image/Video/Text, clock `time` vars for start/target).

## Quick start (typical lower-third from a pipe file)

### 1. Variables

In **Variables**, create for example:

| ID | Type | Data-driven | Show in Control |
|---|---|---|---|
| `name` | text | `main` | off |
| `title` | text | `main` | off |
| `photo` | image | `main` | off |

`Data-driven` = pipeline id (see below). Driven vars are hidden from Control unless you tick **Show in Control**.

### 2. Enable Data

Open **Data** → **Enable Data pipeline**. You get a starter source + pipeline `main`.

### 3. Source

| Field | Example |
|---|---|
| type | `textfile` |
| format | `delimited` |
| path | literal `/uploads/data/guests.txt` (or any path under `/uploads/…`) |
| delimiter | `\|` |
| columns | `name,title,photo` |
| commentPrefix | `#` (optional) |

**File example** (`/var/lib/titulus/uploads/data/guests.txt` → URL `/uploads/data/guests.txt`):

```text
# name|title|photo
Иван Иванов|Корреспондент|asset:0b42921a-a63c-4021-b74a-4a77e4d634ac
Мария Петрова|Редактор|/uploads/Image/portrait.jpg
```

Media cells:

- `asset:<uuid>` — Copy token from MAM (toast «token copied»)
- `/uploads/...` — direct URL
- bare path relative to uploads if your resolve strategy allows `path`

### 4. Pipeline

| Field | Example |
|---|---|
| id | `main` (must match Variables → Data-driven) |
| source | the source id |
| select | `first` / `index` / `byKey` / … |
| map | `name→name (text)`, `title→title (text)`, `photo→photo (image)` |
| mediaResolve | `assetId, url, path` · onMiss `clear` |
| onEmpty | `block` (refuse TAKE if no row) |

### 5. Bind layers

- Text layer content → bind `name` / `title`
- Image layer src → `{ }` bind `photo`

### 6. Preview

In Data → **Preview pipeline**. You should see `ok: true` and `overrides` with resolved values (image URLs expanded).

### 7. On air

TAKE (Templates PLAY / Rundown) runs `runOn` (default `take,load`), fills variables, then goes on air. Video vars also get a timeline clip (duration from MAM; start frame preserved when the row changes).

---

## Source types

### `textfile` / `jsonfile`

Path from:

- **literal** — fixed string, e.g. `/uploads/show/A.txt`
- **variable** — another template variable holds the path (useful when Control exposes a path picker)

Read via `/api/files/read` (`.txt` / `.json` under uploads).

### `inline`

Paste content in the source card. Same formats as files. Good for tests without uploading.

---

## Formats

### `delimited` (CSV-like)

- Options: `delimiter` (default `|`), `columns`, `hasHeader`, `commentPrefix`, `skipEmpty`, `trim`
- One record per non-comment line
- Columns named by `columns` list (or header row if `hasHeader`)

```text
name|title|photo
Alice|Host|asset:…
Bob|Guest|asset:…
```

### `lines`

Each non-empty line → record with a single field (often `value` / index `0`). Use for simple playlists.

### `kv`

`key=value` lines → one record (object). Useful for a single “card” of fields.

```text
name=Alice
title=Host
photo=asset:…
```

### `json`

- Array of objects → many records
- Single object → one record
- Optional `rootPath` for nested arrays

```json
[
  { "name": "Alice", "title": "Host", "photo": "asset:…" },
  { "name": "Bob", "title": "Guest", "photo": "asset:…" }
]
```

---

## Select modes (designer-only)

| Mode | Meaning |
|---|---|
| `first` | First parsed row |
| `last` | Last row |
| `index` | Zero-based index (field appears when selected) |
| `byKey` | First row where `key` column equals `value` |
| `match` | First row where `key` matches regex `pattern` |
| `all` | All rows (advanced; map typically expects one row — prefer first/index/byKey for graphics) |

Examples:

- Always top of rundown file → `first`
- Fixed slot #3 → `index` = `2`
- Look up by slug from a Control-exposed var → put slug in a variable, use `byKey` with that value in the select value field (or drive path via variable)

---

## Map `as` types

| as | Result |
|---|---|
| `text` | String as-is (after optional transform) |
| `multitext` | Multiline string |
| `number` | Coerced number (invalid → error) |
| `time` | Kept as **time expression string** for clock vars (`today+1@20:00`, …) |
| `image` / `video` | Media resolve (`asset:` / url / path) → playable URL |

Transforms (optional): `trim`, `prefix`, `suffix`, `replace`.

---

## runOn / onError

| Field | Values | Meaning |
|---|---|---|
| `runOn` | `take`, `load`, `update` (comma list) | When the pipeline executes |
| `onError` | `block` / `keep` / `clear` | Fail TAKE vs keep previous vs clear mapped vars |

Pipeline `onEmpty`:

- `block` — no row → error (safe default for air)
- `keep` / `clear` — softer handling

---

## Media resolve

Strategies (order matters): `assetId`, `url`, `path`.

| onMiss | Behavior |
|---|---|
| `clear` | Empty string (layer shows nothing) |
| `keep` | Leave previous override |
| `block` | Fail pipeline |

`fallbackUrl` can supply a default image/video URL.

---

## Clock + Data (`time` variables)

1. Variable type **`time`**, default e.g. `today+1@20:00`
2. Mark Data-driven if the file supplies it; map column with `as: time`
3. Clock layer (countup/countdown) → bind Start/Target with `{ }` to that variable

Supported expressions (no scripts):

- `today`, `tomorrow`, `yesterday`
- `today+1`, `today-2`
- `today@18:00`, `today+1@09:30:00`
- `now`, `now+5m`, `now+1h`, `now+30s`
- ISO / `2026-07-28 20:00` / epoch ms

---

## Checklist

- [ ] Variables exist and `drivenBy` matches pipeline id
- [ ] File readable under `/uploads/…`
- [ ] Columns list matches file (trailing commas OK in the Columns UI)
- [ ] Map `as` correct for image/video/time
- [ ] Preview pipeline shows expected overrides
- [ ] Layers bound; TAKE works with file present

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| TAKE blocked | `onEmpty: block` and no row / file missing |
| Image empty | Bad `asset:` token or onMiss `clear` |
| Control shows driven fields | Untick Data-driven or turn off Show in Control |
| Video not on timeline | Need video variable + map `as: video` + layer bind; clip is created on resolve |
| Columns “eating” commas | Use Columns input (allows trailing comma); avoid splitting in a plain text field incorrectly |
