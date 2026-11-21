/**
 * Compute a report's findings after it is loaded (#210, processor #166) and store them with `writeFindings` (#185,
 * #186): S1 (`gross_margin_change`), S2 (`profit_cash_divergence`) and S3 (`restated_comparatives`), with every step
 * and every input's source (#72), under the configuration's `version` (#69, `config_versions` #187).
 *
 * A report is read from its own rows in DuckDB (`reports`, `facts`, `check_results`), so its findings always match the
 * stored report and can be recomputed for any loaded report without reading Zova again.
 *
 * **Blocking checks (decisions 0003, 0006; `docs/SCHEMA.md`).** A report produces no findings when:
 * - it has any failing blocking check in `check_results` (`severity = 'blocking' AND status = 'fail'`), known filing
 *   errors included; or
 * - it has values (`facts`) but no rows in `check_results` (it has not been checked).
 * Its findings under the configuration version are still written (as `[]`), so a report that had findings and later
 * becomes blocked (or fails a new threshold) loses them under that version.
 */
import {
  detectCashProfitQualityDivergence,
  detectGrossMarginDeviation,
  detectRestatementTripwire,
  type IsoDate,
  type ParsedFiling,
  type ParsedFinancialFact,
  type PeriodType,
  type SignalObject,
  type StatementType,
  type VigilConfig,
} from "@vigil/core";
import { loadConfig, storeActiveConfig, storeConfigVersion } from "./config.ts";
import { type Database, rows } from "./db.ts";
import { type FindingsWrite, writeFindings } from "./findings-store.ts";

/** A loaded report and its check status, rebuilt from `reports`, `facts` and `check_results`. */
export interface LoadedReport {
  filing: ParsedFiling;
  /** True when the report fails a blocking check, or has values without any check rows (`docs/SCHEMA.md`). */
  blocked: boolean;
}

/** Read a loaded report and its blocking status from DuckDB; null when the report is not loaded. */
export async function readLoadedFiling(db: Database, disclosureId: number): Promise<LoadedReport | null> {
  const id = BigInt(disclosureId);
  const [r] = await rows(
    db,
    `SELECT company_code, raw_ticker_group, year, quarter, consolidation_type, template_family, scale_unit,
       scale_multiplier::VARCHAR AS scale_multiplier, has_tms29_monetary_item, filepath,
       strftime(published_at, '%Y-%m-%dT%H:%M:%S') AS published_at
     FROM reports WHERE disclosure_id = $1`,
    [id],
  );
  if (r === undefined) return null;

  const factRows = await rows(
    db,
    `SELECT row_id, column_class, role_code, statement_type, label_tr, footnote_ref, period_type, period_label,
       strftime(period_start, '%Y-%m-%d') AS period_start, strftime(period_end, '%Y-%m-%d') AS period_end,
       is_comparative, raw_value::VARCHAR AS raw_value, scale_unit, scale_multiplier::VARCHAR AS scale_multiplier,
       normalized_value_tl::VARCHAR AS normalized_value_tl
     FROM facts WHERE disclosure_id = $1
     ORDER BY role_code, CAST(split_part(row_id, '-row-', 2) AS INTEGER),
       CAST(split_part(column_class, 'col-order-class-', 2) AS INTEGER), row_id, column_class`,
    [id],
  );

  const company_code = String(r.company_code);
  const raw_ticker_group = String(r.raw_ticker_group);
  const year = Number(r.year);
  const quarter = Number(r.quarter);
  const consolidation_type = String(r.consolidation_type);
  const template_family = String(r.template_family);
  const roleSet = new Set<string>();
  let period_start: IsoDate | null = null;
  let period_end: IsoDate | null = null;

  const facts: ParsedFinancialFact[] = factRows.map((f) => {
    const role_code = String(f.role_code);
    roleSet.add(role_code);
    const is_restated_comparative = Boolean(f.is_comparative);
    const start = f.period_start === null ? null : (String(f.period_start) as IsoDate);
    const end = f.period_end === null ? null : (String(f.period_end) as IsoDate);
    if (!is_restated_comparative && start !== null && end !== null) {
      if (period_start === null || start < period_start || (start === period_start && end < (period_end as IsoDate))) {
        period_start = start;
        period_end = end;
      }
    }
    return {
      company_code,
      raw_ticker_group,
      disclosure_id: disclosureId,
      year,
      quarter,
      consolidation_type,
      template_family,
      role_code,
      statement_type: String(f.statement_type) as StatementType,
      row_id: String(f.row_id),
      label_tr: String(f.label_tr),
      footnote_ref: f.footnote_ref === null ? null : String(f.footnote_ref),
      column_class: String(f.column_class),
      period_type: String(f.period_type) as PeriodType,
      period_label: String(f.period_label),
      is_restated_comparative,
      raw_value: BigInt(String(f.raw_value)),
      scale_unit: String(f.scale_unit),
      scale_multiplier: BigInt(String(f.scale_multiplier)),
      normalized_value_tl: BigInt(String(f.normalized_value_tl)),
      period_start: start,
      period_end: end,
    };
  });

  const [checkCounts] = await rows(
    db,
    `SELECT count(*) AS total,
       count(*) FILTER (severity = 'blocking' AND status = 'fail') AS blocking_failed
     FROM check_results WHERE disclosure_id = $1`,
    [id],
  );
  const totalChecks = Number(checkCounts?.total ?? 0);
  const blockingFailed = Number(checkCounts?.blocking_failed ?? 0);
  const blocked = blockingFailed > 0 || (facts.length > 0 && totalChecks === 0);

  const filepath = String(r.filepath);
  return {
    filing: {
      file_name: filepath.split(/[\\/]/).pop() ?? filepath,
      company_code,
      raw_ticker_group,
      disclosure_id: disclosureId,
      year,
      quarter,
      scale_unit: String(r.scale_unit),
      scale_multiplier: BigInt(String(r.scale_multiplier)),
      consolidation_type,
      template_family,
      role_codes: [...roleSet],
      has_tms29_monetary_item: Boolean(r.has_tms29_monetary_item),
      facts,
      published_at: r.published_at === null ? null : String(r.published_at),
      period_start,
      period_end,
      title_disagreements: 0,
      titles_without_text: 0,
    },
    blocked,
  };
}

/** Run S1–S3 on one filing; returns the findings in rule order (S1, S2, S3). Empty when `blocked` is true. */
export function computeReportFindings(
  filing: ParsedFiling,
  config: VigilConfig,
  options: { blocked?: boolean } = {},
): SignalObject[] {
  if (options.blocked) return [];
  const out: SignalObject[] = [];
  for (const detect of [
    detectGrossMarginDeviation,
    detectCashProfitQualityDivergence,
    detectRestatementTripwire,
  ] as const) {
    const s = detect(filing, config);
    if (s !== null) out.push(s);
  }
  return out;
}

export interface FindingsRefreshOptions {
  /** Thresholds to run the rules with; defaults to the active configuration file (`config/vigil.json`, #69). */
  config?: VigilConfig;
  now?: Date;
}

async function ensureConfig(db: Database, options: FindingsRefreshOptions): Promise<VigilConfig> {
  if (options.config !== undefined) {
    const text = JSON.stringify(options.config, (_k, v) => (typeof v === "bigint" ? Number(v) : v), 2);
    await storeConfigVersion(db, text, options.config.version, { now: options.now });
    return options.config;
  }
  await storeActiveConfig(db, { now: options.now });
  return loadConfig();
}

/**
 * Compute and store the findings of one loaded report under the configuration's `version` (#210).
 * A report that fails a blocking check (or has values without check rows) gets no findings. Returns null when the
 * report is not loaded.
 */
export async function computeAndStoreFindings(
  db: Database,
  disclosureId: number,
  options: FindingsRefreshOptions = {},
): Promise<FindingsWrite | null> {
  const loaded = await readLoadedFiling(db, disclosureId);
  if (loaded === null) return null;
  const config = await ensureConfig(db, options);
  const signals = computeReportFindings(loaded.filing, config, { blocked: loaded.blocked });
  return writeFindings(db, [disclosureId], signals, { configVersion: config.version, now: options.now });
}

/** Refresh the findings of a loaded report (#210). Returns the write summary, or null when the report is not loaded. */
export async function refreshFindings(
  db: Database,
  disclosureId: number,
  options: FindingsRefreshOptions = {},
): Promise<FindingsWrite | null> {
  return computeAndStoreFindings(db, disclosureId, options);
}
