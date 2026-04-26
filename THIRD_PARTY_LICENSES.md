# Third-Party Licenses

This product includes third-party software. License notices are reproduced
inline for Docker-sidecar components, and full license texts for bundled npm
dependencies live under `licenses/` (regenerate with `npm run licenses:generate`).

---

## Docker sidecars

These run as separate containers. Images are pulled from Docker Hub at runtime.

### Kroki

- Project: https://github.com/yuzutech/kroki
- Image: `yuzutech/kroki`, `yuzutech/kroki-mermaid`
- Usage: Renders Mermaid, D2, PlantUML, and Graphviz diagrams.

```
MIT License

Copyright (c) 2020-present Kroki

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### PostgreSQL + pgvector

- Projects: https://www.postgresql.org, https://github.com/pgvector/pgvector
- Image: `pgvector/pgvector:pg17`
- Licenses: PostgreSQL License (PostgreSQL core) + PostgreSQL License (pgvector)
  — both permissive BSD-style.

### Redis

- Project: https://github.com/redis/redis
- Image: `redis:7-alpine`
- License: Redis OSS 7.2 and earlier is 3-Clause BSD. Redis 7.4+ is dual
  RSALv2 / SSPLv1 (source-available, not OSI-approved). If shipping a
  commercial distribution, pin to a BSD-licensed tag or switch to
  Valkey / KeyDB.

---

## npm dependencies

The `apps/api` and `apps/ui` production dependency trees are covered by
`npm run licenses:generate`, which writes per-package license files to:

```
licenses/
  api/       # apps/api production deps
  ui/        # apps/ui production deps
```

Each file is named `<package>@<version>-LICENSE.txt` and contains the verbatim
license text from the package's repository.

All npm dependencies use permissive licenses (MIT, ISC, Apache-2.0, BSD,
BlueOak, Unlicense) compatible with closed-source distribution.

### Noteworthy items

- **`dompurify`** (MPL-2.0 OR Apache-2.0) — MPL-2.0 is file-level copyleft.
  Not an issue as long as the upstream source is not modified; preserve the
  notice.
- **`jszip`** (MIT OR GPL-3.0-or-later) — choose MIT by keeping the notice.
- **`buffers@0.1.1`** — no license field in `package.json`; historically MIT
  per the GitHub repo (`substack/node-buffers`). If this becomes a concern,
  replace with `buffer` or drop.

---

## Regenerating

```bash
npm run licenses:generate
```

Run this any time production dependencies change.
