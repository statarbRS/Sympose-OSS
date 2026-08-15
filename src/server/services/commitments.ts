import type { Db } from "../db";
import { fingerprintOf, nowIso, uuid } from "../canonical";
import { withTransaction } from "../db";
import { writeAudit, writeDenialAudit } from "./audit";
import { getEvent } from "./events";
import { planState } from "./planning";
import { SimulatedDeliveryAdapter } from "../adapters/delivery-adapter";
import {
  commitmentOfferTerms,
  commitmentOfferTermsJson,
  commitmentOfferTermsMatchAuthority,
  type CommitmentOfferTermsAuthority,
  type CommitmentOfferTermsEvidence,
} from "./commitment-offer-contract";

export type CommitmentResponseKind = "accepted" | "declined";

export interface CommitmentOfferRow {
  id: string;
  eventId: string;
  planVersionId: string;
  personId: string;
  termsJson: string;
  termsFingerprint: string;
  status: string;
  createdAt: string;
}

export interface DeliverOffersResult {
  offersCreated: number;
  offersAlreadyPresent: number;
  receipts: string[];
}

function planHasExactApproval(
  db: Db,
  workspaceId: string,
  eventId: string,
  planVersionId: string,
): boolean {
  if (planState(db, workspaceId, planVersionId) !== "approved") return false;
  const approval = db.prepare(
    `SELECT COUNT(*) AS count,
            MAX(CASE WHEN decision = 'approved' THEN 1 ELSE 0 END) AS approved
       FROM approvals
      WHERE workspace_id = ? AND event_id = ? AND plan_version_id = ?`,
  ).get(workspaceId, eventId, planVersionId) as { count: number; approved: number | null };
  return approval.count === 1 && approval.approved === 1;
}

export function deliverOffers(
  db: Db,
  workspaceId: string,
  eventId: string,
  actor: { kind: "account"; ref: string },
): DeliverOffersResult {
  return withTransaction(db, () => {
    const event = getEvent(db, workspaceId, eventId);
    if (!event) {
      throw new Error("EVENT_NOT_FOUND");
    }
    const currentPlanVersionId = event.currentPlanVersionId;
    if (!currentPlanVersionId) {
      throw new Error("NO_PLAN: compile and approve a plan before delivering offers.");
    }
    const plan = db
      .prepare(
        `SELECT pv.id, pv.run_id AS runId, pv.fingerprint, pv.content_json AS content, pv.version_number AS versionNumber
         FROM plan_versions pv
         WHERE pv.workspace_id = ? AND pv.event_id = ? AND pv.id = ?`,
      )
      .get(workspaceId, eventId, currentPlanVersionId) as
       | { id: string; runId: string; fingerprint: string; content: string; versionNumber: number }
       | undefined;
    if (!plan) {
      throw new Error("EVENT_CURRENT_PLAN_POINTER_INVALID");
    }
    if (!planHasExactApproval(db, workspaceId, eventId, plan.id)) {
      throw new Error("PLAN_NOT_APPROVED: approve the plan before delivering offers.");
    }

    const assignments = db
      .prepare(
        `SELECT pa.person_id AS personId, pa.program_unit_id AS programUnitId, pa.assignment_type AS assignmentType,
                pu.name AS programUnitName, pu.starts_at AS startsAt, pu.ends_at AS endsAt, pu.capacity
         FROM plan_assignments pa
         JOIN program_units pu
           ON pu.id = pa.program_unit_id
          AND pu.workspace_id = pa.workspace_id
          AND pu.event_id = ?
         WHERE pa.workspace_id = ? AND pa.plan_version_id = ?`,
      )
      .all(eventId, workspaceId, plan.id) as {
      personId: string;
      programUnitId: string;
      assignmentType: string;
      programUnitName: string;
      startsAt: string;
      endsAt: string;
      capacity: number;
    }[];

    const existingOffers = new Map(
      (db
        .prepare(
          `SELECT person_id AS personId, terms_json AS termsJson,
                  terms_fingerprint AS termsFingerprint, status
           FROM commitment_offers
           WHERE workspace_id = ? AND event_id = ? AND plan_version_id = ?`,
        )
        .all(workspaceId, eventId, plan.id) as Array<{
          personId: string;
          termsJson: string;
          termsFingerprint: string;
          status: string;
        }>).map(
        (row) => [row.personId, row] as const,
      ),
    );

    const insertOffer = db.prepare(
      `INSERT OR IGNORE INTO commitment_offers
         (id, workspace_id, event_id, plan_version_id, person_id, terms_json, terms_fingerprint, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'offered', ?)`,
    );
    const delivery = new SimulatedDeliveryAdapter(db);
    const receipts: string[] = [];
    let created = 0;
    let alreadyPresent = 0;

    for (const assignment of assignments) {
      const authority: CommitmentOfferTermsAuthority = {
        planVersionId: plan.id,
        planFingerprint: plan.fingerprint,
        eventId,
        eventName: event.name,
        timezone: event.timezone,
        programUnitId: assignment.programUnitId,
        programUnitName: assignment.programUnitName,
        role: assignment.assignmentType,
        startsAt: assignment.startsAt,
        endsAt: assignment.endsAt,
      };
      const terms = commitmentOfferTerms(authority);
      const termsJson = commitmentOfferTermsJson(terms);
      const termsFingerprint = fingerprintOf(terms);
      const existingOffer = existingOffers.get(assignment.personId);
      if (existingOffer !== undefined) {
        if (
          existingOffer.status !== "offered" ||
          !commitmentOfferTermsMatchAuthority(existingOffer, authority)
        ) {
          throw new Error("OFFER_TERMS_CONFLICT");
        }
        alreadyPresent += 1;
        continue;
      }
      const offerId = uuid();
      const inserted = insertOffer.run(
        offerId,
        workspaceId,
        eventId,
        plan.id,
        assignment.personId,
        termsJson,
        termsFingerprint,
        nowIso(),
      );
      if (inserted.changes === 0) {
        const persisted = db
          .prepare(
            `SELECT terms_json AS termsJson, terms_fingerprint AS termsFingerprint, status
             FROM commitment_offers
             WHERE workspace_id = ? AND event_id = ? AND plan_version_id = ? AND person_id = ?`,
          )
          .get(workspaceId, eventId, plan.id, assignment.personId) as
          | (CommitmentOfferTermsEvidence & { status: unknown })
          | undefined;
        if (
          !persisted ||
          persisted.status !== "offered" ||
          !commitmentOfferTermsMatchAuthority(persisted, authority)
        ) {
          throw new Error("OFFER_TERMS_CONFLICT");
        }
        existingOffers.set(assignment.personId, {
          personId: assignment.personId,
          termsJson: persisted.termsJson as string,
          termsFingerprint: persisted.termsFingerprint as string,
          status: persisted.status,
        });
        alreadyPresent += 1;
        continue;
      }
      created += 1;
      existingOffers.set(assignment.personId, {
        personId: assignment.personId,
        termsJson,
        termsFingerprint,
        status: "offered",
      });
      const receipt = delivery.deliverOffer({
        workspaceId,
        eventId,
        personId: assignment.personId,
        offerId,
        communicationRunId: plan.runId,
        purpose: "commitment-offer",
        channel: "in-app-simulation",
        payloadFingerprint: termsFingerprint,
      });
      receipts.push(receipt.deliveryId);
    }

    if (created > 0) {
      writeAudit(db, workspaceId, {
        actorKind: actor.kind,
        actorRef: actor.ref,
        action: "commitment.offers.delivered",
        targetType: "event",
        targetId: eventId,
        details: { planVersionId: plan.id, created, alreadyPresent, receipts },
      });
    }

    return { offersCreated: created, offersAlreadyPresent: alreadyPresent, receipts };
  });
}

export interface ResponseResult {
  offerId: string;
  personId: string;
  response: CommitmentResponseKind;
  created: boolean;
  termsFingerprint: string;
}

export interface CommitmentResponseCommand {
  offerId: string;
  response: CommitmentResponseKind;
  commandKey: string;
}

interface ResponseFailure {
  failureCode: string;
}

type ResponseOutcome = ResponseResult | ResponseFailure;

/**
 * Stable command identity rendered with an explicit offer. It is not a secret;
 * workspace authorization and the persisted offer remain authoritative. The
 * key makes an exact browser/server-action replay recognizable and testable.
 */
export function commitmentResponseCommandKey(
  offerId: string,
  response: CommitmentResponseKind,
): string {
  return fingerprintOf({ schema: "commitment-response-command/v1", offerId, response });
}

export function commitmentResponseAuditDetails(input: {
  readonly eventId: string;
  readonly planVersionId: string;
  readonly termsFingerprint: string;
  readonly commandKey?: string;
}): Record<string, unknown> {
  return {
    eventId: input.eventId,
    planVersionId: input.planVersionId,
    termsFingerprint: input.termsFingerprint,
    ...(input.commandKey ? { commandKey: input.commandKey } : {}),
  };
}

/**
 * Command boundary used by the server action. It never discovers "the next"
 * offer during execution: the UI posts one immutable offer ID and its stable
 * command key, so replaying the request can only revisit that same offer.
 */
export function respondToOfferCommand(
  db: Db,
  workspaceId: string,
  eventId: string,
  command: CommitmentResponseCommand,
): ResponseResult {
  const expectedKey = commitmentResponseCommandKey(command.offerId, command.response);
  if (command.commandKey !== expectedKey) {
    throw new Error("COMMITMENT_COMMAND_KEY_MISMATCH");
  }

  const outcome = withTransaction(db, () => {
    const offer = db
      .prepare(
        `SELECT id, person_id AS personId
         FROM commitment_offers
         WHERE workspace_id = ? AND event_id = ? AND id = ?`,
      )
      .get(workspaceId, eventId, command.offerId) as
      | { id: string; personId: string }
      | undefined;
    if (!offer) {
      throw new Error("OFFER_NOT_FOUND");
    }
    return recordCommitmentResponseInTransaction(
      db,
      workspaceId,
      eventId,
      offer.id,
      command.response,
      { kind: "person", ref: offer.personId },
      command.commandKey,
    );
  });
  return unwrapResponseOutcome(outcome);
}

export function simulateCommitmentResponse(
  db: Db,
  workspaceId: string,
  offerId: string,
  response: CommitmentResponseKind,
  actor: { kind: "person"; ref: string },
  commandKey?: string,
): ResponseResult {
  const outcome = withTransaction(db, () =>
    recordCommitmentResponseInTransaction(
      db,
      workspaceId,
      undefined,
      offerId,
      response,
      actor,
      commandKey,
    ),
  );
  return unwrapResponseOutcome(outcome);
}

function recordCommitmentResponseInTransaction(
  db: Db,
  workspaceId: string,
  expectedEventId: string | undefined,
  offerId: string,
  response: CommitmentResponseKind,
  actor: { kind: "person"; ref: string },
  commandKey?: string,
): ResponseOutcome {
  const offer = db
    .prepare(
      `SELECT id, person_id AS personId, terms_fingerprint AS termsFingerprint, status,
              event_id AS eventId, plan_version_id AS planVersionId
       FROM commitment_offers WHERE workspace_id = ? AND id = ?`,
    )
    .get(workspaceId, offerId) as
    | {
        id: string;
        personId: string;
        termsFingerprint: string;
        status: string;
        eventId: string;
        planVersionId: string;
      }
    | undefined;
  if (!offer) {
    throw new Error("OFFER_NOT_FOUND");
  }
  if (expectedEventId !== undefined && offer.eventId !== expectedEventId) {
    throw new Error("OFFER_EVENT_MISMATCH");
  }
  if (actor.ref !== offer.personId) {
    throw new Error("OFFER_ACTOR_MISMATCH: only the person named by the offer may respond.");
  }

  const existingResponse = db
    .prepare(
      "SELECT response FROM commitment_responses WHERE workspace_id = ? AND offer_id = ?",
    )
    .get(workspaceId, offer.id) as { response: CommitmentResponseKind } | undefined;
  if (existingResponse) {
    if (existingResponse.response !== response) {
      writeDenialAuditForResponse(db, workspaceId, actor, offer, "COMMITMENT_RESPONSE_CONFLICT", {
        existingResponse: existingResponse.response,
        requestedResponse: response,
      });
      return { failureCode: "COMMITMENT_RESPONSE_CONFLICT" };
    }
    return {
      offerId: offer.id,
      personId: offer.personId,
      response: existingResponse.response,
      created: false,
      termsFingerprint: offer.termsFingerprint,
    };
  }

  const event = db
    .prepare(
      `SELECT current_plan_version_id AS currentPlanVersionId
       FROM events WHERE workspace_id = ? AND id = ?`,
    )
    .get(workspaceId, offer.eventId) as { currentPlanVersionId: string | null } | undefined;
  if (!event) {
    throw new Error("EVENT_NOT_FOUND");
  }

  let currentPlanVersionId = event.currentPlanVersionId;
  let currentPlanApproved = false;
  if (currentPlanVersionId !== null) {
    const currentPlan = db
      .prepare(
        `SELECT id FROM plan_versions
         WHERE workspace_id = ? AND event_id = ? AND id = ?`,
      )
      .get(workspaceId, offer.eventId, currentPlanVersionId) as { id: string } | undefined;
    if (!currentPlan) {
      throw new Error("EVENT_CURRENT_PLAN_POINTER_INVALID");
    }
    currentPlanApproved = planHasExactApproval(db, workspaceId, offer.eventId, currentPlan.id);
  }

  if (
    offer.status !== "offered" ||
    !currentPlanApproved ||
    currentPlanVersionId !== offer.planVersionId
  ) {
    writeDenialAuditForResponse(db, workspaceId, actor, offer, "OFFER_NOT_CURRENT", {
      currentPlanVersionId,
      currentPlanApproved,
    });
    return { failureCode: "OFFER_NOT_CURRENT" };
  }

  const responseId = uuid();
  db.prepare(
    `INSERT INTO commitment_responses (id, workspace_id, offer_id, response, responded_at, actor_person_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(responseId, workspaceId, offer.id, response, nowIso(), actor.ref);

  writeAudit(db, workspaceId, {
    actorKind: actor.kind,
    actorRef: actor.ref,
    action: `commitment.${response}`,
    targetType: "commitment_offer",
    targetId: offer.id,
    details: commitmentResponseAuditDetails({
      eventId: offer.eventId,
      planVersionId: offer.planVersionId,
      termsFingerprint: offer.termsFingerprint,
      ...(commandKey ? { commandKey } : {}),
    }),
  });

  return {
    offerId: offer.id,
    personId: offer.personId,
    response,
    created: true,
    termsFingerprint: offer.termsFingerprint,
  };
}

function writeDenialAuditForResponse(
  db: Db,
  workspaceId: string,
  actor: { kind: "person"; ref: string },
  offer: { id: string; eventId: string; planVersionId: string },
  code: string,
  details: Record<string, unknown>,
): void {
  writeDenialAudit(db, workspaceId, {
    actorKind: actor.kind,
    actorRef: actor.ref,
    code,
    targetType: "commitment_offer",
    targetId: offer.id,
    details: { eventId: offer.eventId, planVersionId: offer.planVersionId, ...details },
  });
}

function unwrapResponseOutcome(outcome: ResponseOutcome): ResponseResult {
  if ("failureCode" in outcome) {
    throw new Error(outcome.failureCode);
  }
  return outcome;
}

export function nextPendingOffer(db: Db, workspaceId: string, eventId: string): CommitmentOfferRow | null {
  const currentPlanVersionId = getCurrentApprovedPlanVersionId(db, workspaceId, eventId);
  if (!currentPlanVersionId) {
    return null;
  }
  const row = db
    .prepare(
      `SELECT o.id, o.event_id AS eventId, o.plan_version_id AS planVersionId, o.person_id AS personId,
              o.terms_json AS termsJson, o.terms_fingerprint AS termsFingerprint, o.status, o.created_at AS createdAt
       FROM commitment_offers o
       WHERE o.workspace_id = ? AND o.event_id = ? AND o.plan_version_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM commitment_responses r
           WHERE r.workspace_id = o.workspace_id AND r.offer_id = o.id
         )
       ORDER BY o.created_at, o.rowid LIMIT 1`,
    )
    .get(workspaceId, eventId, currentPlanVersionId) as CommitmentOfferRow | undefined;
  return row ?? null;
}

export interface CommitmentOfferView extends CommitmentOfferRow {
  personName: string;
  email: string;
  response: string | null;
  respondedAt: string | null;
  acceptCommandKey: string;
  declineCommandKey: string;
}

export function listOffers(db: Db, workspaceId: string, eventId: string): CommitmentOfferView[] {
  const currentPlanVersionId = getCurrentApprovedPlanVersionId(db, workspaceId, eventId);
  if (!currentPlanVersionId) {
    return [];
  }
  const rows = db
    .prepare(
      `SELECT o.id, o.event_id AS eventId, o.plan_version_id AS planVersionId, o.person_id AS personId,
              o.terms_json AS termsJson, o.terms_fingerprint AS termsFingerprint, o.status, o.created_at AS createdAt,
              p.full_name AS personName, p.canonical_email AS email,
              cr.response AS response, cr.responded_at AS respondedAt
       FROM commitment_offers o
       JOIN people p ON p.id = o.person_id AND p.workspace_id = o.workspace_id
       LEFT JOIN commitment_responses cr
         ON cr.offer_id = o.id AND cr.workspace_id = o.workspace_id
        WHERE o.workspace_id = ? AND o.event_id = ? AND o.plan_version_id = ?
        ORDER BY o.created_at, o.rowid`,
    )
    .all(workspaceId, eventId, currentPlanVersionId) as unknown as (CommitmentOfferRow & {
    personName: string;
    email: string;
    response: string | null;
    respondedAt: string | null;
  })[];
  return rows.map((row) => ({
    ...row,
    acceptCommandKey: commitmentResponseCommandKey(row.id, "accepted"),
    declineCommandKey: commitmentResponseCommandKey(row.id, "declined"),
  }));
}

function getCurrentApprovedPlanVersionId(
  db: Db,
  workspaceId: string,
  eventId: string,
): string | null {
  const event = db
    .prepare(
      "SELECT current_plan_version_id AS currentPlanVersionId FROM events WHERE workspace_id = ? AND id = ?",
    )
    .get(workspaceId, eventId) as { currentPlanVersionId: string | null } | undefined;
  if (!event || event.currentPlanVersionId === null) {
    return null;
  }
  const plan = db
    .prepare(
      "SELECT id FROM plan_versions WHERE workspace_id = ? AND event_id = ? AND id = ?",
    )
    .get(workspaceId, eventId, event.currentPlanVersionId) as { id: string } | undefined;
  if (!plan) {
    throw new Error("EVENT_CURRENT_PLAN_POINTER_INVALID");
  }
  if (!planHasExactApproval(db, workspaceId, eventId, plan.id)) {
    return null;
  }
  return plan.id;
}
