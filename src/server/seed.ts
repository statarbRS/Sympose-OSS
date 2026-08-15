import type { Db } from "./db";
import { deterministicUuid, nowIso } from "./canonical";

export interface FixturePerson {
  email: string;
  fullName: string;
  organization: string;
  title: string;
  expertise: string[];
  moderatorEligible: boolean;
}

export interface FixtureManifest {
  workspaceSlug: string;
  provider: string;
  sourceRef: string;
  importedAt: string;
  people: FixturePerson[];
}

export const NORTHSTAR_FIXTURE: FixtureManifest = {
  workspaceSlug: "northstar",
  provider: "fixture-import",
  sourceRef: "fixtures/northstar-participants.v1.json",
  importedAt: "2026-06-01T09:00:00.000Z",
  people: [
    { email: "jane.oakley@meridian.example", fullName: "Jane Oakley", organization: "Meridian Labs", title: "Principal Engineer", expertise: ["moderation", "distributed systems"], moderatorEligible: true },
    { email: "tomas.reyes@atlascore.example", fullName: "Tomas Reyes", organization: "Atlascore", title: "Staff Engineer", expertise: ["platform engineering", "incident response"], moderatorEligible: true },
    { email: "priya.nair@cirruswave.example", fullName: "Priya Nair", organization: "Cirruswave", title: "Research Lead", expertise: ["machine learning", "evaluation"], moderatorEligible: true },
    { email: "marcus.wei@brightfield.example", fullName: "Marcus Wei", organization: "Brightfield AI", title: "ML Engineer", expertise: ["embeddings", "search"], moderatorEligible: false },
    { email: "lena.hoffmann@quell.example", fullName: "Lena Hoffmann", organization: "Quell", title: "Product Manager", expertise: ["product strategy", "roundtables"], moderatorEligible: false },
    { email: "david.okafor@tangentops.example", fullName: "David Okafor", organization: "Tangent Ops", title: "Head of Infrastructure", expertise: ["reliability", "cost control"], moderatorEligible: false },
    { email: "sofia.marino@pelagos.example", fullName: "Sofia Marino", organization: "Pelagos", title: "Data Scientist", expertise: ["observability", "statistics"], moderatorEligible: false },
    { email: "ethan.brooks@stackyard.example", fullName: "Ethan Brooks", organization: "Stackyard", title: "Founding Engineer", expertise: ["developer tools", "typescript"], moderatorEligible: false },
    { email: "amara.diallo@lumenworks.example", fullName: "Amara Diallo", organization: "Lumenworks", title: "Engineering Director", expertise: ["team dynamics", "scaling"], moderatorEligible: true },
    { email: "noah.kim@framehq.example", fullName: "Noah Kim", organization: "Frame HQ", title: "Design Systems Lead", expertise: ["design systems", "accessibility"], moderatorEligible: false },
    { email: "isabella.fontes@novacred.example", fullName: "Isabella Fontes", organization: "Novacred", title: "CTO", expertise: ["fintech", "security"], moderatorEligible: true },
    { email: "owen.slater@graymatter.example", fullName: "Owen Slater", organization: "Gray Matter", title: "Solutions Architect", expertise: ["integration", "apis"], moderatorEligible: false },
  ],
};

export const ACME_FIXTURE: FixtureManifest = {
  workspaceSlug: "acme",
  provider: "fixture-import",
  sourceRef: "fixtures/acme-participants.v1.json",
  importedAt: "2026-06-01T09:05:00.000Z",
  people: [
    { email: "wanda.pickles@acme-corp.example", fullName: "Wanda Pickles", organization: "Acme Corp", title: "Director of Events", expertise: ["operations"], moderatorEligible: false },
    { email: "bruce.tanner@acme-corp.example", fullName: "Bruce Tanner", organization: "Acme Corp", title: "VP Sales", expertise: ["sales", "partners"], moderatorEligible: false },
    { email: "carla.mendez@acme-corp.example", fullName: "Carla Mendez", organization: "Acme Corp", title: "Marketing Lead", expertise: ["campaigns"], moderatorEligible: false },
    { email: "felix.grant@acme-corp.example", fullName: "Felix Grant", organization: "Acme Corp", title: "Solutions Engineer", expertise: ["demos", "apis"], moderatorEligible: false },
    { email: "greta.solberg@acme-corp.example", fullName: "Greta Solberg", organization: "Acme Corp", title: "Analyst", expertise: ["data", "reports"], moderatorEligible: false },
    { email: "hugo.finn@acme-corp.example", fullName: "Hugo Finn", organization: "Acme Corp", title: "Community Manager", expertise: ["community"], moderatorEligible: false },
  ],
};

export function seedWorkspaces(db: Db): void {
  const createdAt = "2026-05-01T00:00:00.000Z";
  const insertWorkspace = db.prepare(
    "INSERT OR IGNORE INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)",
  );
  const insertAccount = db.prepare(
    "INSERT OR IGNORE INTO accounts (id, workspace_id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );

  insertWorkspace.run(
    deterministicUuid("workspace:northstar"),
    "northstar",
    "Northstar Network",
    createdAt,
  );
  insertAccount.run(
    deterministicUuid("account:northstar-organizer"),
    deterministicUuid("workspace:northstar"),
    "organizer@northstar.example",
    "Northstar Organizer",
    "organizer",
    createdAt,
  );

  insertWorkspace.run(deterministicUuid("workspace:acme"), "acme", "Acme Events", createdAt);
  insertAccount.run(
    deterministicUuid("account:acme-organizer"),
    deterministicUuid("workspace:acme"),
    "organizer@acme.example",
    "Acme Organizer",
    "organizer",
    createdAt,
  );
}

export function fixtureForWorkspace(slug: string): FixtureManifest {
  if (slug === "acme") {
    return ACME_FIXTURE;
  }
  return NORTHSTAR_FIXTURE;
}
