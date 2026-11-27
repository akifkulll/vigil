/**
 * `GET /v1/companies?q=&limit=&cursor=&sort=` (#217, docs/API.md "Company"): companies with a loaded report, found by
 * code or title. `q` is folded the Turkish way (`turkishSearchKey`, #189) and matched without spaces, so `işbank`,
 * `ISBANK` and `İş Bank` all find `TÜRKİYE İŞ BANKASI A.Ş.`. Paging and sorting use the shared helper (#215).
 */
import type { Company, Quality, Template } from "@vigil/api-types";
import { turkishSearchKey } from "../companies.ts";
import { type Database, rows } from "../db.ts";
import type { Routes } from "./app.ts";
import { listResponse, pageSql, parseListQuery } from "./paging.ts";

const SORT_FIELDS = ["code", "title"] as const;

/**
 * Each company with its latest report (report period, then publication time, then document id; docs/SCHEMA.md) and
 * that report's quality, worked out from `check_results` as `filingQuality` does in the quality report.
 */
const COMPANIES_SQL = `
WITH latest AS (
    SELECT company_code, disclosure_id, raw_ticker_group, year, quarter, template_family, fact_count
    FROM reports
    QUALIFY row_number() OVER (
        PARTITION BY company_code ORDER BY year DESC, quarter DESC, published_at DESC NULLS LAST, disclosure_id DESC
    ) = 1
), checks AS (
    SELECT disclosure_id,
        count(*) FILTER (severity = 'blocking' AND status = 'fail' AND known_error IS NULL) AS failed,
        count(*) FILTER (severity = 'blocking' AND status = 'fail' AND known_error IS NOT NULL) AS known_errors,
        count(*) FILTER (severity = 'blocking' AND status = 'pass') AS passed
    FROM check_results GROUP BY disclosure_id
)
SELECT
    l.company_code AS code,
    l.raw_ticker_group,
    c.title,
    l.template_family,
    coalesce(c.sector_name, c.main_sector_name) AS sector,
    c.mkk_member_oid,
    l.disclosure_id,
    l.year,
    l.quarter,
    CASE
        WHEN l.fact_count = 0 THEN 'no_values'
        WHEN coalesce(k.failed, 0) > 0 THEN 'fail'
        WHEN coalesce(k.known_errors, 0) > 0 THEN 'known_error'
        WHEN coalesce(k.passed, 0) > 0 THEN 'pass'
        ELSE 'not_checked'
    END AS quality,
    -- Before the company list is loaded (#163) there is no search key: the code is all there is to match.
    replace(coalesce(c.search_key, lower(l.company_code)), ' ', '') AS search_key
FROM latest l
JOIN companies c USING (company_code)
LEFT JOIN checks k USING (disclosure_id)
`;

function toCompany(r: Record<string, unknown>): Company {
  return {
    code: String(r.code),
    codes: String(r.raw_ticker_group).split("-"),
    title: r.title === null ? null : String(r.title),
    template: String(r.template_family) as Template,
    sector: r.sector === null ? null : String(r.sector),
    member_id: r.mkk_member_oid === null ? null : String(r.mkk_member_oid),
    latest_report: {
      document_id: String(r.disclosure_id),
      year: Number(r.year),
      quarter: Number(r.quarter),
      quality: String(r.quality) as Quality,
    },
  };
}

export function companyRoutes(db: Database): Routes {
  return (v1) => {
    v1.get("/companies", async (c) => {
      const query = parseListQuery(c, SORT_FIELDS, "code");
      const q = turkishSearchKey(c.req.query("q") ?? "").replaceAll(" ", "");
      const where = q === "" ? "" : "WHERE contains(search_key, $1)";
      const values = q === "" ? [] : [q];
      const [count] = await rows(db, `SELECT count(*) AS n FROM (${COMPANIES_SQL}) ${where}`, values);
      const page = await rows(
        db,
        `SELECT * FROM (${COMPANIES_SQL}) ${where} ${pageSql(query, { code: "code", title: "title COLLATE tr" }, "code")}`,
        values,
      );
      return c.json(listResponse(page.map(toCompany), Number(count?.n ?? 0), query));
    });
  };
}
