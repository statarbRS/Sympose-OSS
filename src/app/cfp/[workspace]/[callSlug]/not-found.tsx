export default function ApplicantCallNotFound() {
  return (
    <article className="cfp-page cfp-page--narrow" data-testid="applicant-unavailable">
      <section className="cfp-state-panel cfp-state-panel--warning">
        <h1>This call is unavailable</h1>
        <p>
          The applicant page cannot be opened. Check the link or ask the organizer for the current
          call address.
        </p>
      </section>
    </article>
  );
}
