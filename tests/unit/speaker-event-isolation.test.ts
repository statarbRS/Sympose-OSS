import { describe, expect, it } from "vitest";

import {
  EVALUATOR_EVENT_ID,
  EVALUATOR_WORKSPACE_ID,
} from "../../src/server/evaluator-demo";
import {
  createSyntheticSpeakerOperationsRepository,
  speakerEventInitializationFor,
  syntheticSpeakerPortalToken,
} from "../../src/server/services/speaker-operations";
import {
  EVALUATOR_ARTIFACT_PERSON_ID,
} from "../../src/server/services/evaluator-speaker-identity";

const evaluatorEvent = {
  id: EVALUATOR_EVENT_ID,
  name: "Acme Evaluator Summit",
  timezone: "UTC",
  startsAt: "2026-09-18T09:00:00.000Z",
  endsAt: "2026-09-18T17:00:00.000Z",
} as const;

const ordinaryEvent = {
  id: "event-new-empty-roster",
  name: "A newly created event",
  timezone: "UTC",
  startsAt: "2026-09-20T09:00:00.000Z",
  endsAt: "2026-09-20T17:00:00.000Z",
} as const;

describe("speaker event fixture isolation", () => {
  it("seeds only the exact evaluator event and keeps ordinary events empty", () => {
    const repository = createSyntheticSpeakerOperationsRepository({
      clock: () => "2026-08-12T12:00:10.000Z",
      defaultEventInitialization: { kind: "ordinary" },
    });
    const ordinaryOrganizer = {
      kind: "organizer" as const,
      workspaceId: EVALUATOR_WORKSPACE_ID,
      eventId: ordinaryEvent.id,
      actorId: "acme-organizer",
    };

    repository.initializeEvent(EVALUATOR_WORKSPACE_ID, ordinaryEvent, speakerEventInitializationFor(EVALUATOR_WORKSPACE_ID, ordinaryEvent.id));
    repository.initializeEvent(EVALUATOR_WORKSPACE_ID, evaluatorEvent, speakerEventInitializationFor(EVALUATOR_WORKSPACE_ID, evaluatorEvent.id));

    const ordinary = repository.getOrganizerProjection(ordinaryOrganizer, ordinaryEvent);
    const demo = repository.getOrganizerProjection(
      { ...ordinaryOrganizer, eventId: evaluatorEvent.id },
      evaluatorEvent,
    );

    expect(ordinary.roster).toEqual([]);
    expect(ordinary.dashboard).toMatchObject({
      rosterCount: 0,
      acceptedCommitmentCount: 0,
      awaitingResponseCount: 0,
      overdueTaskCount: 0,
      readinessBlockerCount: 0,
      submittedContentCount: 0,
    });
    expect(demo.roster.map((record) => record.person.fullName)).toEqual([
      "Mina Park",
    ]);
  });

  it("does not copy a seeded roster, tasks, or portal access into another event", () => {
    const repository = createSyntheticSpeakerOperationsRepository({
      clock: () => "2026-08-12T12:00:10.000Z",
      defaultEventInitialization: { kind: "ordinary" },
    });
    repository.initializeEvent(EVALUATOR_WORKSPACE_ID, evaluatorEvent, speakerEventInitializationFor(EVALUATOR_WORKSPACE_ID, evaluatorEvent.id));
    const otherEvent = { ...ordinaryEvent, id: "event-acme-second" };
    const otherOrganizer = {
      kind: "organizer" as const,
      workspaceId: EVALUATOR_WORKSPACE_ID,
      eventId: otherEvent.id,
      actorId: "acme-organizer",
    };
    repository.initializeEvent(EVALUATOR_WORKSPACE_ID, otherEvent, speakerEventInitializationFor(EVALUATOR_WORKSPACE_ID, otherEvent.id));

    expect(repository.getOrganizerProjection(otherOrganizer, otherEvent).roster).toEqual([]);
    const evaluatorToken = syntheticSpeakerPortalToken(EVALUATOR_WORKSPACE_ID, evaluatorEvent.id, EVALUATOR_ARTIFACT_PERSON_ID);
    expect(repository.getPortalProjection(evaluatorToken)?.event.id).toBe(EVALUATOR_EVENT_ID);
    expect(repository.getPortalProjection(syntheticSpeakerPortalToken(EVALUATOR_WORKSPACE_ID, otherEvent.id, EVALUATOR_ARTIFACT_PERSON_ID))).toBeNull();
  });

  it("does not resolve a portal token for an empty event", () => {
    const repository = createSyntheticSpeakerOperationsRepository({
      defaultEventInitialization: { kind: "ordinary" },
    });
    const workspaceId = "workspace-empty-event";
    repository.initializeEvent(workspaceId, ordinaryEvent, speakerEventInitializationFor(workspaceId, ordinaryEvent.id));
    const token = syntheticSpeakerPortalToken(workspaceId, ordinaryEvent.id, "person-not-imported");

    expect(repository.resolvePortalToken(token)).toBeNull();
    expect(repository.getPortalProjection(token)).toBeNull();
  });

  it("keeps the current external evaluator speaker route working across repository restarts", () => {
    const token = syntheticSpeakerPortalToken(EVALUATOR_WORKSPACE_ID, EVALUATOR_EVENT_ID, EVALUATOR_ARTIFACT_PERSON_ID);
    const repository = createSyntheticSpeakerOperationsRepository({ defaultEventInitialization: { kind: "ordinary" } });

    expect(repository.resolvePortalToken(token)).toMatchObject({
      workspaceId: EVALUATOR_WORKSPACE_ID,
      eventId: EVALUATOR_EVENT_ID,
      personId: EVALUATOR_ARTIFACT_PERSON_ID,
      active: true,
    });
    expect(repository.getPortalProjection(token)?.person.fullName).toBe("Mina Park");

    const restartedRepository = createSyntheticSpeakerOperationsRepository({ defaultEventInitialization: { kind: "ordinary" } });
    expect(restartedRepository.getPortalProjection(token)?.person.fullName).toBe("Mina Park");
  });
});
