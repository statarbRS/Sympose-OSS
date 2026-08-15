import type { ContentLibraryItem, ContentLibraryProjection } from "@/server/services/content-library";

import styles from "./content-library.module.css";

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function approvalLabel(gates: readonly string[]): string {
  return gates.length > 0 ? gates.join(", ") : "No approval recorded";
}

function needsApproval(item: ContentLibraryItem): boolean {
  return item.reviewState !== "APPROVED" || item.approvalGates.length === 0;
}

export function ContentLibrary({
  workspace,
  projection,
}: {
  readonly workspace: string;
  readonly projection: ContentLibraryProjection;
}) {
  const archiveAction = `/w/${encodeURIComponent(workspace)}/events/${encodeURIComponent(projection.eventId)}/speakers/content/archive`;
  const currentItems = projection.items
    .filter((item) => item.current)
    .sort((left, right) => Number(needsApproval(right)) - Number(needsApproval(left)) || left.speakerName.localeCompare(right.speakerName) || left.taskTitle.localeCompare(right.taskTitle));
  const approvalAttentionItems = currentItems.filter(needsApproval);
  const historicalVersionCount = projection.items.filter((item) => !item.current).length;
  return (
    <div className={styles.libraryStack}>
      <section className={styles.attentionPanel} aria-labelledby="content-attention-title">
        <div className={styles.attentionHeader}>
          <div><p className={styles.eyebrow}>Attention first · exact event</p><h2 id="content-attention-title">Content requiring review</h2></div>
          <span className={approvalAttentionItems.length > 0 ? styles.attentionStatus : styles.readyStatus}>{approvalAttentionItems.length > 0 ? `${approvalAttentionItems.length} need approval` : "No approval gaps"}</span>
        </div>
        <p className={styles.muted}>{approvalAttentionItems.length > 0 ? "Current files without exact approval evidence are listed first below. Approval state and artifact history remain independent from ZIP selection." : currentItems.length > 0 ? "Every current file in this view has approval evidence. Review state still remains tied to its exact immutable version." : "No current speaker files are available for review in this event."}</p>
        <div className={styles.summaryGrid} aria-label="Content Library counts">
          <SummaryCount label="Current files" value={projection.currentFileCount} />
          <SummaryCount label="Need approval" value={approvalAttentionItems.length} attention={approvalAttentionItems.length > 0} />
          <SummaryCount label="Historical versions" value={historicalVersionCount} />
          <SummaryCount label="Persisted versions" value={projection.versionCount} />
        </div>
      </section>
      {projection.items.length === 0 ? (
        <p className={styles.empty}>No persisted speaker files are available for this event.</p>
      ) : (
        <>
          <section className={styles.workSection} aria-labelledby="current-content-title">
            <div className={styles.sectionHeader}><div><p className={styles.eyebrow}>Routine work · current versions only</p><h2 id="current-content-title">Current file work queue</h2></div><span className={styles.count}>{currentItems.length} selectable</span></div>
            {currentItems.length === 0 ? <p className={styles.empty}>No current file versions are available for ZIP selection. Historical versions remain available in immutable evidence below.</p> : <form className={styles.archiveForm} method="post" action={archiveAction}>
              <div className={styles.actions}>
                <button className={styles.downloadButton} type="submit">Download selected latest files (.zip)</button>
                <span className={styles.muted}>Select 1–{projection.archiveLimits.maxFiles} current files, up to {formatBytes(projection.archiveLimits.maxUncompressedBytes)} uncompressed.</span>
              </div>
              <ul className={styles.currentList}>{currentItems.map((item) => <CurrentFileRow key={item.artifactId} workspace={workspace} eventId={projection.eventId} item={item} />)}</ul>
            </form>}
          </section>

          <details className={styles.auditDisclosure}>
            <summary><span><strong>Immutable version evidence</strong><small>Expand every current and superseded version, exact hash, lineage reference, upload time, and approval gate.</small></span><span className={styles.disclosureCount}>{projection.versionCount} versions</span></summary>
          <div
            className={styles.tableWrap}
            role="region"
            aria-label="Immutable speaker artifact version evidence table"
            tabIndex={0}
          >
            <table className={styles.table} aria-label="Persisted speaker artifact versions">
              <caption>Every persisted speaker artifact version with exact file, lineage, review, approval, and hash evidence</caption>
              <thead>
                <tr>
                  <th scope="col">Version / file</th>
                  <th scope="col">Speaker / session</th>
                  <th scope="col">Task / content</th>
                  <th scope="col">Review / approval</th>
                  <th scope="col">Uploaded</th>
                  <th scope="col">Exact hashes</th>
                  <th scope="col">Media / bytes</th>
                  <th scope="col">Lineage</th>
                </tr>
              </thead>
              <tbody>{projection.items.map((item) => (
                <tr key={item.artifactId}>
                  <td className={styles.fileCell}><strong>v{item.version}</strong> · <span className={item.current ? styles.current : styles.superseded}>{item.current ? "Current latest" : "Superseded"}</span><br /><a className={styles.inlineDownload} href={`/w/${encodeURIComponent(workspace)}/events/${encodeURIComponent(projection.eventId)}/speakers/artifacts/${encodeURIComponent(item.artifactId)}`} download={item.originalFilename}>{item.originalFilename}</a><br /><code>{item.contentVersionId}</code></td>
                  <td><strong>{item.speakerName}</strong><br /><span className={styles.muted}>{item.sessionName}</span></td>
                  <td><strong>{item.taskTitle}</strong><br /><span className={styles.muted}>{item.taskKind} · {item.contentKind} · {item.taskState}</span></td>
                  <td><strong>{item.reviewState}</strong><br /><span className={styles.muted}>{approvalLabel(item.approvalGates)}</span></td>
                  <td><time dateTime={item.uploadedAt}>{item.uploadedAt}</time></td>
                  <td><span className={styles.hashLabel}>Content</span><code className={styles.hash}>{item.contentHash}</code><span className={styles.hashLabel}>SHA-256</span><code className={styles.hash}>{item.sha256}</code></td>
                  <td>{item.mediaType}<br /><span className={styles.muted}>{formatBytes(item.byteSize)} · {item.byteSize} bytes</span></td>
                  <td><span className={styles.hashLabel}>Artifact</span><code className={styles.hash}>{item.artifactId}</code><span className={styles.hashLabel}>Supersedes</span>{item.supersedesArtifactId ? <code className={styles.hash}>{item.supersedesArtifactId}</code> : <span className={styles.muted}>Initial version</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          </details>
        </>
      )}
      <p><a className={styles.backLink} href={`/w/${encodeURIComponent(workspace)}/events/${encodeURIComponent(projection.eventId)}/speakers`}>Back to Speaker Operations</a></p>
    </div>
  );
}

function CurrentFileRow({ workspace, eventId, item }: { readonly workspace: string; readonly eventId: string; readonly item: ContentLibraryItem }) {
  const requiresApproval = needsApproval(item);
  return <li className={`${styles.currentRow} ${requiresApproval ? styles.currentRowAttention : ""}`}>
    <label className={styles.selectControl}><input type="checkbox" name="artifactId" value={item.artifactId} aria-label={`Select current ${item.originalFilename} version ${item.version}`} /><span>Select for ZIP</span></label>
    <div className={styles.currentIdentity}><span className={styles.rowLabel}>Speaker / session</span><strong>{item.speakerName}</strong><span className={styles.muted}>{item.sessionName}</span></div>
    <div className={styles.currentFile}><span className={styles.rowLabel}>Task / file</span><strong>{item.taskTitle}</strong><a href={`/w/${encodeURIComponent(workspace)}/events/${encodeURIComponent(eventId)}/speakers/artifacts/${encodeURIComponent(item.artifactId)}`} download={item.originalFilename}>{item.originalFilename}</a><span className={styles.muted}>{item.contentKind} · {formatBytes(item.byteSize)}</span></div>
    <div className={styles.currentReview}><span className={styles.rowLabel}>Review / approval</span><span className={requiresApproval ? styles.attentionStatus : styles.readyStatus}>{item.reviewState}</span><span className={styles.muted}>{approvalLabel(item.approvalGates)}</span></div>
    <div className={styles.currentVersion}><span className={styles.rowLabel}>Exact version</span><strong>v{item.version}</strong><code>{item.contentHash}</code></div>
  </li>;
}

function SummaryCount({ label, value, attention = false }: { readonly label: string; readonly value: number; readonly attention?: boolean }) {
  return <div className={`${styles.summaryCount} ${attention ? styles.summaryCountAttention : ""}`}><span>{label}</span><strong>{value}</strong></div>;
}
