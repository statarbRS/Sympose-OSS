import type { ReactNode } from "react";

export function CfpShell({ children }: { readonly children: ReactNode }) {
  return (
    <div className="cfp-shell">
      <a className="cfp-skip-link" href="#cfp-main">
        Skip to content
      </a>
      <header className="cfp-header">
        <div className="cfp-identity" aria-label="Sympose applicant portal">
          <span className="cfp-identity__name">Sympose</span>
          <span className="cfp-identity__surface">Call for proposals</span>
        </div>
        <span className="cfp-header__context">Applicant portal</span>
      </header>
      <main className="cfp-main" id="cfp-main" tabIndex={-1}>
        {children}
      </main>
      <footer className="cfp-footer">
        <span>Sympose applicant portal</span>
        <span>Applicant access is separate from organizer access.</span>
      </footer>
    </div>
  );
}
