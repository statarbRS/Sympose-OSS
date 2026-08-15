"use client";

import Link from "next/link";
import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import {
  createColumnHelper,
  rowSelectionFeature,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";

import { PlanCompilerReveal } from "@/components/decision-intelligence/plan-compiler-reveal";
import type { DecisionPlanVersionInput } from "@/components/decision-intelligence/plan-projection";
import { Badge, Fingerprint, formatDateTime } from "@/components/truth";
import type { PlanDetail } from "@/server/services/planning";

import styles from "./plan-studio.module.css";

type PaneId = "inputs" | "assignments" | "diagnostics";

export type PlanStudioDetail = {
  readonly version: Pick<PlanDetail["version"], "versionNumber" | "fingerprint" | "status">;
  readonly content: {
    readonly versionNumber: number;
    readonly snapshotFingerprint: string;
    readonly assignments: PlanDetail["content"]["assignments"];
    readonly exclusions: PlanDetail["content"]["exclusions"];
    readonly diagnostics: PlanDetail["content"]["diagnostics"];
  };
  readonly assignmentsJoined: Array<Pick<
    PlanDetail["assignmentsJoined"][number],
    "personId" | "fullName" | "organization" | "programUnitId" | "programUnitName" | "assignmentType" | "explanation"
  >>;
  readonly run: Pick<
    PlanDetail["run"],
    "id" | "status" | "inputFingerprint" | "compiler" | "compilerVersion" | "createdAt"
  >;
  readonly approvals: Array<Pick<PlanDetail["approvals"][number], "id">>;
  readonly states: Array<Pick<PlanDetail["states"][number], "state" | "createdAt" | "reason">>;
};

type AssignmentRow = PlanStudioDetail["assignmentsJoined"][number];
type AssignmentRecord = PlanStudioDetail["content"]["assignments"][number];

const assignmentFeatures = tableFeatures({ rowSelectionFeature });
const assignmentColumnHelper = createColumnHelper<typeof assignmentFeatures, AssignmentRow>();

const paneOptions: ReadonlyArray<{ id: PaneId; label: string }> = [
  { id: "inputs", label: "Inputs" },
  { id: "assignments", label: "Assignments" },
  { id: "diagnostics", label: "Diagnostics" },
];

const columnLabels: Record<string, string> = {
  selection: "Selection",
  fullName: "Person",
  programUnitName: "Program unit",
  assignmentType: "Role",
  explanation: "Compiler explanation",
};

function personHref(workspace: string, personId: string): string {
  return "/w/" + workspace + "/people/" + personId;
}

function assignmentRowId(assignment: AssignmentRow): string {
  return JSON.stringify([
    assignment.personId,
    assignment.programUnitId,
    assignment.assignmentType,
  ]);
}

function assignmentRecordKey(assignment: AssignmentRecord): string {
  return JSON.stringify([
    assignment.personId,
    assignment.programUnitId,
    assignment.assignmentType,
  ]);
}

function decisionPlanVersion(detail: PlanStudioDetail): DecisionPlanVersionInput {
  return {
    versionNumber: detail.version.versionNumber,
    fingerprint: detail.version.fingerprint,
    lifecycleStatus: detail.version.status,
    assignments: detail.assignmentsJoined.map((assignment) => ({
      personId: assignment.personId,
      fullName: assignment.fullName,
      programUnitId: assignment.programUnitId,
      programUnitName: assignment.programUnitName,
      assignmentType: assignment.assignmentType,
    })),
  };
}

function compareAssignmentRecords(
  candidate: readonly AssignmentRecord[],
  approved: readonly AssignmentRecord[],
): { unchanged: number; addedOrMoved: number; removed: number } {
  const approvedCounts = new Map<string, number>();
  for (const assignment of approved) {
    const key = assignmentRecordKey(assignment);
    approvedCounts.set(key, (approvedCounts.get(key) ?? 0) + 1);
  }

  let unchanged = 0;
  let addedOrMoved = 0;
  for (const assignment of candidate) {
    const key = assignmentRecordKey(assignment);
    const count = approvedCounts.get(key) ?? 0;
    if (count > 0) {
      unchanged += 1;
      approvedCounts.set(key, count - 1);
    } else {
      addedOrMoved += 1;
    }
  }

  let removed = 0;
  for (const count of approvedCounts.values()) {
    removed += count;
  }

  return { unchanged, addedOrMoved, removed };
}

function PlanComparison({
  candidate,
  approved,
}: {
  readonly candidate: PlanStudioDetail;
  readonly approved: PlanStudioDetail;
}) {
  const comparison = compareAssignmentRecords(
    candidate.content.assignments,
    approved.content.assignments,
  );

  return (
    <section className={styles.comparison} data-testid="plan-comparison" aria-labelledby="plan-comparison-title">
      <div className={styles.comparisonIntro}>
        <p className={styles.paneKicker}>Exact record comparison</p>
        <h2 id="plan-comparison-title">Candidate v{candidate.version.versionNumber} vs approved v{approved.version.versionNumber}</h2>
        <p className={styles.muted}>
          Counts compare person, program unit, and role records. A changed program unit is counted as added-or-moved;
          no commitment or solver impact is inferred.
        </p>
      </div>
      <dl className={styles.comparisonCounts} aria-label="Exact assignment record comparison counts">
        <div data-testid="plan-comparison-unchanged"><dt>Unchanged</dt><dd>{comparison.unchanged}</dd></div>
        <div data-testid="plan-comparison-added-or-moved"><dt>Added or moved</dt><dd>{comparison.addedOrMoved}</dd></div>
        <div data-testid="plan-comparison-removed"><dt>Removed</dt><dd>{comparison.removed}</dd></div>
      </dl>
    </section>
  );
}

function PlanStudioEmptyState({
  workspace,
  capacityFlightDeck,
}: {
  readonly workspace: string;
  readonly capacityFlightDeck: ReactNode;
}) {
  return (
    <section className={"record " + styles.emptyState} data-testid="plan-review">
      <div>
        <p className={styles.eyebrow}>Plan Studio · immutable review</p>
        <h2>No plan record yet</h2>
        <p>
          There is no unapproved candidate or approved current plan for this event.{" "}
          <Link href={"/w/" + workspace + "/dashboard"}>Compile one from the dashboard.</Link>
        </p>
      </div>
      {capacityFlightDeck ? (
        <details className={styles.auxiliaryDisclosure}>
          <summary>
            <span>Capacity and slate evidence</span>
            <small>Conserved pools, accepted demand, and decision receipts</small>
          </summary>
          <div className={styles.auxiliaryDisclosureBody}>{capacityFlightDeck}</div>
        </details>
      ) : null}
    </section>
  );
}

function PlanStudioContent({
  workspace,
  event,
  detail,
  approvedDetail,
  capacityFlightDeck,
}: {
  readonly workspace: string;
  readonly event: { id: string; name: string };
  readonly detail: PlanStudioDetail;
  readonly approvedDetail: PlanStudioDetail | null;
  readonly capacityFlightDeck: ReactNode;
}) {
  const diagnostics = detail.content.diagnostics;
  const assignments = detail.assignmentsJoined;
  const exclusions = detail.content.exclusions;
  const [activePane, setActivePane] = useState<PaneId>("assignments");
  const [focusedRowId, setFocusedRowId] = useState<string | null>(() => (
    assignments[0] ? assignmentRowId(assignments[0]) : null
  ));
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const stateTone = detail.version.status === "approved" ? "approved" : "candidate";
  const runTone = detail.run.status === "FEASIBLE" ? "active" : "denied";

  const columns = useMemo(
    () => assignmentColumnHelper.columns([
      assignmentColumnHelper.display({
        id: "selection",
        header: "Select",
        cell: ({ row }) => {
          const selected = row.getIsSelected();
          return (
            <button
              type="button"
              className={styles.selectionButton}
              aria-label={(selected ? "Deselect " : "Select ") + row.original.fullName}
              aria-pressed={selected}
              onClick={(event) => {
                event.stopPropagation();
                row.getToggleSelectedHandler()(event);
              }}
            >
              <span aria-hidden="true">{selected ? "✓" : "○"}</span>
              <span>{selected ? "Selected" : "Select"}</span>
            </button>
          );
        },
      }),
      assignmentColumnHelper.accessor("fullName", {
        header: "Person",
        cell: ({ row }) => (
          <div className={styles.personCell}>
            <Link href={personHref(workspace, row.original.personId)}>
              {row.original.fullName}
            </Link>
            <span className={styles.muted}>{row.original.organization ?? "Unknown"}</span>
            <span className={styles.mono}>{row.original.personId}</span>
          </div>
        ),
      }),
      assignmentColumnHelper.accessor("programUnitName", {
        header: "Program unit",
        cell: ({ row }) => (
          <div className={styles.personCell}>
            <strong>{row.original.programUnitName}</strong>
            <span className={styles.mono}>{row.original.programUnitId}</span>
          </div>
        ),
      }),
      assignmentColumnHelper.accessor("assignmentType", {
        header: "Role",
        cell: ({ getValue }) => (
          <div className={styles.evidenceCell}>
            <span className={styles.layerLabel}>Candidate assignment</span>
            <Badge tone="candidate">{getValue()}</Badge>
          </div>
        ),
      }),
      assignmentColumnHelper.accessor("explanation", {
        header: "Compiler explanation",
        cell: ({ getValue }) => (
          <div className={styles.evidenceCell}>
            <span className={styles.layerLabel}>Compiler explanation</span>
            <p className={styles.explanation}>{getValue()}</p>
          </div>
        ),
      }),
    ]),
    [workspace],
  );

  const table = useTable({
    features: assignmentFeatures,
    columns,
    data: assignments,
    getRowId: assignmentRowId,
    enableMultiRowSelection: false,
  });
  const rows = table.getRowModel().rows;
  const selectedRow = table.getSelectedRowModel().rows[0];
  const selectedAssignment = selectedRow?.original;

  function handleRowKeyDown(event: ReactKeyboardEvent<HTMLTableRowElement>, rowId: string) {
    if (event.target !== event.currentTarget) {
      const target = event.target as HTMLElement;
      if (target.closest("a, button, input, select, textarea")) return;
    }

    const rowIndex = rows.findIndex((row) => row.id === rowId);
    if (rowIndex < 0) return;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const nextRow = rows[rowIndex + direction];
      if (!nextRow) return;
      event.preventDefault();
      setFocusedRowId(nextRow.id);
      rowRefs.current.get(nextRow.id)?.focus();
      return;
    }

    if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      rows[rowIndex]?.toggleSelected();
    }
  }

  return (
    <section className={"record " + styles.studio} data-testid="plan-review" aria-label={"Plan Studio review for " + event.name}>
      <header className={styles.studioHeader}>
        <div>
          <p className={styles.eyebrow}>Plan Studio · immutable review</p>
          <p className={styles.studioIntro}>
            Candidate content, compiler diagnostics, and organizer approval are shown separately.
            Approval appends decision truth; it never edits compiler output.
          </p>
        </div>
        <div className={styles.stateRail} aria-label="Plan state summary">
          <div className={styles.stateBlock}>
            <span className={styles.stateLabel}>Run outcome</span>
            <Badge tone={runTone}>{detail.run.status}</Badge>
          </div>
          <div className={styles.stateBlock}>
            <span className={styles.stateLabel}>Lifecycle</span>
            <Badge tone={stateTone}>{detail.version.status}</Badge>
          </div>
        </div>
      </header>

      <PlanCompilerReveal
        candidate={decisionPlanVersion(detail)}
        current={approvedDetail ? decisionPlanVersion(approvedDetail) : null}
      />

      {capacityFlightDeck ? (
        <details className={styles.auxiliaryDisclosure}>
          <summary>
            <span>Capacity and slate evidence</span>
            <small>Conserved pools, accepted demand, and decision receipts</small>
          </summary>
          <div className={styles.auxiliaryDisclosureBody}>{capacityFlightDeck}</div>
        </details>
      ) : null}

      {approvedDetail ? (
        <PlanComparison candidate={detail} approved={approvedDetail} />
      ) : (
        <p className={styles.comparisonNote} data-testid="plan-comparison-status">
          {detail.version.status === "approved"
            ? "Approved current record is shown; no separate unapproved candidate is available."
            : "Unapproved candidate record is shown; no approved current record exists for comparison."}
        </p>
      )}

      <nav className={styles.paneSwitcher} aria-label="Plan Studio pane switcher">
        {paneOptions.map((pane) => (
          <button
            key={pane.id}
            type="button"
            aria-pressed={activePane === pane.id}
            aria-controls={"plan-pane-" + pane.id}
            className={activePane === pane.id ? styles.paneSwitcherActive : ""}
            onClick={() => setActivePane(pane.id)}
          >
            {pane.label}
          </button>
        ))}
      </nav>

      <section className={styles.workspace} aria-label="Plan Studio review workspace">
        <aside
          id="plan-pane-inputs"
          className={styles.pane + " " + styles.paneInputs + (activePane === "inputs" ? "" : " " + styles.paneInactive)}
          aria-labelledby="plan-inputs-title"
        >
          <header className={styles.paneHeader}>
            <div>
              <p className={styles.paneKicker}>Frozen source</p>
              <h2 id="plan-inputs-title">Inputs &amp; manifest</h2>
              <p>The reviewed record is anchored to immutable source fingerprints.</p>
            </div>
            <span className={styles.viewLabel}>INPUTS</span>
          </header>

          <dl className={styles.manifest}>
            <div className={styles.manifestRow}><dt>Plan version</dt><dd>v{detail.version.versionNumber}</dd></div>
            <div className={styles.manifestRow}><dt>Source run</dt><dd><code>{detail.run.id}</code></dd></div>
            <div className={styles.manifestRow}><dt>Plan fingerprint</dt><dd><Fingerprint value={detail.version.fingerprint} /></dd></div>
            <div className={styles.manifestRow}><dt>Input fingerprint</dt><dd><Fingerprint value={detail.run.inputFingerprint} /></dd></div>
            <div className={styles.manifestRow}><dt>Snapshot fingerprint</dt><dd><Fingerprint value={detail.content.snapshotFingerprint} /></dd></div>
            <div className={styles.manifestRow}><dt>Compiler</dt><dd>{detail.run.compiler} · {detail.run.compilerVersion}</dd></div>
            <div className={styles.manifestRow}><dt>Compiled</dt><dd>{formatDateTime(detail.run.createdAt)}</dd></div>
          </dl>
          <p className={styles.manifestNote}>Frozen compiler receipt · later input changes require a new run. The original candidate output remains inspectable after approval.</p>
        </aside>

        <section
          id="plan-pane-assignments"
          className={styles.pane + " " + styles.paneCanvas + (activePane === "assignments" ? "" : " " + styles.paneInactive)}
          aria-labelledby="plan-canvas-title"
        >
          <header className={styles.paneHeader}>
            <div>
              <p className={styles.paneKicker}>{detail.version.status === "approved" ? "Approved current truth" : "Candidate truth"}</p>
              <h2 id="plan-canvas-title">Assignments &amp; explanations</h2>
              <p>Compiler output is read-only here; organizer approval is appended below.</p>
            </div>
            <span className={styles.viewLabel}>ASSIGNMENTS</span>
          </header>

          <div className={styles.canvasSummary} aria-label="Candidate assignment summary">
            <span className={styles.summaryToken}><strong>{assignments.length}</strong> assignments</span>
            <span className={styles.summaryToken}><strong>{exclusions.length}</strong> exclusions</span>
            <span className={styles.summaryToken}>version v{detail.content.versionNumber}</span>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.assignmentTable}>
              <caption className="visually-hidden">Candidate assignments and explanations</caption>
              <thead>
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <th key={header.id} scope="col" colSpan={header.colSpan}>
                        {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr><td colSpan={table.getAllLeafColumns().length} className={styles.muted}>No candidate assignments were emitted.</td></tr>
                ) : rows.map((row) => {
                  const selected = row.getIsSelected();
                  return (
                    <tr
                      key={row.id}
                      ref={(element) => {
                        if (element) rowRefs.current.set(row.id, element);
                        else rowRefs.current.delete(row.id);
                      }}
                      tabIndex={focusedRowId === row.id ? 0 : -1}
                      aria-selected={selected}
                      data-assignment-id={row.id}
                      className={styles.assignmentRow + (selected ? " " + styles.selectedRow : "")}
                      onFocus={() => setFocusedRowId(row.id)}
                      onKeyDown={(event) => handleRowKeyDown(event, row.id)}
                    >
                      {row.getAllCells().map((cell) => (
                        <td
                          key={cell.id}
                          data-label={columnLabels[cell.column.id]}
                          className={cell.column.id === "selection" ? styles.selectionCell : undefined}
                        >
                          <table.FlexRender cell={cell} />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {exclusions.length > 0 ? (
            <details>
              <summary>Excluded candidate records ({exclusions.length})</summary>
              <ul className={styles.exclusions}>{exclusions.map((exclusion) => <li className={styles.exclusion} key={exclusion.personId + "-" + exclusion.reason}><code>{exclusion.personId}</code> · {exclusion.reason}</li>)}</ul>
            </details>
          ) : null}
        </section>

        <aside
          id="plan-pane-diagnostics"
          className={styles.pane + " " + styles.paneDiagnostics + (activePane === "diagnostics" ? "" : " " + styles.paneInactive)}
          aria-labelledby="plan-diagnostics-title"
        >
          <header className={styles.paneHeader}>
            <div>
              <p className={styles.paneKicker}>Explainable state</p>
              <h2 id="plan-diagnostics-title">Diagnostics &amp; state</h2>
              <p>Feasibility and lifecycle remain separate facts.</p>
            </div>
            <span className={styles.viewLabel}>DIAGNOSTICS</span>
          </header>

          <dl className={styles.diagnosticList} aria-label="Plan diagnostic counts">
            <div><dt>Run outcome</dt><dd>{detail.run.status}</dd></div>
            <div><dt>Lifecycle</dt><dd>{detail.version.status}</dd></div>
            <div><dt>Assigned</dt><dd>{assignments.length}</dd></div>
            <div><dt>Excluded</dt><dd>{exclusions.length}</dd></div>
          </dl>

          <section className={styles.inspector} aria-labelledby="selected-assignment-title" aria-live="polite">
            <h3 id="selected-assignment-title" className={styles.diagnosticHeading}>Selected assignment</h3>
            {selectedAssignment ? (
              <>
                <p className={styles.inspectorStatus}>
                  {table.getSelectedRowModel().rows.length > 1 ? table.getSelectedRowModel().rows.length + " selected · showing first" : "One assignment selected"}
                </p>
                <dl className={styles.definitionGrid + " " + styles.inspectorGrid}>
                  <div><dt>Person</dt><dd><Link href={personHref(workspace, selectedAssignment.personId)}>{selectedAssignment.fullName}</Link></dd></div>
                  <div><dt>Program unit</dt><dd>{selectedAssignment.programUnitName}</dd></div>
                  <div><dt>Role</dt><dd>{selectedAssignment.assignmentType}</dd></div>
                  <div><dt>Compiler explanation</dt><dd>{selectedAssignment.explanation}</dd></div>
                </dl>
              </>
            ) : (
              <p className={styles.muted}>Select an assignment row to inspect its person, program unit, role, and compiler explanation.</p>
            )}
          </section>

          <div>
            <h3 className={styles.diagnosticHeading}>Compiler diagnostics</h3>
            {diagnostics.messages.length > 0 ? <ul className={styles.messages}>{diagnostics.messages.map((message) => <li className={styles.message} key={message}>{message}</li>)}</ul> : <p className={styles.muted}>No diagnostic messages were recorded for this run.</p>}
          </div>

          <div>
            <h3 className={styles.diagnosticHeading}>Program-unit counts</h3>
            {Object.keys(diagnostics.unitCounts).length > 0 ? <dl className={styles.definitionGrid}>{Object.entries(diagnostics.unitCounts).map(([unit, count]) => <div key={unit}><dt>{unit}</dt><dd>{count}</dd></div>)}</dl> : <p className={styles.muted}>No program-unit count was recorded.</p>}
          </div>

          {diagnostics.moderatorsWithoutUnit.length > 0 ? <div><h3 className={styles.diagnosticHeading}>Moderators without a unit</h3><ul className={styles.exclusions}>{diagnostics.moderatorsWithoutUnit.map((personId) => <li className={styles.exclusion} key={personId}><code>{personId}</code></li>)}</ul></div> : null}
          <p className={styles.manifestNote}>Every assignment keeps its candidate explanation in the canvas. Approval creates decision truth; it does not promote a candidate row into an operational observation.</p>
        </aside>
      </section>

      <details className={styles.historyDisclosure}>
        <summary>
          <span>Decision and run history</span>
          <small>{detail.states.length} recorded state{detail.states.length === 1 ? "" : "s"} · {detail.approvals.length} approval receipt{detail.approvals.length === 1 ? "" : "s"}</small>
        </summary>
      <section className={styles.historyDock} aria-labelledby="decision-title">
        <div className={styles.historyIntro}>
          <p className={styles.paneKicker}>Durable record</p>
          <h2 id="decision-title">Decision history</h2>
          <p className={styles.muted}>Run history and organizer decisions remain linked to the exact candidate version.</p>
          <dl className={styles.historyMeta}>
            <div><dt>Run</dt><dd><code>{detail.run.id}</code></dd></div>
            <div><dt>Approval receipts</dt><dd>{detail.approvals.length}</dd></div>
          </dl>
        </div>
        <ol className={styles.history}>
          {detail.states.map((state, index) => {
            const decision = state.state === "approved";
            return <li key={state.state + "-" + state.createdAt + "-" + index} className={styles.historyItem + " " + (decision ? styles.historyItemDecision : styles.historyItemCandidate)}>
              <Badge tone={decision ? "approved" : "candidate"}>{state.state}</Badge>
              <div><span className={styles.historyLayer}>{decision ? "Decision truth" : "Candidate truth"}</span><strong>{decision ? "Organizer approval appended" : "Compiler candidate recorded"}</strong><span className={styles.muted}>{state.reason ?? "No override or mutation."}</span></div>
              <time dateTime={state.createdAt}>{formatDateTime(state.createdAt)}</time>
            </li>;
          })}
        </ol>
      </section>
      </details>
    </section>
  );
}

export function PlanStudio({
  workspace,
  event,
  detail,
  approvedDetail = null,
  capacityFlightDeck = null,
}: {
  readonly workspace: string;
  readonly event: { id: string; name: string };
  readonly detail: PlanStudioDetail | null;
  readonly approvedDetail?: PlanStudioDetail | null;
  readonly capacityFlightDeck?: ReactNode;
}) {
  if (!detail) {
    return <PlanStudioEmptyState workspace={workspace} capacityFlightDeck={capacityFlightDeck} />;
  }

  return (
    <PlanStudioContent
      workspace={workspace}
      event={event}
      detail={detail}
      approvedDetail={approvedDetail}
      capacityFlightDeck={capacityFlightDeck}
    />
  );
}
