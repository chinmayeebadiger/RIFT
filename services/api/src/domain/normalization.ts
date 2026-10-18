import type { EvidenceItem, Timestamp } from "./contracts.js";

export type TimestampState = "valid" | "missing" | "invalid";

export interface TimestampNormalization {
  readonly state: TimestampState;
  readonly value?: Timestamp;
  readonly raw?: string;
}

export interface NormalizationDiagnostic {
  readonly code: "invalid_timestamp" | "missing_timestamp" | "unsupported_content" | "malformed_stack_frame";
  readonly lineNumber?: number;
}

export interface EvidenceCitation {
  readonly evidenceId: EvidenceItem["id"];
  readonly contentHash: EvidenceItem["contentHash"];
  readonly source: EvidenceItem["source"];
  readonly lineStart?: number;
  readonly lineEnd?: number;
}

export interface NormalizedLogLine {
  readonly lineNumber: number;
  readonly raw: string;
  readonly text: string;
  readonly timestampState: TimestampState;
  readonly timestamp?: Timestamp;
  readonly fields: Readonly<Record<string, string>>;
  readonly sourceEvidenceId: EvidenceItem["id"];
  readonly citation: EvidenceCitation;
}

export interface NormalizedLog {
  readonly sourceEvidenceId: EvidenceItem["id"];
  readonly source: EvidenceItem["source"];
  readonly lines: readonly NormalizedLogLine[];
  readonly diagnostics: readonly NormalizationDiagnostic[];
}

export interface NormalizedStackFrame {
  readonly functionName?: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface NormalizedStackTrace extends NormalizedLog {
  readonly frames: Readonly<Record<number, NormalizedStackFrame>>;
}

export interface FailureSignature {
  readonly name: string;
  readonly status?: number;
  readonly message?: string;
  readonly citations: readonly EvidenceCitation[];
}

export interface TimelineEntry {
  readonly timestamp: Timestamp | null;
  readonly timestampState: TimestampState;
  readonly sourceEvidenceId: EvidenceItem["id"];
  readonly lineNumber: number;
  readonly title: string;
  readonly detail: string;
  readonly citations: readonly EvidenceCitation[];
}

const TIMESTAMP_TOKEN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\b/u;
const TIMESTAMP_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/u;
const KEY_START = /[^\s=]/u;
const KEY_CHARACTER = /[^\s=]/u;
const STACK_FRAME = /^\s*at\s+(?:(.+?)\s+\()?(.+):(\d+):(\d+)\)?\s*$/u;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function utcDate(year: number, month: number, day: number, hour: number, minute: number, second: number, millisecond: number): Date | undefined {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function daysInMonth(year: number, month: number): number {
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const date = utcDate(nextYear, nextMonth, 1, 0, 0, 0, 0);
  if (date === undefined) return 0;
  date.setUTCDate(date.getUTCDate() - 1);
  return date.getUTCDate();
}

/** Convert a strictly shaped timestamp to the canonical UTC contract form. */
export function normalizeTimestamp(value: unknown): TimestampNormalization {
  if (value === undefined || value === null || value === "") return { state: "missing" };
  if (typeof value !== "string") return { state: "invalid", raw: String(value) };

  const match = TIMESTAMP_WITH_ZONE.exec(value);
  if (match === null) return { state: "invalid", raw: value };

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText = "", zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (fractionText.length > 3 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) {
    return { state: "invalid", raw: value };
  }

  const milliseconds = Number(fractionText.padEnd(3, "0") || "0");
  const date = utcDate(year, month, day, hour, minute, second, milliseconds);
  if (date === undefined) return { state: "invalid", raw: value };

  if (zone !== "Z") {
    const offsetMatch = /^([+-])(\d{2}):(\d{2})$/u.exec(zone);
    if (offsetMatch === null) return { state: "invalid", raw: value };
    const offsetHours = Number(offsetMatch[2]);
    const offsetMinutes = Number(offsetMatch[3]);
    if (offsetHours > 23 || offsetMinutes > 59) return { state: "invalid", raw: value };
    const offset = (offsetHours * 60 + offsetMinutes) * 60 * 1000;
    date.setTime(date.getTime() + (offsetMatch[1] === "+" ? -offset : offset));
  }

  return { state: "valid", value: date.toISOString(), raw: value };
}

function splitLines(content: string): readonly string[] {
  if (content.length === 0) return [];
  const lines = content.split(/\r\n|\n|\r/u);
  if (/(?:\r\n|\n|\r)$/u.test(content)) lines.pop();
  return lines;
}

function parseFields(line: string): Readonly<Record<string, string>> {
  const fields = new Map<string, string>();
  let index = 0;
  while (index < line.length) {
    while (index < line.length && /\s/u.test(line[index] ?? "")) index += 1;
    if (index >= line.length) break;
    if (!KEY_START.test(line[index] ?? "")) {
      while (index < line.length && !/\s/u.test(line[index] ?? "")) index += 1;
      continue;
    }

    const keyStart = index;
    index += 1;
    while (index < line.length && KEY_CHARACTER.test(line[index] ?? "")) index += 1;
    if (line[index] !== "=") {
      while (index < line.length && !/\s/u.test(line[index] ?? "")) index += 1;
      continue;
    }
    const key = line.slice(keyStart, index);
    index += 1;
    let value = "";
    if (line[index] === "\"" || line[index] === "'") {
      const quote = line[index];
      index += 1;
      while (index < line.length) {
        const character = line[index];
        if (character === "\\" && index + 1 < line.length) {
          value += line[index + 1];
          index += 2;
        } else if (character === quote) {
          index += 1;
          break;
        } else {
          value += character;
          index += 1;
        }
      }
    } else {
      const valueStart = index;
      while (index < line.length && !/\s/u.test(line[index] ?? "")) index += 1;
      value = line.slice(valueStart, index);
    }
    fields.set(key, value);
  }
  return Object.fromEntries([...fields.entries()].sort(([left], [right]) => compareText(left, right)));
}

function findTimestamp(line: string): TimestampNormalization {
  const candidate = TIMESTAMP_TOKEN.exec(line)?.[0];
  if (candidate === undefined) return { state: "missing" };
  return normalizeTimestamp(candidate);
}

function normalizeLines(item: EvidenceItem): { lines: readonly NormalizedLogLine[]; diagnostics: readonly NormalizationDiagnostic[] } {
  if (typeof item.content !== "string") {
    return { lines: [], diagnostics: [{ code: "unsupported_content" }] };
  }

  const diagnostics: NormalizationDiagnostic[] = [];
  const lines = splitLines(item.content).map((raw, index) => {
    const lineNumber = index + 1;
    const timestamp = findTimestamp(raw);
    if (timestamp.state !== "valid") diagnostics.push({ code: timestamp.state === "missing" ? "missing_timestamp" : "invalid_timestamp", lineNumber });
    return {
      lineNumber,
      raw,
      text: raw,
      timestampState: timestamp.state,
      ...(timestamp.value === undefined ? {} : { timestamp: timestamp.value }),
      fields: parseFields(raw),
      sourceEvidenceId: item.id,
      citation: citeEvidence(item, lineNumber),
    } satisfies NormalizedLogLine;
  });
  return { lines, diagnostics };
}

export function citeEvidence(item: EvidenceItem, lineStart?: number, lineEnd = lineStart): EvidenceCitation {
  if (lineStart !== undefined && (!Number.isSafeInteger(lineStart) || lineStart < 1)) throw new Error("lineStart must be a positive integer");
  if (lineEnd !== undefined && (!Number.isSafeInteger(lineEnd) || lineEnd < (lineStart ?? 1))) throw new Error("lineEnd must not precede lineStart");
  return {
    evidenceId: item.id,
    contentHash: item.contentHash,
    source: item.source,
    ...(lineStart === undefined ? {} : { lineStart, lineEnd }),
  };
}

export function normalizeLogEvidence(item: EvidenceItem): NormalizedLog {
  const normalized = normalizeLines(item);
  return { sourceEvidenceId: item.id, source: item.source, ...normalized };
}

function parseStackFrame(line: string): NormalizedStackFrame | undefined {
  const match = STACK_FRAME.exec(line);
  if (match === null) return undefined;
  const lineNumber = Number(match[3]);
  const column = Number(match[4]);
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || !Number.isSafeInteger(column) || column < 1) return undefined;
  const functionName = match[1]?.trim();
  return {
    ...(functionName === undefined || functionName.length === 0 ? {} : { functionName }),
    file: match[2],
    line: lineNumber,
    column,
  };
}

export function normalizeStackTraceEvidence(item: EvidenceItem): NormalizedStackTrace {
  const normalized = normalizeLines(item);
  const frames: Record<number, NormalizedStackFrame> = {};
  const diagnostics = [...normalized.diagnostics];
  for (const line of normalized.lines) {
    const frame = parseStackFrame(line.text);
    if (line.text.trimStart().startsWith("at ")) {
      if (frame === undefined) diagnostics.push({ code: "malformed_stack_frame", lineNumber: line.lineNumber });
      else frames[line.lineNumber] = frame;
    }
  }
  return { sourceEvidenceId: item.id, source: item.source, lines: normalized.lines, diagnostics, frames };
}

function numericStatus(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function explicitSignature(line: NormalizedLogLine): string | undefined {
  const value = line.fields.signature?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function exceptionSignature(line: NormalizedLogLine): { name: string; message?: string } | undefined {
  const match = /^\s*([A-Za-z_$][A-Za-z0-9_$]*(?:Error|Exception|Failure))(?::\s*(.*?))?\s*$/u.exec(line.text);
  if (match === null) return undefined;
  const message = match[2]?.trim();
  return { name: match[1], ...(message === undefined || message.length === 0 ? {} : { message }) };
}

function sourceCitation(artifact: NormalizedLog, lineStart: number, lineEnd = lineStart): EvidenceCitation {
  const line = artifact.lines.find((candidate) => candidate.lineNumber === lineStart);
  if (line !== undefined) return citeEvidenceFromLine(line, lineEnd);
  throw new Error(`Cannot cite missing line ${lineStart} in evidence ${artifact.sourceEvidenceId}`);
}

function citeEvidenceFromLine(line: NormalizedLogLine, lineEnd = line.lineNumber): EvidenceCitation {
  return {
    ...line.citation,
    lineStart: line.lineNumber,
    lineEnd,
  };
}

export function extractFailureSignature(artifact: NormalizedLog | NormalizedStackTrace): FailureSignature | undefined {
  const explicit = artifact.lines
    .map((line) => ({ line, name: explicitSignature(line) }))
    .filter((candidate): candidate is { line: NormalizedLogLine; name: string } => candidate.name !== undefined)
    .sort((left, right) => left.line.lineNumber - right.line.lineNumber || compareText(left.line.sourceEvidenceId, right.line.sourceEvidenceId) || compareText(left.name, right.name))[0];

  const fallback = artifact.lines
    .map((line) => ({ line, signature: exceptionSignature(line) }))
    .filter((entry): entry is { line: NormalizedLogLine; signature: { name: string; message?: string } } => entry.signature !== undefined)
    .sort((left, right) => left.line.lineNumber - right.line.lineNumber || compareText(left.line.sourceEvidenceId, right.line.sourceEvidenceId) || compareText(left.signature.name, right.signature.name))[0];

  if (explicit === undefined && fallback === undefined) return undefined;
  const signatureLine = explicit?.line ?? fallback!.line;
  const name = explicit?.name ?? fallback!.signature.name;
  const message = explicit === undefined ? fallback!.signature.message : signatureLine.fields.message?.trim();
  const statusOnSignature = numericStatus(signatureLine.fields.status);
  let statusLine = statusOnSignature === undefined ? undefined : signatureLine;
  let status = statusOnSignature;
  if (status === undefined) {
    const statusCandidate = artifact.lines
      .map((line) => ({ line, status: numericStatus(line.fields.status), distance: Math.abs(line.lineNumber - signatureLine.lineNumber) }))
      .filter((entry): entry is { line: NormalizedLogLine; status: number; distance: number } => entry.status !== undefined)
      .sort((left, right) => left.distance - right.distance || left.line.lineNumber - right.line.lineNumber)[0];
    if (statusCandidate !== undefined) {
      status = statusCandidate.status;
      statusLine = statusCandidate.line;
    }
  }

  const firstLine = Math.min(signatureLine.lineNumber, statusLine?.lineNumber ?? signatureLine.lineNumber);
  const lastLine = Math.max(signatureLine.lineNumber, statusLine?.lineNumber ?? signatureLine.lineNumber);
  return {
    name,
    ...(status === undefined ? {} : { status }),
    ...(message === undefined || message.length === 0 ? {} : { message }),
    citations: [sourceCitation(artifact, firstLine, lastLine)],
  };
}

function timelineTitle(line: NormalizedLogLine): string {
  return line.fields.signature ?? line.fields.level ?? "log";
}

function compareTimeline(left: TimelineEntry, right: TimelineEntry): number {
  if (left.timestamp !== null && right.timestamp === null) return -1;
  if (left.timestamp === null && right.timestamp !== null) return 1;
  if (left.timestamp !== null && right.timestamp !== null) {
    const timestampOrder = compareText(left.timestamp, right.timestamp);
    if (timestampOrder !== 0) return timestampOrder;
  }
  return compareText(left.sourceEvidenceId, right.sourceEvidenceId)
    || left.lineNumber - right.lineNumber
    || compareText(left.citations[0]?.source.locator ?? "", right.citations[0]?.source.locator ?? "")
    || compareText(left.detail, right.detail);
}

export function buildDeterministicTimeline(artifacts: readonly NormalizedLog[]): readonly TimelineEntry[] {
  return artifacts.flatMap((artifact) => artifact.lines.map((line) => ({
    timestamp: line.timestamp ?? null,
    timestampState: line.timestampState,
    sourceEvidenceId: line.sourceEvidenceId,
    lineNumber: line.lineNumber,
    title: timelineTitle(line),
    detail: line.text,
    citations: [line.citation],
  } satisfies TimelineEntry))).sort(compareTimeline);
}
