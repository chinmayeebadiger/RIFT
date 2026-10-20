"use client";

import { useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  Bell,
  Check,
  CheckCircle2,
  CircleDot,
  Clock3,
  FileText,
  GitBranch,
  LayoutDashboard,
  Lock,
  LucideIcon,
  Menu,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Users,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PatchWorkspace } from "@/components/patch-workspace";
import {
  fetchIncident,
  fetchIncidents,
  fetchRecoveryReport,
  submitApprovalIntent,
  verificationStatusLabel,
  type ApprovalDecision,
  type Incident,
  type IncidentTimelineEvent,
  type RecoveryReportRecord,
  type VerificationStatus,
} from "@/lib/incidents";

export type WorkspaceView = "overview" | "incidents" | "evidence" | "patches" | "workspace" | "settings";
type NavItem = { label: string; icon: LucideIcon; path: string; view: WorkspaceView; count?: string };

const primaryNav: NavItem[] = [
  { label: "Overview", icon: LayoutDashboard, path: "/", view: "overview" },
  { label: "Incidents", icon: AlertCircle, path: "/incidents", view: "incidents" },
  { label: "Evidence", icon: FileText, path: "/evidence", view: "evidence" },
  { label: "Patches", icon: GitBranch, path: "/patches", view: "patches" },
];

const secondaryNav: NavItem[] = [
  { label: "Team workspace", icon: Users, path: "/workspace", view: "workspace" },
  { label: "Settings", icon: Settings2, path: "/settings", view: "settings" },
];

function formatDate(timestamp: string) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? timestamp
    : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(date);
}

function formatTime(timestamp: string) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? timestamp
    : new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }).format(date);
}

function statusLabel(status: Incident["status"]) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function Sidebar({ incidentCount, activeView }: { incidentCount: number; activeView: WorkspaceView }) {
  const nav = primaryNav.map((item) => item.label === "Incidents" ? { ...item, count: String(incidentCount) } : item);
  return (
    <aside className="hidden w-[238px] shrink-0 border-r border-white/70 bg-white/55 px-4 py-5 backdrop-blur-2xl lg:flex lg:flex-col">
      <div className="flex items-center gap-3 px-3 pb-7">
        <div className="brand-orb flex h-10 w-10 items-center justify-center rounded-[15px] text-sm font-black text-white shadow-lg shadow-[#ef9d92]/20">r/</div>
        <div><div className="text-[17px] font-black tracking-[-0.04em] text-[#2c2c35]">rift</div><div className="text-[9px] font-bold uppercase tracking-[0.18em] text-[#96939d]">recovery control</div></div>
      </div>
      <div className="flex flex-1 flex-col">
        <div className="mb-3 px-3 text-[10px] font-bold uppercase tracking-[0.16em] text-[#aaa7b0]">Workspace</div>
        <nav className="space-y-1.5" aria-label="Workspace navigation">{nav.map((item) => <NavButton key={item.label} item={item} active={item.view === activeView} />)}</nav>
        <div className="mb-3 mt-8 px-3 text-[10px] font-bold uppercase tracking-[0.16em] text-[#aaa7b0]">Manage</div>
        <nav className="space-y-1.5" aria-label="Management navigation">{secondaryNav.map((item) => <NavButton key={item.label} item={item} active={item.view === activeView} />)}</nav>
        <div className="mt-auto rounded-[22px] border border-white/80 bg-gradient-to-br from-[#fff5ec] to-[#f3e9ff] p-4 shadow-[0_18px_40px_rgba(196,157,177,0.12)]">
          <div className="mb-5 flex items-center justify-between"><div className="brand-orb h-7 w-7 rounded-full" /><Badge variant="success">Secure</Badge></div>
          <p className="text-xs font-extrabold text-[#3c3a47]">Isolated verification</p>
          <p className="mt-1 text-[11px] leading-4 text-[#85818d]">Every patch is tested away from production.</p>
        </div>
      </div>
    </aside>
  );
}

function NavButton({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return <a href={item.path} aria-current={active ? "page" : undefined} className={`flex w-full items-center gap-3 rounded-[14px] px-3.5 py-3 text-left text-sm font-semibold transition ${active ? "bg-white text-[#2c2c35] shadow-[0_8px_22px_rgba(141,121,148,0.12)]" : "text-[#8f8b96] hover:bg-white/55 hover:text-[#3f3c49]"}`}><Icon size={16} strokeWidth={1.8} /><span className="flex-1">{item.label}</span>{item.count && <span className="rounded-full bg-[#f2edf5] px-2 py-0.5 text-[10px] text-[#8f8997]">{item.count}</span>}</a>;
}

function Header() {
  return <header className="flex flex-wrap items-center justify-between gap-4 px-1 pb-7"><div className="flex items-center gap-3"><Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation"><Menu size={19} /></Button><div><div className="flex items-center gap-2"><p className="text-sm font-bold text-[#393641]">Incident recovery</p><Badge variant="neutral" className="hidden sm:inline-flex">API data</Badge></div><p className="mt-1 text-[11px] text-[#96939d]">Evidence-backed recovery workspace</p></div></div><div className="flex items-center gap-2"><div className="hidden h-10 w-52 items-center gap-2 rounded-full border border-white/80 bg-white/60 px-4 text-xs text-[#aaa7b0] shadow-sm backdrop-blur sm:flex"><Search size={15} /><span>Search workspace</span></div><Button variant="ghost" size="icon" aria-label="Search" className="sm:hidden"><Search size={17} /></Button><Button variant="ghost" size="icon" aria-label="Notifications"><Bell size={17} /></Button><div className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-white bg-gradient-to-br from-[#ffc7a9] to-[#c7b7ff] text-xs font-bold text-white shadow-sm">A</div></div></header>;
}

function IncidentSelector({ incidents, selectedId, onSelect }: { incidents: Incident[]; selectedId: string | null; onSelect: (id: string) => void }) {
  return <section className="mb-7"><div className="mb-3 flex items-end justify-between gap-3"><div><p className="section-kicker">Incident index</p><h2 className="mt-1 text-lg font-extrabold tracking-[-0.03em] text-[#36333e]">Recent incidents</h2></div><span className="text-[11px] text-[#7d8a8d]">{incidents.length} tracked</span></div><div className="grid gap-3 md:grid-cols-3">{incidents.map((incident, index) => <button key={incident.id} type="button" aria-pressed={incident.id === selectedId} onClick={() => onSelect(incident.id)} className={`pastel-card group min-h-[122px] text-left ${incident.id === selectedId ? "ring-2 ring-[#111315] ring-offset-2 ring-offset-[#dce5e7]" : ""} ${index % 3 === 0 ? "pastel-peach" : index % 3 === 1 ? "pastel-lilac" : "pastel-mint"}`}><div className="flex items-center justify-between gap-2"><span className="font-mono text-[10px] text-[#59676a]">{incident.id}</span><span className="rounded-none bg-white/70 px-2 py-1 text-[9px] font-bold uppercase tracking-[0.08em] text-[#4c595b]">{incident.severity}</span></div><p className="mt-5 line-clamp-2 text-sm font-extrabold leading-5 text-[#202325]">{incident.title}</p><div className="mt-2 flex items-center gap-2 text-[11px] text-[#59676a]"><span className="h-1.5 w-1.5 rounded-full bg-[#526e70]" />{incident.service} · {statusLabel(incident.status)}</div><ArrowUpRight className="absolute right-4 top-4 opacity-0 transition group-hover:opacity-60" size={16} /></button>)}</div></section>;
}

function LoadingState() { return <div className="glass-card p-10 text-center"><div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-white border-t-[#d98e83]" /><p className="mt-4 text-sm font-semibold text-[#3d3945]">Loading API state</p><p className="mt-1 text-xs text-[#96939d]">Connecting to the recovery API…</p></div>; }

function ErrorState({ message, onRetry, title = "Unable to load incident data" }: { message: string; onRetry: () => void; title?: string }) { return <div role="alert" className="glass-card border-[#f3c3bb] bg-[#fff5f2]/80 p-10 text-center"><TriangleAlert className="mx-auto text-[#db796c]" size={20} /><p className="mt-4 text-sm font-semibold text-[#3d3945]">{title}</p><p className="mx-auto mt-1 max-w-md text-xs leading-5 text-[#817b87]">{message}</p><Button variant="secondary" size="sm" className="mt-5" onClick={onRetry}>Try again</Button></div>; }

function TimelineCard({ timeline }: { timeline: IncidentTimelineEvent[] }) { return <div className="glass-card p-5 sm:p-6"><div className="mb-5 flex items-center justify-between"><div><p className="section-kicker">Progress</p><h3 className="mt-1 text-base font-extrabold text-[#393641]">Investigation timeline</h3></div><div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/70 text-[#d68e84]"><Sparkles size={15} /></div></div>{timeline.length === 0 ? <p className="text-sm text-[#817b87]">No timeline events have been recorded yet.</p> : <div className="space-y-4">{timeline.map((event, index) => <div className="flex gap-3" key={`${event.timestamp}-${event.title}`}><div className={`mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${index === timeline.length - 1 ? "bg-[#f8d4cd] text-[#b8675d]" : "bg-white/80 text-[#aaa2ae]"}`}><CircleDot size={13} /></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs font-bold text-[#4b4652]">{event.title}</p><span className="font-mono text-[10px] text-[#a19ca5]">{formatTime(event.timestamp)}</span></div><p className="mt-1 text-[11px] leading-5 text-[#89838e]">{event.detail}</p></div></div>)}</div>}</div>; }

function EvidenceSummary({ incident }: { incident: Incident }) { return <div className="glass-card pastel-lilac p-5 sm:p-6"><div className="mb-8 flex items-center justify-between"><div><p className="section-kicker">Evidence</p><h3 className="mt-1 text-base font-extrabold text-[#393641]">Collected artifacts</h3></div><div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/70 text-[#897ab9]"><FileText size={16} /></div></div><p className="text-4xl font-black tracking-[-0.06em] text-[#393641]">{incident.evidenceCount}</p><p className="mt-2 text-xs text-[#817b87]">immutable artifacts attached to <span className="font-mono">{incident.id}</span></p><div className="mt-6 h-1.5 overflow-hidden rounded-full bg-white/70"><div className="h-full w-2/3 rounded-full bg-[#a99bd4]" /></div><p className="mt-2 text-[10px] font-semibold text-[#8c84a0]">Evidence chain healthy</p></div>; }

function IncidentDashboard({ incident }: { incident: Incident }) {
  const severityTone = incident.severity === "SEV-1" || incident.severity === "SEV-2" ? "danger" : incident.severity === "SEV-3" ? "warning" : "neutral";
  return <>
    <section className="mb-7 grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
      <div className="hero-card pastel-peach"><div className="relative z-10 max-w-xl"><div className="mb-5 flex flex-wrap items-center gap-2"><Badge variant={severityTone}>{incident.severity}</Badge><span className="font-mono text-[11px] text-[#77727f]">{incident.id}</span></div><p className="section-kicker">Active recovery workspace</p><h1 className="mt-2 max-w-2xl text-3xl font-black leading-[1.05] tracking-[-0.07em] text-[#37333f] sm:text-5xl">{incident.title}</h1><p className="mt-4 max-w-xl text-sm leading-6 text-[#746e7a]">{incident.summary}</p><div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] font-semibold text-[#7c7480]"><span>{incident.service}</span><span>Updated {formatDate(incident.updatedAt)}</span><span className="font-mono">{incident.commit?.slice(0, 8) ?? "revision pending"}</span></div></div><div className="hero-orb" /></div>
      <div className="glass-card flex min-h-[250px] flex-col justify-between p-6"><div className="flex items-center justify-between"><div><p className="section-kicker">Run status</p><h2 className="mt-1 text-xl font-black tracking-[-0.04em] text-[#3a3642]">{statusLabel(incident.status)}</h2></div><div className="flex h-11 w-11 items-center justify-center rounded-full bg-[#eaf8ef] text-[#56aa7d]"><CheckCircle2 size={21} /></div></div><div className="mt-8 grid grid-cols-2 gap-3"><div className="rounded-2xl bg-white/55 p-4"><p className="section-kicker">Stage</p><p className="mt-2 text-sm font-bold capitalize text-[#4b4652]">{incident.stage.replaceAll("-", " ")}</p></div><div className="rounded-2xl bg-white/55 p-4"><p className="section-kicker">Repository</p><p className="mt-2 truncate font-mono text-xs font-bold text-[#4b4652]">{incident.repository}</p></div></div><div className="mt-5 flex items-center gap-2 text-xs font-semibold text-[#6f8e7f]"><span className="h-2 w-2 animate-pulse rounded-full bg-[#6abd8e]" /> API connected · evidence-first mode</div></div>
    </section>
    <div className="mb-7 grid gap-5 md:grid-cols-2"><EvidenceSummary incident={incident} /><TimelineCard timeline={incident.timeline} /></div>
  </>;
}

function ReportBreakdown({ record }: { record: RecoveryReportRecord }) { const report = record.report; return <div className="glass-card mb-7 p-5 sm:p-6"><div className="mb-5 flex items-center justify-between"><div><p className="section-kicker">Replayable report</p><h3 className="mt-1 text-base font-extrabold text-[#393641]">Recovery evidence</h3></div><Badge variant="neutral">{record.approval.status}</Badge></div><div className="grid gap-3 sm:grid-cols-4">{[["Citations", report.evidenceCitations?.length ?? report.evidenceIds?.length ?? 0], ["Hypotheses", report.hypotheses?.length ?? 0], ["Commands", report.commands?.length ?? 0], ["Patches", report.patches?.length ?? report.candidatePatchIds?.length ?? 0]].map(([label, value]) => <div className="rounded-2xl bg-white/55 p-4" key={String(label)}><p className="section-kicker">{label}</p><p className="mt-2 text-2xl font-black tracking-[-0.05em] text-[#3d3945]">{value}</p></div>)}</div><div className="mt-4 grid gap-3 md:grid-cols-2"><div className="rounded-2xl bg-[#f2f8f3]/70 p-4"><p className="text-xs font-bold text-[#4d765c]">Observed facts</p>{report.facts.slice(0, 3).map((fact) => <p className="mt-2 text-[11px] leading-4 text-[#75877b]" key={fact}>{fact}</p>)}</div><div className="rounded-2xl bg-[#f7f1fb]/70 p-4"><p className="text-xs font-bold text-[#76658d]">Inferences and unknowns</p>{[...report.inferences.slice(0, 2), ...report.unknowns.slice(0, 2)].map((item) => <p className="mt-2 text-[11px] leading-4 text-[#877d8f]" key={item}>{item}</p>)}</div></div></div>; }

const verificationTone: Record<VerificationStatus, "neutral" | "danger" | "success" | "warning" | "blue"> = { running: "blue", verified: "success", regressed: "danger", "not-reproduced": "warning", inconclusive: "warning", cancelled: "neutral", "policy-denied": "danger" };

function VerificationPanel({ record }: { record: RecoveryReportRecord }) { const status = record.report.status; const Icon = status === "verified" ? CheckCircle2 : status === "running" ? Activity : status === "policy-denied" ? Lock : status === "cancelled" ? X : TriangleAlert; const description = status === "verified" ? "The candidate patch passed isolated checks." : status === "regressed" ? "Verification found a regression in the candidate patch." : status === "not-reproduced" ? "The reported failure could not be reproduced." : status === "inconclusive" ? "The available checks did not establish a conclusion." : status === "cancelled" ? "Verification was cancelled before completion." : status === "policy-denied" ? "Runner policy prevented verification from starting." : "The isolated verification runner is still working."; return <div className="glass-card mb-7 p-5 sm:p-6"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="section-kicker">Verification</p><h3 className="mt-1 text-base font-extrabold text-[#393641]">Isolated runner result</h3></div><Badge variant={verificationTone[status]}><Icon size={12} />{verificationStatusLabel(status)}</Badge></div><div className="mt-7 flex items-end justify-between gap-3"><div><p className="text-4xl font-black tracking-[-0.06em] text-[#393641]">{record.report.verificationResultIds ? `${record.report.verificationResultIds.length}` : "—"}</p><p className="mt-1 text-xs text-[#817b87]">{description}</p></div><p className="font-mono text-[10px] font-bold text-[#aaa4ad]">{status.toUpperCase()}</p></div><div className="mt-6 grid gap-3 sm:grid-cols-2">{record.report.facts.slice(0, 4).map((fact) => <CheckRow key={fact} label="Report fact" detail={fact} positive={status === "verified"} />)}{record.report.unknowns.slice(0, 2).map((unknown) => <CheckRow key={unknown} label="Unknown" detail={unknown} positive={false} />)}</div></div>; }

function CheckRow({ label, detail, positive }: { label: string; detail: string; positive: boolean }) { return <div className="flex items-start gap-2.5 rounded-2xl bg-white/45 p-3"><div className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${positive ? "bg-[#e4f5e9] text-[#55a578]" : "bg-[#fff2df] text-[#c08a43]"}`}>{positive ? <Check size={11} /> : <CircleDot size={11} />}</div><div><p className="text-xs font-semibold text-[#57515e]">{label}</p><p className="mt-0.5 text-[10px] leading-4 text-[#96909a]">{detail}</p></div></div>; }

type ApprovalHandler = (decision: ApprovalDecision, actorId: string, note: string) => Promise<void>;

function ApprovalBoundary({ record, onSubmit, error }: { record: RecoveryReportRecord; onSubmit: ApprovalHandler; error: string }) { const [actorId, setActorId] = useState(""); const [note, setNote] = useState(""); const [busy, setBusy] = useState(false); const decided = record.approval.status !== "pending"; async function submit(decision: ApprovalDecision) { if (busy || !actorId.trim()) return; setBusy(true); try { await onSubmit(decision, actorId.trim(), note.trim()); } finally { setBusy(false); } } return <div className="glass-card mb-7 border-[#d7cef1] bg-[#faf7ff]/80 p-5 sm:p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="section-kicker">Human control</p><h3 className="mt-1 text-base font-extrabold text-[#393641]">Approval boundary</h3><p className="mt-1 text-xs text-[#817b87]">Review the report before recording a decision.</p></div><Badge variant={record.approval.status === "approved" ? "success" : decided ? "danger" : "warning"}>{decided ? record.approval.status : "Decision required"}</Badge></div><div className="mt-5 rounded-2xl border border-white bg-white/55 p-4"><div className="flex items-start gap-3"><ShieldCheck size={17} className="mt-0.5 shrink-0 text-[#897ab9]" /><div><p className="text-xs font-bold text-[#4d4659]">Approval records intent only</p><p className="mt-1 text-xs leading-5 text-[#817b87]">No deployment, merge, patch application, or production mutation occurs.</p></div></div></div>{!decided && <><label htmlFor="approval-reviewer" className="mt-5 block text-xs font-semibold text-[#5a5361]">Human reviewer ID</label><input id="approval-reviewer" required value={actorId} disabled={busy} onChange={(event) => setActorId(event.target.value)} aria-describedby="approval-reviewer-help" placeholder="Enter your reviewer ID" className="mt-2 w-full rounded-2xl border border-white bg-white/75 px-4 py-3 text-xs text-[#3d3945] outline-none focus:border-[#bfaed9]" /><p id="approval-reviewer-help" className="mt-2 text-[11px] text-[#8e8794]">Self-declared local reviewer identity.</p><label htmlFor="approval-note" className="mt-4 block text-xs font-semibold text-[#5a5361]">Reviewer note <span className="font-normal text-[#aaa4ad]">(optional)</span></label><textarea id="approval-note" value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} placeholder="Summarize what you reviewed" className="mt-2 min-h-20 w-full rounded-2xl border border-white bg-white/75 px-4 py-3 text-xs text-[#3d3945] outline-none focus:border-[#bfaed9]" /><div className="mt-4 flex flex-wrap gap-2"><Button size="sm" onClick={() => submit("approved")} disabled={busy || !actorId.trim()}>Approve intent</Button><Button variant="secondary" size="sm" onClick={() => submit("rejected")} disabled={busy || !actorId.trim()}>Reject</Button></div>{error && <p role="alert" className="mt-3 text-xs text-[#c4635b]">{error}</p>}</>}</div>; }

function IncidentNotice({ incident }: { incident: Incident }) { return <div className="mb-7 rounded-2xl border border-[#f2d6cf] bg-[#fff8f1]/80 px-4 py-3 text-xs text-[#9b766d]"><div className="flex items-start gap-3"><CircleDot className="mt-0.5 text-[#d58c7f]" size={15} /><div><p className="font-bold text-[#765650]">{incident.demo ? "Demo incident · simulated recovery run" : "Incident recovery run"}</p><p className="mt-1 leading-5">{incident.service} · {incident.repository} · commit {incident.commit} · {statusLabel(incident.status)} at {incident.stage.replaceAll("-", " ")}</p></div></div></div>; }

function PendingReport({ loading, onRetry }: { loading: boolean; onRetry: () => void }) { return <div className="glass-card mb-7 p-6"><div className="flex items-center gap-2"><p className="section-kicker">Recovery report</p><Badge variant="neutral">{loading ? "Loading" : "Pending"}</Badge></div><p className="mt-2 text-sm font-bold text-[#45404d]">{loading ? "Loading report-backed evidence…" : "No recovery report has been generated yet."}</p><p className="mt-2 text-xs leading-5 text-[#817b87]">A candidate patch alone is not verification. The report must retain evidence before approval.</p>{!loading && <Button variant="secondary" size="sm" className="mt-5" onClick={onRetry}>Refresh report</Button>}</div>; }

function ViewIntro({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <div className="mb-8 border-b border-[#c9d5d7] pb-6"><p className="section-kicker">{eyebrow}</p><h1 className="mt-2 text-3xl font-black tracking-[-0.07em] text-[#111315] sm:text-4xl">{title}</h1><p className="mt-2 max-w-2xl text-sm text-[#59676a]">{description}</p></div>;
}

function IncidentsView({ incidents, selectedId, onSelect }: { incidents: Incident[]; selectedId: string | null; onSelect: (id: string) => void }) {
  return <><ViewIntro eyebrow="Incident index" title="All incidents" description="Select a case to review its source, evidence, hypotheses, and verification state." /><div className="overflow-hidden border border-[#c9d5d7] bg-[#f8f8f5]"><div className="grid grid-cols-[1.2fr_0.7fr_0.7fr_0.8fr] border-b border-[#c9d5d7] bg-[#e6edef] px-5 py-3 text-[10px] font-bold uppercase tracking-[0.14em] text-[#708083]"><span>Incident</span><span>Service</span><span>Status</span><span>Updated</span></div>{incidents.map((incident) => <button key={incident.id} type="button" onClick={() => onSelect(incident.id)} className={`grid w-full grid-cols-[1.2fr_0.7fr_0.7fr_0.8fr] items-center border-b border-[#dce4e5] px-5 py-4 text-left transition last:border-b-0 hover:bg-[#edf3f3] ${selectedId === incident.id ? "bg-[#e2eeee]" : ""}`}><div><p className="font-mono text-[10px] text-[#708083]">{incident.id}</p><p className="mt-1 text-sm font-bold text-[#202325]">{incident.title}</p></div><span className="text-xs text-[#59676a]">{incident.service}</span><span className="text-xs font-semibold text-[#59676a]">{statusLabel(incident.status)}</span><span className="text-xs text-[#708083]">{formatDate(incident.updatedAt)}</span></button>)}</div></>;
}

function EvidenceView({ incidents }: { incidents: Incident[] }) {
  return <><ViewIntro eyebrow="Evidence ledger" title="Evidence" description="A compact view of the immutable artifacts attached to each incident." /><div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{incidents.map((incident) => <div className="border border-[#c9d5d7] bg-[#f8f8f5] p-5" key={incident.id}><div className="flex items-start justify-between gap-3"><div><p className="font-mono text-[10px] text-[#708083]">{incident.id}</p><h2 className="mt-2 text-base font-bold text-[#202325]">{incident.service}</h2></div><FileText size={17} className="text-[#526e70]" /></div><p className="mt-6 text-4xl font-black tracking-[-0.06em] text-[#202325]">{incident.evidenceCount}</p><p className="mt-1 text-xs text-[#708083]">evidence artifacts attached</p><div className="mt-5 border-t border-[#dce4e5] pt-4 text-xs text-[#59676a]"><p>Latest event</p><p className="mt-1 font-semibold">{incident.timeline.at(-1)?.title ?? "No events recorded"}</p></div></div>)}</div></>;
}

function PatchesView({ selectedId }: { selectedId: string | null }) {
  return <><ViewIntro eyebrow="Patch review" title="Candidate patches" description="Review generated diffs and their leading hypotheses before isolated verification." />{selectedId ? <PatchWorkspace incidentId={selectedId} /> : <div className="border border-dashed border-[#b9c8ca] bg-[#f8f8f5] p-10 text-center text-sm text-[#708083]">Select an incident to load candidate patches.</div>}</>;
}

function TeamWorkspaceView() {
  return <><ViewIntro eyebrow="Team workspace" title="Review desk" description="A focused handoff area for incident owners, patch reviewers, and the approval boundary." /><div className="grid gap-4 md:grid-cols-3"><div className="border border-[#c9d5d7] bg-[#f8f8f5] p-5"><Users size={18} className="text-[#526e70]" /><h2 className="mt-5 text-base font-bold text-[#202325]">One active reviewer</h2><p className="mt-2 text-xs leading-5 text-[#708083]">The local workspace currently supports one operator at a time.</p></div><div className="border border-[#c9d5d7] bg-[#f8f8f5] p-5"><ShieldCheck size={18} className="text-[#526e70]" /><h2 className="mt-5 text-base font-bold text-[#202325]">Approval stays human</h2><p className="mt-2 text-xs leading-5 text-[#708083]">Decisions record intent only and never deploy or mutate production.</p></div><div className="border border-[#c9d5d7] bg-[#f8f8f5] p-5"><Activity size={18} className="text-[#526e70]" /><h2 className="mt-5 text-base font-bold text-[#202325]">Run state is local</h2><p className="mt-2 text-xs leading-5 text-[#708083]">Use the incident and evidence views to hand work to the next reviewer.</p></div></div></>;
}

function SettingsView() {
  return <><ViewIntro eyebrow="Workspace settings" title="Settings" description="Review the active local runtime and safety posture." /><div className="max-w-3xl overflow-hidden border border-[#c9d5d7] bg-[#f8f8f5]"><div className="flex items-center justify-between border-b border-[#dce4e5] px-5 py-4"><div><p className="text-sm font-bold text-[#202325]">API connection</p><p className="mt-1 text-xs text-[#708083]">Local recovery service</p></div><span className="text-xs font-bold text-[#526e70]">Connected</span></div><div className="flex items-center justify-between border-b border-[#dce4e5] px-5 py-4"><div><p className="text-sm font-bold text-[#202325]">Verification mode</p><p className="mt-1 text-xs text-[#708083]">Evidence-first, isolated execution</p></div><span className="text-xs font-bold text-[#526e70]">Enabled</span></div><div className="flex items-center justify-between px-5 py-4"><div><p className="text-sm font-bold text-[#202325]">Production mutation</p><p className="mt-1 text-xs text-[#708083]">Deploy, merge, and push actions</p></div><span className="text-xs font-bold text-[#9b5f56]">Disabled</span></div></div></>;
}

function IncidentWorkspace({ incidentId }: { incidentId: string }) {
  const [incident, setIncident] = useState<Incident | null>(null);
  const [incidentState, setIncidentState] = useState<"loading" | "ready" | "error">("loading");
  const [incidentError, setIncidentError] = useState("");
  const [incidentRetry, setIncidentRetry] = useState(0);
  const [record, setRecord] = useState<RecoveryReportRecord | null>(null);
  const [reportState, setReportState] = useState<"loading" | "ready" | "error">("loading");
  const [reportError, setReportError] = useState("");
  const [reportRetry, setReportRetry] = useState(0);
  const [approvalError, setApprovalError] = useState("");
  const reportGeneration = useRef(0);
  useEffect(() => { let active = true; setIncidentState("loading"); fetchIncident(incidentId).then((nextIncident) => { if (!active) return; setIncident(nextIncident); setIncidentState("ready"); }).catch((reason: unknown) => { if (!active) return; setIncidentError(reason instanceof Error ? reason.message : "The incident detail request failed."); setIncidentState("error"); }); return () => { active = false; }; }, [incidentId, incidentRetry]);
  useEffect(() => { const generation = ++reportGeneration.current; setReportState("loading"); setRecord(null); setApprovalError(""); fetchRecoveryReport(incidentId).then((nextRecord) => { if (reportGeneration.current !== generation) return; setRecord(nextRecord); setReportState("ready"); }).catch((reason: unknown) => { if (reportGeneration.current !== generation) return; setReportError(reason instanceof Error ? reason.message : "The report request failed."); setReportState("error"); }); return () => { reportGeneration.current++; }; }, [incidentId, reportRetry]);
  const onApproval: ApprovalHandler = async (decision, actorId, note) => { if (!record || !actorId.trim()) return; const generation = reportGeneration.current; const reportId = record.report.id; setApprovalError(""); try { const nextRecord = await submitApprovalIntent(reportId, { actorId: actorId.trim(), actorKind: "human", decision, ...(note ? { note } : {}) }); if (reportGeneration.current !== generation) return; setRecord((current) => current?.report.id === reportId ? nextRecord : current); } catch (reason: unknown) { if (reportGeneration.current !== generation) return; setApprovalError(reason instanceof Error ? reason.message : "The approval-intent request failed."); } };
  return <>{incidentState === "loading" && <LoadingState />}{incidentState === "error" && <ErrorState message={incidentError} onRetry={() => setIncidentRetry((value) => value + 1)} />}{incidentState === "ready" && incident && <><IncidentDashboard incident={incident} /><IncidentNotice incident={incident} /><div className="mb-7"><div className="mb-4 flex items-center gap-2"><div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#f7e4df] text-[#c8786d]"><GitBranch size={14} /></div><div><p className="section-kicker">Analysis</p><h2 className="mt-1 text-lg font-extrabold text-[#393641]">Hypotheses and candidate patch</h2></div></div><PatchWorkspace key={incidentId} incidentId={incidentId} /></div></>}{reportState === "error" ? <ErrorState title="Unable to load report data" message={reportError} onRetry={() => setReportRetry((value) => value + 1)} /> : record ? <><ReportBreakdown record={record} /><VerificationPanel record={record} /><ApprovalBoundary key={record.report.id} record={record} onSubmit={onApproval} error={approvalError} /></> : <PendingReport loading={reportState === "loading"} onRetry={() => setReportRetry((value) => value + 1)} />}</>;
}

export function Home({ view = "overview" }: { view?: WorkspaceView }) {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => { let active = true; setState("loading"); fetchIncidents().then((items) => { if (!active) return; setIncidents(items); setSelectedId((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id ?? null); setState("ready"); }).catch((reason: unknown) => { if (!active) return; setError(reason instanceof Error ? reason.message : "The incident list request failed."); setState("error"); }); return () => { active = false; }; }, [retry]);
  const content = state === "loading" ? <LoadingState /> : state === "error" ? <ErrorState message={error} onRetry={() => setRetry((value) => value + 1)} /> : incidents.length === 0 ? <div className="glass-card p-7"><p className="text-sm font-bold text-[#202325]">No incidents yet</p><p className="mt-1 text-xs text-[#59676a]">The API returned no incidents to display.</p><Button variant="secondary" size="sm" className="mt-4" onClick={() => setRetry((value) => value + 1)}>Refresh incidents</Button></div> : view === "overview" ? <><IncidentSelector incidents={incidents} selectedId={selectedId} onSelect={setSelectedId} />{selectedId && <IncidentWorkspace key={selectedId} incidentId={selectedId} />}</> : view === "incidents" ? <IncidentsView incidents={incidents} selectedId={selectedId} onSelect={setSelectedId} /> : view === "evidence" ? <EvidenceView incidents={incidents} /> : view === "patches" ? <PatchesView selectedId={selectedId} /> : view === "workspace" ? <TeamWorkspaceView /> : <SettingsView />;
  return <div className="app-shell"><Sidebar incidentCount={incidents.length} activeView={view} /><main className="min-w-0 flex-1"><div className="mx-auto max-w-[1480px] px-5 py-6 sm:px-8 sm:py-9"><Header />{view === "overview" ? <div className="mb-8 flex items-end justify-between gap-4"><div><p className="section-kicker">Recovery workspace</p><h1 className="mt-2 text-3xl font-black tracking-[-0.07em] text-[#111315] sm:text-4xl">Incident review</h1><p className="mt-2 text-sm text-[#59676a]">Inspect evidence, hypotheses, and verification state.</p></div><div className="hidden items-center gap-2 text-xs font-semibold text-[#526e70] sm:flex"><span className="h-2 w-2 rounded-full bg-[#526e70]" /> API connected</div></div> : null}{content}</div></main></div>;
}

export default Home;
