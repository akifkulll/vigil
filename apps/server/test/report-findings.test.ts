/**
 * Computing a report's findings after loading it (#210, processor #166).
 *
 * Expected values come from `tests/golden/2026_2/KATMR_1651411.csv` and the worked example in `docs/API.md`
 * ("Example: KATMR 2026/2, gross margin change (S1)", -2596 bps, 7 steps, 4 inputs), plus synthetic filings for S2,
 * S3, blocking check failures (decisions 0003, 0006), corrected reports and database rebuilds (#162).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blockingFailures,
  checkFiling,
  detectCashProfitQualityDivergence,
  detectGrossMarginDeviation,
  detectRestatementTripwire,
  type ParsedFiling,
  parseKapXls,
  reconcile,
  type SignalObject,
} from "@vigil/core";
import { CONFIG, fact, katmrFromGolden, periodFromLabel, REPO } from "../../../packages/core/test/helpers.ts";
import { storedConfigVersions } from "../src/config.ts";
import { close, connect, type Database, loadFiling, rows } from "../src/db.ts";
import { emit } from "../src/events.ts";
import { readCalculation } from "../src/findings-store.ts";
import { loadInto, processPending } from "../src/processor.ts";
import { WriteQueue } from "../src/queue.ts";
import { storeRawFile } from "../src/raw-files.ts";
import { rebuildDatabase } from "../src/rebuild.ts";
import { computeAndStoreFindings, computeReportFindings, readLoadedFiling } from "../src/report-findings.ts";
import { migrateStore } from "../src/store-schema.ts";
import { memoryStore, type Store } from "../src/zova.ts";
import { type FixtureFiling, fileName, kapHtml } from "./fixtures/index.ts";

const KATMR = 1651411;
const AKTVK = 1647085;
const V = CONFIG.version;

/**
 * KATMR 2026/2 from its golden file (`tests/golden/2026_2/KATMR_1651411.csv`), with the remaining subtotal lines filled
 * so `checkFiling` passes every subtotal check as the full filing does (the golden file excerpts 16 rows and passes
 * `reconcile`; the remaining components of those subtotals are added here so every subtotal equals its components).
 */
function katmrCompleteFiling(): ParsedFiling {
  const base = katmrFromGolden();
  expect(blockingFailures(reconcile(base))).toEqual([]);
  const byKey = new Map(base.facts.map((f) => [`${f.row_id}|${f.column_class}`, f]));
  const get = (role: string, row: number, col: string) =>
    byKey.get(`general_role_${role}-row-${row}|${col}`) as (typeof base.facts)[0];
  const addRow = (template: (typeof base.facts)[0], role: string, row: number, label: string, value: bigint) =>
    fact({
      ...template,
      role_code: role,
      row_id: `general_role_${role}-row-${row}`,
      label_tr: label,
      raw_value: value,
      normalized_value_tl: value,
      ...periodFromLabel(template.period_label),
    });

  const extra: (typeof base.facts)[0][] = [];
  for (const col of ["col-order-class-4", "col-order-class-5"]) {
    const r4 = get("210015", 4, col);
    const r55 = get("210015", 55, col);
    const r294 = get("210015", 294, col);
    const r296 = get("210015", 296, col);
    extra.push(
      addRow(r55, "210015", 49, "Diğer Dönen Varlıklar", r55.raw_value - r4.raw_value),
      addRow(r55, "210015", 52, "ARA TOPLAM", r55.raw_value),
      addRow(r296, "210015", 245, "Ödenmiş Sermaye", r296.raw_value - r294.raw_value),
      addRow(r296, "210015", 244, "Ana Ortaklığa Ait Özkaynaklar", r296.raw_value),
    );
    const cf2 = get("520003", 2, col);
    const cf120 = get("520003", 120, col);
    const cf162 = get("520003", 162, col);
    const cf206 = get("520003", 206, col);
    const cf204 = cf2.raw_value + cf120.raw_value + cf162.raw_value;
    extra.push(
      addRow(
        cf206,
        "520003",
        204,
        "YABANCI PARA ÇEVRİM FARKLARININ ETKİSİNDEN ÖNCE NAKİT VE NAKİT BENZERLERİNDEKİ NET ARTIŞ (AZALIŞ)",
        cf204,
      ),
      addRow(
        cf206,
        "520003",
        205,
        "Yabancı Para Çevrim Farklarının Nakit ve Nakit Benzerleri Üzerindeki Etkisi",
        cf206.raw_value - cf204,
      ),
    );
  }
  for (const col of ["col-order-class-4", "col-order-class-5", "col-order-class-6", "col-order-class-7"]) {
    const r31 = get("310003", 31, col);
    const r38 = get("310003", 38, col);
    const r53 = get("310003", 53, col);
    const r59 = get("310003", 59, col);
    const r62 = get("310003", 62, col);
    extra.push(
      addRow(r31, "310003", 32, "Genel Yönetim Giderleri", r38.raw_value - r31.raw_value),
      addRow(r38, "310003", 49, "FİNANSMAN GELİRİ (GİDERİ) ÖNCESİ FAALİYET KARI (ZARARI)", r38.raw_value),
      addRow(r53, "310003", 51, "Finansman Giderleri", r53.raw_value - r38.raw_value),
      addRow(r59, "310003", 54, "Sürdürülen Faaliyetler Vergi (Gideri) Geliri", r59.raw_value - r53.raw_value),
      addRow(r59, "310003", 57, "SÜRDÜRÜLEN FAALİYETLER DÖNEM KARI (ZARARI)", r59.raw_value),
      addRow(r62, "310003", 61, "Kontrol Gücü Olmayan Paylar", r59.raw_value - r62.raw_value),
    );
  }
  const facts = [...base.facts.filter((f) => f.row_id !== "general_role_310003-row-42"), ...extra];
  const full = { ...base, facts };
  expect(blockingFailures(checkFiling(full))).toEqual([]);
  return full;
}
/** The finding JSON of `docs/API.md`'s "Example: KATMR 2026/2, gross margin change (S1)". */
function apiExample() {
  const doc = readFileSync(join(REPO, "docs", "API.md"), "utf8");
  const section = doc.slice(doc.indexOf("## Example: KATMR 2026/2, gross margin change (S1)"));
  const block = /```json\n([\s\S]*?)\n```/.exec(section.replaceAll("\r\n", "\n"));
  if (block === null) throw new Error("no JSON example in docs/API.md");
  return JSON.parse(block[1] as string);
}

/** Turn a `ParsedFiling` (such as `katmrFromGolden()`) into KAP `.xls` HTML so the processor can parse it from Zova. */
function parsedToKapHtml(filing: ParsedFiling): string {
  const shown = (n: bigint): string => {
    const abs = n < 0n ? -n : n;
    const s = abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    return n < 0n ? `-${s}` : s;
  };
  const pub =
    filing.published_at === null
      ? "17.08.2026 19:05:18"
      : (() => {
          const [date, time] = filing.published_at.split("T") as [string, string];
          const [y, m, d] = date.split("-");
          return `${d}.${m}.${y} ${time}`;
        })();

  const roles = [...new Set(filing.facts.map((f) => f.role_code))];
  const tables = roles.map((role) => {
    const roleFacts = filing.facts.filter((f) => f.role_code === role);
    const cols = [...new Set(roleFacts.map((f) => f.column_class))].sort(
      (a, b) => Number(a.split("-").pop()) - Number(b.split("-").pop()),
    );
    const maxCol = Math.max(4, ...cols.map((c) => Number(c.split("-").pop())));
    const headers: string[] = [];
    for (let c = 4; c <= maxCol; c++) {
      const colClass = `col-order-class-${c}`;
      const label = roleFacts.find((f) => f.column_class === colClass)?.period_label ?? `Cari Dönem 30.06.2026`;
      headers.push(label);
    }
    const headerHtml = `<tr><td></td>${headers.map((h) => `<td class="context-header"><div>${h}</div></td>`).join("")}</tr>`;

    const rowIds = [...new Set(roleFacts.map((f) => f.row_id))];
    const rowsHtml = rowIds.map((rowId) => {
      const rFacts = roleFacts.filter((f) => f.row_id === rowId);
      const label = rFacts[0]?.label_tr ?? "";
      const byCol = new Map(rFacts.map((f) => [f.column_class, f.raw_value]));
      const cells: string[] = [];
      for (let c = 4; c <= maxCol; c++) {
        const colClass = `col-order-class-${c}`;
        const v = byCol.get(colClass);
        const inner = v === undefined ? '<div class="gwt-Label"></div>' : `<div title="${v}">${shown(v)}</div>`;
        cells.push(`<td class="taxonomy-context-value ${colClass}"><div>${inner}</div></td>`);
      }
      return (
        `<tr class="${rowId} data-input-row presentation-enabled">` +
        `<td><div class="gwt-Label multi-language-content content-tr">${label}</div></td>${cells.join("")}</tr>`
      );
    });
    const cls = `${filing.template_family}_role_${role}`;
    return `<table class="financial-table tbl_${cls}" border="1">${headerHtml}${rowsHtml.join("")}</table>`;
  });

  return (
    `<html><head><meta charset="utf-8"></head><body><div> Gönderim Tarihi:${pub} </div>` +
    `<table><tr><td>Sunum Para Birimi</td><td>${filing.scale_unit}</td>` +
    `<td>Finansal Tablo Niteliği</td><td>${filing.consolidation_type}</td></tr></table>` +
    `${tables.join("")}</body></html>`
  );
}

const H1_HEADERS = [
  "Cari Dönem <br>01.01.2026 - 30.06.2026",
  "Önceki Dönem <br>01.01.2025 - 30.06.2025",
  "Cari Dönem 3 Aylık <br>01.04.2026 - 30.06.2026",
  "Önceki Dönem 3 Aylık <br>01.04.2025 - 30.06.2025",
];

/**
 * A consistent real-sector 2026/2 report in 1,000 TL (thousands) that passes every blocking check and triggers all
 * three rules (S1, S2 and S3):
 * - S1: Q2 gross margin 20% (40,000 / 200,000) vs 40% prior year (60,000 / 150,000) -> -2000 bps;
 * - S2: YTD net profit 250,000k (250 mn TL), operating cash flow -150,000k (-150 mn TL), monetary gain 300,000k;
 * - S3: third balance sheet column (col-6, restated opening 31.12.2024) has 2 populated rows (rows 4 and 129).
 */
function allThreeRulesFiling(
  overrides: { disclosureId?: number; ticker?: string; q2GrossProfit?: number; unbalancedAssets?: number } = {},
): FixtureFiling {
  const gpQ2 = overrides.q2GrossProfit ?? 40_000;
  const cogsQ2 = gpQ2 - 200_000;
  const assetsCurrent = overrides.unbalancedAssets ?? 1_000_000;
  return {
    ticker: overrides.ticker ?? "TSTALL",
    disclosureId: overrides.disclosureId ?? 9_200_001,
    year: 2026,
    quarter: 2,
    family: "general",
    unit: "1.000 TL",
    multiplier: 1_000n,
    consolidation: "Konsolide",
    published: "17.08.2026 19:05:18",
    tables: [
      {
        role: "210015",
        headers: ["Cari Dönem <br>30.06.2026", "Önceki Dönem <br>31.12.2025", "Bir Önceki Dönem <br>31.12.2024"],
        rows: [
          { row: 4, label: "Nakit ve Nakit Benzerleri", values: { 4: 1_000_000, 5: 900_000, 6: 800_000 } },
          { row: 55, label: "TOPLAM DÖNEN VARLIKLAR", values: { 4: 1_000_000, 5: 900_000 } },
          { row: 129, label: "TOPLAM VARLIKLAR", values: { 4: assetsCurrent, 5: 900_000, 6: 800_000 } },
          { row: 245, label: "Ödenmiş Sermaye", values: { 4: 750_000, 5: 700_000 } },
          { row: 294, label: "Net Dönem Karı veya Zararı", values: { 4: 250_000, 5: 200_000 } },
          { row: 244, label: "Ana Ortaklığa Ait Özkaynaklar", values: { 4: 1_000_000, 5: 900_000 } },
          { row: 296, label: "TOPLAM ÖZKAYNAKLAR", values: { 4: 1_000_000, 5: 900_000 } },
          { row: 297, label: "TOPLAM KAYNAKLAR", values: { 4: 1_000_000, 5: 900_000 } },
        ],
      },
      {
        role: "310003",
        headers: H1_HEADERS,
        rows: [
          { row: 3, label: "Hasılat", values: { 4: 500_000, 5: 400_000, 6: 200_000, 7: 150_000 } },
          { row: 4, label: "Satışların Maliyeti", values: { 4: -250_000, 5: -200_000, 6: cogsQ2, 7: -90_000 } },
          {
            row: 5,
            label: "TİCARİ FAALİYETLERDEN BRÜT KAR (ZARAR)",
            values: { 4: 250_000, 5: 200_000, 6: gpQ2, 7: 60_000 },
          },
          { row: 31, label: "BRÜT KAR (ZARAR)", values: { 4: 250_000, 5: 200_000, 6: gpQ2, 7: 60_000 } },
          { row: 38, label: "ESAS FAALİYET KARI (ZARARI)", values: { 4: 250_000, 5: 200_000, 6: gpQ2, 7: 60_000 } },
          {
            row: 49,
            label: "FINANSMAN GELİRİ (GİDERİ) ÖNCESİ FAALİYET KARI (ZARARI)",
            values: { 4: 250_000, 5: 200_000, 6: gpQ2, 7: 60_000 },
          },
          { row: 51, label: "Finansman Giderleri", values: { 4: -300_000 } },
          { row: 52, label: "Net Parasal Pozisyon Kazançları (Kayıpları)", values: { 4: 300_000 } },
          {
            row: 53,
            label: "SÜRDÜRÜLEN FAALİYETLER VERGİ ÖNCESİ KARI (ZARARI)",
            values: { 4: 250_000, 5: 200_000, 6: gpQ2, 7: 60_000 },
          },
          {
            row: 57,
            label: "SÜRDÜRÜLEN FAALİYETLER DÖNEM KARI (ZARARI)",
            values: { 4: 250_000, 5: 200_000, 6: gpQ2, 7: 60_000 },
          },
          { row: 59, label: "DÖNEM KARI (ZARARI)", values: { 4: 250_000, 5: 200_000, 6: gpQ2, 7: 60_000 } },
          { row: 62, label: "Ana Ortaklık Payları", values: { 4: 250_000, 5: 200_000, 6: gpQ2, 7: 60_000 } },
        ],
      },
      {
        role: "520003",
        headers: H1_HEADERS.slice(0, 2),
        rows: [{ row: 2, label: "İŞLETME FAALİYETLERİNDEN NAKİT AKIŞLARI", values: { 4: -150_000, 5: 50_000 } }],
      },
    ],
  };
}

let db: Database;
let store: Store;
let queue: WriteQueue;

beforeEach(async () => {
  db = await connect(":memory:");
  store = memoryStore();
  migrateStore(store);
  queue = new WriteQueue();
});

afterEach(async () => {
  await queue.close();
  store.close();
  close(db);
});

function putHtml(name: string, html: string, downloadedAt = new Date("2026-10-20T08:00:00Z")): void {
  storeRawFile(
    store,
    new TextEncoder().encode(html),
    { fileName: name, sourceUrl: `file:///raw/${name}`, downloadedAt },
    {
      onStored: (s, f) =>
        emit(s, "report_stored", f.object_id, { disclosure_id: f.disclosure_id, file_name: f.file_name }),
    },
  );
}

describe("done when: the KATMR S1 finding appears after processing 2026/2", () => {
  test("processing KATMR 2026/2 stores its S1 finding (-2596 bps) with all 7 steps and 4 inputs from docs/API.md", async () => {
    const katmr = katmrCompleteFiling();
    putHtml("KATMR_1651411_2026_2.xls", parsedToKapHtml(katmr));

    const summary = await processPending(store, queue, { handle: loadInto(db) });
    expect(summary).toEqual({ processed: 1, failed: 0, already_handled: 0, errors: [], gave_up: [] });

    const findings = await rows(
      db,
      "SELECT id, rule, company_code, disclosure_id, year, quarter, size_value, size_unit, config_version FROM findings",
    );
    expect(findings).toEqual([
      {
        id: "2026-2-KATMR-gross_margin_change",
        rule: "gross_margin_change",
        company_code: "KATMR",
        disclosure_id: BigInt(KATMR),
        year: 2026,
        quarter: 2,
        size_value: "-2596",
        size_unit: "bps",
        config_version: V,
      },
    ]);

    const calc = await readCalculation(db, {
      rule: "gross_margin_change",
      disclosure_id: KATMR,
      config_version: V,
    });
    const example = apiExample();
    const expectedSig = detectGrossMarginDeviation(katmr, CONFIG) as SignalObject;
    expect(calc).toEqual(expectedSig.calculation);
    expect(calc?.formula).toBe(example.calculation.formula);
    expect(calc?.definition).toEqual(example.calculation.definition);
    expect(calc?.steps).toHaveLength(7);
    expect(calc?.steps[0]).toEqual(example.calculation.steps[0]);

    // The active configuration version was also recorded in config_versions (#187).
    const versions = await storedConfigVersions(db);
    expect(versions.map((v) => v.version)).toEqual([V]);
  });
});

describe("running S1–S3 and storing steps and inputs", () => {
  test("runs S1, S2 and S3 for a report and stores every finding with its steps and inputs", async () => {
    const f = allThreeRulesFiling();
    putHtml(fileName(f), kapHtml(f));
    await processPending(store, queue, { handle: loadInto(db) });

    const stored = await rows(
      db,
      "SELECT id, rule, size_value, size_unit FROM findings WHERE disclosure_id = $1 ORDER BY rule",
      [BigInt(f.disclosureId)],
    );
    expect(stored).toEqual([
      {
        id: "2026-2-TSTALL-gross_margin_change",
        rule: "gross_margin_change",
        size_value: "-2000",
        size_unit: "bps",
      },
      {
        id: "2026-2-TSTALL-profit_cash_divergence",
        rule: "profit_cash_divergence",
        size_value: "400000000",
        size_unit: "TRY",
      },
      {
        id: "2026-2-TSTALL-restated_comparatives",
        rule: "restated_comparatives",
        size_value: "2",
        size_unit: "count",
      },
    ]);

    const parsed = parseKapXls(kapHtml(f), fileName(f));
    for (const [rule, detect] of [
      ["gross_margin_change", detectGrossMarginDeviation],
      ["profit_cash_divergence", detectCashProfitQualityDivergence],
      ["restated_comparatives", detectRestatementTripwire],
    ] as const) {
      const expected = detect(parsed, CONFIG) as SignalObject;
      const calc = await readCalculation(db, {
        rule,
        disclosure_id: f.disclosureId,
        config_version: V,
      });
      expect(calc).toEqual(expected.calculation);
    }
  });

  test("updating a report replaces its findings: a finding no longer triggered is removed, a kept one keeps created_at", async () => {
    const f1 = allThreeRulesFiling();
    await loadFiling(db, parseKapXls(kapHtml(f1), fileName(f1)));
    const t1 = new Date("2026-11-16T08:00:00Z");
    const w1 = await computeAndStoreFindings(db, f1.disclosureId, { now: t1 });
    expect(w1).toEqual({ added: 3, kept: 0, removed: 0 });

    // Rerunning on the same report keeps all 3 findings and their created_at timestamp.
    const t2 = new Date("2026-11-17T08:00:00Z");
    const w2 = await computeAndStoreFindings(db, f1.disclosureId, { now: t2 });
    expect(w2).toEqual({ added: 0, kept: 3, removed: 0 });
    const timestamps = await rows(db, "SELECT created_at FROM findings WHERE disclosure_id = $1", [
      BigInt(f1.disclosureId),
    ]);
    expect(timestamps.map((r) => r.created_at)).toEqual([t1, t1, t1]);

    // A corrected version where Q2 gross profit is 80,000 (40% margin vs 40% prior year -> 0 bps change) drops S1.
    const f2 = allThreeRulesFiling({ q2GrossProfit: 80_000 });
    putHtml(fileName(f2), kapHtml(f2));
    await processPending(store, queue, { handle: loadInto(db) });

    const remaining = await rows(db, "SELECT rule FROM findings WHERE disclosure_id = $1 ORDER BY rule", [
      BigInt(f1.disclosureId),
    ]);
    expect(remaining.map((r) => r.rule)).toEqual(["profit_cash_divergence", "restated_comparatives"]);
    expect(
      await readCalculation(db, { rule: "gross_margin_change", disclosure_id: f1.disclosureId, config_version: V }),
    ).toBeNull();
  });
});

describe("no findings for a report that fails a blocking check", () => {
  test("a report with a failing blocking check produces no findings when processed", async () => {
    // Unbalanced balance sheet: total assets 1,200,000 vs total liabilities & equity 1,000,000.
    const blockedFiling = allThreeRulesFiling({ unbalancedAssets: 1_200_000 });
    putHtml(fileName(blockedFiling), kapHtml(blockedFiling));
    await processPending(store, queue, { handle: loadInto(db) });

    const loaded = await readLoadedFiling(db, blockedFiling.disclosureId);
    expect(loaded?.blocked).toBe(true);
    // Without the blocking check guard, the filing would produce 3 findings.
    expect(computeReportFindings(loaded?.filing as ParsedFiling, CONFIG, { blocked: false })).toHaveLength(3);
    expect(computeReportFindings(loaded?.filing as ParsedFiling, CONFIG, { blocked: true })).toEqual([]);

    const findings = await rows(db, "SELECT * FROM findings WHERE disclosure_id = $1", [
      BigInt(blockedFiling.disclosureId),
    ]);
    expect(findings).toEqual([]);
    const steps = await rows(db, "SELECT * FROM finding_steps WHERE disclosure_id = $1", [
      BigInt(blockedFiling.disclosureId),
    ]);
    expect(steps).toEqual([]);
  });

  test("a known filing error (decision 0006) still blocks the report from producing findings", async () => {
    const katmr = katmrFromGolden();
    // AKTVK 1647085 is in KNOWN_FILING_ERRORS for balance_sheet_profit_equals_parent_profit.
    const aktvk: ParsedFiling = {
      ...katmr,
      company_code: "AKTVK",
      raw_ticker_group: "AKTVK",
      disclosure_id: AKTVK,
      file_name: `AKTVK_${AKTVK}_2026_2.xls`,
      facts: katmr.facts.map((x) => ({
        ...x,
        company_code: "AKTVK",
        raw_ticker_group: "AKTVK",
        disclosure_id: AKTVK,
        raw_value:
          x.row_id === "general_role_210015-row-294" && x.column_class === "col-order-class-4"
            ? 318919663n + 1000n
            : x.raw_value,
      })),
    };
    putHtml(aktvk.file_name, parsedToKapHtml(aktvk));
    await processPending(store, queue, { handle: loadInto(db) });

    const known = await rows(
      db,
      "SELECT known_error FROM check_results WHERE disclosure_id = $1 AND known_error IS NOT NULL",
      [BigInt(AKTVK)],
    );
    expect(known).toHaveLength(1);
    const findings = await rows(db, "SELECT * FROM findings WHERE disclosure_id = $1", [BigInt(AKTVK)]);
    expect(findings).toEqual([]);
  });

  test("a report with facts but no check_results rows is treated as blocked and loses any earlier findings", async () => {
    const katmr = katmrCompleteFiling();
    await loadFiling(db, katmr);
    await computeAndStoreFindings(db, KATMR);
    expect(await rows(db, "SELECT id FROM findings WHERE disclosure_id = $1", [BigInt(KATMR)])).toHaveLength(1);

    // Simulate an unchecked database state (e.g. upgraded from before migration 4 without reloading check_results).
    await db.con.run("DELETE FROM check_results WHERE disclosure_id = $1", [BigInt(KATMR)]);
    const w = await computeAndStoreFindings(db, KATMR);
    expect(w).toEqual({ added: 0, kept: 0, removed: 1 });
    expect(await rows(db, "SELECT id FROM findings WHERE disclosure_id = $1", [BigInt(KATMR)])).toEqual([]);
  });

  test("when a broken newer version removes a report, its findings are removed too", async () => {
    const f = allThreeRulesFiling();
    putHtml(fileName(f), kapHtml(f), new Date("2026-10-20T08:00:00Z"));
    await processPending(store, queue, { handle: loadInto(db) });
    expect(await rows(db, "SELECT id FROM findings WHERE disclosure_id = $1", [BigInt(f.disclosureId)])).toHaveLength(
      3,
    );

    putHtml(fileName(f), "<html>broken</html>", new Date("2026-10-21T08:00:00Z"));
    await processPending(store, queue, { handle: loadInto(db) });
    expect(await rows(db, "SELECT id FROM findings WHERE disclosure_id = $1", [BigInt(f.disclosureId)])).toEqual([]);
  });

  test("returns null when the disclosure is not loaded in DuckDB", async () => {
    expect(await computeAndStoreFindings(db, 9_999_999)).toBeNull();
  });

  test("a broken config throws before loading the report or its metrics into DuckDB", async () => {
    const f = allThreeRulesFiling();
    putHtml(fileName(f), kapHtml(f));
    const prev = process.env.VIGIL_CONFIG;
    process.env.VIGIL_CONFIG = join(tmpdir(), "vigil-missing-config-for-test.json");
    try {
      const s = await processPending(store, queue, { handle: loadInto(db) });
      expect(s.processed).toBe(0);
      expect(s.errors).toHaveLength(1);
      expect(
        await rows(db, "SELECT disclosure_id FROM reports WHERE disclosure_id = $1", [BigInt(f.disclosureId)]),
      ).toEqual([]);
      expect(
        await rows(db, "SELECT metric_code FROM metrics WHERE disclosure_id = $1", [BigInt(f.disclosureId)]),
      ).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.VIGIL_CONFIG;
      else process.env.VIGIL_CONFIG = prev;
    }
  });
});

test("rebuildDatabase computes findings for every non-blocked report", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vigil-findings-rebuild-"));
  try {
    const clean = allThreeRulesFiling();
    const blocked = allThreeRulesFiling({
      disclosureId: 9_200_002,
      ticker: "TSTBLK",
      unbalancedAssets: 1_200_000,
    });
    putHtml(fileName(clean), kapHtml(clean));
    putHtml(fileName(blocked), kapHtml(blocked));

    const dbPath = join(dir, "vigil.duckdb");
    const summary = await rebuildDatabase(store, dbPath);
    expect(summary.loaded).toBe(2);
    expect(summary.blocked).toBe(1);
    expect(summary.findings).toBe(3);

    const rebuilt = await connect(dbPath);
    try {
      const findings = await rows(rebuilt, "SELECT disclosure_id, rule FROM findings ORDER BY rule");
      expect(findings).toEqual([
        { disclosure_id: BigInt(clean.disclosureId), rule: "gross_margin_change" },
        { disclosure_id: BigInt(clean.disclosureId), rule: "profit_cash_divergence" },
        { disclosure_id: BigInt(clean.disclosureId), rule: "restated_comparatives" },
      ]);
      const steps = await rows(rebuilt, "SELECT count(*) AS n FROM finding_steps");
      expect(Number(steps[0]?.n)).toBeGreaterThan(0);
    } finally {
      close(rebuilt);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
