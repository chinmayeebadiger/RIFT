"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Accessibility, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, Braces, Check, CheckCheck,
  CheckCircle2, ChevronDown, ChevronRight, CircleHelp, Clock3, Code2, Copy, ExternalLink,
  FileSearch, Globe2, History, Layers3, ListFilter, LoaderCircle, Menu, Monitor, Play,
  RefreshCw, Search, ShieldCheck, Sparkles, TriangleAlert, WandSparkles, X, Zap,
} from "lucide-react";
import { SampleStorefront } from "./sample-storefront";
import { auditFilename, sampleAudit, severityLabels, severityOrder, type AuditIssue, type Severity, type WebsiteAudit } from "@/lib/website-audit";

type WorkspaceTab = "scanner" | "history" | "previews";
const categories = ["All issues", "Functionality", "Accessibility", "SEO", "Security", "Performance"] as const;

function RiftMark() {
  return <svg width="29" height="31" viewBox="0 0 29 31" fill="none" aria-hidden="true"><path d="M3 4h11l-4 10H0L3 4Zm12 13h11l-3 10H12l3-10Z" fill="currentColor" /><path d="m19 4-5 10h12l3-10H19ZM0 17h11L6 27H0V17Z" fill="currentColor" opacity=".42" /></svg>;
}

function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={`severity-badge severity-${severity}`}><span />{severityLabels[severity]}</span>;
}

function IssueIcon({ issue }: { issue: AuditIssue }) {
  if (issue.category === "Accessibility") return <Accessibility size={17} />;
  if (issue.category === "SEO") return <Search size={17} />;
  if (issue.category === "Performance") return <Zap size={17} />;
  if (issue.category === "Security") return <ShieldCheck size={17} />;
  return <Braces size={17} />;
}

function downloadText(name: string, value: string, type = "text/plain") {
  const blob = new Blob([value], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Dialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const id = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
      if (event.key !== "Tab") return;
      const controls = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, select, textarea, [tabindex="0"]') ?? []).filter((el) => el.getClientRects().length > 0);
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = overflow; document.removeEventListener("keydown", onKey); previous?.focus(); };
  }, []);
  return <div className="audit-dialog-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}><div ref={ref} role="dialog" aria-modal="true" aria-labelledby={id} className={`audit-dialog ${wide ? "audit-dialog-wide" : ""}`}><div className="dialog-topline"><span><WandSparkles size={17} />{title}</span><button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20} /></button></div><div id={id} className="sr-only">{title}</div>{children}</div></div>;
}

function ResolveDialog({ audit, issue, reviewed, onClose, onSave }: { audit: WebsiteAudit; issue: AuditIssue; reviewed: boolean; onClose: () => void; onSave: () => void }) {
  const [tab, setTab] = useState<"preview" | "code">(audit.sample ? "preview" : "code");
  const [copied, setCopied] = useState(false);
  return <Dialog title="Resolve issue" onClose={onClose} wide>
    <div className="resolve-heading"><div className="resolve-meta"><SeverityBadge severity={issue.severity} /><span>{issue.category}</span></div><h2>{issue.title}</h2><p>{issue.recommendation}</p></div>
    <div className="resolve-tabs" role="tablist" aria-label="Fix comparison">
      {audit.sample && <button role="tab" id="preview-tab" aria-controls="resolve-panel" aria-selected={tab === "preview"} onClick={() => setTab("preview")}><Monitor size={15} />Website preview</button>}
      <button role="tab" id="code-tab" aria-controls="resolve-panel" aria-selected={tab === "code"} onClick={() => setTab("code")}><Code2 size={15} />Code changes</button>
      <span>{audit.sample ? "Interactive demonstration" : "Suggested change"}</span>
    </div>
    <div role="tabpanel" id="resolve-panel" aria-labelledby={tab === "preview" ? "preview-tab" : "code-tab"} className="resolve-panel">
      {tab === "preview" ? <div className="comparison-grid"><div className="comparison-side"><div className="comparison-label"><span className="comparison-dot before-dot" />Before the fix<span>Sample website</span></div><SampleStorefront key={`before-${issue.id}`} issueId={issue.id} compact /></div><div className="comparison-side"><div className="comparison-label"><CheckCircle2 size={14} />With Rift’s fix<span>Preview only</span></div><SampleStorefront key={`after-${issue.id}`} issueId={issue.id} fixed compact /></div></div> : <div className="comparison-grid code-comparison"><div><div className="comparison-label"><span className="comparison-dot before-dot" />Current code</div><pre className="code-before"><code>{issue.before}</code></pre></div><div><div className="comparison-label"><CheckCircle2 size={14} />Suggested code</div><pre className="code-after"><code>{issue.after}</code></pre></div></div>}
    </div>
    <div className="fix-outcome"><span className="outcome-icon"><CheckCheck size={20} /></span><div><strong>What this changes</strong><p>{issue.impact}</p></div></div>
    {!audit.sample && <p className="suggestion-note">This suggestion is based on returned HTML. Adapt it to your source and verify it in a browser before applying it.</p>}
    <div className="resolve-actions"><p><ShieldCheck size={14} />{reviewed ? "Preview saved for your review" : "Review the fix before changing your website"}</p><div><button className="audit-button secondary-button" onClick={async () => { try { await navigator.clipboard.writeText(issue.after); setCopied(true); } catch { downloadText(`${auditFilename(audit)}-${issue.id}.txt`, issue.after); } }}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? "Copied" : "Copy suggestion"}</button><button className="audit-button primary-button" onClick={onSave}><Check size={16} />{reviewed ? "Done" : "Save fix preview"}</button></div></div>
  </Dialog>;
}

function HelpDialog({ onClose }: { onClose: () => void }) {
  return <Dialog title="From broken to understood" onClose={onClose}><div className="help-content"><h2>A clearer way to debug.</h2><p>Start with a URL. Leave with findings you can understand and fixes you can inspect.</p><ol><li><span>1</span><div><strong>Scan a website</strong><p>Rift runs 12 checks on the HTML returned by a public page, covering accessibility, SEO, security, and loading behavior.</p></div></li><li><span>2</span><div><strong>Understand each issue</strong><p>Filter by severity or category. Select an issue to see the evidence, affected markup, and recommended change.</p></div></li><li><span>3</span><div><strong>See how to resolve it</strong><p>Open Resolve for a code comparison. The sample website also includes interactive before-and-after demonstrations.</p></div></li></ol><div className="help-note"><ShieldCheck size={18} /><p>Fix previews don’t modify or deploy your website. Runtime bugs require source code and reproduction evidence in the <a href="/incidents">recovery workspace</a>.</p></div></div></Dialog>;
}

export default function WebsiteWorkspace() {
  const [audit, setAudit] = useState<WebsiteAudit>(sampleAudit);
  const [history, setHistory] = useState<WebsiteAudit[]>([sampleAudit]);
  const [url, setUrl] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanStep, setScanStep] = useState(0);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState(sampleAudit.issues[0].id);
  const [category, setCategory] = useState<string>("All issues");
  const [severity, setSeverity] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [detailTab, setDetailTab] = useState<"preview" | "details">("preview");
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("scanner");
  const [resolving, setResolving] = useState<AuditIssue | null>(null);
  const [reviewed, setReviewed] = useState<string[]>([]);
  const [help, setHelp] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [toast, setToast] = useState("");
  const [workspaceMenu, setWorkspaceMenu] = useState(false);
  const urlInput = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const results = useRef<HTMLDivElement>(null);
  const closeResolve = useCallback(() => setResolving(null), []);
  const closeHelp = useCallback(() => setHelp(false), []);
  useEffect(() => () => { controller.current?.abort(); }, []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 4500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { if (!scanning) return; const timer = setInterval(() => setScanStep((n) => Math.min(n + 1, 2)), 1800); return () => clearInterval(timer); }, [scanning]);

  const keyFor = (issue: AuditIssue) => `${audit.id}:${issue.id}`;
  const previewCount = audit.issues.filter((issue) => reviewed.includes(keyFor(issue))).length;
  const visible = audit.issues.filter((issue) => (category === "All issues" || issue.category === category) && (severity === "all" || issue.severity === severity) && (workspaceTab !== "previews" || reviewed.includes(keyFor(issue))) && `${issue.title} ${issue.description} ${issue.category}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  const selected = visible.find((issue) => issue.id === selectedId) ?? visible[0];
  const presentCategories = categories.filter((item) => item === "All issues" || audit.issues.some((issue) => issue.category === item));

  function loadAudit(next: WebsiteAudit) {
    setAudit(next); setSelectedId(next.issues[0]?.id ?? ""); setCategory("All issues"); setSeverity("all"); setSearch(""); setWorkspaceTab("scanner"); setDetailTab(next.sample ? "preview" : "details"); setError("");
  }

  async function scanWebsite(event?: FormEvent, target?: string) {
    event?.preventDefault();
    if (scanning) return;
    const address = (target ?? url).trim();
    if (!address) { setError("Enter a website URL to start a scan, or explore the sample below."); urlInput.current?.focus(); return; }
    const run = ++sequence.current;
    const abort = new AbortController(); controller.current = abort;
    setScanning(true); setScanStep(0); setError("");
    try {
      const response = await fetch("/api/website-audit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: address }), signal: abort.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "The scan could not complete. Check the address and try again.");
      if (run !== sequence.current) return;
      const next = body as WebsiteAudit;
      loadAudit(next); setUrl(next.url); setHistory((items) => [next, ...items].slice(0, 12));
      setToast(`Scan complete. ${next.issues.length} issue${next.issues.length === 1 ? "" : "s"} found across ${next.checks} HTML checks.`);
      requestAnimationFrame(() => results.current?.focus());
    } catch (reason) {
      if (run !== sequence.current || abort.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : "The scan could not complete. Try again.");
    } finally { if (run === sequence.current) setScanning(false); }
  }

  function showSample() {
    sequence.current++; controller.current?.abort(); setScanning(false); loadAudit(sampleAudit); setUrl("");
  }

  function navigate(tab: WorkspaceTab) {
    setWorkspaceTab(tab); setMobileMenu(false); setCategory("All issues"); setSeverity("all"); setSearch("");
  }

  function exportReport() {
    downloadText(`${auditFilename(audit)}-report.json`, JSON.stringify({ ...audit, reviewedPreviewIds: audit.issues.filter((issue) => reviewed.includes(keyFor(issue))).map((issue) => issue.id) }, null, 2), "application/json");
    setToast("Report exported with findings, evidence, and suggested fixes.");
  }

  return <div className="website-app">
    <a className="skip-link" href="#audit-main">Skip to workspace</a>
    {mobileMenu && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMobileMenu(false)} />}
    <aside className={`audit-sidebar ${mobileMenu ? "sidebar-open" : ""}`}>
      <a className="rift-brand" href="/" aria-label="Rift website scanner"><RiftMark /><span>rift<span className="brand-period">.</span></span></a>
      <div className="workspace-switcher-wrap"><button className="workspace-switcher" aria-expanded={workspaceMenu} onClick={() => setWorkspaceMenu((open) => !open)}><span className="workspace-avatar"><Layers3 size={16} /></span><span>Personal workspace<small>Local environment</small></span><ChevronDown size={13} /></button>{workspaceMenu && <div className="workspace-popover"><button onClick={() => { navigate("scanner"); setWorkspaceMenu(false); }}><Check size={14} />Personal workspace</button><a href="/workspace"><ArrowUpRight size={14} />Recovery workspace</a></div>}</div>
      <span className="navigation-label">Workspace</span>
      <nav aria-label="Website workspace"><button className={workspaceTab === "scanner" ? "nav-active" : ""} onClick={() => navigate("scanner")} aria-current={workspaceTab === "scanner" ? "page" : undefined}><FileSearch size={18} />Website scanner<span className="nav-active-dot" /></button><button className={workspaceTab === "history" ? "nav-active" : ""} onClick={() => navigate("history")} aria-current={workspaceTab === "history" ? "page" : undefined}><History size={18} />Audit history<span className="nav-count">{history.length}</span></button><button className={workspaceTab === "previews" ? "nav-active" : ""} onClick={() => navigate("previews")} aria-current={workspaceTab === "previews" ? "page" : undefined}><WandSparkles size={18} />Fix previews{previewCount > 0 && <span className="nav-count">{previewCount}</span>}</button></nav>
      <div className="sidebar-divider" /><span className="navigation-label">Recovery tools</span><nav aria-label="Recovery tools"><a href="/incidents"><Layers3 size={18} />Incident workspace<ArrowUpRight size={13} /></a><a href="/evidence"><ShieldCheck size={18} />Evidence library<ArrowUpRight size={13} /></a></nav>
      <div className="sidebar-bottom"><div className="sidebar-note"><div className="sidebar-note-icon"><ShieldCheck size={21} /></div><strong>See the fix. Stay in control.</strong><p>Inspect every change before it reaches your website.</p><button onClick={() => setHelp(true)}>How Rift works <ArrowRight size={13} /></button></div><button className="sidebar-help" onClick={() => setHelp(true)}><CircleHelp size={17} />Help & getting started</button><div className="sidebar-profile"><span>Y</span><div>Your workspace<small>Website recovery, simplified</small></div><span className="profile-status" /></div></div>
    </aside>

    <div className="audit-body">
      <header className="audit-topbar"><div className="topbar-breadcrumb"><button className="icon-button mobile-nav-toggle" aria-label="Open navigation" onClick={() => setMobileMenu(true)}><Menu size={20} /></button><span className="breadcrumb-home"><Globe2 size={15} />Workspace</span><ChevronRight size={13} /><strong>{workspaceTab === "history" ? "Audit history" : workspaceTab === "previews" ? "Fix previews" : "Website scanner"}</strong></div><div className="topbar-actions"><span className="local-indicator"><span />Local workspace</span><button className="topbar-help" onClick={() => setHelp(true)}><CircleHelp size={16} /><span>How it works</span></button></div></header>
      <main id="audit-main" className="audit-main">
        <div className="workspace-heading"><div><h1>{workspaceTab === "history" ? "Every scan, in one place." : workspaceTab === "previews" ? "A closer look at your fixes." : "Find the break. See the fix."}</h1><p>{workspaceTab === "history" ? "Revisit reports from this session and pick up where you left off." : workspaceTab === "previews" ? "Your saved fix previews for the current report, ready to review." : "A clear view of what’s wrong with your website. And how to make it right."}</p></div><div className="heading-steps"><span><FileSearch size={14} />Detect</span><span className="step-connector" /><span><Search size={14} />Understand</span><span className="step-connector" /><span><WandSparkles size={14} />Resolve</span></div></div>

        {workspaceTab === "scanner" && <section className={`scan-entry ${scanning ? "scan-in-progress" : ""}`} aria-labelledby="scan-entry-heading"><div className="scan-entry-title"><span id="scan-entry-heading">Which website should we check?</span><span><ShieldCheck size={12} />Your website stays untouched</span></div><form onSubmit={scanWebsite} noValidate><div className="website-url-input"><Globe2 size={18} /><input ref={urlInput} type="text" inputMode="url" aria-label="Website URL" aria-describedby={error ? "scan-error" : "scan-hint"} aria-invalid={!!error} placeholder="https://your-website.com" value={url} disabled={scanning} onChange={(event) => { setUrl(event.target.value); setError(""); }} /><span className="input-protocol">URL</span></div><button className="audit-button primary-button scan-submit" disabled={scanning} type="submit">{scanning ? <LoaderCircle size={17} className="spin" /> : <Sparkles size={17} />}{scanning ? "Scanning website…" : "Scan website"}{!scanning && <ArrowRight size={16} />}</button></form><div className="scan-entry-footer"><p id="scan-hint">Public page HTML. Clear findings. Reviewable fixes.</p><button className="sample-link" type="button" onClick={showSample}><Play size={11} fill="currentColor" />Try a sample website</button></div>{error && <div className="scan-error" id="scan-error" role="alert"><TriangleAlert size={16} /><span>{error}</span></div>}{scanning && <div role="status" aria-live="polite" className="scan-progress"><div className="scan-progress-track"><span style={{ width: `${25 + scanStep * 30}%` }} /></div><span>{["Connecting to your website…", "Reading page structure and markup…", "Checking accessibility, SEO, security, and loading behavior…"][scanStep]}</span><button onClick={() => { sequence.current++; controller.current?.abort(); setScanning(false); setToast("Scan cancelled. Your previous report is still available."); }}>Cancel scan</button></div>}</section>}

        {workspaceTab === "history" ? <section className="history-panel"><div className="history-heading"><h2>Recent audits</h2><span>Saved for this session</span></div>{history.map((entry) => <button className="history-row" key={entry.id} onClick={() => loadAudit(entry)}><span className="report-site-icon"><Globe2 size={19} /></span><div><strong>{entry.title}</strong><span>{entry.url}</span></div><span className="history-type">{entry.sample ? "Sample audit" : new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(entry.scannedAt))}</span><span>{entry.issues.length} issues</span><ChevronRight size={17} /></button>)}<p className="history-note"><Clock3 size={14} />Session history clears when you reload. Export a report to keep a copy.</p></section> : <>
          <section className="report-overview" ref={results} tabIndex={-1} aria-label="Website audit report"><div className="report-identity"><span className="report-site-icon"><Globe2 size={21} /></span><div><div className="report-title"><h2>{audit.title}</h2><span className={`report-kind ${audit.sample ? "sample-kind" : ""}`}>{audit.sample ? "Sample audit" : "HTML audit"}</span></div><div className="report-address"><span>{new URL(audit.url).hostname}{new URL(audit.url).pathname !== "/" ? new URL(audit.url).pathname : ""}</span><span className="report-address-divider" /><CheckCircle2 size={12} /><span>{audit.sample ? "Explore the example report" : `${audit.checks} checks completed`}</span></div></div></div><div className="report-actions">{!audit.sample && <button className="icon-button" aria-label="Rescan website" disabled={scanning} onClick={() => { setUrl(audit.url); void scanWebsite(undefined, audit.url); }}><RefreshCw size={16} /></button>}<button className="audit-button secondary-button export-button" onClick={exportReport}><ArrowDownToLine size={14} />Export report</button></div></section>

          <div className="report-summary"><div className="summary-total"><span className="summary-alert"><TriangleAlert size={18} /></span><strong>{audit.issues.length}</strong><span>{audit.issues.length === 1 ? "issue to look into" : "issues to look into"}</span></div><div className="severity-summary">{(["critical", "high", "medium", "low"] as Severity[]).map((level) => <button key={level} onClick={() => setSeverity((current) => current === level ? "all" : level)} className={`severity-summary-item ${severity === level ? "summary-selected" : ""}`} aria-pressed={severity === level}><span className={`severity-dot severity-dot-${level}`} /><strong>{audit.issues.filter((issue) => issue.severity === level).length}</strong><span>{severityLabels[level]}</span></button>)}</div><span className="report-check-count">{audit.sample ? "Illustrative findings" : "Single-page scan"}</span></div>

          <div className="audit-report-grid">
            <section className="issue-panel" aria-label={workspaceTab === "previews" ? "Saved fix previews" : "Website issues"}>
              <div className="issue-panel-toolbar"><div className="issue-tabs" aria-label="Filter by category">{presentCategories.map((item) => <button key={item} aria-pressed={category === item} className={category === item ? "issue-tab-active" : ""} onClick={() => setCategory(item)}>{item}{item === "All issues" && <span>{audit.issues.length}</span>}</button>)}</div></div>
              <div className="issue-list-controls"><label className="issue-search"><Search size={14} /><input aria-label="Search issues" placeholder="Search issues…" value={search} onChange={(event) => setSearch(event.target.value)} /></label><label className="severity-filter"><ListFilter size={13} /><select aria-label="Filter severity" value={severity} onChange={(event) => setSeverity(event.target.value)}><option value="all">All severities</option>{(["critical", "high", "medium", "low"] as Severity[]).map((level) => <option value={level} key={level}>{severityLabels[level]}</option>)}</select><ChevronDown size={11} /></label></div>
              <div className="issue-list">{visible.length === 0 ? <div className="empty-issues"><CheckCircle2 size={32} /><h3>{workspaceTab === "previews" ? "Your fix previews will live here" : audit.issues.length ? "No matching issues" : "No issues found in these checks"}</h3><p>{workspaceTab === "previews" ? "Open an issue, select Resolve, and save its fix preview to review it here." : audit.issues.length ? "Try a different filter or search term." : "These HTML checks passed. Runtime behavior and visual layout still need browser testing."}</p><button className="audit-button secondary-button" onClick={() => { if (workspaceTab === "previews") navigate("scanner"); else { setCategory("All issues"); setSeverity("all"); setSearch(""); } }}>{workspaceTab === "previews" ? "Explore issues" : "Reset filters"}</button></div> : visible.map((issue) => <article className={`issue-row ${selected?.id === issue.id ? "issue-row-selected" : ""}`} key={issue.id}><button className="issue-select" onClick={() => setSelectedId(issue.id)} aria-pressed={selected?.id === issue.id}><span className={`issue-type-icon issue-type-${issue.severity}`}><IssueIcon issue={issue} /></span><span className="issue-row-content"><strong>{issue.title}</strong><span>{issue.category}<span className="issue-category-divider" />{issue.location.split(" / ").pop()}{reviewed.includes(keyFor(issue)) && <span className="reviewed-inline"><Check size={11} />Preview saved</span>}</span></span></button><div className="issue-row-actions"><SeverityBadge severity={issue.severity} /><button className="resolve-row-button" onClick={() => { setSelectedId(issue.id); setResolving(issue); }} aria-label={`Resolve: ${issue.title}`}>Resolve <ArrowUpRight size={12} /></button></div></article>)}</div>
              <div className="issue-panel-footer"><span>Showing {visible.length} of {audit.issues.length} issues</span><span><ListFilter size={12} />Highest severity first</span></div>
            </section>

            <aside className="issue-inspector" aria-label="Selected issue"><div className="inspector-tabs"><div role="tablist" aria-label="Issue inspection">{audit.sample && <button id="website-preview-tab" role="tab" aria-selected={detailTab === "preview"} aria-controls="inspection-panel" onClick={() => setDetailTab("preview")}><Monitor size={14} />Website preview</button>}<button id="issue-details-tab" role="tab" aria-selected={detailTab === "details"} aria-controls="inspection-panel" onClick={() => setDetailTab("details")}><Code2 size={14} />Issue details</button></div><span className="inspector-live-indicator"><span />{audit.sample ? "Sample" : "HTML"}</span></div>
              <div id="inspection-panel" role="tabpanel" aria-labelledby={detailTab === "preview" && audit.sample ? "website-preview-tab" : "issue-details-tab"}>{selected ? <>
                {detailTab === "preview" && audit.sample ? <div className="website-browser"><div className="browser-toolbar"><div className="browser-dots"><span /><span /><span /></div><span><ShieldCheck size={10} />rift-shop.example</span><span className="browser-desktop"><Monitor size={12} /></span></div><SampleStorefront key={selected.id} issueId={selected.id} /></div> : <div className="evidence-preview"><div className="evidence-preview-heading"><span><FileSearch size={15} />Observed evidence</span><span>{selected.category}</span></div><pre><code>{selected.evidence}</code></pre><div className="evidence-location"><Code2 size={13} />{selected.location}</div>{!audit.sample && <a href={audit.url} target="_blank" rel="noreferrer">Open original website<ExternalLink size={12} /></a>}</div>}
                <div className="selected-issue-detail"><div className="selected-issue-meta"><span className={`detail-alert detail-alert-${selected.severity}`}><TriangleAlert size={14} />{severityLabels[selected.severity]} issue</span><span>{selected.category}</span></div><h3>{selected.title}</h3><p>{selected.description}</p><div className="affected-location"><Code2 size={12} /><span>{selected.location}</span></div><button className="audit-button primary-button inspector-resolve" onClick={() => setResolving(selected)}><WandSparkles size={15} />Resolve this issue<ArrowRight size={15} /></button><p className="preview-reassurance"><ShieldCheck size={11} />See the proposed fix before making a change</p></div>
              </> : <div className="inspector-empty"><FileSearch size={36} /><h3>Select an issue to take a closer look</h3><p>Evidence, context, and a proposed fix will appear here.</p></div>}</div>
            </aside>
          </div>
          <div className="audit-scope"><span><ShieldCheck size={14} /></span><p>{audit.scope}</p></div>
          <div className="workspace-bottom-note"><RiftMark /><span>A little clarity. A better website.</span><button onClick={() => setHelp(true)}>About this scan <CircleHelp size={13} /></button></div>
        </>}
      </main>
    </div>
    {resolving && <ResolveDialog key={resolving.id} audit={audit} issue={resolving} reviewed={reviewed.includes(keyFor(resolving))} onClose={closeResolve} onSave={() => { setReviewed((items) => items.includes(keyFor(resolving)) ? items : [...items, keyFor(resolving)]); setResolving(null); setToast("Fix preview saved for review. No website changes applied."); }} />}
    {help && <HelpDialog onClose={closeHelp} />}
    {toast && <div className="audit-toast" role="status"><CheckCircle2 size={18} /><span>{toast}</span><button aria-label="Dismiss notification" onClick={() => setToast("")}><X size={15} /></button></div>}
  </div>;
}
