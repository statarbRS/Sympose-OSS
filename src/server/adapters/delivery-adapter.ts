import { deterministicUuid, fingerprintOf, nowIso } from "../canonical";
import type { Db } from "../db";
import {
  SHARED_ACTION_TASK_REMINDER_PROVIDER_RECEIPT_SCHEMA,
  type ActionTaskReminderDeliveryAdapter,
  type ActionTaskReminderDeliveryIntent,
  type ActionTaskReminderProviderReceipt,
} from "../services/speaker-operations/contracts";

export interface DeliveryReceipt {
  deliveryId: string;
  channel: string;
  deliveredAt: string;
  simulated: true;
}

export interface DeliveryAdapter {
  readonly kind: string;
  deliverOffer(intent: DeliveryIntent): DeliveryReceipt;
}

export interface DeliveryIntent {
  workspaceId: string;
  eventId: string;
  personId: string;
  offerId: string;
  communicationRunId: string;
  purpose: string;
  channel: string;
  payloadFingerprint: string;
}

/**
 * Safe default for the automatic reminder worker. It performs no I/O and returns a deterministic
 * provider-shaped acknowledgement which the worker persists before marking the outbox delivered.
 */
export class NoNetworkActionTaskReminderDeliveryAdapter implements ActionTaskReminderDeliveryAdapter {
  readonly kind = "speaker-reminder.no-network-simulated/v1";
  readonly networkContacted = false as const;
  readonly providerMutation = false as const;
  private readonly clock: () => string;

  constructor(options: { readonly clock?: () => string } = {}) {
    this.clock = options.clock ?? nowIso;
  }

  deliver(intent: ActionTaskReminderDeliveryIntent): ActionTaskReminderProviderReceipt {
    return {
      schema: SHARED_ACTION_TASK_REMINDER_PROVIDER_RECEIPT_SCHEMA,
      providerReceiptId: deterministicUuid(
        `speaker-reminder-no-network-receipt:${intent.messageId}:${intent.idempotencyKey}:${intent.payloadFingerprint}`,
      ),
      messageId: intent.messageId,
      idempotencyKey: intent.idempotencyKey,
      payloadFingerprint: intent.payloadFingerprint,
      acceptedAt: this.clock(),
      deliveryMode: "NO_NETWORK_SIMULATED",
      networkContacted: false,
      providerMutation: false,
    };
  }
}

/**
 * Explicit simulated delivery adapter. It produces a durable receipt exactly like a real
 * provider would, but never contacts any external service. The receipt is evidence that the
 * offer envelope left the system; it is not commitment truth.
 */
export class SimulatedDeliveryAdapter implements DeliveryAdapter {
  readonly kind = "delivery.in-app.simulated";
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  deliverOffer(intent: DeliveryIntent): DeliveryReceipt {
    const deliveryId = deterministicUuid(`delivery:${intent.workspaceId}:${intent.offerId}`);
    const auditId = deterministicUuid(`audit:${deliveryId}`);
    const intentFingerprint = fingerprintOf(intent);
    const findAudit = this.db.prepare(
      `SELECT created_at AS createdAt, details_json AS detailsJson
       FROM audit_events
       WHERE id = ? AND workspace_id = ?
         AND action = 'commitment.offer.delivered'
         AND target_type = 'commitment_offer' AND target_id = ?`,
    );
    const readPersistedReceipt = (): DeliveryReceipt | null => {
      const persisted = findAudit.get(auditId, intent.workspaceId, intent.offerId) as
        | { createdAt: string; detailsJson: string | null }
        | undefined;
      if (!persisted) {
        return null;
      }
      let details: {
        workspaceId?: unknown;
        eventId?: unknown;
        personId?: unknown;
        offerId?: unknown;
        communicationRunId?: unknown;
        purpose?: unknown;
        channel?: unknown;
        payloadFingerprint?: unknown;
        intentFingerprint?: unknown;
        deliveryId?: unknown;
      } = {};
      try {
        details = persisted.detailsJson
          ? (JSON.parse(persisted.detailsJson) as typeof details)
          : {};
      } catch {
        throw new Error("DELIVERY_RECEIPT_INVALID");
      }
      if (
        details.workspaceId !== intent.workspaceId ||
        details.eventId !== intent.eventId ||
        details.personId !== intent.personId ||
        details.offerId !== intent.offerId ||
        details.communicationRunId !== intent.communicationRunId ||
        details.purpose !== intent.purpose ||
        details.channel !== intent.channel ||
        details.payloadFingerprint !== intent.payloadFingerprint ||
        details.intentFingerprint !== intentFingerprint ||
        details.deliveryId !== deliveryId
      ) {
        throw new Error("DELIVERY_COMMAND_CONFLICT");
      }
      return {
        deliveryId,
        channel: intent.channel,
        deliveredAt: persisted.createdAt,
        simulated: true,
      };
    };

    const existing = readPersistedReceipt();
    if (existing) {
      return existing;
    }

    const deliveredAt = nowIso();
    try {
      this.db.prepare(
        `INSERT INTO audit_events (id, workspace_id, actor_kind, actor_ref, action, target_type, target_id, details_json, created_at)
         VALUES (?, ?, 'system', ?, 'commitment.offer.delivered', 'commitment_offer', ?, ?, ?)`,
      ).run(
        auditId,
        intent.workspaceId,
        this.kind,
        intent.offerId,
        JSON.stringify({
          adapter: this.kind,
          operation: "commitment.offer.delivery",
          schema: "delivery-receipt/v1",
          serviceIdentity: this.kind,
          workspaceId: intent.workspaceId,
          eventId: intent.eventId,
          personId: intent.personId,
          offerId: intent.offerId,
          communicationRunId: intent.communicationRunId,
          purpose: intent.purpose,
          channel: intent.channel,
          payloadFingerprint: intent.payloadFingerprint,
          intentFingerprint,
          deliveryId,
          completedAt: deliveredAt,
        }),
        deliveredAt,
      );
    } catch {
      const replay = readPersistedReceipt();
      if (replay) {
        return replay;
      }
      throw new Error("DELIVERY_RECEIPT_CONFLICT");
    }
    return { deliveryId, channel: intent.channel, deliveredAt, simulated: true };
  }
}
