import Link from "next/link";

import type { ApplicantCallAvailability } from "./contracts";

type ApplicantJourneyStep = "overview" | "verify" | "draft" | "dashboard";

const steps: readonly {
  readonly id: ApplicantJourneyStep;
  readonly label: string;
  readonly detail: string;
  readonly suffix: string;
}[] = [
  { id: "overview", label: "Call details", detail: "Read first", suffix: "" },
  { id: "verify", label: "Verify email", detail: "Secure access", suffix: "/verify" },
  { id: "draft", label: "Build draft", detail: "Save as you go", suffix: "/draft" },
  { id: "dashboard", label: "Check status", detail: "Follow the record", suffix: "/dashboard" },
];

export function ApplicantJourney({
  baseHref,
  active,
  availability,
}: {
  readonly baseHref: string;
  readonly active: ApplicantJourneyStep;
  readonly availability?: ApplicantCallAvailability;
}) {
  const visibleSteps = availability === "closed"
    ? steps.filter((step) => step.id === "overview" || step.id === "dashboard")
    : steps;

  return (
    <nav className="cfp-journey" aria-label="Application progress">
      <p className="cfp-journey__label">Your application path</p>
      <ol className="cfp-journey__steps">
        {visibleSteps.map((step, index) => (
          <li className="cfp-journey__item" data-active={active === step.id} key={step.id}>
            <Link
              className="cfp-journey__link"
              href={`${baseHref}${step.suffix}`}
              aria-current={active === step.id ? "step" : undefined}
            >
              <span className="cfp-journey__index" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="cfp-journey__copy">
                <strong>{step.label}</strong>
                <small>{step.detail}</small>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </nav>
  );
}
