/**
 * `GET /v1/findings?rule=&template=&quarter=&company=&limit=&cursor=&sort=` (#223, docs/API.md "Finding (list item)"):
 * the findings under the configuration in force (#69), without their steps (those are in `/v1/findings/{id}`, #224).
 *
 * Filters, each optional and combined with AND: `rule` (`gross_margin_change`, `profit_cash_divergence`,
 * `restated_comparatives`), `template` (the report's template family), `quarter` (`2026-2`) and `company` (any code of
 * the ticker group). `sort` is `size` (the rank score, comparable within a rule only: docs/SCHEMA.md) or `date` (the
 * report's publication time); the default is `-size`, the largest first. Paging uses the shared helper (#215).
 */
import type { Finding, RuleId, Template } from "@vigil/api-types";
import { loadConfig } from "../config.ts";
import { type Database, rows } from "../db.ts";
import type { Routes } from "./app.ts";
import { listResponse, pageSql, parseListQuery } from "./paging.ts";
import {
  parseCompanyCode,
  parseOptionalEnumParam,
  parseOptionalQuarterParam,
  RULE_IDS,
  TEMPLATES,
} from "./validation.ts";

const SORT_FIELDS = ["size", "date"] as const;

const FINDINGS_SQL = `
SELECT
    f.id, f.rule, f.title, f.company_code, f.disclosure_id, f.year, f.quarter, f.size_value, f.size_unit,
    f.rank_score, f.summary, f.config_version, strftime(f.created_at, '%Y-%m-%dT%H:%M:%SZ') AS created_at,
    r.template_family, r.raw_ticker_group, r.published_at
FROM findings f
JOIN reports r USING (disclosure_id)
`;

/** Turkish number: thousands with `.`, decimals with `,`; a negative number keeps its `-`. */
function trNumber(n: number | bigint, digits = 0): string {
  const text = typeof n === "bigint" ? n.toString() : n.toFixed(digits);
  const sign = text.startsWith("-") ? "-" : "";
  const [int, frac] = text.replace("-", "").split(".");
  const grouped = (int ?? "").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return sign + (frac === undefined ? grouped : `${grouped},${frac}`);
}

/** `-0.0853` → `-%8,53` (the sign goes before `%`, as Turkish writes it). */
function percent(ratio: number): string {
  const text = trNumber(ratio * 100, 2);
  return text.startsWith("-") ? `-%${text.slice(1)}` : `%${text}`;
}

/** One sentence stating the change, from the rule's summary numbers. It never says what to do (docs/legal.md). */
export function headline(rule: RuleId, summary: Record<string, unknown>): string {
  switch (rule) {
    case "gross_margin_change": {
      const before = Number(summary.prior_year_q_standalone_restated_margin);
      const now = Number(summary.current_q_standalone_margin);
      const verb = Number(summary.delta_bps) < 0 ? "geriledi" : "yükseldi";
      return `3 aylık brüt marj bir yıl önceki ${percent(before)} seviyesinden ${percent(now)} seviyesine ${verb}.`;
    }
    case "profit_cash_divergence": {
      const gap = BigInt(String(summary.profit_minus_ocf_gap_tl));
      return `Dönem net kârı, işletme faaliyetlerinden elde edilen nakit akışının ${trNumber(gap)} TL üzerinde.`;
    }
    case "restated_comparatives":
      return `Bilançonun ${trNumber(Number(summary.restated_balance_sheet_line_count))} kaleminde geçmiş dönem değerleri yeniden düzenlenmiş.`;
  }
}

function toFinding(r: Record<string, unknown>): Finding {
  const rule = String(r.rule) as RuleId;
  return {
    id: String(r.id),
    rule,
    title: String(r.title),
    company_code: String(r.company_code),
    document_id: String(r.disclosure_id),
    year: Number(r.year),
    quarter: Number(r.quarter),
    template: String(r.template_family) as Template,
    size: { value: String(r.size_value), unit: r.size_unit as "bps" | "TRY" | "count", status: "ok" },
    headline: headline(rule, JSON.parse(String(r.summary))),
    config_version: String(r.config_version),
    created_at: String(r.created_at),
  };
}

export interface FindingRoutesOptions {
  /** The configuration version whose findings are listed; the active configuration file's by default. */
  configVersion?: string;
}

export function findingRoutes(db: Database, options: FindingRoutesOptions = {}): Routes {
  const configVersion = options.configVersion ?? loadConfig().version;
  return (v1) => {
    v1.get("/findings", async (c) => {
      const query = parseListQuery(c, SORT_FIELDS, "-size");
      const rule = parseOptionalEnumParam(c.req.query("rule"), "rule", RULE_IDS);
      const template = parseOptionalEnumParam(c.req.query("template"), "template", TEMPLATES);
      const quarter = parseOptionalQuarterParam(c.req.query("quarter"));
      const rawCompany = c.req.query("company");
      const company =
        rawCompany === undefined || rawCompany === "" ? undefined : parseCompanyCode(rawCompany, "company");

      const where = ["config_version = $1"];
      const values: (string | number)[] = [configVersion];
      const add = (sql: (n: string) => string, value: string | number) => {
        values.push(value);
        where.push(sql(`$${values.length}`));
      };
      if (rule !== undefined) add((n) => `rule = ${n}`, rule);
      if (template !== undefined) add((n) => `template_family = ${n}`, template);
      if (quarter !== undefined) {
        add((n) => `year = ${n}`, quarter.year);
        add((n) => `quarter = ${n}`, quarter.quarter);
      }
      if (company !== undefined) add((n) => `list_contains(string_split(raw_ticker_group, '-'), ${n})`, company);

      const from = `FROM (${FINDINGS_SQL}) WHERE ${where.join(" AND ")}`;
      const [count] = await rows(db, `SELECT count(*) AS n ${from}`, values);
      const page = await rows(
        db,
        `SELECT * ${from} ${pageSql(query, { size: "rank_score", date: "published_at" }, "id")}`,
        values,
      );
      return c.json(listResponse(page.map(toFinding), Number(count?.n ?? 0), query));
    });
  };
}
