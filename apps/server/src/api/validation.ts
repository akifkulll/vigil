/**
 * Request validation and error helpers for `/v1` routes (#214, docs/API.md).
 *
 * Every invalid path parameter, query parameter or JSON body throws `ApiError("invalid_request", ...)` so Hono's
 * error handler returns HTTP 400 with `{ error: { code: "invalid_request", message, details } }` instead of crashing
 * or falling through to 500.
 */
import type { CurrencyPart, RuleId, StatementName, Template, VersionSelector } from "@vigil/api-types";
import { type IsoDate, isoDate } from "@vigil/core";
import type { Context } from "hono";
import { ApiError } from "./app.ts";

export const STATEMENT_NAMES: readonly StatementName[] = [
  "balance_sheet",
  "income_statement",
  "comprehensive_income",
  "cash_flow",
  "equity_changes",
];

export const STATEMENT_VIEWS = ["cumulative", "three_month"] as const;
export type StatementView = (typeof STATEMENT_VIEWS)[number];

export const RULE_IDS: readonly RuleId[] = ["gross_margin_change", "profit_cash_divergence", "restated_comparatives"];

export const TEMPLATES: readonly Template[] = ["general", "banks", "par-banks", "finance", "holding", "insurance"];

export const CURRENCY_PARTS: readonly CurrencyPart[] = ["total", "tp", "yp"];

const POSITIVE_INT_RE = /^[1-9]\d*$/;
const NON_NEGATIVE_INT_RE = /^(0|[1-9]\d*)$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const QUARTER_RE = /^(\d{4})-([1-4])$/;
const COMPANY_CODE_RE = /^[A-Za-z0-9-]+$/;
const ROW_ID_RE = /^[a-z0-9-]+_role_\d{6}-row-\d+$/;
const FINDING_ID_RE = /^(\d{4})-([1-4])-([A-Za-z0-9-]+)-([a-z_]+)$/;

/** Throw a 400 `invalid_request` error naming the offending parameter. */
export function invalidRequest(parameter: string, message: string, details: Record<string, unknown> = {}): never {
  throw new ApiError("invalid_request", message, { parameter, ...details });
}

/** Parse a required integer parameter within optional `[min, max]` bounds (defaults to `min = 1`). */
export function parseIntParam(
  raw: string | undefined,
  parameter: string,
  options: { min?: number; max?: number } = {},
): number {
  const min = options.min ?? 1;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (raw === undefined || raw === "") {
    invalidRequest(parameter, `${parameter} parametresi gerekli.`);
  }
  const re = min >= 1 ? POSITIVE_INT_RE : NON_NEGATIVE_INT_RE;
  if (!re.test(raw)) {
    invalidRequest(parameter, `${parameter} geçerli bir tam sayı olmalı.`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    invalidRequest(parameter, `${parameter} geçerli aralıkta değil.`);
  }
  if (n < min) {
    invalidRequest(parameter, `${parameter} en az ${min} olmalı.`, { min });
  }
  if (n > max) {
    invalidRequest(parameter, `${parameter} en fazla ${max} olabilir.`, { max });
  }
  return n;
}

/** Parse an optional integer parameter; returns `undefined` when omitted or empty. */
export function parseOptionalIntParam(
  raw: string | undefined,
  parameter: string,
  options: { min?: number; max?: number } = {},
): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  return parseIntParam(raw, parameter, options);
}

/** Parse a required enum parameter against `allowed`. */
export function parseEnumParam<T extends string>(raw: string | undefined, parameter: string, allowed: readonly T[]): T {
  if (raw === undefined || raw === "") {
    invalidRequest(parameter, `${parameter} parametresi gerekli.`, { allowed: [...allowed] });
  }
  if (!(allowed as readonly string[]).includes(raw)) {
    invalidRequest(parameter, `Geçersiz ${parameter}: ${raw}.`, { allowed: [...allowed] });
  }
  return raw as T;
}

/** Parse an optional enum parameter; returns `undefined` when omitted or empty. */
export function parseOptionalEnumParam<T extends string>(
  raw: string | undefined,
  parameter: string,
  allowed: readonly T[],
): T | undefined {
  if (raw === undefined || raw === "") return undefined;
  return parseEnumParam(raw, parameter, allowed);
}

/** Parse a required ISO 8601 date (`YYYY-MM-DD`) and verify it is a real calendar date. */
export function parseIsoDateParam(raw: string | undefined, parameter: string): IsoDate {
  if (raw === undefined || raw === "") {
    invalidRequest(parameter, `${parameter} parametresi gerekli.`);
  }
  const m = ISO_DATE_RE.exec(raw);
  if (m === null) {
    invalidRequest(parameter, `${parameter} YYYY-AA-GG biçiminde olmalı.`);
  }
  const valid = isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  if (valid === null) {
    invalidRequest(parameter, `${parameter} geçerli bir tarih değil: ${raw}.`);
  }
  return valid;
}

/** Parse an optional ISO 8601 date (`YYYY-MM-DD`). */
export function parseOptionalIsoDateParam(raw: string | undefined, parameter: string): IsoDate | undefined {
  if (raw === undefined || raw === "") return undefined;
  return parseIsoDateParam(raw, parameter);
}

/** Parse a quarter string (`YYYY-Q`, e.g. `2026-2`). */
export function parseQuarterParam(
  raw: string | undefined,
  parameter = "quarter",
): { year: number; quarter: number; value: string } {
  if (raw === undefined || raw === "") {
    invalidRequest(parameter, `${parameter} parametresi gerekli.`);
  }
  const m = QUARTER_RE.exec(raw);
  if (m === null) {
    invalidRequest(parameter, `${parameter} YYYY-Ç biçiminde olmalı (ör. 2026-2).`);
  }
  return { year: Number(m[1]), quarter: Number(m[2]), value: raw };
}

/** Parse an optional quarter string (`YYYY-Q`). */
export function parseOptionalQuarterParam(
  raw: string | undefined,
  parameter = "quarter",
): { year: number; quarter: number; value: string } | undefined {
  if (raw === undefined || raw === "") return undefined;
  return parseQuarterParam(raw, parameter);
}

/** Parse a company ticker code (`A-Z`, `0-9`, `-`), normalised to uppercase. */
export function parseCompanyCode(raw: string | undefined, parameter = "code"): string {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "" || !COMPANY_CODE_RE.test(trimmed)) {
    invalidRequest(parameter, `Geçersiz şirket kodu: ${raw ?? ""}.`);
  }
  return trimmed.toUpperCase();
}

/** Parse a KAP disclosure document id (positive integer), returning the validated string. */
export function parseDocumentId(raw: string | undefined, parameter = "document_id"): string {
  parseIntParam(raw, parameter, { min: 1 });
  return raw as string;
}

/** Parse a line-item row id (e.g. `general_role_310003-row-3`). */
export function parseRowId(raw: string | undefined, parameter = "row"): string {
  if (raw === undefined || !ROW_ID_RE.test(raw)) {
    invalidRequest(parameter, `Geçersiz kalem kodu: ${raw ?? ""}.`);
  }
  return raw;
}

/** Parse a `version` query selector (`latest`, `first`, or `report:{document_id}`). */
export function parseVersionSelector(raw: string | undefined, parameter = "version"): VersionSelector {
  if (raw === undefined || raw === "") return "latest";
  if (raw === "latest" || raw === "first") return raw;
  if (raw.startsWith("report:")) {
    const id = raw.slice("report:".length);
    if (POSITIVE_INT_RE.test(id) && Number.isSafeInteger(Number(id))) {
      return raw as VersionSelector;
    }
  }
  invalidRequest(parameter, `Geçersiz sürüm seçimi: ${raw}.`);
}

/** Parse a statement path parameter (`balance_sheet`, `income_statement`, ...). */
export function parseStatementName(raw: string | undefined, parameter = "statement"): StatementName {
  return parseEnumParam(raw, parameter, STATEMENT_NAMES);
}

/** Parse a statement `view` query parameter (`cumulative` by default, or `three_month`). */
export function parseStatementView(raw: string | undefined, parameter = "view"): StatementView {
  if (raw === undefined || raw === "") return "cumulative";
  return parseEnumParam(raw, parameter, STATEMENT_VIEWS);
}

/** Parse a finding id (`YYYY-Q-CODE-rule`, e.g. `2026-2-KATMR-gross_margin_change`). */
export function parseFindingId(raw: string | undefined, parameter = "id"): string {
  if (raw === undefined || raw === "") {
    invalidRequest(parameter, `${parameter} parametresi gerekli.`);
  }
  const m = FINDING_ID_RE.exec(raw);
  if (m === null || !(RULE_IDS as readonly string[]).includes(m[4] as string)) {
    invalidRequest(parameter, `Geçersiz bulgu kimliği: ${raw}.`);
  }
  return `${m[1]}-${m[2]}-${(m[3] as string).toUpperCase()}-${m[4]}`;
}

/** Parse a JSON request body as a plain object; throws 400 `invalid_request` on malformed JSON or non-objects. */
export async function parseJsonBody(c: Context): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    invalidRequest("body", "İstek gövdesi geçerli bir JSON olmalı.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    invalidRequest("body", "İstek gövdesi bir JSON nesnesi olmalı.");
  }
  return body as Record<string, unknown>;
}
