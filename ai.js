import fs from "node:fs";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import { GOOGLE_API_KEY, MODEL_CANDIDATES, FORCE_MODEL_NAME } from "./config.js";
import { logAiCall, logError } from "./logger.js";

const ai = GOOGLE_API_KEY ? new GoogleGenAI({ apiKey: GOOGLE_API_KEY }) : null;
const modelCooldownUntil = new Map();
const searchUnsupportedModels = new Set();
const WEB_SEARCH_MODELS = new Set([
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-1.5-pro",
  "gemini-1.5-flash",
  "gemini-3.1-flash-lite",
]);

let orderedModels = FORCE_MODEL_NAME ? [FORCE_MODEL_NAME] : [...MODEL_CANDIDATES];
let currentModelIndex = 0;
let modelsPrepared = false;

const MAX_ATTEMPTS_PER_MODEL = 4;
const MAX_COOLDOWN_MS = 15_000;

const MODEL_USAGE_FILE = path.resolve(process.cwd(), "logs/model-usage.json");
const MODEL_DAILY_LIMITS = {
  "gemini-2.5-flash": 20,
  "gemini-3.1-flash-lite": 500,
  "gemini-2.5-flash-lite": 20,
  "gemma-3-12b-it": 14_400,
};

let usageState = null;

const GOOGLE_SEARCH_TOOL = {
  googleSearch: {},
};

function isClaudeModelName(modelName) {
  return /^claude-/i.test(String(modelName || ""));
}

function isGoogleModelName(modelName) {
  return !isClaudeModelName(modelName);
}

function buildHttpError(status, message, extra = {}) {
  const err = new Error(String(message || "http_error"));
  err.status = Number(status || 0);
  Object.assign(err, extra);
  return err;
}

function extractGroundingSources(response) {
  const chunks = response?.candidates?.[0]?.groundingMetadata?.groundingChunks;
  if (!Array.isArray(chunks)) return [];

  const dedup = new Map();
  for (const chunk of chunks) {
    const web = chunk?.web;
    const uri = String(web?.uri || "").trim();
    if (!uri) continue;
    const title = String(web?.title || "").trim();
    if (!dedup.has(uri)) {
      dedup.set(uri, { title, uri });
    }
  }
  return Array.from(dedup.values());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTodayKey() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
}

function defaultUsageState() {
  return { date: getTodayKey(), counts: {} };
}

function persistUsageState() {
  try {
    fs.mkdirSync(path.dirname(MODEL_USAGE_FILE), { recursive: true });
    fs.writeFileSync(MODEL_USAGE_FILE, JSON.stringify(usageState, null, 2), "utf8");
  } catch {
    // Ignore usage persistence failures; runtime behavior still works in-memory.
  }
}

function ensureUsageStateLoaded() {
  if (usageState) {
    if (usageState.date !== getTodayKey()) {
      usageState = defaultUsageState();
      persistUsageState();
    }
    return;
  }

  try {
    if (fs.existsSync(MODEL_USAGE_FILE)) {
      usageState = JSON.parse(fs.readFileSync(MODEL_USAGE_FILE, "utf8"));
    } else {
      usageState = defaultUsageState();
    }
  } catch {
    usageState = defaultUsageState();
  }

  if (!usageState || typeof usageState !== "object" || typeof usageState.counts !== "object") {
    usageState = defaultUsageState();
  }
  if (usageState.date !== getTodayKey()) {
    usageState = defaultUsageState();
    persistUsageState();
  }
}

function getDailyLimit(modelName) {
  return MODEL_DAILY_LIMITS[modelName] ?? Number.POSITIVE_INFINITY;
}

function getUsedCount(modelName) {
  ensureUsageStateLoaded();
  return Number(usageState.counts[modelName] || 0);
}

function hasRemainingQuota(modelName) {
  return getUsedCount(modelName) < getDailyLimit(modelName);
}

function incrementUsage(modelName) {
  ensureUsageStateLoaded();
  usageState.counts[modelName] = getUsedCount(modelName) + 1;
  persistUsageState();
}

function markQuotaExhausted(modelName) {
  ensureUsageStateLoaded();
  usageState.counts[modelName] = getDailyLimit(modelName);
  persistUsageState();
}

function isQuotaError(err) {
  const msg = String(err?.message || "").toLowerCase();
  return (
    msg.includes("resource_exhausted") ||
    msg.includes("quota") ||
    msg.includes("credit balance") ||
    msg.includes("insufficient credits") ||
    msg.includes("billing")
  );
}

function isRateLimitError(err) {
  const msg = String(err?.message || "").toLowerCase();
  return (
    err?.status === 429 ||
    msg.includes("rate_limit_error") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("per minute") ||
    msg.includes("per-minute") ||
    msg.includes("perminute") ||
    msg.includes("requests per minute") ||
    msg.includes("rpm")
  );
}

function isHardQuotaExceededError(err) {
  const msg = String(err?.message || "").toLowerCase();
  return (
    isQuotaError(err) &&
    (msg.includes("quota exceeded") ||
      msg.includes("free_tier_requests") ||
      msg.includes("perday") ||
      msg.includes("per day"))
  );
}

function isUnavailableModelError(err) {
  const msg = String(err?.message || "").toLowerCase();
  return err?.status === 404 || msg.includes("not found") || msg.includes("not supported");
}

function isDeprecatedOrRetiredModelError(err) {
  const msg = String(err?.message || "").toLowerCase();
  return (
    err?.status === 400 &&
    (msg.includes("deprecated") || msg.includes("retired") || msg.includes("end-of-life"))
  );
}

function isNetworkFetchError(err) {
  const msg = String(err?.message || "").toLowerCase();
  const causeCode = String(err?.cause?.code || "").toLowerCase();
  return (
    msg.includes("fetch failed") ||
    causeCode === "enotfound" ||
    causeCode === "eai_again" ||
    causeCode === "econnreset" ||
    causeCode === "etimedout" ||
    causeCode === "econnrefused" ||
    causeCode === "ecanceled"
  );
}

function isTransientError(err) {
  const msg = String(err?.message || "").toLowerCase();
  return (
    isNetworkFetchError(err) ||
    err?.status === 408 ||
    err?.status === 425 ||
    err?.status === 529 ||
    isRateLimitError(err) ||
    err?.status === 500 ||
    err?.status === 502 ||
    err?.status === 503 ||
    err?.status === 504 ||
    msg.includes("overloaded_error") ||
    msg.includes("overloaded") ||
    msg.includes("high demand") ||
    msg.includes("service unavailable") ||
    msg.includes("try again later") ||
    msg.includes("temporar")
  );
}

function isUnsupportedResponseConfigError(err) {
  const msg = String(err?.message || "").toLowerCase();
  return (
    err?.status === 400 &&
    (msg.includes("responsemimetype") ||
      msg.includes("response mime type") ||
      msg.includes("json mode is not enabled") ||
      msg.includes("generationconfig") ||
      msg.includes("invalid argument"))
  );
}

function isSearchToolUnsupportedError(err) {
  const msg = String(err?.message || "").toLowerCase();
  if (err?.status !== 400) return false;
  const mentionsTool = msg.includes("tool") || msg.includes("tools");
  const mentionsSearch = msg.includes("search") || msg.includes("retrieval") || msg.includes("google");
  const unsupported = msg.includes("not supported") || msg.includes("unsupported") || msg.includes("invalid argument");
  return (mentionsTool || mentionsSearch) && unsupported;
}

function parseRetryDelayMs(err) {
  const retryAfterSeconds = Number(err?.retryAfterSeconds);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(MAX_COOLDOWN_MS, Math.max(250, Math.ceil(retryAfterSeconds * 1000)));
  }

  const msg = String(err?.message || "");

  const directMatch = msg.match(/please retry in\s+([\d.]+)s/i);
  if (directMatch) {
    const seconds = Number(directMatch[1]);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(MAX_COOLDOWN_MS, Math.max(250, Math.ceil(seconds * 1000)));
    }
  }

  const jsonLikeMatch = msg.match(/"retryDelay":"(\d+)s"/i);
  if (jsonLikeMatch) {
    const seconds = Number(jsonLikeMatch[1]);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(MAX_COOLDOWN_MS, Math.max(250, seconds * 1000));
    }
  }

  return null;
}

function computeBackoffMs(attempt, err) {
  const hinted = parseRetryDelayMs(err);
  if (hinted != null) return hinted;

  const base = 600 * (2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * 400);
  return Math.min(MAX_COOLDOWN_MS, base + jitter);
}

function findPreferredModelIndex(options = {}) {
  const { respectCooldown = false } = options;
  const total = orderedModels.length;
  if (total === 0) return -1;

  const start = ((currentModelIndex % total) + total) % total;
  const now = Date.now();

  for (let offset = 0; offset < total; offset += 1) {
    const i = (start + offset) % total;
    const modelName = orderedModels[i];

    if (!hasRemainingQuota(modelName)) continue;
    if (respectCooldown) {
      const cooldownUntil = modelCooldownUntil.get(modelName) || 0;
      if (cooldownUntil > now) continue;
    }
    return i;
  }

  return ((currentModelIndex % total) + total) % total;
}

async function prepareModels() {
  if (modelsPrepared) return;
  modelsPrepared = true;
  if (FORCE_MODEL_NAME) return;

  const nonGoogleModels = MODEL_CANDIDATES.filter((modelName) => !isGoogleModelName(modelName));
  const googleModels = MODEL_CANDIDATES.filter((modelName) => isGoogleModelName(modelName));
  if (!GOOGLE_API_KEY || googleModels.length === 0) {
    orderedModels = [...MODEL_CANDIDATES];
    currentModelIndex = 0;
    return;
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${GOOGLE_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) {
      orderedModels = [...MODEL_CANDIDATES];
      currentModelIndex = 0;
      return;
    }

    const data = await res.json();
    const available = new Set(
      (Array.isArray(data.models) ? data.models : [])
        .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent"))
        .map((m) => String(m.name || "").replace(/^models\//, "")),
    );

    const availableGoogle = googleModels.filter((m) => available.has(m));
    const merged = [
      ...(availableGoogle.length > 0 ? availableGoogle : googleModels),
      ...nonGoogleModels,
    ];
    if (merged.length > 0) {
      orderedModels = merged;
      currentModelIndex = 0;
    }
  } catch {
    // Keep configured order when listModels fails.
  }
}

export function getCurrentModelName() {
  ensureUsageStateLoaded();
  const preferredIndex = findPreferredModelIndex({ respectCooldown: false });
  if (preferredIndex >= 0) {
    return orderedModels[preferredIndex];
  }
  return FORCE_MODEL_NAME || MODEL_CANDIDATES[0];
}

async function generateWithGoogle(modelName, prompt, options = {}) {
  const { useWebSearch = false } = options;
  if (!ai) {
    throw buildHttpError(401, "google_api_key_missing");
  }

  const config = { responseMimeType: "application/json" };
  if (useWebSearch) {
    config.tools = [GOOGLE_SEARCH_TOOL];
  }
  const request = {
    model: modelName,
    contents: prompt,
    config,
  };

  try {
    const result = await ai.models.generateContent(request);
    return {
      text: result.text,
      sources: useWebSearch ? extractGroundingSources(result) : [],
    };
  } catch (err) {
    if (!isUnsupportedResponseConfigError(err)) throw err;
    if (!useWebSearch) {
      const legacyResult = await ai.models.generateContent({
        model: modelName,
        contents: prompt,
      });
      return { text: legacyResult.text, sources: [] };
    }
    const legacyResult = await ai.models.generateContent({
      model: modelName,
      contents: prompt,
      config: { tools: [GOOGLE_SEARCH_TOOL] },
    });
    return {
      text: legacyResult.text,
      sources: extractGroundingSources(legacyResult),
    };
  }
}

async function generateJsonFirst(modelName, prompt, options = {}) {
  return generateWithGoogle(modelName, prompt, options);
}

async function tryGenerateWithRetries(modelName, prompt, options = {}) {
  const { useWebSearch = false } = options;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt += 1) {
    try {
      const text = await generateJsonFirst(modelName, prompt, options);
      if (!String(text?.text || "").trim()) {
        const emptyErr = new Error("empty_model_response");
        emptyErr.status = 503;
        throw emptyErr;
      }
      incrementUsage(modelName);
      return { ok: true, text };
    } catch (err) {
      if (useWebSearch && isSearchToolUnsupportedError(err)) {
        logAiCall(modelName, prompt, null, false, err);
        return { ok: false, kind: "search_unsupported", err };
      }

      if (isHardQuotaExceededError(err)) {
        logAiCall(modelName, prompt, null, false, err);
        return { ok: false, kind: "quota_exhausted_hard", err };
      }

      if (isRateLimitError(err)) {
        const delayMs = computeBackoffMs(attempt, err);
        console.warn(
          `Model retry (${modelName}) rate_limited attempt=${attempt}/${MAX_ATTEMPTS_PER_MODEL}, delayMs=${delayMs}, status=${err?.status || ""}, cause=${err?.cause?.code || ""}`,
        );

        if (attempt < MAX_ATTEMPTS_PER_MODEL) {
          await sleep(delayMs);
          continue;
        }

        logAiCall(modelName, prompt, null, false, err);
        return { ok: false, kind: "temporary", err, cooldownMs: delayMs };
      }

      if (isDeprecatedOrRetiredModelError(err) || isUnavailableModelError(err)) {
        logAiCall(modelName, prompt, null, false, err);
        return { ok: false, kind: "permanent", err };
      }

      if (isQuotaError(err)) {
        logAiCall(modelName, prompt, null, false, err);
        return { ok: false, kind: "quota_exhausted_soft", err, cooldownMs: computeBackoffMs(attempt, err) };
      }

      if (!isTransientError(err)) {
        logAiCall(modelName, prompt, null, false, err);
        return { ok: false, kind: "fatal", err };
      }

      const delayMs = computeBackoffMs(attempt, err);
      console.warn(
        `Model retry (${modelName}) attempt=${attempt}/${MAX_ATTEMPTS_PER_MODEL}, delayMs=${delayMs}, status=${err?.status || ""}, cause=${err?.cause?.code || ""}`,
      );

      if (attempt < MAX_ATTEMPTS_PER_MODEL) {
        await sleep(delayMs);
        continue;
      }

      logAiCall(modelName, prompt, null, false, err);
      return { ok: false, kind: "temporary", err, cooldownMs: delayMs };
    }
  }

  return { ok: false, kind: "temporary", err: new Error("unknown"), cooldownMs: 1500 };
}

export async function callModel(prompt, options = {}) {
  const { useWebSearch = false, returnMeta = false, channel } = options;
  if (channel) {
    channel.sendTyping();
  }
  ensureUsageStateLoaded();
  await prepareModels();

  const totalModels = orderedModels.length;
  if (totalModels === 0) {
    const text = JSON.stringify({
      action: "reply",
      message: "사용 가능한 AI 모델이 없습니다. 관리자에게 모델 설정을 확인해 달라고 요청해 주세요.",
    });
    return returnMeta ? { text, sources: [] } : text;
  }

  const eligibleModels = useWebSearch
    ? orderedModels.filter((name) => WEB_SEARCH_MODELS.has(name) && !searchUnsupportedModels.has(name))
    : orderedModels;
  const eligibleTotal = eligibleModels.length;

  if (useWebSearch && eligibleTotal === 0) {
    const text = JSON.stringify({
      action: "reply",
      message: "웹 검색이 가능한 AI 모델이 없습니다. 관리자에게 검색 지원 모델 설정을 확인해 달라고 요청해 주세요.",
    });
    return returnMeta ? { text, sources: [] } : text;
  }

  const preferredIndex = findPreferredModelIndex({ respectCooldown: false });
  const startIndex = preferredIndex >= 0
    ? preferredIndex
    : ((currentModelIndex % totalModels) + totalModels) % totalModels;
  let sawTemporaryFailure = false;
  let nextRetryAt = Number.POSITIVE_INFINITY;
  const preferredLiteModel = MODEL_CANDIDATES.find((m) => m.includes("gemini-3.1-flash-lite"));

  for (let offset = 0; offset < totalModels; offset += 1) {
    const i = (startIndex + offset) % totalModels;
    const modelName = orderedModels[i];

    if (useWebSearch && !WEB_SEARCH_MODELS.has(modelName)) {
      continue;
    }
    if (useWebSearch && searchUnsupportedModels.has(modelName)) {
      continue;
    }

    // Keep Gemma strictly last-resort while 3.1 Flash Lite still has quota.
    if (modelName === "gemma-3-12b-it" && preferredLiteModel && hasRemainingQuota(preferredLiteModel)) {
      continue;
    }

    if (!hasRemainingQuota(modelName)) {
      continue;
    }

    const cooldownUntil = modelCooldownUntil.get(modelName) || 0;
    const now = Date.now();
    if (cooldownUntil > now) {
      sawTemporaryFailure = true;
      nextRetryAt = Math.min(nextRetryAt, cooldownUntil);
      continue;
    }

    const outcome = await tryGenerateWithRetries(modelName, prompt, { useWebSearch });
    if (outcome.ok) {
      currentModelIndex = (i + 1) % totalModels;
      modelCooldownUntil.delete(modelName);
      logAiCall(modelName, prompt, outcome.text?.text || "", true);
      if (returnMeta) return outcome.text;
      return outcome.text?.text || "";
    }

    if (outcome.kind === "temporary") {
      sawTemporaryFailure = true;
      const cooldownMs = Math.min(MAX_COOLDOWN_MS, outcome.cooldownMs || 1500);
      const until = Date.now() + cooldownMs;
      modelCooldownUntil.set(modelName, until);
      nextRetryAt = Math.min(nextRetryAt, until);
      console.warn(`Model failed (${modelName}). failover=true temporary status=${outcome.err?.status || ""}, cause=${outcome.err?.cause?.code || ""}`);
      continue;
    }

    if (outcome.kind === "permanent") {
      if (isHardQuotaExceededError(outcome.err)) {
        markQuotaExhausted(modelName);
      }
      console.warn(`Model failed (${modelName}). failover=true permanent status=${outcome.err?.status || ""}`);
      continue;
    }

    if (outcome.kind === "search_unsupported") {
      searchUnsupportedModels.add(modelName);
      console.warn(`Model failed (${modelName}). failover=true search_unsupported status=${outcome.err?.status || ""}`);
      continue;
    }

    if (outcome.kind === "quota_exhausted_hard") {
      markQuotaExhausted(modelName);
      console.warn(`Model failed (${modelName}). failover=true quota_exhausted_hard status=${outcome.err?.status || ""}`);
      continue;
    }

    if (outcome.kind === "quota_exhausted_soft") {
      sawTemporaryFailure = true;
      const cooldownMs = Math.min(MAX_COOLDOWN_MS, outcome.cooldownMs || 1500);
      const until = Date.now() + cooldownMs;
      modelCooldownUntil.set(modelName, until);
      nextRetryAt = Math.min(nextRetryAt, until);
      console.warn(`Model failed (${modelName}). failover=true quota_exhausted_soft status=${outcome.err?.status || ""}`);
      continue;
    }

    if (outcome.kind === "fatal") {
      console.warn(`Model failed (${modelName}). failover=true fatal status=${outcome.err?.status || ""}`);
      continue;
    }
  }

  if (sawTemporaryFailure && Number.isFinite(nextRetryAt)) {
    const waitSeconds = Math.max(1, Math.ceil((nextRetryAt - Date.now()) / 1000));
    const text = JSON.stringify({
      action: "reply",
      message: `현재 AI 모델 요청이 몰려 응답이 지연되고 있습니다. 약 ${waitSeconds}초 후 다시 시도해 주세요.`,
    });
    return returnMeta ? { text, sources: [] } : text;
  }

  if (useWebSearch && eligibleModels.length > 0 && eligibleModels.every((name) => searchUnsupportedModels.has(name))) {
    const text = JSON.stringify({
      action: "reply",
      message: "웹 검색을 지원하는 모델이 없어 응답할 수 없습니다. 관리자에게 모델 설정을 확인해 달라고 요청해 주세요.",
    });
    return returnMeta ? { text, sources: [] } : text;
  }

  const quotaCheckModels = useWebSearch
    ? orderedModels.filter((name) => WEB_SEARCH_MODELS.has(name) && !searchUnsupportedModels.has(name))
    : orderedModels;
  const allQuotaExhausted = quotaCheckModels.length > 0 && quotaCheckModels.every((m) => !hasRemainingQuota(m));
  if (allQuotaExhausted) {
    const text = JSON.stringify({
      action: "reply",
      message: useWebSearch
        ? "오늘 사용 가능한 웹 검색 모델 호출 한도를 모두 소진했습니다. 내일 다시 시도해 주세요."
        : "오늘 사용 가능한 모델 호출 한도를 모두 소진했습니다. 내일 다시 시도해 주세요.",
    });
    return returnMeta ? { text, sources: [] } : text;
  }

  console.error("AI call failed: all models unavailable or daily quota exhausted.");
  logAiCall("all_models", prompt, null, false);
  const text = JSON.stringify({
    action: "reply",
    message: "현재 모든 AI 모델이 일시적으로 사용 불가하거나 호출 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.",
  });
  return returnMeta ? { text, sources: [] } : text;
}
