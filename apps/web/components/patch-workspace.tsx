"use client";

import { useEffect, useState } from "react";
import { Check, Code2, FileCode2, Lock, RefreshCw, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchCandidatePatches, fetchHypotheses, type CandidatePatch, type Hypothesis, type HypothesisSet } from "@/lib/patches";
import { getLeadingHypothesis, getPatchPanelState } from "@/lib/patch-state";

interface PatchWorkspaceProps {
  incidentId: string;
}

function LoadingPanel() {
  return <Card aria-label="Loading patch data" aria-busy="true"><CardContent className="flex min-h-64 flex-col items-center justify-center text-center"><div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-200 border-t-navy" /><p className="mt-4 text-sm font-semibold text-navy">Loading hypotheses and candidate patches</p><p className="mt-1 text-xs text-slate-400">Connecting to the recovery API…</p></CardContent></Card>;
}

function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <Card role="alert" className="border-[#ffd5d0] bg-[#fff8f7]"><CardContent className="flex min-h-64 flex-col items-center justify-center text-center"><div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#fff1ef] text-coral"><TriangleAlert size={19} /></div><p className="mt-4 text-sm font-semibold text-navy">Unable to load patch analysis</p><p className="mx-auto mt-1 max-w-md text-xs leading-5 text-slate-500">{message}</p><Button variant="secondary" size="sm" className="mt-5" onClick={onRetry}><RefreshCw size={13} /> Try again</Button></CardContent></Card>;
}

function HypothesisSummary({ hypothesis }: { hypothesis?: Hypothesis }) {
  return <div className="rounded-xl border border-[#cbdcff] bg-[#f6f8ff] p-4"><div className="mb-2 flex items-center gap-2"><Badge variant="blue">Leading hypothesis</Badge>{hypothesis && <span className="text-[11px] font-semibold text-[#5877d1]">{Math.round(hypothesis.confidence * 100)}% confidence</span>}</div><p className="text-sm font-semibold leading-5 text-navy">{hypothesis?.statement ?? "No hypothesis has been returned for this incident."}</p>{hypothesis?.nextCheck && <p className="mt-2 text-xs leading-5 text-slate-500">Next check: {hypothesis.nextCheck}</p>}</div>;
}

function EmptyPanel({ hypothesis }: { hypothesis?: Hypothesis }) {
  return <Card><CardHeader><div className="flex items-center gap-2"><CardTitle>Candidate patch</CardTitle><Badge variant="neutral">No patch yet</Badge></div><CardDescription>Patch generation has not produced a candidate for review.</CardDescription></CardHeader><CardContent><HypothesisSummary hypothesis={hypothesis} /><div className="mt-4 flex items-center gap-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4"><FileCode2 size={18} className="text-slate-400" /><p className="text-xs leading-5 text-slate-500">The leading hypothesis is available, but there is no patch diff or rationale to review yet.</p></div></CardContent></Card>;
}

function RejectedPanel({ hypothesis }: { hypothesis?: Hypothesis }) {
  return <Card className="border-[#ffd5d0]"><CardHeader><div className="flex items-center gap-2"><CardTitle>Candidate patch</CardTitle><Badge variant="danger">Rejected</Badge></div><CardDescription>This recovery candidate cannot be approved from the current analysis.</CardDescription></CardHeader><CardContent><HypothesisSummary hypothesis={hypothesis} /><div className="mt-4 rounded-xl border border-[#ffd5d0] bg-[#fff8f7] p-4"><p className="text-xs font-semibold text-[#a84439]">Patch rejected</p><p className="mt-1 text-xs leading-5 text-slate-500">The API marked the leading hypothesis or candidate patch as rejected. No patch is presented as review-ready.</p></div></CardContent></Card>;
}

function DiffView({ diff }: { diff: string }) {
  return <div role="region" aria-label="Candidate patch diff" className="rounded-xl border border-line bg-[#111827] p-4 text-[11px] leading-6 text-slate-300 shadow-inner"><div className="mb-3 flex items-center gap-2 border-b border-white/10 pb-3"><span className="h-2 w-2 rounded-full bg-[#f26b5b]" /><span className="h-2 w-2 rounded-full bg-[#f3c665]" /><span className="h-2 w-2 rounded-full bg-[#5dc8a8]" /><span className="ml-2 font-mono text-[10px] text-slate-500">candidate.patch</span></div><div className="overflow-x-auto font-mono" tabIndex={0}>{diff.split("\n").map((line, index) => <p className="min-w-max whitespace-pre" key={`${index}-${line}`}><span className="mr-3 inline-block w-6 select-none text-right text-slate-600">{index + 1}</span><span className={line.startsWith("+") && !line.startsWith("+++") ? "text-emerald-300" : line.startsWith("-") && !line.startsWith("---") ? "text-rose-300" : "text-slate-500"}>{line || " "}</span></p>)}</div></div>;
}

function ReviewPanel({ patch, hypothesis }: { patch: CandidatePatch; hypothesis?: Hypothesis }) {
  const [showDiff, setShowDiff] = useState(true);
  return <Card className="overflow-hidden"><div className="border-b border-line bg-[#fbfcfe] px-5 py-5 sm:px-6"><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex items-center gap-2"><CardTitle>Candidate patch</CardTitle><Badge variant="blue">Review ready</Badge></div><CardDescription className="mt-1">Generated from the leading root-cause hypothesis</CardDescription></div><Button type="button" variant="secondary" size="sm" aria-expanded={showDiff} onClick={() => setShowDiff((visible) => !visible)}><Code2 size={14} /> {showDiff ? "Hide diff" : "Open diff"}</Button></div></div><CardContent className="pt-5"><HypothesisSummary hypothesis={hypothesis} />{showDiff && <div className="mt-4"><DiffView diff={patch.diff} /></div>}<div className="mt-5 grid gap-4 md:grid-cols-2"><div><p className="mb-2 text-[11px] font-bold uppercase tracking-[0.08em] text-slate-400">Rationale</p><p className="text-xs leading-5 text-slate-600">{patch.rationale || "No rationale was provided by the API."}</p></div><div><p className="mb-2 text-[11px] font-bold uppercase tracking-[0.08em] text-slate-400">Touched paths</p>{patch.touchedPaths.length > 0 ? <div className="flex flex-wrap gap-2">{patch.touchedPaths.map((path) => <code key={path} className="rounded-md bg-slate-100 px-2 py-1 text-[11px] text-slate-600">{path}</code>)}</div> : <p className="text-xs text-slate-500">No paths were returned.</p>}</div></div><div className="mt-4 rounded-xl border border-[#f9dfaa] bg-[#fffbf1] p-3"><p className="text-[11px] font-bold uppercase tracking-[0.08em] text-[#a66a00]">Expected invariant</p><p className="mt-1 text-xs leading-5 text-slate-600">{patch.expectedInvariant || "No invariant was provided by the API."}</p></div></CardContent></Card>;
}

function VerificationPending() {
  return <Card><CardHeader><div className="flex items-center gap-2"><CardTitle>Verification</CardTitle><Badge variant="warning"><span className="h-1.5 w-1.5 rounded-full bg-[#b17b18]" /> Not verified</Badge></div><CardDescription>Verification results are not available for this recovery run.</CardDescription></CardHeader><CardContent><div className="flex items-start gap-3 rounded-xl border border-[#f9dfaa] bg-[#fffbf1] p-4"><Lock size={17} className="mt-0.5 shrink-0 text-[#b17b18]" /><div><p className="text-sm font-semibold text-navy">Pending verification</p><p className="mt-1 text-xs leading-5 text-slate-500">A candidate patch existing does not verify it. This slice has no VerificationResult, so no checks are shown as passed.</p></div></div><div className="mt-4 flex items-center gap-2 text-[11px] text-slate-400"><Check size={12} className="text-slate-300" /> Awaiting isolated verification results</div></CardContent></Card>;
}

export function PatchWorkspace({ incidentId }: PatchWorkspaceProps) {
  const [hypothesisSet, setHypothesisSet] = useState<HypothesisSet | null>(null);
  const [patches, setPatches] = useState<CandidatePatch[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    setStatus("loading");
    setErrorMessage("");
    Promise.all([fetchHypotheses(incidentId), fetchCandidatePatches(incidentId)]).then(([nextHypotheses, nextPatches]) => {
      if (!active) return;
      setHypothesisSet(nextHypotheses);
      setPatches(nextPatches);
      setStatus("ready");
    }).catch((error: unknown) => {
      if (!active) return;
      setErrorMessage(error instanceof Error ? error.message : "The patch analysis request failed.");
      setStatus("error");
    });
    return () => { active = false; };
  }, [incidentId, retry]);

  const hypotheses = hypothesisSet?.hypotheses ?? [];
  const panelState = getPatchPanelState({ loading: status === "loading", error: status === "error", hypotheses, patches });
  const leadingHypothesis = getLeadingHypothesis(hypotheses);

  if (panelState === "loading") return <div className="mb-7 grid gap-5 xl:grid-cols-[1.25fr_0.75fr]"><LoadingPanel /><VerificationPending /></div>;
  if (panelState === "error") return <div className="mb-7 grid gap-5 xl:grid-cols-[1.25fr_0.75fr]"><ErrorPanel message={errorMessage} onRetry={() => setRetry((value) => value + 1)} /><VerificationPending /></div>;

  const patch = patches[0];
  return <div className="mb-7 grid gap-5 xl:grid-cols-[1.25fr_0.75fr]">{panelState === "empty" && <EmptyPanel hypothesis={leadingHypothesis} />}{panelState === "rejected" && <RejectedPanel hypothesis={leadingHypothesis} />}{panelState === "review-ready" && patch && <ReviewPanel patch={patch} hypothesis={leadingHypothesis} />}<VerificationPending /></div>;
}
