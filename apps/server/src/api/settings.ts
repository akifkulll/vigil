/**
 * `GET` and `PUT /v1/settings` (#226, docs/API.md "Endpoints"): read and update local settings (`settings.ts`, #195).
 *
 * The LLM API key is write-only: `GET` and `PUT` both return `toApiSettings(...)`, which exposes `api_key_set` and
 * never returns the key itself.
 */
import {
  defaultSettingsPath,
  readSettings,
  SettingsError,
  type StoredSettings,
  toApiSettings,
  writeSettings,
} from "../settings.ts";
import { ApiError, type Routes } from "./app.ts";
import { invalidRequest, parseJsonBody } from "./validation.ts";

const ALLOWED_UPDATE_KEYS: ReadonlySet<string> = new Set(["quarters", "llm"]);

/** Merge a `PUT /v1/settings` update into the stored settings, preserving an existing API key when omitted. */
function mergeSettingsUpdate(existing: StoredSettings, body: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(body)) {
    if (!ALLOWED_UPDATE_KEYS.has(key)) {
      invalidRequest("body", `Güncellenemeyen veya bilinmeyen ayar anahtarı: '${key}'.`);
    }
  }

  let llm: unknown = existing.llm;
  if ("llm" in body && body.llm !== undefined) {
    if (body.llm === null) {
      llm = null;
    } else if (typeof body.llm !== "object" || Array.isArray(body.llm)) {
      invalidRequest("llm", "llm bir nesne veya null olmalı.");
    } else {
      const updateLlm = body.llm as Record<string, unknown>;
      const hasApiKey = "api_key" in updateLlm && updateLlm.api_key !== undefined;
      if (hasApiKey && updateLlm.api_key !== null && typeof updateLlm.api_key !== "string") {
        invalidRequest("llm.api_key", "api_key metin veya null olmalı.");
      }
      const keepExistingKey =
        !hasApiKey && existing.llm !== null && existing.llm.provider === updateLlm.provider
          ? existing.llm.api_key
          : null;
      llm = {
        ...updateLlm,
        api_key: hasApiKey ? updateLlm.api_key : keepExistingKey,
      };
    }
  }

  return {
    data_dir: existing.data_dir,
    quarters: "quarters" in body && body.quarters !== undefined ? body.quarters : existing.quarters,
    llm,
  };
}

export function settingsRoutes(settingsPath = defaultSettingsPath()): Routes {
  return (v1) => {
    v1.get("/settings", (c) => {
      return c.json(toApiSettings(readSettings(settingsPath)));
    });

    v1.put("/settings", async (c) => {
      const body = await parseJsonBody(c);
      const existing = readSettings(settingsPath);
      const candidate = mergeSettingsUpdate(existing, body);
      try {
        const saved = writeSettings(settingsPath, candidate);
        return c.json(toApiSettings(saved));
      } catch (e) {
        if (e instanceof SettingsError) {
          throw new ApiError("invalid_request", e.message, { parameter: "body" });
        }
        throw e;
      }
    });
  };
}
