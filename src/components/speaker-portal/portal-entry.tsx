import {
  openAcmeSpeakerPortal,
  openDevflowSpeakerPortal,
  openSpeakerPortal,
} from "@/app/speaker/actions";

import styles from "./speaker-portal.module.css";

export function SpeakerPortalEntry() {
  return (
    <main className={styles.portalMain} id="main-content">
      <article className={styles.entryCard}>
        <header className={styles.entryHeader}>
          <p className={styles.eyebrow}>Sympose speaker portal</p>
          <h1>Your speaker work starts here</h1>
          <p className={styles.lede}>Open the event-specific workspace your organizer shared to review your accepted session, timing, tasks, profile, and requested materials.</p>
          <div className={styles.entryContext} aria-label="Speaker portal contents">
            <span>Accepted session</span>
            <span>Event details</span>
            <span>Speaker tasks and materials</span>
          </div>
        </header>

        <section className={styles.primaryEntry} aria-labelledby="organizer-access-heading">
          <p className={styles.sectionLabel}>Your organizer invitation</p>
          <h2 id="organizer-access-heading">Enter your private access code</h2>
          <p className={styles.entryCopy}>Use the code from your speaker invitation. Access stays limited to the event, speaker identity, and current assignment tied to it.</p>
          <form action={openSpeakerPortal} className={styles.entryForm}>
            <label htmlFor="speaker-portal-token">Speaker portal access code</label>
            <input aria-describedby="speaker-portal-token-help" id="speaker-portal-token" name="token" type="password" autoComplete="off" required maxLength={128} />
            <p className={styles.inputHint} id="speaker-portal-token-help">Paste the complete code exactly as your organizer sent it.</p>
            <button className={styles.primaryButton} type="submit">Open my speaker portal</button>
          </form>
        </section>

        <section className={styles.evaluatorEntry} aria-labelledby="evaluator-access-heading">
          <p className={styles.sectionLabel}>Full walkthrough · Stagecraft 2026</p>
          <h2 id="evaluator-access-heading">Continue Mina Park’s accepted session</h2>
          <p className={styles.entryCopy}>Follow the same accepted proposal from the Acme organizer journey into Mina’s session context, tasks, exact artifact versions, and public-ready profile.</p>
          <form action={openAcmeSpeakerPortal} className={styles.evaluatorForm}>
            <button className={styles.secondaryButton} type="submit">Preview Mina’s speaker portal</button>
          </form>
        </section>

        <section className={styles.evaluatorEntry} aria-labelledby="compatibility-access-heading">
          <p className={styles.sectionLabel}>Compatibility reference · DevFlow Conf 2027</p>
          <h2 id="compatibility-access-heading">Inspect Priya Raman’s isolated assignment</h2>
          <p className={styles.entryCopy}>Use this secondary fixture only when checking the pinned DevFlow reviewer and speaker contracts. It remains separate from the primary Acme walkthrough.</p>
          <form action={openDevflowSpeakerPortal} className={styles.evaluatorForm}>
            <button className={styles.secondaryButton} type="submit">Preview Priya’s speaker portal</button>
          </form>
        </section>

        <details className={styles.entryDetails}>
          <summary>Privacy and local-preview details</summary>
          <div className={styles.entryDetailsBody}>
            <p>Portal codes are submitted in the request body, stored only in an HttpOnly cookie, and never placed in the URL.</p>
            <p>The evaluator preview uses real local artifact bytes. Task changes, profile and text versions, and reviews persist in local SQLite. Bounded PNG/PDF uploads retain matching version evidence there and exact bytes in scoped local filesystem storage.</p>
            <p>No malware scanner, object-storage provider, SMTP, or provider delivery is configured.</p>
          </div>
        </details>
      </article>
    </main>
  );
}
