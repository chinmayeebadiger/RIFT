import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Incident, RecoveryReportRecord } from "./incidents";

// Exercise the client component's async lifecycle without adding a DOM dependency.
const hooks = vi.hoisted(() => ({ current: null as null | HookRender }));
vi.mock("react", async (original) => ({
  ...await original<typeof React>(),
  useState: (initial: unknown) => hooks.current!.state(initial),
  useRef: (initial: unknown) => hooks.current!.ref(initial),
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => hooks.current!.effect(effect, deps),
}));
vi.mock("@/components/ui/badge", () => ({ Badge: "badge" }));
vi.mock("@/components/ui/button", () => ({ Button: "button" }));
vi.mock("@/components/ui/card", () => ({ Card: "card", CardContent: "content", CardDescription: "description", CardHeader: "header", CardTitle: "title" }));
vi.mock("@/components/patch-workspace", () => ({ PatchWorkspace: "patch-workspace" }));
vi.mock("@/lib/incidents", async () => ({
  ...await import("./incidents"),
  fetchIncidents: vi.fn(), fetchIncident: vi.fn(), fetchRecoveryReport: vi.fn(), submitApprovalIntent: vi.fn(),
}));
import Home from "../app/page";
import { fetchIncident, fetchIncidents, fetchRecoveryReport, submitApprovalIntent } from "@/lib/incidents";

type Element = React.ReactElement<Record<string, any>>;
type Component = (props: any) => React.ReactNode;
class HookRender {
  private slots: any[] = [];
  private cursor = 0;
  private pending: (() => void)[] = [];
  tree: React.ReactNode;
  updates = 0;
  constructor(private component: Component, private props = {}) {}
  state(initial: unknown) {
    const index = this.cursor++;
    if (!(index in this.slots)) this.slots[index] = initial;
    return [this.slots[index], (value: any) => {
      this.updates++;
      this.slots[index] = typeof value === "function" ? value(this.slots[index]) : value;
    }];
  }
  ref(initial: unknown) {
    const index = this.cursor++;
    return this.slots[index] ??= { current: initial };
  }
  effect(effect: () => void | (() => void), deps: unknown[]) {
    const index = this.cursor++;
    const previous = this.slots[index];
    if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
    this.pending.push(() => {
      previous?.cleanup?.();
      this.slots[index] = { deps, cleanup: effect() };
    });
  }
  render() {
    this.cursor = 0;
    hooks.current = this;
    this.tree = this.component(this.props);
    hooks.current = null;
    this.pending.splice(0).forEach((effect) => effect());
    return this;
  }
  unmount() { this.slots.forEach((slot) => slot?.cleanup?.()); }
}
function elements(node: React.ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
function find(render: HookRender, name: string): Element {
  const match = elements(render.tree).find((node) => typeof node.type === "function" ? node.type.name === name : node.type === name);
  if (!match) throw new Error(`Missing ${name}`);
  return match;
}
function text(node: React.ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (React.isValidElement(node)) return text((node as Element).props.children);
  return typeof node === "string" ? node : "";
}
const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const record = (id: string): RecoveryReportRecord => ({ report: { id, status: "running", approvalRequired: true, facts: [], inferences: [], unknowns: [] }, approval: { status: "pending", requestedAt: "2026-10-18T00:00:00Z" } });
async function workspace(id = "RIFT-A") {
  vi.mocked(fetchIncidents).mockResolvedValue([{ id }] as Incident[]);
  vi.mocked(fetchIncident).mockResolvedValue({ id } as Incident);
  const home = new HookRender(Home).render();
  await settle();
  home.render();
  const child = find(home, "IncidentWorkspace");
  expect(child.key).toBe(id);
  return new HookRender(child.type as Component, child.props).render();
}
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });

describe("dashboard integration", () => {
  it("keeps incident and patch analysis available while a report is missing or loading", async () => {
    vi.stubGlobal("React", React);
    const report = deferred<RecoveryReportRecord | null>();
    vi.mocked(fetchRecoveryReport).mockReturnValue(report.promise);
    const render = await workspace();
    await settle();
    render.render();
    expect(find(render, "IncidentDashboard").props.incident.id).toBe("RIFT-A");
    expect(find(render, "patch-workspace").props.incidentId).toBe("RIFT-A");
    expect(find(render, "PendingReport").props.loading).toBe(true);
    report.resolve(null);
    await settle();
    render.render();
    expect(find(render, "PendingReport").props.loading).toBe(false);
    expect(find(render, "IncidentDashboard")).toBeDefined();
    expect(find(render, "patch-workspace")).toBeDefined();
    expect(elements(render.tree).some((node) => typeof node.type === "function" && node.type.name === "ApprovalBoundary")).toBe(false);
    render.unmount();
  });

  it("shows a retryable report error without hiding incident or patch data", async () => {
    vi.stubGlobal("React", React);
    vi.mocked(fetchRecoveryReport).mockRejectedValueOnce(new Error("Report service unavailable")).mockResolvedValueOnce(record("report-A"));
    const render = await workspace();
    await settle();
    render.render();
    const error = find(render, "ErrorState");
    expect(error.props.message).toBe("Report service unavailable");
    expect(find(render, "IncidentDashboard")).toBeDefined();
    expect(find(render, "patch-workspace")).toBeDefined();
    error.props.onRetry();
    render.render();
    await settle();
    render.render();
    expect(find(render, "VerificationPanel").props.record.report.id).toBe("report-A");
    expect(find(render, "ApprovalBoundary")).toBeDefined();
    render.unmount();
  });

  it("requires human reviewer input and sends that actor as an intent only", async () => {
    vi.stubGlobal("React", React);
    vi.mocked(fetchRecoveryReport).mockResolvedValue(record("report-A"));
    vi.mocked(submitApprovalIntent).mockResolvedValue(record("report-A"));
    const render = await workspace();
    await settle();
    render.render();
    const approval = find(render, "ApprovalBoundary");
    const form = new HookRender(approval.type as Component, approval.props).render();
    expect(find(form, "button").props.disabled).toBe(true);
    await find(form, "button").props.onClick();
    expect(submitApprovalIntent).not.toHaveBeenCalled();
    find(form, "input").props.onChange({ target: { value: " reviewer-alice " } });
    form.render();
    expect(find(form, "button").props.disabled).toBe(false);
    await find(form, "button").props.onClick();
    await settle();
    expect(submitApprovalIntent).toHaveBeenCalledTimes(1);
    expect(submitApprovalIntent).toHaveBeenCalledWith("report-A", { actorId: "reviewer-alice", actorKind: "human", decision: "approved" });
    const dashboard = find(render, "IncidentDashboard");
    expect(text(new HookRender(dashboard.type as Component, { incident: { id: "RIFT-A", severity: "SEV-2", status: "investigating", stage: "detected", updatedAt: "2026-10-18T00:00:00Z" } }).render().tree)).not.toContain("Start recovery");
    render.unmount();
  });

  it.each(["success", "error"])("ignores an old approval %s after selecting a different incident", async (outcome) => {
    vi.stubGlobal("React", React);
    vi.mocked(fetchRecoveryReport).mockImplementation(async (id) => record(`report-${id}`));
    const oldApproval = deferred<RecoveryReportRecord>();
    vi.mocked(submitApprovalIntent).mockReturnValue(oldApproval.promise);
    const old = await workspace("RIFT-A");
    await settle();
    old.render();
    const submit = find(old, "ApprovalBoundary").props.onSubmit("approved", "alice", "Reviewed A");
    old.unmount();
    const updatesBeforeResponse = old.updates;
    const current = await workspace("RIFT-B");
    await settle();
    current.render();
    if (outcome === "success") oldApproval.resolve(record("report-RIFT-A"));
    else oldApproval.reject(new Error("Old approval failed"));
    await submit;
    current.render();
    expect(old.updates).toBe(updatesBeforeResponse);
    expect(find(current, "ApprovalBoundary").props.record.report.id).toBe("report-RIFT-B");
    expect(find(current, "ApprovalBoundary").props.error).toBe("");
    current.unmount();
  });
});
