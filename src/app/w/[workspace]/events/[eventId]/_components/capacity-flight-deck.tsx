import { ArrowRight, Gauge, Layers3 } from "lucide-react";

import { Badge, Fingerprint, formatDateTime } from "@/components/truth";
import type {
  CapacityFlightDeckPoolType,
  CapacityFlightDeckProjection,
} from "@/server/services/capacity-flight-deck";

import styles from "./capacity-flight-deck.module.css";

function valueOrDash(value: number | null): string | number {
  return value === null ? "—" : value;
}

function poolTypeTone(type: CapacityFlightDeckPoolType): "accepted" | "denied" | "neutral" {
  if (type.state === "OVER") return "denied";
  if (type.state === "CLEAR") return "accepted";
  return "neutral";
}

function poolTypeStatus(type: CapacityFlightDeckPoolType): string {
  if (type.state === "OVER") {
    return type.pools.length === 0
      ? `${type.over} demand uncovered by conserved pools`
      : `${type.over} over capacity`;
  }
  if (type.state === "CLEAR") return "Within capacity";
  return "Demand not projected";
}

function TypeLane({ type }: { readonly type: CapacityFlightDeckPoolType }) {
  const utilization = type.utilizationPercent === null ? null : Math.max(type.utilizationPercent, 0);
  return (
    <article
      className={styles.typeLane}
      data-testid="capacity-pool-type"
      data-unit-kind={type.unitKind}
      data-state={type.state.toLowerCase()}
    >
      <header className={styles.typeHeader}>
        <div>
          <span className={styles.kicker}>Typed pool family</span>
          <h4>{type.unitKind}</h4>
        </div>
        <Badge tone={poolTypeTone(type)}>{poolTypeStatus(type)}</Badge>
      </header>

      <div className={styles.balanceReadout}>
        <div>
          <span>Conserved now</span>
          <strong>{type.conserved}</strong>
          <small>{type.configured} configured · {type.pools.length} pool{type.pools.length === 1 ? "" : "s"}</small>
        </div>
        <div className={styles.balanceArrow} aria-hidden="true"><ArrowRight size={17} /></div>
        <div>
          <span>Accepted demand</span>
          <strong>{valueOrDash(type.demand)}</strong>
          <small>{type.demand === null ? "No commitment projection" : `${type.unitKind} required`}</small>
        </div>
      </div>

      {utilization === null ? (
        <div className={styles.coverageUnavailable}>
          {type.demand === null
            ? "Coverage waits for an accepted-session projection."
            : "No conserved capacity exists, so a utilization ratio is not defined."}
        </div>
      ) : (
        <div className={styles.coverage}>
          <div
            className={styles.coverageTrack}
            role="img"
            aria-label={`${type.unitKind} accepted demand uses ${utilization}% of current conserved capacity`}
          >
            <span
              className={styles.coverageFill}
              style={{ width: `${Math.min(utilization, 100)}%` }}
            />
          </div>
          <span>{utilization}% used</span>
        </div>
      )}

      <dl className={styles.capacityMetrics} aria-label={`${type.unitKind} capacity coverage`}>
        <div><dt>Allocated</dt><dd>{valueOrDash(type.allocated)}</dd></div>
        <div><dt>Remaining</dt><dd>{valueOrDash(type.remaining)}</dd></div>
        <div className={type.over && type.over > 0 ? styles.metricOver : undefined}><dt>Over</dt><dd>{valueOrDash(type.over)}</dd></div>
      </dl>

      {type.pools.length === 0 ? (
        <p className={styles.poolEmpty}>No conserved {type.unitKind} pool is configured. Demand is shown without inventing a pool assignment.</p>
      ) : (
        <ul className={styles.poolList} aria-label={`${type.unitKind} pool balances`}>
          {type.pools.map((pool) => (
            <li key={pool.poolId}>
              <div><strong>{pool.poolName}</strong><code>{pool.poolId}</code></div>
              <div className={styles.poolBalance}><strong>{pool.remaining}</strong><span>current balance</span></div>
              <div className={styles.poolFlow}><span>+{pool.transferredIn} in</span><span>−{pool.transferredOut} out</span></div>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

export function CapacityFlightDeck({
  projection,
}: {
  readonly projection: CapacityFlightDeckProjection;
}) {
  const { capacity, acceptedDemand, plan } = projection;
  return (
    <section
      className={styles.deck}
      data-testid="capacity-flight-deck"
      data-capacity-sequence={capacity.sequenceNumber}
      aria-labelledby="capacity-flight-deck-title"
    >
      <header className={styles.deckHeader}>
        <div className={styles.titleGroup}>
          <div className={styles.titleMark} aria-hidden="true"><Gauge size={22} /></div>
          <div>
            <p className={styles.eyebrow}>Capacity Flight Deck · read-only projection</p>
            <h2 id="capacity-flight-deck-title">Conserved capacity, demand, and slate evidence</h2>
            <p>
              Current balances come from typed pools and transfer receipts. Accepted-session demand
              and plan drivers remain linked to their own truth records.
            </p>
          </div>
        </div>
        <div className={styles.sequence}>
          <span>Ledger sequence</span>
          <strong>{capacity.sequenceNumber}</strong>
          <Fingerprint value={capacity.ledgerFingerprint} label="Capacity ledger fingerprint" />
        </div>
      </header>

      <dl className={styles.sourceRail} aria-label="Capacity Flight Deck source anchors">
        <div>
          <dt>Conserved capacity</dt>
          <dd><strong>{capacity.poolCount}</strong> typed pool{capacity.poolCount === 1 ? "" : "s"}</dd>
          <dd className={styles.sourceMeta}>Decision projection</dd>
        </div>
        <div>
          <dt>Accepted demand</dt>
          <dd><strong>{acceptedDemand.total ?? "—"}</strong> {acceptedDemand.available ? acceptedDemand.unitKind : "not projected"}</dd>
          <dd className={styles.sourceMeta}>{acceptedDemand.sessions.length} accepted session{acceptedDemand.sessions.length === 1 ? "" : "s"}</dd>
        </div>
        <div>
          <dt>Slate lens</dt>
          <dd><strong>{plan ? `v${plan.versionNumber}` : "—"}</strong> {plan?.status ?? "No plan"}</dd>
          <dd className={styles.sourceMeta}>{plan ? `${plan.assignmentCount} assignments` : "No plan evidence"}</dd>
        </div>
      </dl>

      <section className={styles.capacityPlane} aria-labelledby="typed-capacity-title">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.kicker}>Conservation plane</p>
            <h3 id="typed-capacity-title"><Layers3 size={18} aria-hidden="true" /> Typed capacity coverage</h3>
          </div>
          <p>
            “Allocated” is accepted <code>SEAT</code> demand covered at the type level. It does not
            assign a session to a named pool or create operational state.
          </p>
        </div>

        {capacity.poolCount === 0 ? (
          <div className={styles.emptyNotice} data-testid="capacity-empty-state" role="status">
            <strong>No conserved capacity pools exist for this event.</strong>
            <span>{acceptedDemand.available ? "Accepted demand remains visible and is measured against zero conserved capacity." : "No accepted-session demand is projected yet."}</span>
          </div>
        ) : null}

        {capacity.poolTypes.length > 0 ? (
          <div className={styles.typeGrid}>{capacity.poolTypes.map((type) => <TypeLane key={type.unitKind} type={type} />)}</div>
        ) : null}
      </section>

      <div className={styles.detailGrid}>
        <section className={styles.detailPanel} aria-labelledby="accepted-demand-title">
          <div className={styles.panelHeader}>
            <div><p className={styles.kicker}>Commitment truth</p><h3 id="accepted-demand-title">Accepted-session demand</h3></div>
            {acceptedDemand.available ? <Badge tone="accepted">Accepted inventory</Badge> : <Badge tone="neutral">Not projected</Badge>}
          </div>
          {!acceptedDemand.available ? (
            <div className={styles.panelEmpty}>No approved-plan accepted-session projection exists yet. Capacity balance is shown without inferring demand.</div>
          ) : acceptedDemand.sessions.length === 0 ? (
            <div className={styles.panelEmpty}>The accepted inventory projection contains no sessions.</div>
          ) : (
            <ul className={styles.sessionList}>
              {acceptedDemand.sessions.map((session) => (
                <li key={session.id} data-room-state={session.placement?.over ? "over" : session.placement ? "clear" : "unscheduled"}>
                  <div className={styles.sessionIdentity}><strong>{session.title}</strong><code>{session.id}</code></div>
                  <dl>
                    <div><dt>Demand</dt><dd>{session.demand} {session.unitKind}</dd></div>
                    <div><dt>Schedule allocation</dt><dd>{session.placement ? session.placement.roomName : "Unscheduled"}</dd></div>
                    <div><dt>Room fit</dt><dd>{session.placement ? session.placement.over > 0 ? `${session.placement.over} over room` : `${session.placement.remaining} remaining` : "No room comparison"}</dd></div>
                  </dl>
                </li>
              ))}
            </ul>
          )}
          {acceptedDemand.inventoryFingerprint ? (
            <div className={styles.sourceFoot}>
              <span>Accepted inventory</span>
              <span data-testid="accepted-inventory-fingerprint"><Fingerprint value={acceptedDemand.inventoryFingerprint} label="Accepted inventory fingerprint" /></span>
            </div>
          ) : null}
        </section>

        <section className={styles.detailPanel} aria-labelledby="slate-drivers-title">
          <div className={styles.panelHeader}>
            <div><p className={styles.kicker}>Candidate / decision truth</p><h3 id="slate-drivers-title">Selected slate drivers</h3></div>
            {plan ? <Badge tone={plan.status === "approved" ? "approved" : "candidate"}>{plan.status}</Badge> : <Badge tone="neutral">No plan</Badge>}
          </div>
          {!plan ? (
            <div className={styles.panelEmpty}>No plan projection exists, so no constraint, objective, or alternative evidence is inferred.</div>
          ) : (
            <>
              <div className={plan.alignsWithAcceptedDemand === false ? styles.anchorWarning : styles.anchorNote}>
                {plan.alignsWithAcceptedDemand === true
                  ? "This plan is the exact approved plan anchoring accepted-session demand."
                  : plan.alignsWithAcceptedDemand === false
                    ? "The reviewed plan differs from the approved plan anchoring accepted demand; their records remain separate."
                    : "No accepted-demand plan anchor exists for comparison."}
              </div>
              {plan.drivers.length === 0 ? (
                <div className={styles.panelEmpty}>No assignment explanation was emitted for this plan.</div>
              ) : (
                <ol className={styles.driverList}>
                  {plan.drivers.map((driver) => (
                    <li key={driver.explanation}>
                      <div className={styles.driverMeta}>
                        <span>{driver.assignmentCount} assignment{driver.assignmentCount === 1 ? "" : "s"}</span>
                        <span>{driver.assignmentTypes.join(" · ")}</span>
                      </div>
                      <p>{driver.explanation}</p>
                      <span className={styles.driverUnits}>{driver.programUnits.map((unit) => unit.name).join(" · ")}</span>
                    </li>
                  ))}
                </ol>
              )}
              <div className={styles.diagnosticRecord}>
                <strong>Recorded compiler diagnostics</strong>
                {plan.diagnosticMessages.length === 0 ? (
                  <span>No diagnostic messages were emitted.</span>
                ) : (
                  <ul>{plan.diagnosticMessages.map((message) => <li key={message}>{message}</li>)}</ul>
                )}
              </div>
              <details className={styles.alternatives} open={plan.alternatives.length > 0}>
                <summary>Recorded alternatives / exclusions <span>{plan.alternatives.length}</span></summary>
                {plan.alternatives.length === 0 ? (
                  <p>No excluded alternative records were emitted. Counterfactual swaps are not reconstructed.</p>
                ) : (
                  <ul>{plan.alternatives.map((alternative) => <li key={`${alternative.personId}:${alternative.reason}`}><code>{alternative.personId}</code><span>{alternative.reason}</span></li>)}</ul>
                )}
              </details>
              <div className={styles.sourceFoot}>
                <span>Plan v{plan.versionNumber}</span>
                <span data-testid="plan-source-fingerprint"><Fingerprint value={plan.fingerprint} label="Plan fingerprint" /></span>
              </div>
            </>
          )}
        </section>
      </div>

      <section className={styles.transferPanel} aria-labelledby="capacity-transfers-title">
        <div className={styles.panelHeader}>
          <div><p className={styles.kicker}>Decision receipts</p><h3 id="capacity-transfers-title">Explicit capacity transfers</h3></div>
          <Badge tone={capacity.transfers.length > 0 ? "approved" : "neutral"}>{capacity.transfers.length} receipt{capacity.transfers.length === 1 ? "" : "s"}</Badge>
        </div>
        {capacity.transfers.length === 0 ? (
          <div className={styles.panelEmpty}>No transfer or release receipt exists. Current pool balances equal their ledger-defined starting balances.</div>
        ) : (
          <ol className={styles.transferList}>
            {capacity.transfers.map((transfer) => (
              <li key={transfer.receiptId}>
                <div className={styles.transferSequence}><span>SEQ</span><strong>{transfer.sequenceNumber}</strong></div>
                <div className={styles.transferMain}>
                  <div className={styles.transferRoute}>
                    <strong>{transfer.sourcePoolName}</strong>
                    <span><ArrowRight size={15} aria-hidden="true" /> {transfer.quantity} {transfer.unitKind}</span>
                    <strong>{transfer.destinationPoolName}</strong>
                  </div>
                  <p>{transfer.reason}</p>
                  <span>{transfer.sourceBefore} → {transfer.sourceAfter} source · {transfer.destinationBefore} → {transfer.destinationAfter} destination</span>
                </div>
                <div className={styles.transferEvidence}>
                  <Badge tone="approved">{transfer.operation}</Badge>
                  <time dateTime={transfer.decidedAt}>{formatDateTime(transfer.decidedAt)}</time>
                  <code>{transfer.approvalReference}</code>
                  <Fingerprint value={transfer.fingerprint} label="Transfer receipt fingerprint" />
                </div>
              </li>
            ))}
          </ol>
        )}
        <div className={styles.ledgerSource}>
          <span>Reloaded from server-owned ledger sequence {capacity.sequenceNumber}</span>
          <span data-testid="capacity-ledger-fingerprint"><Fingerprint value={capacity.ledgerFingerprint} label="Capacity ledger fingerprint" /></span>
        </div>
      </section>
    </section>
  );
}
