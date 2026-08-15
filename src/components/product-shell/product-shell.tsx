"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  CalendarDays,
  Cable,
  ChartNoAxesCombined,
  ChevronDown,
  ChevronRight,
  CircleUserRound,
  Command,
  ContactRound,
  House,
  BrainCircuit,
  Monitor,
  Moon,
  Search,
  Sun,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  Button as AriaButton,
  Dialog,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  Modal,
  ModalOverlay,
  Popover,
  SearchField,
  Select,
  SelectValue,
} from "react-aria-components";
import type { Capability } from "@/server/auth";

const THEME_STORAGE_KEY = "sympose-theme";
type ThemePreference = "light" | "dark" | "system";

const themeOptions: ReadonlyArray<{
  id: ThemePreference;
  label: string;
  description: string;
  Icon: LucideIcon;
}> = [
  { id: "system", label: "System", description: "Follow your device", Icon: Monitor },
  { id: "light", label: "Light", description: "Bright and focused", Icon: Sun },
  { id: "dark", label: "Dark", description: "Low-light workspace", Icon: Moon },
];

const contextualDestinations: ReadonlyArray<{
  id: string;
  label: string;
  description: string;
  path: string;
  keywords: string;
}> = [
  {
    id: "event-overview",
    label: "Event overview",
    description: "Readiness, lifecycle, and event context",
    path: "overview",
    keywords: "event overview readiness lifecycle",
  },
  {
    id: "event-plan",
    label: "Plan evidence",
    description: "Review the current immutable plan",
    path: "plan",
    keywords: "plan plans planning compiler candidate decision",
  },
  {
    id: "event-review",
    label: "Review",
    description: "Review evidence for this event",
    path: "review",
    keywords: "review evidence submissions",
  },
  {
    id: "event-program",
    label: "Plan Studio",
    description: "Shape the event schedule",
    path: "program",
    keywords: "program schedule sessions",
  },
  {
    id: "event-speakers",
    label: "Speakers",
    description: "Track speaker commitments and readiness",
    path: "speakers",
    keywords: "speakers speaker commitments readiness",
  },
  {
    id: "event-publication",
    label: "Publication",
    description: "Preview audience releases",
    path: "publication",
    keywords: "publication agenda release audience",
  },
  {
    id: "event-operations",
    label: "Operations",
    description: "Open the event-day operating packet",
    path: "operations",
    keywords: "operations live event day",
  },
  {
    id: "event-cfp",
    label: "Call for proposals",
    description: "Manage this event's proposal call",
    path: "cfp",
    keywords: "call proposals cfp submissions",
  },
];

const primaryDestinationDefinitions = [
  { id: "home", label: "Home", description: "Workspace overview and next actions", keywords: "home dashboard workspace overview", path: "dashboard", Icon: House, requiredCapability: "phase0.pipeline.manage" },
  { id: "events", label: "Events", description: "Browse the workspace event portfolio", keywords: "events portfolio event", path: "events", Icon: CalendarDays, requiredCapability: "phase0.pipeline.manage" },
  { id: "crm", label: "CRM", description: "People and relationship context", keywords: "crm people relationships network", path: "crm", Icon: ContactRound, requiredCapability: "phase0.pipeline.manage" },
  { id: "memory", label: "Memory", description: "Evidence across events", keywords: "memory evidence history lineage", path: "memory", Icon: BrainCircuit, requiredCapability: "phase0.pipeline.manage" },
] as const satisfies ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly keywords: string;
  readonly path: string;
  readonly Icon: LucideIcon;
  readonly requiredCapability: Capability;
}>;

const utilityDestinationDefinitions = [
  { id: "connectors", label: "Connector Hub", description: "Provider status and safe workspace exports", keywords: "connector connectors integrations airtable hubspot salesforce csv export", path: "connectors", Icon: Cable, requiredCapability: "connectors.manage" },
  { id: "analytics", label: "Analytics", description: "Cross-event operational health", keywords: "analytics metrics funnel review readiness schedule publication health", path: "analytics", Icon: ChartNoAxesCombined, requiredCapability: "phase0.pipeline.manage" },
] as const satisfies ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly keywords: string;
  readonly path: string;
  readonly Icon: LucideIcon;
  readonly requiredCapability: Capability;
}>;

function capabilitySet(capabilities: readonly Capability[]): ReadonlySet<Capability> {
  return new Set(capabilities);
}

export function authorizedProductShellDestinationIds(
  capabilities: readonly Capability[],
): readonly string[] {
  const authorized = capabilitySet(capabilities);
  return Object.freeze(
    [...primaryDestinationDefinitions, ...utilityDestinationDefinitions]
      .filter(({ requiredCapability }) => authorized.has(requiredCapability))
      .map(({ id }) => id),
  );
}

function readThemePreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" || value === "system" ? value : "system";
  } catch {
    return "system";
  }
}

function resolveTheme(preference: ThemePreference): "light" | "dark" {
  if (preference !== "system") return preference;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(preference: ThemePreference): void {
  const resolved = resolveTheme(preference);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themePreference = preference;
  root.style.colorScheme = resolved;
}

function eventIdFromPath(pathname: string | null): string | null {
  if (!pathname) return null;
  const match = pathname.match(/^\/w\/[^/]+\/events\/([^/]+)/u);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function isOperationsPath(pathname: string | null): boolean {
  return pathname ? /^\/w\/[^/]+\/events\/[^/]+\/operations(?:\/|$)/u.test(pathname) : false;
}

function commandSurfaceLabel(pathname: string | null, capabilities: ReadonlySet<Capability>): string {
  if (capabilities.has("phase0.pipeline.manage") && pathname?.includes("/events/")) return "Event workspace";
  if (capabilities.has("phase0.pipeline.manage") && pathname?.endsWith("/analytics")) return "Analytics";
  if (capabilities.has("connectors.manage") && pathname?.endsWith("/connectors")) return "Connector Hub";
  if (capabilities.has("phase0.pipeline.manage") && pathname?.endsWith("/crm")) return "People";
  if (capabilities.has("phase0.pipeline.manage") && pathname?.endsWith("/memory")) return "Memory";
  return "Workspace home";
}

function ThemeControl() {
  const [preference, setPreference] = useState<ThemePreference>("system");

  useEffect(() => {
    const stored = readThemePreference();
    setPreference(stored);
    applyTheme(stored);

    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const onChange = () => {
      if (readThemePreference() === "system") applyTheme("system");
    };
    media.addEventListener?.("change", onChange);
    return () => media.removeEventListener?.("change", onChange);
  }, []);

  function changePreference(value: ThemePreference): void {
    setPreference(value);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, value);
    } catch {
      // Theme remains usable for this session when local storage is unavailable.
    }
    applyTheme(value);
  }

  return (
    <Select
      aria-label="Theme"
      className="productShell__theme-control"
      selectedKey={preference}
      onSelectionChange={(key) => {
        if (typeof key === "string" && (key === "light" || key === "dark" || key === "system")) {
          changePreference(key);
        }
      }}
    >
      <Label className="productShell__theme-label">Theme</Label>
      <AriaButton className="productShell__theme-trigger">
        <SelectValue />
        <ChevronDown aria-hidden="true" size={15} strokeWidth={1.8} />
      </AriaButton>
      <Popover className="productShell__theme-popover">
        <ListBox aria-label="Theme options" className="productShell__theme-list" selectionMode="single">
          {themeOptions.map(({ id, label, description, Icon }) => (
            <ListBoxItem
              key={id}
              id={id}
              textValue={`${label} ${description}`}
              className="productShell__theme-option"
              onAction={() => changePreference(id)}
            >
              <Icon aria-hidden="true" size={16} strokeWidth={1.8} />
              <span>
                <strong>{label}</strong>
                <small>{description}</small>
              </span>
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </Select>
  );
}

function CommandMenu({
  workspaceSlug,
  capabilities,
  pathname,
  isOpen,
  onOpenChange,
}: {
  workspaceSlug: string;
  capabilities: readonly Capability[];
  pathname: string | null;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");

  const eventId = eventIdFromPath(pathname);
  const workspacePath = `/w/${workspaceSlug}`;
  const authorized = capabilitySet(capabilities);
  const baseCommands = [...primaryDestinationDefinitions, ...utilityDestinationDefinitions]
    .filter(({ requiredCapability }) => authorized.has(requiredCapability))
    .map(({ path, ...destination }) => ({
      ...destination,
      href: `${workspacePath}/${path}`,
    }));

  const commands = eventId && authorized.has("phase0.pipeline.manage")
    ? [
        ...baseCommands,
        ...contextualDestinations.map(({ id, label, description, path, keywords }) => ({
          id,
          label,
          description,
          href: `${workspacePath}/events/${encodeURIComponent(eventId)}/${path}`,
          keywords,
          Icon: CalendarDays,
        })),
      ]
    : baseCommands;

  const normalizedQuery = query.trim().toLowerCase();
  const filteredCommands = normalizedQuery
    ? commands.filter((command) =>
        `${command.label} ${command.description} ${command.keywords}`.toLowerCase().includes(normalizedQuery),
      )
    : commands;

  function navigateTo(href: string): void {
    onOpenChange(false);
    setQuery("");
    router.push(href);
  }

  function handleOpenChange(nextIsOpen: boolean): void {
    if (!nextIsOpen) setQuery("");
    onOpenChange(nextIsOpen);
  }

  return (
    <ModalOverlay
      className="productShell__command-overlay"
      isOpen={isOpen}
      isDismissable
      onOpenChange={handleOpenChange}
    >
      <Modal className="productShell__command-modal">
        <Dialog aria-label="Command menu" className="productShell__command-dialog">
          <div className="productShell__command-head">
            <div>
              <p className="productShell__command-kicker">Navigate</p>
              <h2>Command menu</h2>
            </div>
            <AriaButton
              aria-label="Close command menu"
              className="productShell__icon-button"
              onPress={() => handleOpenChange(false)}
            >
              <span aria-hidden="true">×</span>
            </AriaButton>
          </div>
          <SearchField
            aria-label="Filter destinations"
            autoFocus
            className="productShell__command-search"
            value={query}
            onChange={setQuery}
          >
            <Search aria-hidden="true" size={17} strokeWidth={1.8} />
            <Input placeholder="Search events, people, plans, or destinations…" />
            <AriaButton
              aria-label="Clear destination search"
              className="productShell__search-clear"
              onPress={() => setQuery("")}
              slot="clear"
            >
              ×
            </AriaButton>
          </SearchField>
          <p className="productShell__command-help">
            <span>Working destinations only</span>
            <span><kbd>Esc</kbd> close · <kbd>⌘K</kbd>/<kbd>Ctrl K</kbd> open</span>
          </p>
          <ListBox
            aria-label="Available destinations"
            className="productShell__command-list"
            renderEmptyState={() => <p className="productShell__command-empty">No matching destinations.</p>}
            selectionMode="none"
          >
            {filteredCommands.map(({ id, label, description, href, Icon }) => (
              <ListBoxItem
                key={id}
                id={id}
                textValue={`${label} ${description}`}
                className="productShell__command-item"
                onAction={() => navigateTo(href)}
              >
                <span className="productShell__command-item-icon"><Icon aria-hidden="true" size={18} strokeWidth={1.8} /></span>
                <span className="productShell__command-item-copy">
                  <strong>{label}</strong>
                  <small>{description}</small>
                </span>
                <ChevronRight aria-hidden="true" size={16} strokeWidth={1.8} />
              </ListBoxItem>
            ))}
          </ListBox>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

export function ProductShell({
  workspaceSlug,
  workspaceName,
  displayName,
  email,
  accountInitials,
  capabilities,
  accountControl,
  children,
}: {
  workspaceSlug: string;
  workspaceName: string;
  displayName: string;
  email: string;
  accountInitials: string;
  capabilities: readonly Capability[];
  accountControl: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const eventId = eventIdFromPath(pathname);
  const isOperationsRoute = isOperationsPath(pathname);
  const [commandOpen, setCommandOpen] = useState(false);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const mobileMoreRef = useRef<HTMLDetailsElement | null>(null);

  const workspacePath = `/w/${workspaceSlug}`;
  const authorized = capabilitySet(capabilities);
  const primaryNavItems = primaryDestinationDefinitions
    .filter(({ requiredCapability }) => authorized.has(requiredCapability))
    .map(({ path, ...item }) => ({ ...item, href: `${workspacePath}/${path}` }));
  const utilityNavItems = utilityDestinationDefinitions
    .filter(({ requiredCapability }) => authorized.has(requiredCapability))
    .map(({ path, ...item }) => ({ ...item, href: `${workspacePath}/${path}` }));
  const mobileNavItems = primaryNavItems.filter(({ id }) => id !== "memory");
  const mobileMoreItems = [
    ...primaryNavItems.filter(({ id }) => id === "memory"),
    ...utilityNavItems,
  ];
  const hasDestinations = primaryNavItems.length + utilityNavItems.length > 0;
  const shellHome = authorized.has("phase0.pipeline.manage") ? `${workspacePath}/dashboard` : "/";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (hasDestinations && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setCommandOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hasDestinations]);

  useEffect(() => {
    if (commandOpen || !restoreFocusRef.current) return;
    const element = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (!element.isConnected) return;
    window.requestAnimationFrame(() => element.focus());
  }, [commandOpen]);

  useEffect(() => {
    if (mobileMoreRef.current) mobileMoreRef.current.open = false;
  }, [pathname]);

  function openCommand(): void {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCommandOpen(true);
  }

  function setCommandState(isOpen: boolean): void {
    setCommandOpen(isOpen);
  }

  function isActive(id: string, href: string): boolean {
    if (!pathname) return id === "home";
    return id === "home" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <div
      className={`shell productShell${isOperationsRoute ? " productShell--operator" : ""}`}
      data-density="comfortable"
      data-shell-surface={isOperationsRoute ? "operations" : "organizer"}
    >
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className="productShell__rail" aria-label="Authorized workspace navigation">
        <Link className="productShell__brand" href={shellHome} aria-label="Sympose home">
          <span className="productShell__mark" aria-hidden="true">S</span>
          <span className="productShell__brand-copy">
            <strong>Sympose</strong>
            <small>Event operating system</small>
          </span>
        </Link>
        <div className="productShell__rail-workspace">
          <span className="productShell__eyebrow">Workspace</span>
          <strong>{workspaceName}</strong>
        </div>
        <nav className="productShell__nav" aria-label="Workspace">
          {primaryNavItems.map(({ id, label, href, Icon }) => {
            const active = isActive(id, href);
            return (
              <Link
                key={id}
                href={href}
                className={`productShell__nav-link${active ? " productShell__nav-link--active" : ""}`}
                aria-current={active ? "page" : undefined}
                aria-label={label}
                title={label}
              >
                <Icon aria-hidden="true" size={18} strokeWidth={1.8} />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>
        <nav className="productShell__mobile-nav" aria-label="Mobile workspace navigation">
          {mobileNavItems.map(({ id, label, href, Icon }) => {
            const active = isActive(id, href);
            return (
              <Link key={id} href={href} aria-current={active ? "page" : undefined} className={`productShell__mobile-link${active ? " productShell__mobile-link--active" : ""}`}>
                <Icon aria-hidden="true" size={18} strokeWidth={1.8} />
                <span>{id === "crm" ? "People" : label}</span>
              </Link>
            );
          })}
          {mobileMoreItems.length > 0 ? <details className="productShell__mobile-more" ref={mobileMoreRef}>
            <summary
              className={`productShell__mobile-link${mobileMoreItems.some(({ id, href }) => isActive(id, href)) ? " productShell__mobile-link--active" : ""}`}
            >
              <ChevronDown aria-hidden="true" size={18} strokeWidth={1.8} />
              <span>More</span>
            </summary>
            <div className="productShell__mobile-more-panel" role="group" aria-label="More workspace destinations">
              {mobileMoreItems.map(({ id, label, href, Icon }) => {
                const active = isActive(id, href);
                return (
                  <Link
                    key={id}
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={`productShell__mobile-more-link${active ? " productShell__mobile-more-link--active" : ""}`}
                    onClick={() => {
                      if (mobileMoreRef.current) mobileMoreRef.current.open = false;
                    }}
                  >
                    <Icon aria-hidden="true" size={17} strokeWidth={1.8} />
                    <span>{label}</span>
                  </Link>
                );
              })}
            </div>
          </details> : null}
        </nav>
        <div className="productShell__rail-account shell__account shell__rail-account">
          <details className="productShell__account">
            <summary aria-label={`Account for ${displayName}`}>
              <span className="productShell__account-avatar shell__account-avatar" aria-hidden="true">{accountInitials || "A"}</span>
              <span className="productShell__account-summary">
                <strong>{displayName}</strong>
                <small>{email}</small>
              </span>
              <ChevronDown aria-hidden="true" size={16} strokeWidth={1.8} />
            </summary>
            <div className="productShell__account-panel">
              <div className="productShell__account-details">
                <CircleUserRound aria-hidden="true" size={17} strokeWidth={1.8} />
                <span><strong>{displayName}</strong><small>{email}</small></span>
              </div>
              <ThemeControl />
            </div>
          </details>
          {accountControl}
        </div>
      </aside>
      <div className="productShell__body">
        {isOperationsRoute && eventId ? (
          <nav className="productShell__operator-chrome" aria-label="Operations navigation">
            <div className="productShell__operator-heading">
              <span className="productShell__operator-kicker">Event-day control</span>
              <strong>Operations</strong>
            </div>
            <div className="productShell__operator-links">
              <a className="productShell__operator-link" href="#operations-live">Live</a>
              <a className="productShell__operator-link" href="#operations-proof">Proof</a>
              <a className="productShell__operator-link" href="#operations-timeline">Activity</a>
              <Link
                className="productShell__operator-link"
                href={`${workspacePath}/events/${encodeURIComponent(eventId)}/overview`}
              >
                Overview
              </Link>
            </div>
          </nav>
        ) : null}
        <header className="productShell__header">
          <div className="productShell__identity" data-event-id={eventId ?? undefined}>
            <span className="productShell__eyebrow">{eventId ? "Event workspace" : commandSurfaceLabel(pathname, authorized)}</span>
            {eventId ? null : <strong>{workspaceName}</strong>}
            {eventId ? null : <span className="productShell__slug">{`/w/${workspaceSlug}`}</span>}
          </div>
          <div className="productShell__header-actions">
            {hasDestinations ? <AriaButton
              aria-label="Open command menu (Command K or Control K)"
              className="productShell__command-trigger"
              onPress={openCommand}
            >
              <Search aria-hidden="true" size={17} strokeWidth={1.8} />
              <span>Search or jump</span>
              <kbd><Command aria-hidden="true" size={12} strokeWidth={1.8} />K</kbd>
            </AriaButton> : null}
            {eventId ? null : <span className="productShell__header-surface">{commandSurfaceLabel(pathname, authorized)}</span>}
          </div>
        </header>
        <main id="main-content" className="productShell__content" tabIndex={-1}>{children}</main>
      </div>
      {hasDestinations ? <CommandMenu
        workspaceSlug={workspaceSlug}
        capabilities={capabilities}
        pathname={pathname}
        isOpen={commandOpen}
        onOpenChange={setCommandState}
      /> : null}
    </div>
  );
}
