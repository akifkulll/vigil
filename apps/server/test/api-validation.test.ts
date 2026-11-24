/**
 * Request validation and error responses (#214, docs/API.md).
 *
 * Tests both the individual validators and real Hono routes via `apiHarness`, verifying that invalid path
 * parameters, query parameters and JSON bodies return HTTP 400 in the common `ErrorResponse` shape (`code:
 * "invalid_request"`, non-empty `message`, `details.parameter`) without crashing or producing 500s.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ApiError, type Routes } from "../src/api/app.ts";
import {
  CURRENCY_PARTS,
  parseCompanyCode,
  parseDocumentId,
  parseFindingId,
  parseIntParam,
  parseIsoDateParam,
  parseJsonBody,
  parseOptionalEnumParam,
  parseOptionalIntParam,
  parseOptionalIsoDateParam,
  parseOptionalQuarterParam,
  parseQuarterParam,
  parseRowId,
  parseStatementName,
  parseStatementView,
  parseVersionSelector,
  RULE_IDS,
  TEMPLATES,
} from "../src/api/validation.ts";
import { type ApiHarness, apiHarness } from "./api-harness.ts";

const validationRoutes: Routes = (v1) => {
  v1.get("/companies/:code/metrics", (c) => {
    const code = parseCompanyCode(c.req.param("code"));
    const period = parseOptionalQuarterParam(c.req.query("period"), "period");
    const version = parseVersionSelector(c.req.query("version"));
    return c.json({ code, period: period?.value ?? null, version });
  });

  v1.get("/companies/:code/facts/:row/versions", (c) => {
    const code = parseCompanyCode(c.req.param("code"));
    const row = parseRowId(c.req.param("row"));
    const period_end = parseIsoDateParam(c.req.query("period_end"), "period_end");
    const currency_part = parseOptionalEnumParam(c.req.query("currency_part"), "currency_part", CURRENCY_PARTS);
    return c.json({ code, row, period_end, currency_part: currency_part ?? "total" });
  });

  v1.get("/reports/:document_id/statements/:statement", (c) => {
    const document_id = parseDocumentId(c.req.param("document_id"));
    const statement = parseStatementName(c.req.param("statement"));
    const view = parseStatementView(c.req.query("view"));
    return c.json({ document_id, statement, view });
  });

  v1.get("/findings", (c) => {
    const rule = parseOptionalEnumParam(c.req.query("rule"), "rule", RULE_IDS);
    const template = parseOptionalEnumParam(c.req.query("template"), "template", TEMPLATES);
    const quarter = parseOptionalQuarterParam(c.req.query("quarter"));
    const limit = parseOptionalIntParam(c.req.query("limit"), "limit", { min: 1, max: 200 }) ?? 50;
    return c.json({ rule: rule ?? null, template: template ?? null, quarter: quarter?.value ?? null, limit });
  });

  v1.get("/findings/:id", (c) => {
    const id = parseFindingId(c.req.param("id"));
    return c.json({ id });
  });

  v1.post("/settings-check", async (c) => {
    const body = await parseJsonBody(c);
    return c.json({ keys: Object.keys(body) });
  });
};

let api: ApiHarness;
beforeAll(async () => {
  api = await apiHarness({ filings: [], routes: () => [validationRoutes] });
});
afterAll(() => api.close());

describe("unit validators", () => {
  test("parseIntParam accepts valid integers in range and rejects bad input", () => {
    expect(parseIntParam("42", "limit")).toBe(42);
    expect(parseIntParam("0", "offset", { min: 0 })).toBe(0);
    expect(parseIntParam("200", "limit", { min: 1, max: 200 })).toBe(200);

    for (const bad of [undefined, "", "0", "-5", "1.5", "12abc", "1e5", "99999999999999999999"]) {
      expect(() => parseIntParam(bad, "limit")).toThrow(ApiError);
    }
    expect(() => parseIntParam("201", "limit", { min: 1, max: 200 })).toThrow(ApiError);
  });

  test("parseIsoDateParam validates format and real calendar dates", () => {
    expect(parseIsoDateParam("2026-06-30", "period_end")).toBe("2026-06-30");
    expect(parseOptionalIsoDateParam(undefined, "period_end")).toBeUndefined();
    expect(parseOptionalIsoDateParam("", "period_end")).toBeUndefined();

    for (const bad of ["2026-6-30", "2026-02-29", "2026-13-01", "not-a-date"]) {
      expect(() => parseIsoDateParam(bad, "period_end")).toThrow(ApiError);
    }
  });

  test("parseQuarterParam validates YYYY-Q format", () => {
    expect(parseQuarterParam("2026-2")).toEqual({ year: 2026, quarter: 2, value: "2026-2" });
    for (const bad of ["2026", "2026-0", "2026-5", "2026_2", "abcd-1"]) {
      expect(() => parseQuarterParam(bad)).toThrow(ApiError);
    }
  });

  test("parseVersionSelector accepts latest, first and report:<id>", () => {
    expect(parseVersionSelector(undefined)).toBe("latest");
    expect(parseVersionSelector("latest")).toBe("latest");
    expect(parseVersionSelector("first")).toBe("first");
    expect(parseVersionSelector("report:1651411")).toBe("report:1651411");

    for (const bad of ["second", "report:", "report:abc", "report:0", "report:-1"]) {
      expect(() => parseVersionSelector(bad)).toThrow(ApiError);
    }
  });

  test("parseFindingId validates rule and period and normalises ticker", () => {
    expect(parseFindingId("2026-2-katmr-gross_margin_change")).toBe("2026-2-KATMR-gross_margin_change");
    for (const bad of ["2026-2-KATMR-unknown_rule", "2026-5-KATMR-gross_margin_change", "bad"]) {
      expect(() => parseFindingId(bad)).toThrow(ApiError);
    }
  });
});

describe("done when: invalid parameters return 400 with a message", () => {
  test("valid requests succeed with normalised values", async () => {
    const m = await api.get("/v1/companies/katmr/metrics?period=2026-2&version=report:1651411");
    expect(m.status).toBe(200);
    expect(m.body).toEqual({ code: "KATMR", period: "2026-2", version: "report:1651411" });

    const s = await api.get("/v1/reports/1651411/statements/income_statement?view=three_month");
    expect(s.status).toBe(200);
    expect(s.body).toEqual({ document_id: 1651411, statement: "income_statement", view: "three_month" });

    const f = await api.get("/v1/findings?rule=gross_margin_change&template=general&quarter=2026-2&limit=50");
    expect(f.status).toBe(200);
    expect(f.body).toEqual({ rule: "gross_margin_change", template: "general", quarter: "2026-2", limit: 50 });
  });

  test("invalid path parameters return 400 invalid_request naming the parameter", async () => {
    const badDoc = await api.getError("/v1/reports/abc/statements/income_statement", 400);
    expect(badDoc.code).toBe("invalid_request");
    expect(badDoc.message.length).toBeGreaterThan(0);
    expect(badDoc.details).toEqual({ parameter: "document_id" });

    const badStmt = await api.getError("/v1/reports/1651411/statements/unknown_stmt", 400);
    expect(badStmt.code).toBe("invalid_request");
    expect(badStmt.details.parameter).toBe("statement");

    const badCode = await api.getError("/v1/companies/katmr$1/metrics", 400);
    expect(badCode.code).toBe("invalid_request");
    expect(badCode.details).toEqual({ parameter: "code" });

    const badRow = await api.getError("/v1/companies/KATMR/facts/bad-row/versions?period_end=2026-06-30", 400);
    expect(badRow.code).toBe("invalid_request");
    expect(badRow.details).toEqual({ parameter: "row" });

    const badFinding = await api.getError("/v1/findings/not-a-finding-id", 400);
    expect(badFinding.code).toBe("invalid_request");
    expect(badFinding.details).toEqual({ parameter: "id" });
  });

  test("invalid query parameters return 400 invalid_request naming the parameter", async () => {
    const badLimit = await api.getError("/v1/findings?limit=201", 400);
    expect(badLimit.code).toBe("invalid_request");
    expect(badLimit.details).toMatchObject({ parameter: "limit", max: 200 });

    const badRule = await api.getError("/v1/findings?rule=S1", 400);
    expect(badRule.code).toBe("invalid_request");
    expect(badRule.details.parameter).toBe("rule");

    const badQuarter = await api.getError("/v1/findings?quarter=2026-9", 400);
    expect(badQuarter.code).toBe("invalid_request");
    expect(badQuarter.details).toEqual({ parameter: "quarter" });

    const badVersion = await api.getError("/v1/companies/KATMR/metrics?version=report:xyz", 400);
    expect(badVersion.code).toBe("invalid_request");
    expect(badVersion.details).toEqual({ parameter: "version" });

    const badDate = await api.getError(
      "/v1/companies/KATMR/facts/general_role_310003-row-3/versions?period_end=2026-02-30",
      400,
    );
    expect(badDate.code).toBe("invalid_request");
    expect(badDate.details).toEqual({ parameter: "period_end" });

    const badView = await api.getError("/v1/reports/1651411/statements/income_statement?view=yearly", 400);
    expect(badView.code).toBe("invalid_request");
    expect(badView.details.parameter).toBe("view");
  });

  test("malformed or non-object JSON request body returns 400 invalid_request", async () => {
    const malformed = await api.request("/v1/settings-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad json",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      error: { code: "invalid_request", details: { parameter: "body" } },
    });

    const arrayBody = await api.request("/v1/settings-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "[1, 2, 3]",
    });
    expect(arrayBody.status).toBe(400);
    expect(await arrayBody.json()).toMatchObject({
      error: { code: "invalid_request", details: { parameter: "body" } },
    });

    expect(api.internalErrors).toEqual([]);
  });
});
