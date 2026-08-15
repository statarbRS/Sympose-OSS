export function ReviewUnavailable() {
  return (
    <section className="review-state-panel" aria-labelledby="review-unavailable-title">
      <p className="review-eyebrow">Review console</p>
      <h1 id="review-unavailable-title">Review unavailable</h1>
      <p>
        This review surface is not available. Return to the address supplied for your review
        session or sign out.
      </p>
    </section>
  );
}
