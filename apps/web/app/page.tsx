"use client";

import { useEffect, useState } from "react";
import {
  Activity,
  AlertCircle,
  ArrowRight,
  Bell,
  Check,
  CheckCircle2,
  CircleDot,
  Clock3,
  Code2,
  FileText,
  Gauge,
  GitBranch,
  Inbox,
  LayoutDashboard,
  Lightbulb,
  Lock,
  Menu,
  MoreHorizontal,
  Play,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Timer,
  TriangleAlert,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { fetchIncident, fetchIncidents, type Incident, type IncidentTimelineEvent } from "@/lib/incidents";

type NavItem = { label: string; icon: LucideIcon; active?: boolean; count?: string };

const primaryNav: NavItem[] = [
  { label: "Overview", icon: LayoutDashboard, active: true },
  { label: "Incidents", icon: AlertCircle },
  { label: "Evidence", icon: FileText },
  { label: "Patches", icon: GitBranch },
];

const secondaryNav: NavItem[] = [
  { label: "Team workspace", icon: Users },
  { label: "Settings", icon: Settings2 },
];

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date);
}

function formatDate(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(date);
}

function statusLabel(status: Incident["status"]): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function Sidebar({ incidentCount }: { incidentCount: number }) {
  const navigation = primaryNav.map((item) => (item.label === "Incidents" ? { ...item, count: String(incidentCount) } : item));

  return (
    <aside className="hidden w-[248px] shrink-0 border-r border-line bg-white lg:flex lg:flex-col">
      <div className="flex h-[76px] items-center gap-3 border-b border-line px-6">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-navy text-white shadow-sm"><span className="text-lg font-black tracking-[-0.12em]">r/</span></div>
        <div><div className="text-[15px] font-extrabold tracking-[-0.03em] text-navy">rift</div><div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">recovery control</div></div>
      </div>
      <div className="flex flex-1 flex-col px-3 py-6">
        <div className="mb-3 px-3 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Workspace</div>
        <nav className="space-y-1" aria-label="Workspace navigation">{navigation.map((item) => <NavButton key={item.label} item={item} />)}</nav>
        <div className="mb-3 mt-8 px-3 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">Manage</div>
        <nav className="space-y-1" aria-label="Management navigation">{secondaryNav.map((item) => <NavButton key={item.label} item={item} />)}</nav>
        <div className="mt-auto rounded-xl border border-[#d9f2eb] bg-[#f0fbf7] p-4">
          <div className="mb-3 flex items-center justify-between"><div className="flex h-7 w-7 items-center justify-center rounded-lg bg-white text-mint shadow-sm"><ShieldCheck size={15} /></div><Badge variant="success">Secure</Badge></div>
          <p className="text-xs font-bold text-[#176d59]">Isolated verification</p><p className="mt-1 text-[11px] leading-4 text-[#4e8c7d]">Every patch is tested away from production.</p>
        </div>
      </div>
      <div className="border-t border-line p-4"><div className="flex items-center gap-3 rounded-xl p-2 hover:bg-slate-50"><div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#f7d9cf] text-[11px] font-bold text-[#a84c3d]">MC</div><div className="min-w-0 flex-1"><p className="truncate text-xs font-bold text-navy">Maya Chen</p><p className="truncate text-[11px] text-slate-400">Platform engineering</p></div><MoreHorizontal size={16} className="text-slate-400" /></div></div>
    </aside>
  );
}

function NavButton({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return <button className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-semibold transition-colors ${item.active ? "bg-navy text-white shadow-sm" : "text-slate-500 hover:bg-slate-50 hover:text-navy"}`}><Icon size={16} strokeWidth={item.active ? 2.3 : 1.9} /><span className="flex-1">{item.label}</span>{item.count && <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${item.active ? "bg-white/15 text-white" : "bg-slate-100 text-slate-400"}`}>{item.count}</span>}</button>;
}

function Metric({ label, value, detail, icon: Icon, tone }: { label: string; value: string; detail: string; icon: LucideIcon; tone: "coral" | "blue" | "mint" | "gold" }) {
  const tones = { coral: "bg-[#fff1ef] text-coral", blue: "bg-[#eff4ff] text-[#5877d1]", mint: "bg-[#eafaf5] text-mint", gold: "bg-[#fff8e8] text-[#b17b18]" };
  return <div className="flex items-start gap-3"><div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${tones[tone]}`}><Icon size={17} /></div><div><p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">{label}</p><p className="mt-0.5 text-xl font-bold tracking-[-0.03em] text-navy">{value}</p><p className="mt-0.5 text-[11px] text-slate-400">{detail}</p></div></div>;
}

function IncidentSelector({ incidents, selectedId, onSelect }: { incidents: Incident[]; selectedId: string | null; onSelect: (id: string) => void }) {
  return <Card className="mb-7"><CardHeader className="pb-3"><CardTitle>Recent incidents</CardTitle><CardDescription>Select an incident to open its recovery workspace</CardDescription></CardHeader><CardContent><div className="grid gap-2 md:grid-cols-3">{incidents.map((incident) => <button key={incident.id} type="button" aria-pressed={incident.id === selectedId} onClick={() => onSelect(incident.id)} className={`rounded-xl border p-3 text-left transition-all ${incident.id === selectedId ? "border-navy bg-[#f6f8fc] shadow-sm" : "border-line hover:border-slate-300 hover:bg-slate-50"}`}><div className="flex items-center justify-between gap-2"><span className="font-mono text-[10px] font-semibold text-slate-400">{incident.id}</span><Badge variant={incident.severity === "SEV-1" || incident.severity === "SEV-2" ? "danger" : "neutral"}>{incident.severity}</Badge></div><p className="mt-2 truncate text-xs font-bold text-navy">{incident.title}</p><p className="mt-1 text-[11px] text-slate-400">{incident.service} · {statusLabel(incident.status)}</p></button>)}</div></CardContent></Card>;
}

function TimelineCard({ timeline }: { timeline: IncidentTimelineEvent[] }) {
  const colors = ["coral", "blue", "gold", "mint"] as const;
  const colorMap = { coral: "bg-[#fff1ef] text-coral border-[#ffd5d0]", blue: "bg-[#eff4ff] text-[#5877d1] border-[#cbdcff]", gold: "bg-[#fff8e8] text-[#b17b18] border-[#f9dfaa]", mint: "bg-[#eafaf5] text-mint border-[#bcecdf]" };
  return <Card className="h-full"><CardHeader className="flex-row items-start justify-between"><div><CardTitle>Investigation timeline</CardTitle><CardDescription>Automated progress for this recovery run</CardDescription></div><Button variant="ghost" size="sm">View log <ArrowRight size={13} /></Button></CardHeader><CardContent>{timeline.length === 0 ? <p className="text-sm text-slate-500">No timeline events have been recorded yet.</p> : <div className="relative space-y-0"><div className="absolute bottom-5 left-[15px] top-5 w-px bg-line" />{timeline.map((event, index) => { const Icon = index === 0 ? TriangleAlert : index === timeline.length - 1 ? Sparkles : index % 2 === 0 ? Lightbulb : TerminalSquare; const color = colors[index % colors.length]; return <div className="relative flex gap-4 pb-6 last:pb-0" key={`${event.timestamp}-${event.title}`}><div className={`z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-4 border-white ${colorMap[color]}`}><Icon size={13} /></div><div className="min-w-0 pt-0.5"><div className="flex flex-wrap items-center gap-x-2 gap-y-1"><p className="text-sm font-bold text-navy">{event.title}</p><span className="font-mono text-[10px] text-slate-400">{formatTime(event.timestamp)}</span></div><p className="mt-1 max-w-[430px] text-xs leading-5 text-slate-500">{event.detail}</p></div>{index === timeline.length - 1 && <Badge className="ml-auto hidden shrink-0 sm:inline-flex" variant="success">Current</Badge>}</div>; })}</div>}</CardContent></Card>;
}

function EvidenceSummary({ incident }: { incident: Incident }) {
  return <div className="mb-7"><div className="mb-4 flex items-end justify-between"><div><h2 className="text-[15px] font-bold text-navy">Evidence collected</h2><p className="mt-1 text-xs text-slate-500">Immutable artifacts attached to this incident</p></div><Button variant="ghost" size="sm">View all <ArrowRight size={13} /></Button></div><div className="rounded-xl border border-line bg-white p-5 shadow-panel"><div className="flex items-center gap-4"><div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#eff4ff] text-[#5877d1]"><FileText size={20} /></div><div><p className="text-2xl font-bold tracking-[-0.04em] text-navy">{incident.evidenceCount}</p><p className="text-xs text-slate-500">evidence {incident.evidenceCount === 1 ? "artifact" : "artifacts"} attached to {incident.id}</p></div></div></div></div>;
}

function PatchPanel() {
  return <Card className="overflow-hidden"><div className="border-b border-line bg-[#fbfcfe] px-5 py-5 sm:px-6"><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex items-center gap-2"><CardTitle>Candidate patch</CardTitle><Badge variant="blue">Review ready</Badge></div><CardDescription className="mt-1">Generated from the leading root-cause hypothesis</CardDescription></div><Button variant="secondary" size="sm"><Code2 size={14} /> Open diff</Button></div></div><CardContent className="pt-5"><div className="rounded-xl border border-line bg-[#111827] p-4 text-[11px] leading-6 text-slate-300 shadow-inner"><div className="mb-3 flex items-center gap-2 border-b border-white/10 pb-3"><span className="h-2 w-2 rounded-full bg-[#f26b5b]" /><span className="h-2 w-2 rounded-full bg-[#f3c665]" /><span className="h-2 w-2 rounded-full bg-[#5dc8a8]" /><span className="ml-2 font-mono text-[10px] text-slate-500">recovery.patch</span></div><div className="font-mono"><p><span className="mr-3 select-none text-slate-600">18</span><span className="text-rose-300">- existing recovery path</span></p><p><span className="mr-3 select-none text-slate-600">18</span><span className="text-emerald-300">+ bounded recovery path</span></p><p><span className="mr-3 select-none text-slate-600">19</span><span className="text-slate-500">  try &#123;</span></p><p><span className="mr-3 select-none text-slate-600">20</span><span className="text-emerald-300">+   await verify(candidate);</span></p><p><span className="mr-3 select-none text-slate-600">21</span><span className="text-slate-500">    return recover();</span></p><p><span className="mr-3 select-none text-slate-600">22</span><span className="text-emerald-300">+ &#125; finally &#123; release(); &#125;</span></p></div></div><div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-slate-400"><Badge variant="success"><Check size={11} /> Tests passing</Badge><span>Generated in isolated workspace</span></div></CardContent></Card>;
}

function VerificationPanel() {
  return <Card><CardHeader className="flex-row items-start justify-between"><div><div className="flex items-center gap-2"><CardTitle>Verification</CardTitle><Badge variant="success"><span className="h-1.5 w-1.5 rounded-full bg-mint" />Passed</Badge></div><CardDescription>Isolated checks against the candidate patch</CardDescription></div><Button variant="ghost" size="icon" aria-label="More verification actions"><MoreHorizontal size={17} /></Button></CardHeader><CardContent><div className="mb-5 flex items-end justify-between"><div><p className="text-3xl font-bold tracking-[-0.05em] text-navy">4 / 4</p><p className="mt-1 text-xs text-slate-500">checks completed successfully</p></div><div className="text-right"><p className="font-mono text-xs font-semibold text-mint">00:42.18</p><p className="mt-1 text-[10px] uppercase tracking-[0.08em] text-slate-400">runtime</p></div></div><Progress value={100} /><div className="mt-5 grid gap-3 sm:grid-cols-2"><CheckRow label="Baseline reproduction" detail="failed as expected" /><CheckRow label="Retry regression suite" detail="128 tests passed" /><CheckRow label="Connection leak check" detail="no leaks detected" /><CheckRow label="Type & lint checks" detail="clean" /></div><div className="mt-5 flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2.5"><span className="flex items-center gap-2 text-[11px] font-semibold text-slate-500"><Lock size={13} /> Sandbox: verify-7c29f</span><span className="font-mono text-[10px] text-slate-400">node 20.11 · linux</span></div></CardContent></Card>;
}

function CheckRow({ label, detail }: { label: string; detail: string }) {
  return <div className="flex items-start gap-2.5"><div className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#eafaf5] text-mint"><Check size={10} strokeWidth={3} /></div><div><p className="text-xs font-semibold text-slate-700">{label}</p><p className="mt-0.5 text-[10px] text-slate-400">{detail}</p></div></div>;
}

function Header() {
  return <header className="flex h-[76px] items-center justify-between border-b border-line bg-white/80 px-5 backdrop-blur sm:px-8"><div className="flex items-center gap-3"><Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation"><Menu size={19} /></Button><div><div className="flex items-center gap-2"><p className="text-sm font-bold text-navy">Incident recovery</p><Badge variant="neutral" className="hidden sm:inline-flex">API data</Badge></div><p className="mt-0.5 hidden text-[11px] text-slate-400 sm:block">Evidence-backed recovery workspace</p></div></div><div className="flex items-center gap-2 sm:gap-3"><Button variant="ghost" size="icon" aria-label="Search"><Search size={17} /></Button><Button variant="ghost" size="icon" aria-label="Notifications" className="relative"><Bell size={17} /><span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-coral ring-2 ring-white" /></Button><div className="ml-1 hidden h-6 w-px bg-line sm:block" /><div className="hidden items-center gap-2 text-xs font-semibold text-slate-500 sm:flex"><span className="h-2 w-2 rounded-full bg-mint" /> All systems nominal</div></div></header>;
}

function LoadingState() {
  return <div className="rounded-2xl border border-line bg-white p-8 text-center shadow-panel"><div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-slate-200 border-t-navy" /><p className="mt-4 text-sm font-semibold text-navy">Loading incidents</p><p className="mt-1 text-xs text-slate-400">Connecting to the recovery API…</p></div>;
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div role="alert" className="rounded-2xl border border-[#ffd5d0] bg-[#fff8f7] p-8 text-center shadow-panel"><div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-[#fff1ef] text-coral"><TriangleAlert size={19} /></div><p className="mt-4 text-sm font-semibold text-navy">Unable to load incident data</p><p className="mx-auto mt-1 max-w-md text-xs leading-5 text-slate-500">{message}</p><Button variant="secondary" size="sm" className="mt-5" onClick={onRetry}>Try again</Button></div>;
}

export default function Home() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIncident, setSelectedIncident] = useState<Incident | null>(null);
  const [listState, setListState] = useState<"loading" | "ready" | "error">("loading");
  const [detailState, setDetailState] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [retry, setRetry] = useState(0);
  const [detailRetry, setDetailRetry] = useState(0);

  useEffect(() => {
    let active = true;
    setListState("loading");
    fetchIncidents().then((items) => {
      if (!active) return;
      setIncidents(items);
      setSelectedId((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id ?? null);
      setListState("ready");
    }).catch((error: unknown) => {
      if (!active) return;
      setErrorMessage(error instanceof Error ? error.message : "The incident list request failed.");
      setListState("error");
    });
    return () => { active = false; };
  }, [retry]);

  useEffect(() => {
    if (!selectedId) {
      setSelectedIncident(null);
      setDetailState("ready");
      return;
    }
    let active = true;
    setDetailState("loading");
    fetchIncident(selectedId).then((incident) => {
      if (!active) return;
      setSelectedIncident(incident);
      setDetailState("ready");
    }).catch((error: unknown) => {
      if (!active) return;
      setErrorMessage(error instanceof Error ? error.message : "The incident detail request failed.");
      setDetailState("error");
    });
    return () => { active = false; };
  }, [selectedId, retry, detailRetry]);

  return <div className="flex min-h-screen bg-canvas"><Sidebar incidentCount={incidents.length} /><main className="min-w-0 flex-1"><Header /><div className="mx-auto max-w-[1440px] px-5 py-7 sm:px-8 sm:py-9"><IncidentSelector incidents={incidents} selectedId={selectedId} onSelect={(id) => { setDetailRetry(0); setSelectedId(id); }} />{listState === "loading" && <LoadingState />}{listState === "error" && <ErrorState message={errorMessage} onRetry={() => setRetry((value) => value + 1)} />}{listState === "ready" && incidents.length === 0 && <ErrorState message="The API returned no incidents to display." onRetry={() => setRetry((value) => value + 1)} />}{listState === "ready" && incidents.length > 0 && detailState === "loading" && <LoadingState />}{listState === "ready" && incidents.length > 0 && detailState === "error" && <ErrorState message={errorMessage} onRetry={() => setDetailRetry((value) => value + 1)} />}{listState === "ready" && selectedIncident && detailState === "ready" && <IncidentDashboard incident={selectedIncident} />}</div></main></div>;
}

function IncidentDashboard({ incident }: { incident: Incident }) {
  const severityTone = incident.severity === "SEV-1" || incident.severity === "SEV-2" ? "danger" : incident.severity === "SEV-3" ? "warning" : "neutral";
  return <><div className="mb-7 flex flex-col justify-between gap-5 md:flex-row md:items-end"><div><div className="mb-3 flex flex-wrap items-center gap-2"><Badge variant={severityTone}><span className="h-1.5 w-1.5 rounded-full bg-coral" /> {incident.severity}</Badge><span className="font-mono text-[11px] text-slate-400">{incident.id}</span><span className="text-slate-300">·</span><span className="text-xs text-slate-500">Updated {formatDate(incident.updatedAt)}</span></div><h1 className="max-w-3xl text-2xl font-bold tracking-[-0.04em] text-navy sm:text-3xl">{incident.title}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">{incident.summary}</p></div><div className="flex items-center gap-2"><Button variant="secondary" size="sm"><Clock3 size={14} /> Activity</Button><Button variant="coral" size="sm"><Play size={14} fill="currentColor" /> Start recovery</Button></div></div><div className="mb-7 rounded-xl border border-[#f5dfb2] bg-[#fffbf1] px-4 py-3"><div className="flex items-start gap-3"><div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#fff0c9] text-[#b17b18]"><CircleDot size={14} /></div><div className="min-w-0 flex-1"><p className="text-xs font-bold text-[#8a5e0d]">{incident.demo ? "Demo incident · simulated recovery run" : "Incident recovery run"}</p><p className="mt-0.5 text-xs leading-5 text-[#a77b2e]">{incident.service} · {incident.repository} · commit {incident.commit} · {statusLabel(incident.status)} at {incident.stage.replaceAll("-", " ")}</p></div><button className="hidden text-[#b17b18] sm:block" aria-label="Dismiss incident notice"><X size={15} /></button></div></div><div className="mb-7 grid gap-5 rounded-2xl border border-line bg-white p-5 shadow-panel sm:grid-cols-2 sm:p-6 xl:grid-cols-4"><Metric label="Evidence" value={String(incident.evidenceCount)} detail="artifacts attached" icon={FileText} tone="coral" /><Metric label="Timeline" value={String(incident.timeline.length)} detail="events recorded" icon={Timer} tone="blue" /><Metric label="Status" value={statusLabel(incident.status)} detail={`stage: ${incident.stage.replaceAll("-", " ")}`} icon={Gauge} tone="mint" /><Metric label="Service" value={incident.service} detail={`${incident.repository} · ${incident.commit}`} icon={Activity} tone="gold" /></div><div className="mb-7 grid gap-5 xl:grid-cols-[1.25fr_0.75fr]"><TimelineCard timeline={incident.timeline} /><Card><CardHeader><div className="flex items-start justify-between"><div><CardTitle>Incident details</CardTitle><CardDescription>Fields returned by the recovery API</CardDescription></div><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#fff8e8] text-[#b17b18]"><Lightbulb size={16} /></span></div></CardHeader><CardContent><div className="rounded-xl border border-[#f5dfb2] bg-[#fffbf1] p-4"><div className="flex items-center justify-between gap-3"><p className="text-sm font-bold text-navy">{incident.service}</p><span className="font-mono text-xs font-bold text-[#a66a00]">{incident.severity}</span></div><p className="mt-3 text-xs leading-5 text-slate-500">{incident.summary}</p></div><div className="mt-5 space-y-3"><EvidenceLine icon={CheckCircle2} label={`${incident.evidenceCount} supporting artifacts`} detail={`${incident.repository} · ${incident.commit}`} color="mint" /><EvidenceLine icon={AlertCircle} label={statusLabel(incident.status)} detail={`Detected ${formatDate(incident.detectedAt)}`} color="coral" /></div><Button variant="secondary" className="mt-5 w-full">Explore incident <ArrowRight size={14} /></Button></CardContent></Card></div><EvidenceSummary incident={incident} /><div className="mb-7 grid gap-5 xl:grid-cols-[1.25fr_0.75fr]"><PatchPanel /><VerificationPanel /></div><div className="grid-fade flex min-h-24 items-center justify-between gap-4 rounded-2xl border border-dashed border-slate-300 bg-white/60 px-5 py-4 sm:px-6"><div className="flex items-center gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-100 text-slate-400"><Inbox size={17} /></div><div><p className="text-xs font-bold text-slate-600">No additional recovery actions</p><p className="mt-0.5 text-[11px] text-slate-400">The queue is clear. New evidence will appear here as it arrives.</p></div></div><span className="hidden items-center gap-1.5 text-[11px] font-semibold text-slate-400 sm:flex"><span className="h-1.5 w-1.5 rounded-full bg-slate-300" /> Listening</span></div><p className="mt-6 text-center text-[10px] font-semibold uppercase tracking-[0.13em] text-slate-400">Rift recovery control · API environment</p></>;
}

function EvidenceLine({ icon: Icon, label, detail, color }: { icon: LucideIcon; label: string; detail: string; color: "mint" | "coral" }) {
  return <div className="flex items-center gap-3"><div className={`flex h-7 w-7 items-center justify-center rounded-full ${color === "mint" ? "bg-[#eafaf5] text-mint" : "bg-[#fff1ef] text-coral"}`}><Icon size={14} /></div><div><p className="text-xs font-semibold text-slate-700">{label}</p><p className="mt-0.5 text-[11px] text-slate-400">{detail}</p></div></div>;
}
