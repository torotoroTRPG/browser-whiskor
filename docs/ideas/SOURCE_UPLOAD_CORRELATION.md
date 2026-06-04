# Source upload & runtime↔source correlation

**Status:** design / proposed (2026-06-04)

## Goal

Let the user **upload the target site's source** (front-end only, full-stack, or
just a slice) and have whiskor automatically correlate what it observes at runtime
with the relevant source — e.g. "the component rendering this button is defined in
`src/auth/LoginForm.tsx`" — and hand the agent **only the necessary slice** as
context when it asks, instead of the whole tree.

## Why it fits whiskor

whiskor already does runtime→source correlation for *fetched* assets:
`source-store` (CSS source cache + cross-session hashing), `source-map-resolver`
(VLQ sourcemaps), `css-origin`, and `framework-dom-map` (framework component ↔
DOM node). This feature extends that from "assets the browser served" to "source
the **user** holds" — including server code the browser never sees — and adds a
component→file index + on-demand slicing.

## Pieces

### 1. Upload & store (server)
- `POST /api/source/upload` — accept a zip (whiskor already ships a dependency-free
  zip *writer*; add a small reader) or a path the user points at. Store under
  `cache/uploaded-source/<projectId>/` with a manifest (file list, hashes, langs).
- A `projectId` ties an upload to a site (origin/host) so correlation scopes to it.
- Respect `.gitignore`-style excludes and a size cap; never index `node_modules/`.
- Privacy: uploaded source stays server-side; the secret guard
  ([[project_secret_guard]]) still redacts any secret that would surface in a slice.

### 2. Index (server)
- Build a lightweight **symbol index**: file → exported symbols (components,
  functions, classes) and component-name → file(s). v1 is grep/heuristic
  (e.g. `export function Foo`, `export default class Bar`, `const Baz = () => `),
  not a full AST — cheap, language-agnostic-ish, good enough to map a name to a
  file. v2 can add real parsing per language.
- For React/Vue/etc., key the index by **component display name** so it lines up
  with what the framework adapters report at runtime.

### 3. Correlate (runtime → source)
- When whiskor observes a component (react adapter / `framework-dom-map`), look up
  its name in the symbol index → candidate source file(s). Record the mapping
  (component → file, with a confidence: exact name match > fuzzy).
- Sourcemaps tighten it: if the page ships a sourcemap, `source-map-resolver`
  already yields the original path — cross-check against the uploaded tree to pin
  the exact file (and even line range).

### 4. Serve (on demand, sliced)
- New MCP tool `get_source_context({ component?, selector?, file?, around? })`:
  resolve the target (a component name, a DOM selector → its component, or an
  explicit file) → return **just the relevant slice** — the defining file, or a
  focused excerpt around the symbol (± `around` lines) — not the whole repo.
- Returns `{ file, language, lines:[from,to], excerpt, related:[...] }`. The agent
  pulls more only when it asks; context stays lean (the whole point).

## Phasing
- **Slice 1:** upload + store + a flat file index; `get_source_context({ file })`
  returns a sliced excerpt. (No correlation yet — just "serve uploaded source
  lean".) Unit-testable: zip read, index build, slicing.
- **Slice 2:** symbol index + `component`/`selector` resolution via the existing
  framework-dom-map / react adapter names.
- **Slice 3:** sourcemap cross-check for exact file+line pinning; record observed
  correlations so repeat lookups are instant.

## Open questions
- Upload UX: zip via the dashboard, a watched directory, or a CLI (`whiskor source
  add <path>`)? Start with `POST /api/source/upload` + a dashboard control.
- Multi-project / identity scoping (one whiskor, several uploaded codebases) —
  key by `projectId`; reuse the identity-bucket idea if needed.
- Back-end source: indexed and sliceable the same way, but correlation to runtime
  is weaker (no DOM signal) — rely on network endpoints / file names. Treat as
  "searchable context" rather than DOM-correlated for v1.
- Size/perf: index lazily, cap file sizes, skip binaries/`node_modules`.
```
