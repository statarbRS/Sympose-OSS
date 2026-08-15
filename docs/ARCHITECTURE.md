# Architecture

Sympose is a modular monolith built with Next.js, React, TypeScript, Zod, and Node's SQLite driver for
the self-contained evaluator deployment.

## Domain spine

The application preserves four distinct truth layers:

1. Candidate truth: what submitted data and rules imply.
2. Decision truth: what an authorized organizer selected or approved.
3. Commitment truth: what the relevant parties accepted or declined.
4. Operational truth: what happened during delivery.

Evidence and provenance explain those layers. They do not become a generic status field.

Canonical people persist independently from event participation. Proposals retain immutable lineage.
Reviews, advocacy, decisions, conditions, speaker tasks, artifact versions, schedule drafts, and sealed
publication releases remain separate but linked records.

## Runtime boundaries

- Every organizer query and command derives workspace authority from a server session.
- Reviewer, applicant, speaker, public, and organizer projections expose only their permitted fields.
- Database constraints and service checks enforce cross-workspace and cross-event isolation.
- Uploaded bytes use generated storage identities, bounded size/type checks, hashes, scoped downloads,
  and immutable version records.
- Publication copies approved exact versions into immutable audience releases. Later changes create
  drift or a superseding release; they never rewrite a sealed release.
- Connector execution is selected server-side. Synthetic mode cannot perform provider traffic, and
  production-network mode fails closed unless explicitly configured.

## Storage

The evaluator uses one local SQLite database and a private local artifact directory. This provides a
reproducible single-host demonstration; it is not a claim of multi-instance durability. The service
isolates release state and verifies the exact build SHA at startup and through `/health`.

The domain/service boundaries are designed so a production deployment can replace local persistence
and job execution without changing product semantics or public projections.
