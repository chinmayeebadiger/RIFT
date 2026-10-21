import { validateRecoveryReport } from "@rift/core";
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { sha256 } from "../domain/hashing.js";
import type { ApprovalState, HumanApprovalRequest, RecoveryReportRecord, ReportStore } from "./ports.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

export class ReportStoreError extends Error {
  public constructor(
    message: string,
    public readonly code: "REPORT_DUPLICATE" | "REPORT_NOT_FOUND" | "REPORT_INVALID" | "REPORT_STORE_CORRUPT" | "REPORT_STORE_IO" | "APPROVAL_INVALID" | "APPROVAL_POLICY_DENIED" | "APPROVAL_ALREADY_DECIDED",
  ) {
    super(message);
    this.name = "ReportStoreError";
  }
}

function validateRecord(record: RecoveryReportRecord): void {
  const validation = validateRecoveryReport(record.report);
  if (!validation.ok) throw new ReportStoreError("Recovery report failed contract validation", "REPORT_INVALID");
  if (record.approval.status !== "pending" && record.approval.status !== "approved" && record.approval.status !== "rejected") throw new ReportStoreError("Recovery report approval state is invalid", "REPORT_INVALID");
  if (!validTimestamp(record.approval.requestedAt)) throw new ReportStoreError("Recovery report approval timestamp is invalid", "REPORT_INVALID");
  if (record.approval.decidedAt !== undefined && !validTimestamp(record.approval.decidedAt)) throw new ReportStoreError("Recovery report decision timestamp is invalid", "REPORT_INVALID");
  if (record.approval.status === "pending" && (record.approval.decidedAt !== undefined || record.approval.approverId !== undefined)) throw new ReportStoreError("Pending approval cannot have a decision", "REPORT_INVALID");
  if (record.approval.status !== "pending" && (record.approval.decidedAt === undefined || record.approval.approverId === undefined)) throw new ReportStoreError("Decided approval must identify the approver and time", "REPORT_INVALID");
  const { contentHash, ...withoutHash } = record.report;
  if (contentHash !== sha256(withoutHash as never)) throw new ReportStoreError("Recovery report content hash does not match payload", "REPORT_INVALID");
}

/** In-memory report persistence used by the local API and deterministic tests. */
export class InMemoryReportStore implements ReportStore {
  private readonly records = new Map<string, RecoveryReportRecord>();

  public constructor(initial: readonly RecoveryReportRecord[] = []) {
    initial.forEach((record) => this.save(record));
  }

  public save(record: RecoveryReportRecord): RecoveryReportRecord {
    validateRecord(record);
    const existing = this.records.get(record.report.id);
    if (existing !== undefined) {
      if (JSON.stringify(existing) === JSON.stringify(record)) return clone(existing);
      throw new ReportStoreError(`Recovery report already exists: ${record.report.id}`, "REPORT_DUPLICATE");
    }
    this.records.set(record.report.id, clone(record));
    return clone(record);
  }

  public get(reportId: string): RecoveryReportRecord | undefined {
    const record = this.records.get(reportId);
    return record === undefined ? undefined : clone(record);
  }

  public list(query: { readonly incidentId?: string } = {}): readonly RecoveryReportRecord[] {
    return [...this.records.values()]
      .filter((record) => query.incidentId === undefined || record.report.incidentId === query.incidentId)
      .map((record) => clone(record));
  }

  public recordApproval(reportId: string, request: HumanApprovalRequest, now = new Date().toISOString()): RecoveryReportRecord {
    const record = this.records.get(reportId);
    if (record === undefined) throw new ReportStoreError(`Recovery report not found: ${reportId}`, "REPORT_NOT_FOUND");
    if (request.actorKind !== undefined && request.actorKind !== "human") {
      throw new ReportStoreError("Only a human actor may record approval", "APPROVAL_POLICY_DENIED");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(request.actorId)) {
      throw new ReportStoreError("Approval requires a bounded human actor id", "APPROVAL_INVALID");
    }
    if (request.decision !== "approved" && request.decision !== "rejected") {
      throw new ReportStoreError("Approval decision must be approved or rejected", "APPROVAL_INVALID");
    }
    if (request.note !== undefined && (request.note.length === 0 || request.note.length > 512)) {
      throw new ReportStoreError("Approval note must be between 1 and 512 characters", "APPROVAL_INVALID");
    }
    if (!validTimestamp(now)) throw new ReportStoreError("Approval timestamp is invalid", "APPROVAL_INVALID");
    if (record.approval.status !== "pending") {
      throw new ReportStoreError(`Recovery report approval is already ${record.approval.status}`, "APPROVAL_ALREADY_DECIDED");
    }

    const approval: ApprovalState = {
      ...record.approval,
      status: request.decision,
      decidedAt: now,
      approverId: request.actorId,
      ...(request.note === undefined ? {} : { note: request.note }),
    };
    const updated: RecoveryReportRecord = { report: record.report, approval };
    this.records.set(reportId, clone(updated));
    return clone(updated);
  }
}

/** Durable local JSONL report persistence. Reports are immutable records; approval
 * decisions append a new snapshot while preserving the original report payload. */
export class LocalReportStore implements ReportStore {
  private readonly records = new Map<string, RecoveryReportRecord>();

  public constructor(public readonly filePath: string) {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      if (!existsSync(filePath)) appendFileSync(filePath, "", { encoding: "utf8" });
      this.load();
    } catch (error) {
      if (error instanceof ReportStoreError) throw error;
      throw new ReportStoreError(`Unable to open report store: ${error instanceof Error ? error.message : "unknown error"}`, "REPORT_STORE_IO");
    }
  }

  public save(record: RecoveryReportRecord): RecoveryReportRecord {
    validateRecord(record);
    const existing = this.records.get(record.report.id);
    if (existing !== undefined) {
      if (JSON.stringify(existing) === JSON.stringify(record)) return clone(existing);
      if (JSON.stringify(existing.report) !== JSON.stringify(record.report)) throw new ReportStoreError(`Recovery report already exists: ${record.report.id}`, "REPORT_DUPLICATE");
      if (existing.approval.status !== "pending") throw new ReportStoreError(`Recovery report approval is already ${existing.approval.status}`, "APPROVAL_ALREADY_DECIDED");
    }
    this.appendLine(record);
    this.records.set(record.report.id, clone(record));
    return clone(record);
  }

  public get(reportId: string): RecoveryReportRecord | undefined {
    const record = this.records.get(reportId);
    return record === undefined ? undefined : clone(record);
  }

  public list(query: { readonly incidentId?: string } = {}): readonly RecoveryReportRecord[] {
    return [...this.records.values()].filter((record) => query.incidentId === undefined || record.report.incidentId === query.incidentId).map((record) => clone(record));
  }

  public recordApproval(reportId: string, request: HumanApprovalRequest, now = new Date().toISOString()): RecoveryReportRecord {
    const record = this.records.get(reportId);
    if (record === undefined) throw new ReportStoreError(`Recovery report not found: ${reportId}`, "REPORT_NOT_FOUND");
    if (request.actorKind !== undefined && request.actorKind !== "human") throw new ReportStoreError("Only a human actor may record approval", "APPROVAL_POLICY_DENIED");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(request.actorId)) throw new ReportStoreError("Approval requires a bounded human actor id", "APPROVAL_INVALID");
    if (request.decision !== "approved" && request.decision !== "rejected") throw new ReportStoreError("Approval decision must be approved or rejected", "APPROVAL_INVALID");
    if (request.note !== undefined && (request.note.length === 0 || request.note.length > 512)) throw new ReportStoreError("Approval note must be between 1 and 512 characters", "APPROVAL_INVALID");
    if (!validTimestamp(now)) throw new ReportStoreError("Approval timestamp is invalid", "APPROVAL_INVALID");
    if (record.approval.status !== "pending") throw new ReportStoreError(`Recovery report approval is already ${record.approval.status}`, "APPROVAL_ALREADY_DECIDED");
    const updated: RecoveryReportRecord = { report: record.report, approval: { ...record.approval, status: request.decision, decidedAt: now, approverId: request.actorId, ...(request.note === undefined ? {} : { note: request.note }) } };
    return this.save(updated);
  }

  private appendLine(record: RecoveryReportRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(this.filePath, "a");
      const buffer = Buffer.from(line, "utf8");
      let offset = 0;
      while (offset < buffer.byteLength) {
        const written = writeSync(descriptor, buffer, offset);
        if (written <= 0) throw new Error("Report store write made no progress");
        offset += written;
      }
      fsyncSync(descriptor);
    } catch (error) {
      throw new ReportStoreError(`Unable to append report: ${error instanceof Error ? error.message : "unknown error"}`, "REPORT_STORE_IO");
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  private load(): void {
    const lines = readFileSync(this.filePath, "utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(lines[index]); } catch { throw new ReportStoreError(`Report store line ${index + 1} is not valid JSON`, "REPORT_STORE_CORRUPT"); }
      try {
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("report" in parsed) || !("approval" in parsed)) throw new Error("record shape is invalid");
        const record = parsed as RecoveryReportRecord;
        validateRecord(record);
        const existing = this.records.get(record.report.id);
        if (existing !== undefined && JSON.stringify(existing.report) !== JSON.stringify(record.report)) throw new Error("report payload changed");
        this.records.set(record.report.id, clone(record));
      } catch (error) {
        if (error instanceof ReportStoreError && error.code === "REPORT_INVALID") throw new ReportStoreError(`Report store line ${index + 1}: ${error.message}`, "REPORT_STORE_CORRUPT");
        throw new ReportStoreError(`Report store line ${index + 1}: ${error instanceof Error ? error.message : "invalid record"}`, "REPORT_STORE_CORRUPT");
      }
    }
  }
}

export const RecoveryReportStore = InMemoryReportStore;
