"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, AlertCircle, Check, CheckCircle2, CircleDot, Clock3, FileText, GitBranch, LayoutDashboard, Lock, LucideIcon, Menu, Search, Settings2, ShieldCheck, Sparkles, TriangleAlert, Users, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PatchWorkspace } from "@/components/patch-workspace";
import { fetchIncident, fetchIncidents, fetchRecoveryReport, submitApprovalIntent, verificationStatusLabel, type ApprovalDecision, type Incident, type IncidentTimelineEvent, type RecoveryReportRecord, type VerificationStatus } from "@/lib/incidents";

type NavItem = { label: string; icon: LucideIcon; active?: boolean; count?: string };
const primaryNav: NavItem[] = [{ label: "Overview", icon: LayoutDashboard, active: true }, { label: "Incidents", icon: AlertCircle }, { label: "Evidence", icon: FileText }, { label: "Patches", icon: GitBranch }];
const secondaryNav: NavItem[] = [{ label: "Team workspace", icon: Users }, { label: "Settings", icon: Settings2 }];

function formatDate(timestamp: string) { const date = new Date(timestamp); return Number.isNaN(date.getTime()) ? timestamp : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(date); }
function formatTime(timestamp: string) { const date = new Date(timestamp); return Number.isNaN(date.getTime()) ? timestamp : new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC" }).format(date); }
function statusLabel(status: Incident["status"]) { return status.charAt(0).toUpperCase() + status.slice(1); }

function Sidebar({ incidentCount }: { incidentCount: number }) {
  const nav = primaryNav.map((item) => item.label === "Incidents" ? { ...item, count: String(incidentCount) } : item);
  return <aside className="hidden w-[248px] shrink-0 border-r border-line bg-white lg:flex lg:flex-col"><div className="flex h-[76px] items-center gap-3 border-b border-line px-6"><div className="flex h-9 w-9 items-center justify-center rounded-xl bg-navy text-lg font-black tracking-[-0.12em] text-white">r/</div><div><div className="text-[15px] font-extrabold text-navy">rift</div><div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">recovery control</div></div></div><div className="flex flex-1 flex-col px-3 py-6"><div className="mb-3 px-3 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Workspace</div><nav className="space-y-1" aria-label="Workspace navigation">{nav.map((item) => <NavButton key={item.label} item={item} />)}</nav><div className="mb-3 mt-8 px-3 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Manage</div><nav className="space-y-1" aria-label="Management navigation">{secondaryNav.map((item) => <NavButton key={item.label} item={item} />)}</nav><div className="mt-auto rounded-xl border border-[#d9f2eb] bg-[#f0fbf7] p-4"><div className="mb-3 flex items-center justify-between"><ShieldCheck size={17} className="text-mint" /><Badge variant="success">Secure</Badge></div><p className="text-xs font-bold text-[#176d59]">Isolated verification</p><p className="mt-1 text-[11px] leading-4 text-[#4e8c7d]">Every patch is tested away from production.</p></div></div></aside>;
}
function NavButton({ item }: { item: NavItem }) { const Icon = item.icon; return <button className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-semibold ${item.active ? "bg-navy text-white" : "text-slate-500 hover:bg-slate-50 hover:text-navy"}`}><Icon size={16} /><span className="flex-1">{item.label}</span>{item.count && <span className="rounded-full bg-white/15 px-2 py-0.5 text-[10px]">{item.count}</span>}</button>; }
function Header() { return <header className="flex h-[76px] items-center justify-between border-b border-line bg-white/80 px-5 backdrop-blur sm:px-8"><div className="flex items-center gap-3"><Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation"><Menu size={19} /></Button><div><div className="flex items-center gap-2"><p className="text-sm font-bold text-navy">Incident recovery</p><Badge variant="neutral" className="hidden sm:inline-flex">API data</Badge></div><p className="mt-0.5 hidden text-[11px] text-slate-400 sm:block">Evidence-backed recovery workspace</p></div></div><div className="flex items-center gap-2 sm:gap-3"><Button variant="ghost" size="icon" aria-label="Search"><Search size={17} /></Button><div className="hidden items-center gap-2 text-xs font-semibold text-slate-500 sm:flex"><span className="h-2 w-2 rounded-full bg-mint" /> All systems nominal</div></div></header>; }

function IncidentSelector({ incidents, selectedId, onSelect }: { incidents: Incident[]; selectedId: string | null; onSelect: (id: string) => void }) { return <Card className="mb-7"><CardHeader className="pb-3"><CardTitle>Recent incidents</CardTitle><CardDescription>Select an incident to open its recovery workspace</CardDescription></CardHeader><CardContent><div className="grid gap-2 md:grid-cols-3">{incidents.map((incident) => <button key={incident.id} type="button" aria-pressed={incident.id === selectedId} onClick={() => onSelect(incident.id)} className={`rounded-xl border p-3 text-left ${incident.id === selectedId ? "border-navy bg-[#f6f8fc]" : "border-line hover:bg-slate-50"}`}><div className="flex items-center justify-between gap-2"><span className="font-mono text-[10px] text-slate-400">{incident.id}</span><Badge variant={incident.severity === "SEV-1" || incident.severity === "SEV-2" ? "danger" : "neutral"}>{incident.severity}</Badge></div><p className="mt-2 truncate text-xs font-bold text-navy">{incident.title}</p><p className="mt-1 text-[11px] text-slate-400">{incident.service} · {statusLabel(incident.status)}</p></button>)}</div></CardContent></Card>; }
function LoadingState() { return <div className="rounded-2xl border border-line bg-white p-8 text-center shadow-panel"><div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-slate-200 border-t-navy" /><p className="mt-4 text-sm font-semibold text-navy">Loading API state</p><p className="mt-1 text-xs text-slate-400">Connecting to the recovery API…</p></div>; }
function ErrorState({ message, onRetry, title = "Unable to load incident data" }: { message: string; onRetry: () => void; title?: string }) { return <div role="alert" className="rounded-2xl border border-[#ffd5d0] bg-[#fff8f7] p-8 text-center shadow-panel"><TriangleAlert className="mx-auto text-coral" size={20} /><p className="mt-4 text-sm font-semibold text-navy">{title}</p><p className="mx-auto mt-1 max-w-md text-xs leading-5 text-slate-500">{message}</p><Button variant="secondary" size="sm" className="mt-5" onClick={onRetry}>Try again</Button></div>; }

function TimelineCard({ timeline }: { timeline: IncidentTimelineEvent[] }) { return <Card><CardHeader><CardTitle>Investigation timeline</CardTitle><CardDescription>Automated progress for this recovery run</CardDescription></CardHeader><CardContent>{timeline.length === 0 ? <p className="text-sm text-slate-500">No timeline events have been recorded yet.</p> : <div className="space-y-5">{timeline.map((event, index) => <div className="flex gap-3" key={`${event.timestamp}-${event.title}`}><div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#eff4ff] text-[#5877d1]"><Sparkles size={14} /></div><div><div className="flex flex-wrap gap-2"><p className="text-sm font-bold text-navy">{event.title}</p><span className="font-mono text-[10px] text-slate-400">{formatTime(event.timestamp)}</span></div><p className="mt-1 text-xs leading-5 text-slate-500">{event.detail}</p>{index === timeline.length - 1 && <Badge className="mt-2" variant="success">Current</Badge>}</div></div>)}</div>}</CardContent></Card>; }
function EvidenceSummary({ incident }: { incident: Incident }) { return <Card><CardHeader><CardTitle>Evidence collected</CardTitle><CardDescription>Immutable artifacts attached to this incident</CardDescription></CardHeader><CardContent><div className="flex items-center gap-4"><div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#eff4ff] text-[#5877d1]"><FileText size={20} /></div><div><p className="text-2xl font-bold text-navy">{incident.evidenceCount}</p><p className="text-xs text-slate-500">evidence artifacts attached to {incident.id}</p></div></div></CardContent></Card>; }

function ReportBreakdown({ record }: { record: RecoveryReportRecord }) { const report = record.report; return <Card className="mt-7"><CardHeader><CardTitle>Recovery report evidence</CardTitle><CardDescription>Structured report inputs retained for reviewer replay</CardDescription></CardHeader><CardContent><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><div><p className="text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400">Citations</p><p className="mt-1 text-lg font-bold text-navy">{report.evidenceCitations?.length ?? report.evidenceIds?.length ?? 0}</p></div><div><p className="text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400">Hypotheses</p><p className="mt-1 text-lg font-bold text-navy">{report.hypotheses?.length ?? 0}</p></div><div><p className="text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400">Commands</p><p className="mt-1 text-lg font-bold text-navy">{report.commands?.length ?? 0}</p></div><div><p className="text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400">Patches</p><p className="mt-1 text-lg font-bold text-navy">{report.patches?.length ?? report.candidatePatchIds?.length ?? 0}</p></div></div><div className="mt-5 grid gap-3 md:grid-cols-2"><div className="rounded-lg bg-slate-50 p-3"><p className="text-xs font-bold text-navy">Observed facts</p>{report.facts.slice(0, 3).map((fact) => <p className="mt-1 text-[11px] text-slate-500" key={fact}>{fact}</p>)}</div><div className="rounded-lg bg-slate-50 p-3"><p className="text-xs font-bold text-navy">Inferences and unknowns</p>{[...report.inferences.slice(0, 2), ...report.unknowns.slice(0, 2)].map((item) => <p className="mt-1 text-[11px] text-slate-500" key={item}>{item}</p>)}</div></div><p className="mt-4 text-[11px] text-slate-400">Environment fingerprint: {report.environmentFingerprint?.snapshotId ?? "not available"} · baseline results: {report.baselineResults?.length ?? 0} · patched results: {report.patchedResults?.length ?? 0}</p></CardContent></Card>; }

const verificationTone: Record<VerificationStatus, "neutral" | "danger" | "success" | "warning" | "blue"> = { running: "blue", verified: "success", regressed: "danger", "not-reproduced": "warning", inconclusive: "warning", cancelled: "neutral", "policy-denied": "danger" };
function VerificationPanel({ record }: { record: RecoveryReportRecord }) { const status = record.report.status; const Icon = status === "verified" ? CheckCircle2 : status === "running" ? Activity : status === "policy-denied" ? Lock : status === "cancelled" ? X : TriangleAlert; const description = status === "verified" ? "The candidate patch passed isolated checks." : status === "regressed" ? "Verification found a regression in the candidate patch." : status === "not-reproduced" ? "The reported failure could not be reproduced." : status === "inconclusive" ? "The available checks did not establish a conclusion." : status === "cancelled" ? "Verification was cancelled before completion." : status === "policy-denied" ? "Runner policy prevented verification from starting." : "The isolated verification runner is still working."; return <Card><CardHeader><div className="flex flex-wrap items-center gap-2"><CardTitle>Verification</CardTitle><Badge variant={verificationTone[status]}><Icon size={12} />{verificationStatusLabel(status)}</Badge></div><CardDescription>Live report classification from the isolated verification API</CardDescription></CardHeader><CardContent><div className="mb-5 flex items-end justify-between"><div><p className="text-3xl font-bold text-navy">{record.report.verificationResultIds ? `${record.report.verificationResultIds.length} result(s)` : "Results not supplied"}</p><p className="mt-1 text-xs text-slate-500">{description}</p></div><div className="text-right"><p className="font-mono text-xs font-semibold text-slate-400">{status.toUpperCase()}</p><p className="mt-1 text-[10px] uppercase tracking-[0.08em] text-slate-400">API status</p></div></div><div className="mt-5 grid gap-3 sm:grid-cols-2">{record.report.facts.slice(0, 4).map((fact) => <CheckRow key={fact} label="Report fact" detail={fact} positive={status === "verified"} />)}{record.report.unknowns.slice(0, 2).map((unknown) => <CheckRow key={unknown} label="Unknown" detail={unknown} positive={false} />)}</div><div className="mt-5 flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2.5"><span className="flex items-center gap-2 text-[11px] font-semibold text-slate-500"><Lock size={13} /> Verification is isolated</span><span className="font-mono text-[10px] text-slate-400">report {record.report.id}</span></div></CardContent></Card>; }
function CheckRow({ label, detail, positive }: { label: string; detail: string; positive: boolean }) { return <div className="flex items-start gap-2.5"><div className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${positive ? "bg-[#eafaf5] text-mint" : "bg-[#fff8e8] text-[#b17b18]"}`}>{positive ? <Check size={10} /> : <CircleDot size={10} />}</div><div><p className="text-xs font-semibold text-slate-700">{label}</p><p className="mt-0.5 text-[10px] text-slate-400">{detail}</p></div></div>; }

type ApprovalHandler = (decision: ApprovalDecision, actorId: string, note: string) => Promise<void>;

function ApprovalBoundary({ record, onSubmit, error }: { record: RecoveryReportRecord; onSubmit: ApprovalHandler; error: string }) {
  const [actorId, setActorId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const decided = record.approval.status !== "pending";
  async function submit(decision: ApprovalDecision) {
    if (busy || !actorId.trim()) return;
    setBusy(true);
    try { await onSubmit(decision, actorId.trim(), note.trim()); }
    finally { setBusy(false); }
  }
  return <Card className="mt-7 border-[#cbdcff]"><CardHeader><div className="flex flex-wrap items-center justify-between gap-2"><div><CardTitle>Human approval boundary</CardTitle><CardDescription>Review the evidence-backed report before recording a decision.</CardDescription></div><Badge variant={record.approval.status === "approved" ? "success" : decided ? "danger" : "warning"}>{decided ? record.approval.status : "Decision required"}</Badge></div></CardHeader><CardContent><div className="rounded-xl border border-[#cbdcff] bg-[#f7f9ff] p-4"><div className="flex items-start gap-3"><ShieldCheck size={17} className="mt-0.5 shrink-0 text-[#5877d1]" /><div><p className="text-xs font-bold text-navy">Approval records intent only</p><p className="mt-1 text-xs leading-5 text-slate-500">This calls only the approval-intent API. No deployment, merge, patch application, or production mutation occurs.</p></div></div></div>{!decided && <><label htmlFor="approval-reviewer" className="mt-4 block text-xs font-semibold text-slate-600">Human reviewer ID (required)</label><input id="approval-reviewer" required value={actorId} disabled={busy} onChange={(event) => setActorId(event.target.value)} aria-describedby="approval-reviewer-help" placeholder="Enter your reviewer ID" className="mt-2 w-full rounded-lg border border-line bg-white px-3 py-2 text-xs text-navy outline-none focus:border-[#5877d1]" /><p id="approval-reviewer-help" className="mt-2 text-[11px] text-slate-500">Self-declared human reviewer identity; local authentication is not yet implemented.</p><label htmlFor="approval-note" className="mt-4 block text-xs font-semibold text-slate-600">Reviewer note <span className="font-normal text-slate-400">(optional)</span></label><textarea id="approval-note" value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} placeholder="Summarize what you reviewed" className="mt-2 min-h-20 w-full rounded-lg border border-line bg-white px-3 py-2 text-xs text-navy outline-none focus:border-[#5877d1]" /><div className="mt-4 flex flex-wrap gap-2"><Button size="sm" disabled={busy || !actorId.trim()} onClick={() => void submit("approved")}>{busy ? "Recording…" : "Approve report"}</Button><Button variant="secondary" size="sm" disabled={busy || !actorId.trim()} onClick={() => void submit("rejected")}>Reject report</Button></div></>}{decided && record.approval.approverId && <p className="mt-4 text-xs text-slate-500">Recorded by {record.approval.approverId}</p>}{error && <p role="alert" className="mt-3 text-xs font-semibold text-coral">{error}</p>}</CardContent></Card>;
}

function IncidentDashboard({ incident }: { incident: Incident }) { const severityTone = incident.severity === "SEV-1" || incident.severity === "SEV-2" ? "danger" : incident.severity === "SEV-3" ? "warning" : "neutral"; return <><div className="mb-7 flex flex-col justify-between gap-5 md:flex-row md:items-end"><div><div className="mb-3 flex flex-wrap items-center gap-2"><Badge variant={severityTone}>{incident.severity}</Badge><span className="font-mono text-[11px] text-slate-400">{incident.id}</span><span className="text-xs text-slate-500">Updated {formatDate(incident.updatedAt)}</span></div><h1 className="max-w-3xl text-2xl font-bold text-navy sm:text-3xl">{incident.title}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">{incident.summary}</p></div><div className="flex items-center gap-2"><Button variant="secondary" size="sm" disabled><Clock3 size={14} /> Activity</Button></div></div><div className="mb-7 rounded-xl border border-[#f5dfb2] bg-[#fffbf1] px-4 py-3"><div className="flex items-start gap-3"><CircleDot className="mt-0.5 text-[#b17b18]" size={16} /><div><p className="text-xs font-bold text-[#8a5e0d]">{incident.demo ? "Demo incident · simulated recovery run" : "Incident recovery run"}</p><p className="mt-0.5 text-xs leading-5 text-[#a77b2e]">{incident.service} · {incident.repository} · commit {incident.commit} · {statusLabel(incident.status)} at {incident.stage.replaceAll("-", " ")}</p></div></div></div><div className="mb-7 grid gap-5 md:grid-cols-2"><EvidenceSummary incident={incident} /><TimelineCard timeline={incident.timeline} /></div></>; }

function PendingReport({ loading, onRetry }: { loading: boolean; onRetry: () => void }) {
  return <Card><CardHeader><div className="flex items-center gap-2"><CardTitle>Recovery report</CardTitle><Badge variant="neutral">{loading ? "Loading" : "Pending"}</Badge></div><CardDescription>{loading ? "Loading the recovery report…" : "No recovery report has been generated for this incident yet."}</CardDescription></CardHeader><CardContent><p className="text-xs font-semibold text-navy">Verification</p><p className="mt-1 text-xs text-slate-500">No report-backed verification result is available. A candidate patch alone is not verification.</p><p className="mt-4 text-xs font-semibold text-navy">Human approval boundary</p><p className="mt-1 text-xs text-slate-500">Awaiting a report before an approval intent can be recorded.</p>{!loading && <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>Refresh report</Button>}</CardContent></Card>;
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

  useEffect(() => {
    let active = true;
    setIncidentState("loading");
    fetchIncident(incidentId).then((nextIncident) => {
      if (!active) return;
      setIncident(nextIncident);
      setIncidentState("ready");
    }).catch((reason: unknown) => {
      if (!active) return;
      setIncidentError(reason instanceof Error ? reason.message : "The incident detail request failed.");
      setIncidentState("error");
    });
    return () => { active = false; };
  }, [incidentId, incidentRetry]);

  useEffect(() => {
    const generation = ++reportGeneration.current;
    setReportState("loading");
    setRecord(null);
    setApprovalError("");
    fetchRecoveryReport(incidentId).then((nextRecord) => {
      if (reportGeneration.current !== generation) return;
      setRecord(nextRecord);
      setReportState("ready");
    }).catch((reason: unknown) => {
      if (reportGeneration.current !== generation) return;
      setReportError(reason instanceof Error ? reason.message : "The report request failed.");
      setReportState("error");
    });
    // Invalidate report and approval responses when this selected workspace unmounts.
    return () => { reportGeneration.current++; };
  }, [incidentId, reportRetry]);

  const onApproval: ApprovalHandler = async (decision, actorId, note) => {
    if (!record || !actorId.trim()) return;
    const generation = reportGeneration.current;
    const reportId = record.report.id;
    setApprovalError("");
    try {
      const nextRecord = await submitApprovalIntent(reportId, { actorId: actorId.trim(), actorKind: "human", decision, ...(note ? { note } : {}) });
      if (reportGeneration.current !== generation) return;
      setRecord((current) => current?.report.id === reportId ? nextRecord : current);
    } catch (reason: unknown) {
      if (reportGeneration.current !== generation) return;
      setApprovalError(reason instanceof Error ? reason.message : "The approval-intent request failed.");
    }
  };

  return <>{incidentState === "loading" && <LoadingState />}{incidentState === "error" && <ErrorState message={incidentError} onRetry={() => setIncidentRetry((value) => value + 1)} />}{incidentState === "ready" && incident && <IncidentDashboard incident={incident} />}
    {/* The Phase 3 workspace bundles a placeholder verification card. Hide that
        placeholder here so report-backed verification below is the single authority. */}
    <div className="[&>div]:!grid-cols-1 [&>div>div:last-child]:hidden"><PatchWorkspace key={incidentId} incidentId={incidentId} /></div>
    {reportState === "error" ? <ErrorState title="Unable to load report data" message={reportError} onRetry={() => setReportRetry((value) => value + 1)} /> : record ? <><ReportBreakdown record={record} /><VerificationPanel record={record} /><ApprovalBoundary key={record.report.id} record={record} onSubmit={onApproval} error={approvalError} /></> : <PendingReport loading={reportState === "loading"} onRetry={() => setReportRetry((value) => value + 1)} />}
  </>;
}

export default function Home() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setState("loading");
    fetchIncidents().then((items) => {
      if (!active) return;
      setIncidents(items);
      setSelectedId((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id ?? null);
      setState("ready");
    }).catch((reason: unknown) => {
      if (!active) return;
      setError(reason instanceof Error ? reason.message : "The incident list request failed.");
      setState("error");
    });
    return () => { active = false; };
  }, [retry]);
  return <div className="flex min-h-screen bg-canvas"><Sidebar incidentCount={incidents.length} /><main className="min-w-0 flex-1"><Header /><div className="mx-auto max-w-[1440px] px-5 py-7 sm:px-8 sm:py-9"><IncidentSelector incidents={incidents} selectedId={selectedId} onSelect={setSelectedId} />{state === "loading" && <LoadingState />}{state === "error" && <ErrorState message={error} onRetry={() => setRetry((value) => value + 1)} />}{state === "ready" && incidents.length === 0 && <Card><CardHeader><CardTitle>No incidents yet</CardTitle><CardDescription>The API returned no incidents to display.</CardDescription></CardHeader><CardContent><Button variant="secondary" size="sm" onClick={() => setRetry((value) => value + 1)}>Refresh incidents</Button></CardContent></Card>}{state === "ready" && selectedId && <IncidentWorkspace key={selectedId} incidentId={selectedId} />}</div></main></div>;
}
