# ADR 0001: Local append-only evidence persistence

- **Status:** Accepted
- **Date:** 2026-10-18
- **Owners:** Control plane / evidence domain

## Context

Rift's first release must be replayable offline and must not introduce a
database service, credentials, migrations, or an availability dependency. The
system also needs an immutable provenance trail: imported observations must not
be replaced or deleted during retries.

## Decision

Persist evidence as newline-delimited JSON in a local filesystem file owned by
the control plane. Each successful append is one complete JSON object followed
by a newline. The writer validates the `EvidenceItem`, verifies its
content-addressed `contentHash`, writes with append semantics, flushes the file,
and then makes the record visible to readers. Startup validates every existing
record and fails closed on malformed JSON, invalid contracts, duplicate IDs, or
duplicate content hashes.

The store exposes `append`, `get`, and `list` only. It does not expose update or
delete operations. Retries with the same ID and identical payload are
idempotent; a reused ID or content hash with a different payload is rejected.
The default API test server may use the in-memory implementation, but a
production-like local run must select `LocalEvidenceStore` with an explicit
path from configuration. Evidence files are workspace data, never source-tree
files, and are excluded from git.

## Consequences

- No database is required for M1–M5 local workflows.
- JSONL is inspectable and easy to copy into a replay fixture.
- Concurrent writers, retention, compaction, and multi-host durability remain
  explicit M6 work; no process may silently rewrite the log.
- The persistence boundary remains an interface so a later durable backend can
  be added without changing contract consumers.

## Rejected alternatives

- **SQLite now:** useful durability, but adds a migration and locking surface
  before the product has stable retention requirements.
- **Mutable JSON snapshot:** simple, but loses append history and makes crash
  recovery ambiguous.
- **Remote database:** violates the offline and local-first foundation.
