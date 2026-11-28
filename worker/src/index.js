
import settings from "../../config/settings.json" with { type: "json" };
import { runHourlyTrend, runHourlyAutoPublish, generateHumorVariants, publishThreads } from "./hourly-social.js";

const SETTINGS = settings;

const STAGES = ["topic", "text", "final"];

const STAGE_NAMES = {
  topic: "ТЕМА",
  text: "ТЕКСТ",
  final: "ФИНАЛЬНОЕ РАЗРЕШЕНИЕ"
};

const OUTBOX_RETRY_MS = 30_000;
const TELEGRAM_SAFE_LIMIT = 4000;

// ======================================================
// COMMON HELPERS
// ======================================================

function json(data, status = 200) {
  return Response.json(data, { status });
}

function isAuthorizedChat(chat, env) {
  return (
    chat?.type === "private" &&
    Boolean(env.TELEGRAM_CHAT_ID) &&
    String(chat.id) === String(env.TELEGRAM_CHAT_ID)
  );
}

function splitTelegramText(text, limit = TELEGRAM_SAFE_LIMIT) {
  const chars = Array.from(String(text ?? ""));
  const chunks = [];

  while (chars.length > 0) {
    if (chars.length <= limit) {
      chunks.push(chars.join(""));
      break;
    }

    let cut = limit;
    const paragraphBreak = chars.lastIndexOf("\n", limit - 1);

    if (paragraphBreak > limit * 0.6) {
      cut = paragraphBreak + 1;
    } else {
      const wordBreak = chars.lastIndexOf(" ", limit - 1);

      if (wordBreak > limit * 0.6) {
        cut = wordBreak + 1;
      }
    }

    chunks.push(chars.slice(0, cut).join(""));
    chars.splice(0, cut);
  }

  return chunks;
}

function normalizeEditorialTopic(value) {
  const stop = new Set(["для","при","как","что","это","или","через","между","после","перед","над","под","без","про","когда","который","которая","которые","новый","новая","новые","метод","способ","система","подход","анализ","проверка"]);
  return String(value || "").toLowerCase().replace(/ё/gu, "е").replace(/[^а-яa-z0-9]+/giu, " ").trim().split(/\s+/u)
    .map(word => word.replace(/(иями|ями|ами|ого|ему|ому|ыми|ими|иях|ах|ях|ов|ев|ей|ам|ям|ом|ем|ой|ый|ий|ая|яя|ое|ее|ы|и|а|я|у|ю|е)$/u, ""))
    .filter(word => word.length >= 3 && !stop.has(word));
}
function editorialTopicSimilarity(left, right) {
  const a = normalizeEditorialTopic(left), b = normalizeEditorialTopic(right);
  if (!a.length || !b.length) return 0;
  const A = new Set(a), B = new Set(b);
  const common = [...A].filter(token => B.has(token)).length;
  const containment = common / Math.min(A.size, B.size);
  const jaccard = common / new Set([...A, ...B]).size;
  const bigrams = tokens => new Set(tokens.slice(0, -1).map((token, i) => token + " " + tokens[i + 1]));
  const ba = bigrams(a), bb = bigrams(b);
  const sharedBigrams = [...ba].filter(value => bb.has(value)).length;
  return Math.max(jaccard, containment * 0.82, sharedBigrams ? 0.72 : 0);
}
async function getRecentEditorialTopics(storage, excludeItemId = "", limit = 120) {
  const entries = await storage.list({ prefix: "item:" });
  const items = [...entries.values()].filter(item => item && item.id !== excludeItemId && item.title && item.stage)
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""))).slice(0, limit);
  const saved = await storage.get("editorial:topic_history") || [];
  return [...new Set([...items.map(item => String(item.title).trim()), ...saved.map(item => String(typeof item === "string" ? item : item.title || "").trim())].filter(Boolean))].slice(0, limit);
}
function isSimilarEditorialTopic(candidate, previousTopics) {
  return (previousTopics || []).some(previous => editorialTopicSimilarity(candidate, previous) >= 0.58);
}

function editorialTopicModerationFailure(candidate) {
  const title = String(candidate || "").trim();
  if (!title) return "Пустой заголовок";
  if (/[\r\n]/u.test(title)) return "Заголовок содержит несколько строк";
  if (/https?:\/\/|www\.|#[\p{L}\p{N}_]+/iu.test(title)) return "В заголовке есть ссылка или хэштег";
  if (/^\s*(?:\d+[.)]|[-•*])\s*/u.test(title)) return "Заголовок содержит нумерацию или маркер списка";
  const words = title.split(/\s+/u).filter(Boolean);
  if (words.length < 5 || words.length > 16) return "Нарушена длина заголовка: " + words.length + " слов";
  if (title.length < 25 || title.length > 160) return "Нарушена длина заголовка: " + title.length + " символов";
  return "";
}

async function isSemanticDuplicateEditorialTopic(env, candidate, previousTopics) {
  const comparisonSet = [...new Set((previousTopics || []).map(value => String(value || "").trim()).filter(Boolean))].slice(0, 80);
  if (!comparisonSet.length) return false;
  const verdict = await geminiGenerate(
    env,
    "Ты — независимый редактор-дедупликатор. Сравни новую тему со списком уже предложенных тем. " +
      "Определи совпадение СМЫСЛА, а не слов. Считай темой-дубликатом, если совпадает центральная проблема, объект исследования, схема, метод или практический вопрос, даже если заголовки сформулированы иначе. " +
      "Считай новой только тему с другим самостоятельным предметом и другим редакционным вопросом. " +
      "Если сомневаешься — DUPLICATE. Верни ровно одно слово: DUPLICATE или NEW.\\n\\n" +
      "НОВАЯ ТЕМА: " + candidate + "\\n\\nУЖЕ ПРЕДЛОЖЕННЫЕ ТЕМЫ:\\n" +
      comparisonSet.map((topic, index) => (index + 1) + ". " + topic).join("\\n"),
    { task: "editorial_semantic_deduplication", temperature: 0, maxOutputTokens: 20, maxAttempts: 2, fallbackModels: ["gemini-3.1-flash-lite"] }
  );
  const normalized = String(verdict || "").trim().toUpperCase();
  if (normalized.includes("DUPLICATE")) return true;
  if (normalized.includes("NEW")) return false;
  throw new Error("Семантическая проверка темы вернула некорректный ответ; тема не будет передана на согласование.");
}

function getApprovalContent(item) {
  if (item.stage === "topic") return item.content || "";
  if (item.stage === "text" || item.stage === "final") {
    return String(item.text_content || item.content || "").trim();
  }
  return item.content || "";
}

// ======================================================
// TELEGRAM API
// ======================================================

async function telegram(env, method, data) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(data)
    }
  );

  let result;

  try {
    result = await response.json();
  } catch {
    throw new Error(
      `Telegram returned invalid JSON: ${response.status}`
    );
  }

  if (!response.ok || !result.ok) {
    const description = result.description || "Unknown error";

    console.error("Telegram API error:", {
      method,
      status: response.status,
      description
    });

    throw new Error(
      `Telegram API error: ${method}, status ${response.status}: ${description}`
    );
  }

  return result;
}

// GEMINI AI
// ======================================================

async function geminiGeneratePrimary(env, prompt, options = {}) {
  if (!env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  console.log("Gemini request started:", options.task || "generation");

  const model = options.model || "gemini-3.5-flash-lite";
  const requestBody = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: options.temperature ?? 0.7,
      maxOutputTokens: options.maxOutputTokens ?? 2500,
      ...(options.responseMimeType ? { responseMimeType: options.responseMimeType } : {})
    }
  };
  if (options.googleSearch === true) requestBody.tools = [{ google_search: {} }];

  const requestGemini = async (selectedModel, body) => fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY
      },
      body: JSON.stringify(body)
    }
  );

  let response;
  let result;
  let retryDelaySeconds = null;
  const maxAttempts = Math.max(1, Math.min(3, Number(options.maxAttempts) || 3));
  const fallbackModels = Array.isArray(options.fallbackModels)
    ? [...new Set(options.fallbackModels.map(value => String(value || "").trim()).filter(value => value && value !== model))]
    : [];
  let activeModel = model;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt++;
    let responseText = "";
    try {
      response = await requestGemini(activeModel, requestBody);
      responseText = await response.text();
      try { result = responseText ? JSON.parse(responseText) : {}; }
      catch { result = {}; }
    } catch (networkError) {
      console.warn("Gemini transport failure:", { model: activeModel, attempt, message: String(networkError.message || networkError).slice(0, 250) });
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, Math.min(1500 * attempt, 5000)));
        continue;
      }
      if (fallbackModels.length) {
        const previousModel = activeModel;
        activeModel = fallbackModels.shift();
        attempt = 0;
        console.warn("Gemini transport fallback:", { from: previousModel, to: activeModel });
        continue;
      }
      throw new Error("Gemini transport error: " + String(networkError.message || networkError).slice(0, 350));
    }

    if (response.ok) {
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new Error("Gemini returned malformed JSON with HTTP " + response.status);
      }
      break;
    }

    const details = Array.isArray(result.error?.details) ? result.error.details : [];
    const quotaDetails = details.filter(item => item?.["@type"]?.includes("QuotaFailure"))
      .flatMap(item => Array.isArray(item.violations) ? item.violations : []);
    const retryInfo = details.find(item => item?.["@type"]?.includes("RetryInfo"));
    const retryDelay = retryInfo?.retryDelay || details.find(item => item?.retryDelay)?.retryDelay || "";
    const retryMatch = String(retryDelay).match(/^(\d+(?:\.\d+)?)s$/);
    retryDelaySeconds = retryMatch ? Number(retryMatch[1]) : null;
    const quotaText = quotaDetails.map(item => [item.quotaMetric, item.quotaId, item.description].filter(Boolean).join(" ")).join(" ");
    const dailyQuota = /RequestsPerDay|requests_per_day|generate_content_free_tier_requests/i.test(quotaText);
    const retryable = [408, 425, 429, 500, 502, 503, 504, 522, 524].includes(response.status);
    const retryAfter = response.headers.get("retry-after");
    const retryAfterSeconds = Number(retryAfter);
    const waitSeconds = retryDelaySeconds ?? (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? Math.min(retryAfterSeconds, 15) : Math.min(2 ** (attempt - 1), 8));

    // Gateway failures (including Cloudflare 524 HTML responses) must be
    // retried/fail over before attempting to interpret their response as JSON.
    if ((response.status === 429 || [500, 502, 503, 504, 522, 524].includes(response.status)) && fallbackModels.length) {
      const previousModel = activeModel;
      activeModel = fallbackModels.shift();
      attempt = 0;
      console.warn("Gemini model fallback:", { from: previousModel, to: activeModel, status: response.status, dailyQuota });
      continue;
    }

    if (!retryable || dailyQuota || attempt === maxAttempts || waitSeconds > 20) {
      const errorMessage = result.error?.message || (responseText
        ? responseText.replace(/\s+/g, " ").slice(0, 220)
        : "empty upstream response");
      const quotaInfo = quotaDetails.map(item => [
        item.quotaMetric && "quotaMetric=" + item.quotaMetric,
        item.quotaId && "quotaId=" + item.quotaId,
        item.description && "description=" + item.description
      ].filter(Boolean).join(", ")).filter(Boolean).join("; ");
      const diagnostic = [
        "Модель: " + activeModel,
        quotaInfo ? "Детали лимита: " + quotaInfo : "",
        retryAfter ? "Retry-After: " + retryAfter : "",
        dailyQuota ? "Дневная квота исчерпана; повтор до сброса не поможет" : ""
      ].filter(Boolean).join(". ");
      console.error("Gemini API error:", { status: response.status, model: activeModel, message: errorMessage, quotaInfo, retryAfter, attempt, dailyQuota });
      throw new Error("Gemini API HTTP " + response.status + ": " + errorMessage.slice(0, 350) + (diagnostic ? ". " + diagnostic : ""));
    }

    const delayMs = Math.max(1000, waitSeconds * 1000) + Math.floor(Math.random() * 500);
    console.warn("Gemini transient upstream failure; retrying:", { model: activeModel, attempt, maxAttempts, waitMs: delayMs, status: response.status });
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }

  const answer = result.candidates?.[0]?.content?.parts
    ?.map(part => part.text || "")
    .join("")
    .trim();

  if (!answer) {
    console.error(
      "Gemini returned no text:",
      JSON.stringify(result).slice(0, 1500)
    );

    throw new Error("Gemini returned an empty response");
  }

  console.log("Gemini generation successful:", options.task || "generation");

  if (options.returnMetadata === true) {
    const groundingMetadata = result.candidates?.[0]?.groundingMetadata || null;
    const sources = Array.isArray(groundingMetadata?.groundingChunks)
      ? [...new Set(groundingMetadata.groundingChunks
          .map(chunk => String(chunk?.web?.uri || "").trim())
          .filter(uri => uri.startsWith("https://") || uri.startsWith("http://")))]
      : [];
    return { text: answer, groundingMetadata, sources };
  }
  return answer;
}

// INDEPENDENT WEB SEARCH — hourly facts
// ======================================================

async function tavilySearch(env, query, options = {}) {
  if (!env.TAVILY_API_KEY) {
    throw new Error("TAVILY_API_KEY is not configured. Add the Tavily key as a Cloudflare Worker secret.");
  }

  const requestBody = {
    query,
    topic: "general",
    search_depth: options.search_depth || "basic",
    max_results: Math.max(5, Math.min(20, Number(options.max_results) || 20)),
    include_answer: false,
    include_raw_content: false
  };
  if (Array.isArray(options.include_domains) && options.include_domains.length) {
    requestBody.include_domains = options.include_domains;
  }
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + env.TAVILY_API_KEY
    },
    body: JSON.stringify(requestBody)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = String(data.detail?.error || data.message || data.error || data.detail || "Unknown Tavily error").slice(0, 500);
    throw new Error("Tavily Search API " + response.status + ": " + message);
  }

  const results = Array.isArray(data.results) ? data.results : [];
  const unique = [];
  const seenUrls = new Set();
  const distinctHosts = new Set();
  for (const item of results) {
    const url = String(item.url || "").trim();
    let host = "";
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;
      host = parsed.hostname.toLowerCase().replace(/^www\./u, "");
    } catch (_) { continue; }
    // Keep different pages from the same trusted publisher. The fact checker
    // independently enforces two distinct domains for every individual fact.
    if (!url || !item.content || seenUrls.has(url)) continue;
    seenUrls.add(url);
    distinctHosts.add(host);
    unique.push({
      title: String(item.title || "").slice(0, 240),
      url,
      content: String(item.content || "").slice(0, 1800)
    });
  }

  console.log("Tavily hourly fact search completed:", {
    raw_results: results.length,
    unique_urls: unique.length,
    distinct_hosts: distinctHosts.size,
    request_id: data.request_id || null
  });
  return unique;
}

// GROQ AI — hourly humor only
// ======================================================

async function groqGenerate(env, prompt, options = {}) {
  if (!env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not configured. Add it as a Cloudflare Worker secret.");
  }

  const model = options.model || "openai/gpt-oss-120b";
  console.log("Groq request started:", options.task || "generation", "model:", model);

  const requestBody = {
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: options.temperature ?? 0.7,
    // GPT-OSS spends completion tokens on internal reasoning before writing.
    // Reserve enough budget so reasoning does not consume the entire response.
    max_completion_tokens: options.maxOutputTokens ?? 4096,
    reasoning_effort: options.reasoningEffort || "low",
    ...(options.browserSearch === true ? {
      tools: [{ type: "browser_search" }],
      tool_choice: "required"
    } : {})
  };

  let response;
  let result = {};
  const maxAttempts = Math.max(1, Math.min(2, Number(options.maxAttempts) || 2));
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + env.GROQ_API_KEY
      },
      body: JSON.stringify(requestBody)
    });

    result = await response.json().catch(() => ({}));
    if (response.ok) break;

    const message = result.error?.message || "Unknown Groq API error";
    // Groq may include the model/tool payload that failed its internal parser.
    // Keep this diagnostic in Worker Logs (not Telegram) and cap its size.
    const failedGeneration = result.error?.failed_generation ??
      result.error?.metadata?.failed_generation ??
      result.failed_generation ??
      null;
    const retryMatch = message.match(/try again in ([0-9.]+)s/i);
    const retryAfter = Number(response.headers.get("retry-after") || 0);
    const waitSeconds = Math.max(retryAfter, retryMatch ? Number(retryMatch[1]) : 0);
    const rateHeaders = {
      limit_requests: response.headers.get("x-ratelimit-limit-requests"),
      remaining_requests: response.headers.get("x-ratelimit-remaining-requests"),
      reset_requests: response.headers.get("x-ratelimit-reset-requests"),
      limit_tokens: response.headers.get("x-ratelimit-limit-tokens"),
      remaining_tokens: response.headers.get("x-ratelimit-remaining-tokens"),
      reset_tokens: response.headers.get("x-ratelimit-reset-tokens"),
      retry_after: response.headers.get("retry-after")
    };
    const canRetry = response.status === 429 && attempt < maxAttempts && waitSeconds > 0 && waitSeconds <= 15;

    console.error("Groq API error:", {
      status: response.status,
      message,
      error_type: result.error?.type || null,
      error_code: result.error?.code || null,
      failed_generation: failedGeneration == null
        ? null
        : String(typeof failedGeneration === "string" ? failedGeneration : JSON.stringify(failedGeneration)).slice(0, 2000),
      rate_limits: rateHeaders,
      task: options.task || "generation",
      attempt,
      retry_in_seconds: canRetry ? waitSeconds : null
    });

    if (!canRetry) {
      const limitDetails = [
        rateHeaders.remaining_tokens !== null
          ? "Остаток токенов: " + rateHeaders.remaining_tokens + "; сброс через " + (rateHeaders.reset_tokens || "не указан")
          : "",
        rateHeaders.remaining_requests !== null
          ? "Остаток запросов: " + rateHeaders.remaining_requests + "; сброс через " + (rateHeaders.reset_requests || "не указан")
          : "",
        rateHeaders.retry_after ? "Повторить через " + rateHeaders.retry_after + " сек." : ""
      ].filter(Boolean).join(". ");
      const apiCode = result.error?.code ? " Код: " + result.error.code + "." : "";
      const apiType = result.error?.type ? " Тип: " + result.error.type + "." : "";
      const apiReason = message && message !== "Unknown Groq API error"
        ? " Ответ Groq: " + String(message).slice(0, 700)
        : "";
      const friendly = response.status === 429
        ? "Groq ограничил запросы (HTTP 429)." + apiCode + apiType + apiReason + (limitDetails ? " Заголовки лимитов: " + limitDetails : " Заголовки лимитов не переданы.") + " Ничего не опубликовано."
        : "Ошибка сервиса генерации: " + message;
      throw new Error("Groq API " + response.status + ": " + friendly);
    }

    await new Promise(resolve => setTimeout(resolve, Math.ceil(waitSeconds * 1000) + 350));
  }

  const choice = result.choices?.[0] || {};
  const message = choice.message || {};
  const content = message.content ?? message.reasoning_content ?? message.reasoning;
  const answer = Array.isArray(content)
    ? content.map(part => typeof part === "string" ? part : part?.text || "").join("").trim()
    : String(content || "").trim();

  if (!answer) {
    const finishReason = choice.finish_reason || "unknown";
    const usage = result.usage || {};
    console.error("Groq returned no text:", JSON.stringify({
      id: result.id,
      finish_reason: finishReason,
      usage,
      message_keys: Object.keys(message)
    }).slice(0, 1200));
    throw new Error("Groq returned an empty response (finish_reason=" + finishReason + ", completion_tokens=" + (usage.completion_tokens ?? "unknown") + ")");
  }

  console.log("Groq generation successful:", options.task || "generation");
  if (options.returnMetadata === true) {
    const executedTools = Array.isArray(message.executed_tools) ? message.executed_tools : [];
    const sources = executedTools.flatMap(tool =>
      Array.isArray(tool?.browser_results) ? tool.browser_results.map(item => item?.url || "").filter(Boolean) : []
    );
    return { text: answer, sources: [...new Set(sources)] };
  }
  return answer;
}


/**
 * Unified AI provider with automatic failover.
 * Gemini remains primary; Groq receives the identical prompt/options whenever
 * Gemini is unavailable, rate-limited (including exhausted daily quota), or
 * returns an unusable response. All editorial and utility generation paths
 * call this wrapper, so fallback is not limited to hourly content.
 */
async function geminiGenerate(env, prompt, options = {}) {
  try {
    return await geminiGeneratePrimary(env, prompt, options);
  } catch (geminiError) {
    if (!env.GROQ_API_KEY) {
      console.error("AI provider fallback unavailable: GROQ_API_KEY is missing", {
        task: options.task || "generation",
        gemini_error: String(geminiError.message || geminiError).slice(0, 500)
      });
      throw geminiError;
    }
    console.warn("AI provider failover: Gemini -> Groq", {
      task: options.task || "generation",
      gemini_error: String(geminiError.message || geminiError).slice(0, 500)
    });
    try {
      return await groqGenerate(env, prompt, {
        ...options,
        maxAttempts: Math.max(2, Number(options.groqMaxAttempts) || 2),
        maxOutputTokens: Math.max(1200, Number(options.maxOutputTokens) || 0),
        browserSearch: options.browserSearch === true
      });
    } catch (groqError) {
      console.error("Both AI providers failed", {
        task: options.task || "generation",
        gemini_error: String(geminiError.message || geminiError).slice(0, 350),
        groq_error: String(groqError.message || groqError).slice(0, 500)
      });
      throw new Error("Gemini failed and automatic Groq fallback also failed. Gemini: " +
        String(geminiError.message || geminiError).slice(0, 250) +
        ". Groq: " + String(groqError.message || groqError).slice(0, 350));
    }
  }
}

// APPROVAL MESSAGE
// ======================================================

function approvalMessage(item, chatId) {
  return {
    chat_id: chatId,
    text:
      `OSINT EDITORIAL\n\n` +
      `Материал: ${item.id}\n` +
      `Этап: ${STAGE_NAMES[item.stage]}\n\n` +
      `${getApprovalContent(item)}\n\n` +
      `Выбери решение:`,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "Одобрено — дальше",
            callback_data: `approve:${item.id}:${item.approval_id}`
          },
          {
            text: "Отклонить — стоп",
            callback_data: `reject:${item.id}:${item.approval_id}`
          }
        ],
        [
          {
            text: "На доработку — ещё вариант",
            callback_data: `revise:${item.id}:${item.approval_id}`
          }
        ]
      ]
    }
  };
}


function menuKeyboard(enabled) {
  return {
    inline_keyboard: [
      [{ text: "🧠 Новая редакционная тема", callback_data: "menu:generate" }, { text: "😄 Юмор без очереди", callback_data: "humor:start" }],
      [{ text: "🚀 Интересные факты сейчас", callback_data: "menu:hourly_now" }, { text: "▶️ Включить и запустить", callback_data: "menu:hourly_start" }],
      [{ text: enabled ? "🔴 Выключить автофакты" : "🟢 Включить автофакты", callback_data: "hourly_toggle" }, { text: "👀 Предпросмотр", callback_data: "menu:hourly_preview" }],
      [{ text: "🔗 Статус Threads", callback_data: "menu:threads_status" }, { text: "🔐 Права публикации", callback_data: "menu:threads_publish_check" }],
      [{ text: "📈 Проверить тренды", callback_data: "menu:threads_trends_test" }, { text: "⚙️ Настройки", callback_data: "menu:settings" }],
      [{ text: "🧪 Тест согласования", callback_data: "menu:test" }, { text: "🤖 Проверка Gemini", callback_data: "menu:ai_test" }],
      [{ text: "📤 Повтор публикации", callback_data: "menu:publish_retry" }, { text: "🆔 Мой ID", callback_data: "menu:id" }],
      [{ text: "▶️ /start", callback_data: "menu:start" }, { text: "📋 /menu", callback_data: "menu:menu" }],
      [{ text: "🔄 Обновить меню", callback_data: "hourly_refresh" }]
    ]
  };
}

async function sendMainMenu(env, chatId, userId, messageId = null, welcome = false) {
  const status = await callCoordinator(env, "/hourly-settings", {
    action: "get",
    user_id: userId,
    chat_id: chatId
  });
  const enabled = status.enabled === true;
  const text = (welcome ? "OSINT Editorial подключён.\nСистема управления готова.\n\n" : "") +
    "OSINTNER — ГЛАВНОЕ МЕНЮ\n\n" +
    "Ежечасные факты: " + (enabled ? "ВКЛЮЧЁН" : "ВЫКЛЮЧЕН") + "\n" +
    "Редакционные публикации: 09:00, 12:00, 15:00, 18:00 и 21:00 — с финальным одобрением.\n\n" +
    "Выбери действие:";
  if (!messageId) {
    await telegram(env, "sendMessage", {
      chat_id: chatId,
      text: "Кнопка главного меню закреплена внизу чата. Нажми её в любой момент, чтобы открыть команды.",
      reply_markup: {
        keyboard: [[{ text: "📋 Главное меню" }]],
        resize_keyboard: true,
        is_persistent: true,
        input_field_placeholder: "Выбери «Главное меню» или введи команду"
      }
    });
  }
  const payload = { chat_id: chatId, text, reply_markup: menuKeyboard(enabled) };
  if (messageId) {
    payload.message_id = messageId;
    await telegram(env, "editMessageText", payload);
  } else {
    await telegram(env, "sendMessage", payload);
  }
}

function hourlyVariantsPayload(chatId, result, messageId = null) {
  // Source URLs remain attached to each variant for internal verification,
  // but the Telegram editorial preview shows only the news text.
  const lines = (result.variants || []).map((item, index) =>
    (index + 1) + ". " + item.text
  ).join("\n\n");
  const keyboard = (result.variants || []).map((item, index) => [{
    text: "Опубликовать вариант " + (index + 1),
    callback_data: "hourly:publish:" + result.session_id + ":" + index
  }]);
  keyboard.push([{ text: "Отклонить всю пятёрку", callback_data: "hourly:reject:" + result.session_id }]);
  const payload = {
    chat_id: chatId,
    text: "ЕЖЕЧАСНЫЕ ФАКТЫ — ВЫБЕРИ ОДИН ВАРИАНТ\n" +
      "Тема: " + (result.trend || "Свободная тема") + "\n" +
      "На выбор — 3 минуты. Публикация только после твоего нажатия.\n\n" + lines,
    reply_markup: { inline_keyboard: keyboard }
  };
  if (messageId) payload.message_id = messageId;
  return payload;
}

function humorVariantsPayload(chatId, result, messageId = null) {
  const lines = result.variants.map((item, index) => (index + 1) + ". " + item.text).join("\n\n");
  const keyboard = result.variants.map((item, index) => [{
    text: "Выбрать вариант " + (index + 1),
    callback_data: "humor:pick:" + result.session_id + ":" + index
  }]);
  keyboard.push([{ text: "🔁 Повторная генерация — ещё 5", callback_data: "humor:regen:" + result.session_id }]);
  keyboard.push([{ text: "✖️ Отмена", callback_data: "humor:cancel:" + result.session_id }]);
  const payload = {
    chat_id: chatId,
    text: "ЮМОРНАЯ НОВОСТЬ БЕЗ ОЧЕРЕДИ\nТема: " + result.topic + "\n\n" +
      lines + "\n\nВыбери один вариант для публикации или запроси новую пятёрку.",
    reply_markup: { inline_keyboard: keyboard }
  };
  if (messageId) payload.message_id = messageId;
  return payload;
}

async function runMenuAction(env, action, userId, chatId) {
  if (action === "menu" || action === "start") {
    await sendMainMenu(env, chatId, userId, null, action === "start");
    return;
  }
  if (action === "generate") {
    await telegram(env, "sendMessage", { chat_id: chatId, text: "Запускаю генерацию новой редакционной темы..." });
    await callCoordinator(env, "/generate", { user_id: userId, chat_id: chatId });
    return;
  }
  if (action === "hourly_now" || action === "hourly_start") {
    if (action === "hourly_start") {
      await callCoordinator(env, "/hourly-settings", { action: "enable", user_id: userId, chat_id: chatId });
    }
    const result = await callCoordinator(env, "/hourly-trend", {
      scheduled_at: Date.now(), manual: true, preview: true
    });
    if (result.preview && result.session_id) {
      await telegram(env, "sendMessage", hourlyVariantsPayload(chatId, result));
    } else {
      await telegram(env, "sendMessage", { chat_id: chatId, text: "Не удалось подготовить пятёрку: " + String(result.reason || result.error || "неизвестная ошибка") + (result.detail ? "\nПодробности: " + String(result.detail).slice(0, 700) : "") });
    }
    return;
  }
  if (action === "hourly_preview") {
    const result = await callCoordinator(env, "/hourly-trend", { scheduled_at: Date.now(), manual: true, preview: true });
    if (result.preview && Array.isArray(result.variants) && result.session_id) {
      await telegram(env, "sendMessage", hourlyVariantsPayload(chatId, result));
    } else {
      await telegram(env, "sendMessage", {
        chat_id: chatId,
        text: "Не удалось подготовить пятёрку. Причина: " + String(result.reason || result.error || "неизвестная ошибка") + (result.detail ? "\nПодробности: " + String(result.detail).slice(0, 700) : "")
      });
    }
    return;
  }
  if (action === "threads_status") {
    const result = await callCoordinator(env, "/threads/status", { user_id: userId, chat_id: chatId });
    const expiry = result.expires_at ? new Date(result.expires_at).toLocaleString("ru-RU") : "—";
    await telegram(env, "sendMessage", { chat_id: chatId, text: result.connected
      ? "THREADS: @" + result.username + "\nТокен: " + (result.expired ? "истёк" : "действителен") + "\nСрок действия до: " + expiry
      : "Аккаунт Threads не подключён." });
    return;
  }
  if (action === "threads_publish_check") {
    const result = await callCoordinator(env, "/threads/publish-check", {
      user_id: userId, chat_id: chatId,
      app_id: env.THREADS_APP_ID || "", app_secret: env.THREADS_APP_SECRET || ""
    });
    await telegram(env, "sendMessage", { chat_id: chatId,
      text: "ПРОВЕРКА THREADS PUBLISH\nПрофиль: " + (result.username ? "@" + result.username : "—") +
        "\nID совпадает: " + (result.user_id_matches === true ? "ДА" : result.user_id_matches === false ? "НЕТ" : "неизвестно") +
        "\nthreads_basic: " + (result.has_basic === true ? "есть" : result.has_basic === false ? "нет" : "неизвестно") +
        "\nthreads_content_publish: " + (result.has_publish === true ? "есть" : result.has_publish === false ? "нет" : "неизвестно") +
        "\nРазрешения: " + (result.scopes || []).join(", ") + "\nПубликация не выполнялась." });
    return;
  }
  if (action === "threads_trends_test") {
    const result = await callCoordinator(env, "/threads/trends-test", { user_id: userId, chat_id: chatId });
    const details = (result.countries || []).map(item =>
      item.country + ": HTTP " + (item.http_status ?? "—") +
      (item.count !== undefined ? ", трендов: " + item.count : ", ошибка: " + String(item.error || "неизвестная ошибка")) +
      (item.topics?.length ? "\n" + item.topics.join("\n") : "")
    ).join("\n\n");
    await telegram(env, "sendMessage", {
      chat_id: chatId,
      text: (result.success ? "THREADS TRENDING TOPICS: ДОСТУП ЕСТЬ" : "THREADS TRENDING TOPICS: ОШИБКА ПРОВЕРКИ") +
        "\n\n" + (details || String(result.error || "API не вернул данные.")) +
        "\n\nПроверка только читает тренды. Генерация и публикация не запускались."
    });
    return;
  }
  if (action === "settings") {
    await telegram(env, "sendMessage", { chat_id: chatId,
      text: "OSINTNER SETTINGS\nПлатформа: Threads\nЧасовой пояс: " + SETTINGS.publishing.schedule_timezone +
        "\nРедакционные публикации: " + SETTINGS.publishing.feed_schedule.join(", ") +
        "\nРотация: " + SETTINGS.content_strategy.topic_rotation.join(" → ") + "\nХештеги: отключены" });
    return;
  }
  if (action === "test") {
    await callCoordinator(env, "/test", { user_id: userId, chat_id: chatId });
    return;
  }
  if (action === "ai_test") {
    const answer = await geminiGenerate(env, "Напиши три способа проверить цифровой след компании из открытых источников. Не выдумывай факты.", { task: "ai_test" });
    await telegram(env, "sendMessage", { chat_id: chatId, text: answer });
    return;
  }
  if (action === "id") {
    await telegram(env, "sendMessage", { chat_id: chatId,
      text: "TELEGRAM DIAGNOSTICS\nChat ID: " + chatId + "\nUser ID: " + userId +
        "\nGemini: " + (env.GEMINI_API_KEY ? "configured" : "missing") +
        "\nCoordinator: " + (env.APPROVAL_COORDINATOR ? "configured" : "missing") });
    return;
  }
  if (action === "publish_retry") {
    await telegram(env, "sendMessage", { chat_id: chatId,
      text: "Для безопасного повтора отправь команду:\n/publish_retry material-xxxxxxxx\n\nID материала указан в сообщении о согласовании." });
  }
}

// ======================================================
// DURABLE OBJECT REQUEST
// ======================================================

async function callCoordinator(env, path, payload) {
  if (!env.APPROVAL_COORDINATOR) {
    throw new Error("APPROVAL_COORDINATOR is not configured");
  }

  const id = env.APPROVAL_COORDINATOR.idFromName(
    "osint-editorial"
  );

  const stub = env.APPROVAL_COORDINATOR.get(id);

  const response = await stub.fetch(
    `https://approval-coordinator${path}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  );

  let result;

  try {
    result = await response.json();
  } catch {
    throw new Error(
      `Approval Coordinator returned invalid JSON: ${response.status}`
    );
  }

  if (!response.ok || !result.ok) {
    const detail = String(result.error || result.message || response.status) + (result.detail ? ": " + String(result.detail).slice(0, 700) : "");
    console.error("Approval Coordinator request failed:", { path, status: response.status, detail });
    throw new Error(`Approval Coordinator ${path} error: ${detail} (HTTP ${response.status})`);
  }

  return result;
}

// ======================================================
// MAIN WORKER
// ======================================================

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      const url = new URL(request.url);
      const path = url.pathname;
      const redirectUri = "https://osint-telegram-gateway-staging.vssitner.workers.dev/threads/callback";

      if (path === "/threads/connect") {
        if (!env.THREADS_APP_ID || !env.THREADS_APP_SECRET) {
          return new Response("Threads API credentials are not configured.", { status: 500 });
        }

        try {
          const state = crypto.randomUUID();
          await callCoordinator(env, "/threads/oauth/save-state", {
            state,
            created_at: Date.now()
          });

          const authorizeUrl = new URL("https://threads.net/oauth/authorize");
          authorizeUrl.searchParams.set("client_id", env.THREADS_APP_ID);
          authorizeUrl.searchParams.set("redirect_uri", redirectUri);
          authorizeUrl.searchParams.set("scope", "threads_basic,threads_content_publish");
          authorizeUrl.searchParams.set("response_type", "code");
          authorizeUrl.searchParams.set("state", state);

          return Response.redirect(authorizeUrl.toString(), 302);
        } catch (error) {
          console.error("Threads OAuth start failed:", error.message);
          return new Response("Could not start Threads authorization. Check Worker configuration.", { status: 500 });
        }
      }

      if (path === "/threads/callback") {
        const oauthError = url.searchParams.get("error");
        if (oauthError) {
          return new Response("Threads authorization was not completed. You can close this page.", { status: 400 });
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");

        if (!code || !state) {
          return new Response("Missing Threads authorization code or state.", { status: 400 });
        }

        try {
          await callCoordinator(env, "/threads/oauth/consume-state", { state });

          const tokenForm = new URLSearchParams({
            client_id: env.THREADS_APP_ID,
            client_secret: env.THREADS_APP_SECRET,
            grant_type: "authorization_code",
            redirect_uri: redirectUri,
            code
          });

          const shortTokenResponse = await fetch("https://graph.threads.net/oauth/access_token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokenForm
          });

          if (!shortTokenResponse.ok) {
            console.error("Threads short-lived token exchange failed:", shortTokenResponse.status);
            return new Response("Threads authorization succeeded, but token exchange failed. Check Meta app settings and the registered redirect URI.", { status: 502 });
          }

          const shortToken = await shortTokenResponse.json();
          if (!shortToken.access_token || !shortToken.user_id) {
            console.error("Threads short-lived token response was incomplete.");
            return new Response("Meta returned an incomplete authorization response.", { status: 502 });
          }

          const longTokenUrl = new URL("https://graph.threads.net/access_token");
          longTokenUrl.searchParams.set("grant_type", "th_exchange_token");
          longTokenUrl.searchParams.set("client_secret", env.THREADS_APP_SECRET);
          longTokenUrl.searchParams.set("access_token", shortToken.access_token);

          const longTokenResponse = await fetch(longTokenUrl.toString());
          if (!longTokenResponse.ok) {
            console.error("Threads long-lived token exchange failed:", longTokenResponse.status);
            return new Response("Authorization succeeded, but the long-lived token could not be issued. Please retry.", { status: 502 });
          }

          const longToken = await longTokenResponse.json();
          if (!longToken.access_token) {
            console.error("Threads long-lived token response was incomplete.");
            return new Response("Meta did not return a long-lived access token.", { status: 502 });
          }

          let profileId = "";
          let username = "";
          try {
            const profileUrl = new URL("https://graph.threads.net/v1.0/me");
            profileUrl.searchParams.set("fields", "id,username");
            profileUrl.searchParams.set("access_token", longToken.access_token);
            const profileResponse = await fetch(profileUrl.toString());
            const profile = await profileResponse.json().catch(() => ({}));
            if (!profileResponse.ok || !profile.id || !profile.username) {
              throw new Error(profile.error?.message || "Threads profile ID or username was not returned");
            }
            profileId = String(profile.id);
            username = String(profile.username);
          } catch (profileError) {
            console.error("Threads profile lookup failed:", profileError.message);
            return new Response("Threads authorization succeeded, but the profile ID could not be verified. Please retry the connection.", { status: 502 });
          }

          const expiresIn = Number(longToken.expires_in || 5184000);
          await callCoordinator(env, "/threads/oauth/save-token", {
            access_token: longToken.access_token,
            user_id: profileId,
            username,
            token_type: longToken.token_type || "bearer",
            expires_at: Date.now() + expiresIn * 1000,
            saved_at: Date.now()
          });

          const accountLabel = username ? "@" + username : "аккаунт Threads";
          const expiryDate = new Date(Date.now() + expiresIn * 1000).toLocaleDateString("ru-RU");
          return new Response(
            "Threads успешно подключён: " + accountLabel + ". Долгосрочный токен сохранён на стороне Worker до " + expiryDate + ". Эту страницу можно закрыть.",
            { headers: { "Content-Type": "text/plain; charset=utf-8" } }
          );
        } catch (error) {
          console.error("Threads OAuth callback failed:", error.message);
          return new Response("Threads authorization could not be completed. Check that the redirect URI is registered and try again.", { status: 400 });
        }
      }

      return new Response("OSINT Editorial Gateway is running.");
    }

    const requestUrl = new URL(request.url);
    if (request.method === "POST" && requestUrl.pathname === "/internal/dzen-notify") {
      const suppliedSecret = String(request.headers.get("X-Dzen-Notify-Secret") || "").trim();
      const configuredSecret = String(env.DZEN_NOTIFY_SECRET || "").trim();
      if (!configuredSecret || !suppliedSecret || suppliedSecret !== configuredSecret) {
        console.warn("Dzen notification authentication rejected:", {
          configured: Boolean(configuredSecret),
          supplied: Boolean(suppliedSecret),
          configured_length: configuredSecret.length,
          supplied_length: suppliedSecret.length
        });
        return new Response("Unauthorized", { status: 401 });
      }
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
        return new Response("Telegram delivery is not configured", { status: 503 });
      }
      let payload;
      try {
        payload = await request.json();
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }
      const status = String(payload.status || "");
      if (!["success", "failure"].includes(status)) {
        return new Response("Invalid notification status", { status: 400 });
      }
      const topic = String(payload.topic || "Тема не определена").slice(0, 500);
      const category = String(payload.category || "Не определена").slice(0, 120);
      const details = String(payload.details || "").slice(0, 1800);
      const timestamp = String(payload.timestamp || new Date().toISOString()).slice(0, 80);
      const publicationUrl = String(payload.url || "").slice(0, 500);
      const heading = status === "success"
        ? "✅ Публикация успешно размещена в Дзене"
        : "❌ Публикация в Дзене не состоялась";
      const lines = [
        heading,
        "",
        "Тема: " + topic,
        "Рубрика: " + category,
        "Время: " + timestamp,
        details ? "Подробности: " + details : "",
        publicationUrl ? "Ссылка: " + publicationUrl : ""
      ].filter(Boolean);
      await telegram(env, "sendMessage", {
        chat_id: env.TELEGRAM_CHAT_ID,
        text: lines.join("\n"),
        disable_web_page_preview: true
      });
      return json({ ok: true, delivered: true });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405
      });
    }

    const suppliedSecret = request.headers.get(
      "X-Telegram-Bot-Api-Secret-Token"
    );

    if (
      !suppliedSecret ||
      !env.TELEGRAM_WEBHOOK_SECRET ||
      suppliedSecret !== env.TELEGRAM_WEBHOOK_SECRET
    ) {
      console.error("Webhook rejected: invalid secret");

      return new Response("Unauthorized", {
        status: 401
      });
    }

    let update;

    try {
      update = await request.json();
    } catch {
      console.error("Webhook received invalid JSON");

      return new Response("Invalid JSON", {
        status: 400
      });
    }

    try {
      console.log("Telegram update received:", {
        updateId: update.update_id,
        hasMessage: Boolean(update.message),
        hasCallback: Boolean(update.callback_query)
      });

      // ==================================================
      // TELEGRAM MESSAGES
      // ==================================================

      if (update.message) {
        const message = update.message;

        const chatId = String(
          message.chat?.id ?? ""
        );

        const userId = String(
          message.from?.id ?? ""
        );

        const command = String(message.text ?? "")
          .trim()
          .split(/\s+/)[0]
          .split("@")[0];

        const allowed = isAuthorizedChat(
          message.chat,
          env
        );

        console.log("TELEGRAM DIAGNOSTICS:", {
          updateId: update.update_id,
          command: command || "no_command",
          chatType: message.chat?.type,
          chatAllowed: allowed,
          geminiKeyConfigured: Boolean(env.GEMINI_API_KEY)
        });

        if (!allowed) {
          console.error("MESSAGE REJECTED: unauthorized chat");
          return new Response("OK");
        }

        if (command === "/start") {
          await sendMainMenu(env, chatId, userId, null, true);
        }

        else if (String(message.text || "").trim() === "📋 Главное меню") {
          await sendMainMenu(env, chatId, userId);
        }

        else if (command === "/menu") {
          await sendMainMenu(env, chatId, userId);
        }

        else if (command === "/id") {
          await telegram(env, "sendMessage", {
            chat_id: chatId,
            text:
              "TELEGRAM DIAGNOSTICS\n\n" +
              `Chat ID: ${chatId}\n` +
              `User ID: ${userId}\n` +
              `Chat type: ${message.chat?.type}\n` +
              `Gemini key: ${env.GEMINI_API_KEY ? "configured" : "missing"}\n` +
              `Coordinator: ${env.APPROVAL_COORDINATOR ? "configured" : "missing"}`
          });
        }

        else if (command === "/settings") {
          await telegram(env, "sendMessage", {
            chat_id: chatId,
            text:
              "OSINT EDITORIAL SETTINGS\n\n" +
              `Platform: Threads only\n` +
              `Timezone: ${SETTINGS.publishing.schedule_timezone}\n` +
              `Editorial posts per day: ${SETTINGS.publishing.feed_posts_per_day}\n` +
              `Target schedule: ${SETTINGS.publishing.feed_schedule.join(", ")}\n` +
              `Format: text-only Threads posts\n` +
              `Topic rotation: ${SETTINGS.content_strategy.topic_rotation.join(" → ")}\n` +
              `Hashtags: disabled`
          });
        }

        else if (command === "/test") {
          console.log("Approval test started");

          await callCoordinator(env, "/test", {
            user_id: userId,
            chat_id: chatId
          });
        }

        else if (command === "/hourly_preview") {
          await telegram(env, "sendMessage", { chat_id: chatId, text: "Готовлю пять вариантов. Публикация будет только после твоего выбора..." });
          const result = await callCoordinator(env, "/hourly-trend", { scheduled_at: Date.now(), manual: true, preview: true });
          if (result.preview && result.session_id) {
            await telegram(env, "sendMessage", hourlyVariantsPayload(chatId, result));
          } else {
            await telegram(env, "sendMessage", { chat_id: chatId, text: "Не удалось подготовить пятёрку. Причина: " + String(result.reason || result.error || "неизвестная ошибка") + (result.detail ? "\nПодробности: " + String(result.detail).slice(0, 700) : "") });
          }
        }

        else if (command === "/hourly_start") {
          const settings = await callCoordinator(env, "/hourly-settings", { action: "enable", user_id: userId, chat_id: chatId });
          await telegram(env, "sendMessage", { chat_id: chatId, text: settings.enabled
            ? "Ежечасная рубрика включена. Первая пятёрка готовится; публикация — только после твоего выбора."
            : "Не удалось включить ежечасную рубрику." });
          if (settings.enabled) {
            const result = await callCoordinator(env, "/hourly-trend", { scheduled_at: Date.now(), manual: true, preview: true });
            if (result.preview && result.session_id) await telegram(env, "sendMessage", hourlyVariantsPayload(chatId, result));
            else await telegram(env, "sendMessage", { chat_id: chatId, text: "Не удалось подготовить пятёрку: " + String(result.reason || result.error || "неизвестная ошибка") + (result.detail ? "\nПодробности: " + String(result.detail).slice(0, 700) : "") });
          }
        }

        else if (command === "/hourly_now") {
          const result = await callCoordinator(env, "/hourly-trend", { scheduled_at: Date.now(), manual: true, preview: true });
          if (result.preview && result.session_id) await telegram(env, "sendMessage", hourlyVariantsPayload(chatId, result));
          else await telegram(env, "sendMessage", { chat_id: chatId, text: "Не удалось подготовить пятёрку: " + String(result.reason || result.error || "неизвестная ошибка") + (result.detail ? "\nПодробности: " + String(result.detail).slice(0, 700) : "") });
        }

        else if (command === "/threads_trends_test") {
          await telegram(env, "sendMessage", {
            chat_id: chatId,
            text: "Проверяю только чтение Threads Trending Topics. Генерация и публикация постов не запускаются..."
          });
          try {
            const result = await callCoordinator(env, "/threads/trends-test", {
              user_id: userId,
              chat_id: chatId
            });
            if (result.success) {
              const details = (result.countries || []).map(country =>
                country.country + ": HTTP " + country.http_status +
                (country.count !== undefined ? ", трендов: " + country.count : ", ошибка: " + country.error) +
                (country.topics?.length ? "\n" + country.topics.join("\n") : "") +
                (country.response_keys?.length ? "\nПоля ответа: " + country.response_keys.join(", ") : "") +
                (country.response_preview ? "\nОтвет API: " + country.response_preview : "")
              ).join("\n\n");
              await telegram(env, "sendMessage", {
                chat_id: chatId,
                text: "THREADS TRENDING TOPICS: ПРОВЕРКА ЗАВЕРШЕНА\n" +
                  (details || String(result.error || "API не вернул подробности.")) +
                  "\n\nПроверка выполнена без генерации и публикации."
              });
            } else {
              await telegram(env, "sendMessage", {
                chat_id: chatId,
                text: "THREADS TRENDING TOPICS: ДОСТУП НЕ ПОДТВЕРЖДЁН\nHTTP: " +
                  String(result.http_status || "—") + "\nПричина: " +
                  String(result.error || "неизвестная ошибка").slice(0, 700) +
                  "\n\nПроверка не запускала генерацию и публикацию."
              });
            }
          } catch (error) {
            await telegram(env, "sendMessage", {
              chat_id: chatId,
              text: "Не удалось выполнить безопасную проверку трендов.\nПричина: " +
                String(error.message || error).slice(0, 700) +
                "\n\nПубликация не запускалась."
            });
          }
        }

        else if (command === "/threads_status") {
          const status = await callCoordinator(env, "/threads/status", {
            user_id: userId,
            chat_id: chatId
          });
          const expiry = status.expires_at ? new Date(status.expires_at).toLocaleString("ru-RU", { timeZone: SETTINGS.timezone }) : "";
          await telegram(env, "sendMessage", {
            chat_id: chatId,
            text: status.connected
              ? "THREADS STATUS\nПодключённый аккаунт: @" + String(status.username || "имя не получено") + "\nТокен: " + (status.expired ? "истёк" : "действителен") + (expiry ? "\nСрок действия до: " + expiry : "")
              : "THREADS STATUS\nАккаунт Threads пока не авторизован. Для подключения открой ссылку:\nhttps://osint-telegram-gateway-staging.vssitner.workers.dev/threads/connect"
          });
        }

        else if (command === "/threads_publish_check") {
          await telegram(env, "sendMessage", {
            chat_id: chatId,
            text: "Проверяю ID профиля Threads и разрешения токена. Ничего не публикую..."
          });
          try {
            const result = await callCoordinator(env, "/threads/publish-check", {
              user_id: userId,
              chat_id: chatId,
              app_id: env.THREADS_APP_ID || "",
              app_secret: env.THREADS_APP_SECRET || ""
            });
            const scopes = Array.isArray(result.scopes) ? result.scopes.join(", ") : "не удалось получить";
            await telegram(env, "sendMessage", {
              chat_id: chatId,
              text: "ПРОВЕРКА THREADS PUBLISH\n" +
                "Профиль: " + (result.username ? "@" + result.username : "не определён") + "\n" +
                "ID сохранённого токена совпадает с ID профиля: " + (result.user_id_matches === true ? "ДА" : result.user_id_matches === false ? "НЕТ" : "не удалось проверить") + "\n" +
                "threads_basic: " + (result.has_basic === true ? "есть" : result.has_basic === false ? "НЕТ" : "неизвестно") + "\n" +
                "threads_content_publish: " + (result.has_publish === true ? "есть" : result.has_publish === false ? "НЕТ" : "неизвестно") + "\n" +
                "Разрешения токена: " + scopes + "\n" +
                (result.diagnostic_error ? "Диагностика: " + result.diagnostic_error : "") +
                "\n\nПубликация не выполнялась."
            });
          } catch (error) {
            await telegram(env, "sendMessage", {
              chat_id: chatId,
              text: "Проверка Threads не выполнена: " + String(error.message || error).slice(0, 500) +
                "\n\nПубликация не выполнялась."
            });
          }
        }

        else if (command === "/publish_retry") {
          const itemId = String(message.text || "").trim().split(/\s+/)[1] || "";
          if (!/^material-[a-f0-9-]+$/i.test(itemId)) {
            await telegram(env, "sendMessage", {
              chat_id: chatId,
              text: "Укажи ID материала: /publish_retry material-xxxxxxxx"
            });
          } else {
            await callCoordinator(env, "/publish-retry", {
              user_id: userId,
              chat_id: chatId,
              item_id: itemId
            });
          }
        }

        else if (command === "/generate") {
          console.log("CONTENT GENERATION REQUESTED");

          await telegram(env, "sendMessage", {
            chat_id: chatId,
            text: "Запускаю генерацию новой темы. Подожди..."
          });

          await callCoordinator(env, "/generate", {
            user_id: userId,
            chat_id: chatId
          });
        }

        else if (command === "/ai_test") {
          console.log("GEMINI TEST STARTED");

          await telegram(env, "sendMessage", {
            chat_id: chatId,
            text: "Запускаю Gemini. Подожди немного..."
          });

          try {
            const answer = await geminiGenerate(
              env,
              "Ты OSINT-аналитик. Напиши краткий тестовый материал на русском языке: три способа проверить цифровой след компании из открытых источников. Не выдумывай факты. Используй нумерованный список.",
              { task: "ai_test" }
            );

            for (const chunk of splitTelegramText(answer)) {
              await telegram(env, "sendMessage", {
                chat_id: chatId,
                text: chunk
              });
            }

            console.log("GEMINI TEST COMPLETED");

          } catch (error) {
            console.error("GEMINI COMMAND FAILED:", error.message);

            await telegram(env, "sendMessage", {
              chat_id: chatId,
              text:
                "Не удалось получить ответ от Gemini.\n\n" +
                `Причина: ${error.message}`
            });
          }
        }


        else if (message.text && !String(message.text).trim().startsWith("/")) {
          const result = await callCoordinator(env, "/humor-topic", {
            action: "input", user_id: userId, chat_id: chatId, text: message.text
          });
          if (result.generated) {
            await telegram(env, "sendMessage", humorVariantsPayload(chatId, result));
          } else if (result.failed) {
            await telegram(env, "sendMessage", { chat_id: chatId, text: "Не удалось подготовить пять вариантов.\n" + String(result.error || "Попробуй отправить тему ещё раз.").slice(0, 700) });
          } else if (result.awaiting_choice) {
            await telegram(env, "sendMessage", { chat_id: chatId, text: "Для этой темы уже подготовлены пять вариантов. Выбери один кнопкой или нажми повторную генерацию." });
          }
        }

        else if (command.startsWith("/")) {
          await telegram(env, "sendMessage", {
            chat_id: chatId,
            text:
              "Неизвестная команда.\n\n" +
              "Доступные команды:\n" +
              "/start или /menu — главное меню\n" +
              "/generate — новая редакционная тема\n" +
              "/test — тест согласования без публикации\n" +
              "/hourly_now — факты вне очереди\n" +
              "/hourly_start — включить автоподборку фактов и запустить\n" +
              "/hourly_preview — предпросмотр фактов без публикации\n" +
              "/threads_status — статус подключения Threads\n" +
              "/threads_publish_check — проверка разрешений\n" +
              "/threads_trends_test — проверка трендов\n" +
              "/publish_retry ID — безопасный повтор публикации\n" +
              "/settings — настройки\n" +
              "/ai_test — проверка Gemini\n" +
              "/id — идентификаторы чата"
          });
        }
      }

      // ==================================================
      // INLINE BUTTON CALLBACKS
      // ==================================================

      if (update.callback_query) {
        const callback = update.callback_query;
        const callbackChat = callback.message?.chat;
        const callbackUserId = String(callback.from?.id || "");
        const callbackChatId = String(callbackChat?.id || "");
        const callbackAllowed = isAuthorizedChat(callbackChat, env) &&
          callbackUserId === String(env.TELEGRAM_CHAT_ID || "");
        const data = String(callback.data || "");

        // Telegram callback queries must be acknowledged immediately, before
        // coordinator/Gemini/Threads calls that may take longer than Telegram's deadline.
        try {
          await telegram(env, "answerCallbackQuery", {
            callback_query_id: callback.id,
            text: callbackAllowed ? "Принято. Выполняю..." : "Нет доступа",
            ...(!callbackAllowed ? { show_alert: true } : {})
          });
        } catch (ackError) {
          // An expired callback acknowledgement must never prevent command execution.
          console.warn("Telegram callback acknowledgement failed; continuing:", ackError.message);
        }

        if (callbackAllowed) {
          if (data === "hourly_toggle" || data === "hourly_refresh") {
            const status = await callCoordinator(env, "/hourly-settings", {
              action: data === "hourly_toggle" ? "toggle" : "get",
              user_id: callbackUserId, chat_id: callbackChatId
            });
            await sendMainMenu(env, callbackChatId, callbackUserId, callback.message.message_id);
          } else if (data.startsWith("menu:")) {
            await runMenuAction(env, data.slice(5), callbackUserId, callbackChatId);
          } else if (data === "humor:start") {
            await callCoordinator(env, "/humor-topic", { action: "start", user_id: callbackUserId, chat_id: callbackChatId });
            await telegram(env, "sendMessage", { chat_id: callbackChatId, text: "Напиши тему юморной новости одним сообщением. Я подготовлю до пяти разных шуток — с неожиданными поворотами и панчлайнами. Ничего не будет опубликовано, пока ты не выберешь вариант." });
          } else if (data.startsWith("humor:regen:")) {
            const sessionId = data.split(":")[2] || "";
            const result = await callCoordinator(env, "/humor-topic", { action: "regenerate", session_id: sessionId, user_id: callbackUserId, chat_id: callbackChatId });
            if (result.generated) {
              await telegram(env, "editMessageText", humorVariantsPayload(callbackChatId, result, callback.message.message_id));
            } else if (result.failed) {
              await telegram(env, "sendMessage", { chat_id: callbackChatId, text: String(result.error || "Не удалось создать варианты").slice(0, 700) });
            }
          } else if (data.startsWith("humor:pick:")) {
            const parts = data.split(":");
            const sessionId = parts[2] || "";
            const index = Number(parts[3]);
            const result = await callCoordinator(env, "/humor-select", { action: "select", session_id: sessionId, index, user_id: callbackUserId, chat_id: callbackChatId });
            if (result.published) {
              await telegram(env, "editMessageText", {
                chat_id: callbackChatId, message_id: callback.message.message_id,
                text: "ВЫБРАННЫЙ ВАРИАНТ ОПУБЛИКОВАН В THREADS\n\n" + result.text +
                  (result.permalink ? "\n\n" + result.permalink : "\nID: " + result.post_id)
              });
            } else if (result.failed) {
              await telegram(env, "sendMessage", { chat_id: callbackChatId, text: "Публикация не выполнена. Повторно нажимать вариант не нужно.\n" + String(result.error || "Проверь Threads вручную.").slice(0, 600) });
            }
          } else if (data.startsWith("hourly_review:")) {
            const parts = data.split(":");
            const action = parts[1] === "approve" ? "approve" : "reject";
            const slot = parts.slice(2).join(":");
            const result = await callCoordinator(env, "/hourly-auto-publish", {
              action, slot, user_id: callbackUserId, chat_id: callbackChatId
            });
            await telegram(env, "editMessageText", {
              chat_id: callbackChatId, message_id: callback.message.message_id,
              text: result.published
                ? "СОГЛАСОВАНО И ОПУБЛИКОВАНО В THREADS\n\n" + result.text + (result.permalink ? "\n\n" + result.permalink : "")
                : result.rejected
                  ? "ПОСТ ОТКЛОНЁН. Публикация отменена."
                  : "РЕШЕНИЕ НЕ ВЫПОЛНЕНО\n" + String(result.error || "Неизвестная ошибка")
            });
          } else if (data.startsWith("hourly:publish:")) {
            const parts = data.split(":");
            const result = await callCoordinator(env, "/hourly-select", {
              session_id: parts[2] || "", index: Number(parts[3]), user_id: callbackUserId, chat_id: callbackChatId
            });
            await telegram(env, "editMessageText", {
              chat_id: callbackChatId, message_id: callback.message.message_id,
              text: result.published
                ? "ОПУБЛИКОВАНО В THREADS\n\n" + result.text + (result.permalink ? "\n\n" + result.permalink : "")
                : "Публикация не выполнена: " + String(result.error || "подборка устарела")
            });
          } else if (data.startsWith("hourly:reject:")) {
            const sessionId = data.split(":")[2] || "";
            const result = await callCoordinator(env, "/hourly-reject", {
              session_id: sessionId, user_id: callbackUserId, chat_id: callbackChatId
            });
            await telegram(env, "editMessageText", {
              chat_id: callbackChatId, message_id: callback.message.message_id,
              text: result.rejected ? "ПЯТЁРКА ОТКЛОНЕНА. Переходим к следующему часу." : "Не удалось отклонить: " + String(result.error || "подборка уже закрыта")
            });

          } else if (data.startsWith("humor:cancel:")) {
            const sessionId = data.split(":")[2] || "";
            await callCoordinator(env, "/humor-topic", { action: "cancel", session_id: sessionId, user_id: callbackUserId, chat_id: callbackChatId });
            await telegram(env, "editMessageText", { chat_id: callbackChatId, message_id: callback.message.message_id, text: "Генерация юморной новости отменена." });
          } else if (!data.startsWith("humor:")) {
            await callCoordinator(env, "/callback", { callback });
          }
        }
      }

      return new Response("OK");

    } catch (error) {
      console.error(
        "Webhook processing failed:",
        error.message,
        error.stack || ""
      );

      const failedChatId = String(update?.message?.chat?.id || update?.callback_query?.message?.chat?.id || "");
      const failedChat = update?.message?.chat || update?.callback_query?.message?.chat;
      if (failedChatId && isAuthorizedChat(failedChat, env)) {
        try {
          await telegram(env, "sendMessage", {
            chat_id: failedChatId,
            text: "Команда не выполнена из-за ошибки.\nПричина: " + String(error.message || error).slice(0, 700) +
              "\n\nНичего дополнительно не публиковалось. Попробуй повторить действие позже."
          });
        } catch (notifyError) {
          console.error("Webhook error notification failed:", notifyError.message);
        }
      }

      return new Response("Internal error", {
        status: 500
      });
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const localTime = new Date(controller.scheduledTime).toLocaleTimeString("en-GB", {
          timeZone: SETTINGS.publishing.schedule_timezone || SETTINGS.timezone || "Europe/Moscow",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false
        });
        const editorialSlots = SETTINGS.publishing.feed_schedule || [];
        if (editorialSlots.includes(localTime)) {
          const editorialPayload = {
            user_id: env.TELEGRAM_CHAT_ID,
            chat_id: env.TELEGRAM_CHAT_ID,
            scheduled_at: controller.scheduledTime,
            schedule_key: "editorial:" + new Date(controller.scheduledTime).toISOString()
          };
          let editorialResult = null;
          let editorialError = null;
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              editorialResult = await callCoordinator(env, "/generate", editorialPayload);
              break;
            } catch (error) {
              editorialError = error;
              console.error("Scheduled editorial generation attempt failed:", {
                attempt, error: String(error.message || error).slice(0, 500)
              });
              if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 5000));
            }
          }
          if (!editorialResult) throw editorialError || new Error("Scheduled editorial generation failed");
          console.log("Scheduled editorial approval workflow started:", editorialResult);
        }
        const hourlyState = await callCoordinator(env, "/hourly-expire", {
          user_id: env.TELEGRAM_CHAT_ID, chat_id: env.TELEGRAM_CHAT_ID
        });
        const hourlySettings = await callCoordinator(env, "/hourly-settings", {
          action: "get", user_id: env.TELEGRAM_CHAT_ID, chat_id: env.TELEGRAM_CHAT_ID
        });
        if (localTime.endsWith(":00") && hourlySettings.enabled === true) {
          const hourlyResult = await callCoordinator(env, "/hourly-auto-publish", {
            scheduled_at: controller.scheduledTime,
            stream: "topic"
          });
          console.log("Hourly OSINT/compliance/anti-fraud auto-publish result:", hourlyResult);

          const moscowHour = Number(localTime.slice(0, 2));
          const specialHours = [8, 11, 14, 17, 20];
          if (specialHours.includes(moscowHour)) {
            const specialResult = await callCoordinator(env, "/hourly-auto-publish", {
              scheduled_at: controller.scheduledTime,
              stream: "special"
            });
            console.log("Additional quote/nostalgia auto-publish result:", specialResult);
          }
        }
      } catch (error) {
        console.error("Scheduled social workflow failed:", error.message);
        try {
          await telegram(env, "sendMessage", {
            chat_id: env.TELEGRAM_CHAT_ID,
            text: "Не удалось запустить запланированный поток OSINTNER.\nПричина: " + String(error.message || error).slice(0, 500)
          });
        } catch (notifyError) {
          console.error("Scheduled workflow error notification failed:", notifyError.message);
        }
      }
    })());
  }
};

// ======================================================
// APPROVAL COORDINATOR
// ======================================================

export class ApprovalCoordinator {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405
      });
    }

    const path = new URL(request.url).pathname;

    if (
      path !== "/callback" &&
      path !== "/test" &&
      path !== "/generate" &&
      path !== "/publish-retry" &&
      path !== "/threads/status" &&
      path !== "/threads/publish-check" &&
      path !== "/threads/trends-test" &&
      path !== "/threads/oauth/save-state" &&
      path !== "/threads/oauth/consume-state" &&
      path !== "/threads/oauth/save-token" &&
      path !== "/hourly-trend" &&
      path !== "/hourly-auto-publish" &&
      path !== "/hourly-settings" &&
      path !== "/hourly-select" &&
      path !== "/hourly-reject" &&
      path !== "/hourly-expire" &&
      path !== "/humor-topic" &&
      path !== "/humor-select"
    ) {
      return new Response("Not found", {
        status: 404
      });
    }

    let payload;

    try {
      payload = await request.json();
    } catch {
      return json({
        ok: false,
        error: "Invalid JSON"
      }, 400);
    }

    try {
      let result;

      if (path === "/test") {
        result = await this.handleTest(payload);
      } else if (path === "/generate") {
        result = await this.handleGenerate(payload);
      } else if (path === "/threads/trends-test") {
        const expectedId = String(this.env.TELEGRAM_CHAT_ID || "");
        if (String(payload.chat_id || "") !== expectedId || String(payload.user_id || "") !== expectedId) {
          result = { ok: true, success: false, http_status: 401, error: "Unauthorized" };
        } else {
          const token = await this.ctx.storage.get("threads:oauth:token");
          if (!token?.access_token || !token?.user_id || Number(token.expires_at || 0) <= Date.now()) {
            result = { ok: true, success: false, http_status: 0, error: "Токен Threads отсутствует или истёк. Сначала проверь /threads_status." };
          } else {
            const countryResults = [];
            for (const countryCode of ["US", "JP"]) {
              try {
                const trendsUrl = new URL("https://graph.threads.com/v1.0/trending_topics");
                trendsUrl.searchParams.set("country_code", countryCode);
                trendsUrl.searchParams.set("access_token", token.access_token);
                const trendsResponse = await fetch(trendsUrl.toString());
                const trendsResult = await trendsResponse.json().catch(() => ({}));
                if (!trendsResponse.ok) {
                  const apiError = trendsResult.error || {};
                  countryResults.push({
                    country: countryCode,
                    http_status: trendsResponse.status,
                    error: [
                      apiError.message || "Threads Trending Topics API вернул ошибку",
                      apiError.type ? "type=" + apiError.type : "",
                      apiError.code !== undefined ? "code=" + apiError.code : "",
                      apiError.error_subcode !== undefined ? "subcode=" + apiError.error_subcode : "",
                      apiError.fbtrace_id ? "fbtrace_id=" + apiError.fbtrace_id : ""
                    ].filter(Boolean).join("; ")
                  });
                } else {
                  const raw = Array.isArray(trendsResult.trends)
                    ? trendsResult.trends
                    : Array.isArray(trendsResult.data)
                      ? trendsResult.data
                      : Array.isArray(trendsResult.trending_topics)
                        ? trendsResult.trending_topics
                        : [];
                  countryResults.push({
                    country: countryCode,
                    http_status: trendsResponse.status,
                    count: raw.length,
                    response_keys: Object.keys(trendsResult).slice(0, 12),
                    topics: raw.slice(0, 5).map(item => String(item.title || item.name || item.topic || item.trend_name || "").slice(0, 120)).filter(Boolean)
                  });
                }
              } catch (error) {
                countryResults.push({
                  country: countryCode,
                  http_status: 0,
                  error: String(error.message || error).slice(0, 400)
                });
              }
            }
            const successful = countryResults.filter(item => item.http_status === 200);
            result = {
              ok: true,
              success: successful.length > 0,
              http_status: successful.length ? 200 : (countryResults[0]?.http_status || 0),
              countries: countryResults
            };
          }
        }
      } else if (path === "/threads/status") {
        const expectedId = String(this.env.TELEGRAM_CHAT_ID || "");
        if (String(payload.chat_id || "") !== expectedId || String(payload.user_id || "") !== expectedId) {
          result = { ok: false, error: "Unauthorized" };
        } else {
          const token = await this.ctx.storage.get("threads:oauth:token");
          const expiresAt = Number(token?.expires_at || 0);
          result = {
            ok: true,
            connected: Boolean(token?.access_token && token?.user_id),
            username: String(token?.username || ""),
            expires_at: expiresAt || null,
            expired: !expiresAt || expiresAt <= Date.now()
          };
        }
      } else if (path === "/threads/publish-check") {
        const expectedId = String(this.env.TELEGRAM_CHAT_ID || "");
        if (String(payload.chat_id || "") !== expectedId || String(payload.user_id || "") !== expectedId) {
          result = { ok: false, error: "Unauthorized" };
        } else {
          const token = await this.ctx.storage.get("threads:oauth:token");
          if (!token?.access_token || !token?.user_id || Number(token.expires_at || 0) <= Date.now()) {
            result = { ok: false, error: "Threads token missing or expired" };
          } else {
            let profileId = "";
            let username = "";
            let diagnosticError = "";
            const profileUrl = new URL("https://graph.threads.net/v1.0/me");
            profileUrl.searchParams.set("fields", "id,username");
            profileUrl.searchParams.set("access_token", token.access_token);
            const profileResponse = await fetch(profileUrl.toString());
            const profileData = await profileResponse.json().catch(() => ({}));
            if (profileResponse.ok) {
              profileId = String(profileData.id || "");
              username = String(profileData.username || "");
            } else {
              diagnosticError = "Profile lookup: " + String(profileData.error?.message || profileResponse.status).slice(0, 250);
            }

            let scopes = [];
            let hasBasic = null;
            let hasPublish = null;
            const appId = String(payload.app_id || this.env.THREADS_APP_ID || "");
            const appSecret = String(payload.app_secret || this.env.THREADS_APP_SECRET || "");
            if (appId && appSecret) {
              try {
                const debugUrl = new URL("https://graph.threads.net/v1.0/debug_token");
                debugUrl.searchParams.set("input_token", token.access_token);
                debugUrl.searchParams.set("access_token", "TH|" + appId + "|" + appSecret);
                const debugResponse = await fetch(debugUrl.toString());
                const debugData = await debugResponse.json().catch(() => ({}));
                if (debugResponse.ok && debugData.data) {
                  scopes = Array.isArray(debugData.data.scopes) ? debugData.data.scopes.map(String) : [];
                  hasBasic = scopes.includes("threads_basic");
                  hasPublish = scopes.includes("threads_content_publish");
                } else {
                  diagnosticError += (diagnosticError ? "; " : "") + "Token debugger: " + String(debugData.error?.message || debugResponse.status).slice(0, 250);
                }
              } catch (error) {
                diagnosticError += (diagnosticError ? "; " : "") + "Token debugger: " + String(error.message || error).slice(0, 200);
              }
            } else {
              diagnosticError += (diagnosticError ? "; " : "") + "App credentials unavailable for permission inspection";
            }
            result = {
              ok: true,
              username,
              user_id_matches: profileId ? profileId === String(token.user_id) : null,
              has_basic: hasBasic,
              has_publish: hasPublish,
              scopes,
              diagnostic_error: diagnosticError
            };
          }
        }
      } else if (path === "/publish-retry") {
        const expectedId = String(this.env.TELEGRAM_CHAT_ID || "");
        if (String(payload.chat_id || "") !== expectedId || String(payload.user_id || "") !== expectedId) {
          result = { ok: false, error: "Unauthorized" };
        } else {
          const itemId = String(payload.item_id || "");
          const item = await this.ctx.storage.get("item:" + itemId);
          if (!item || item.status !== "publication_approved" || !["created", "failed", "paused", undefined].includes(item.threads_publication_status)) {
            result = { ok: false, error: "No safely retryable Threads publication exists for this item" };
          } else {
            result = await this.publishApprovedThreadsPost(itemId);
          }
        }
      } else if (path === "/threads/oauth/save-state") {
        const state = String(payload.state || "");
        if (!/^[0-9a-f-]{36}$/i.test(state)) {
          result = { ok: false, error: "Invalid OAuth state" };
        } else {
          await this.ctx.storage.put("threads:oauth:state:" + state, {
            created_at: Number(payload.created_at || Date.now())
          });
          result = { ok: true };
        }
      } else if (path === "/threads/oauth/consume-state") {
        const state = String(payload.state || "");
        const stateKey = "threads:oauth:state:" + state;
        const savedState = await this.ctx.storage.get(stateKey);
        await this.ctx.storage.delete(stateKey);
        if (!savedState || Date.now() - Number(savedState.created_at || 0) > 10 * 60 * 1000) {
          result = { ok: false, error: "OAuth state is invalid or expired" };
        } else {
          result = { ok: true };
        }
      } else if (path === "/threads/oauth/save-token") {
        if (!payload.access_token || !payload.user_id || !payload.expires_at) {
          result = { ok: false, error: "Incomplete Threads token data" };
        } else {
          await this.ctx.storage.put("threads:oauth:token", {
            access_token: String(payload.access_token),
            user_id: String(payload.user_id),
            username: String(payload.username || ""),
            token_type: String(payload.token_type || "bearer"),
            expires_at: Number(payload.expires_at),
            saved_at: Number(payload.saved_at || Date.now())
          });
          result = { ok: true };
        }
      } else if (path === "/humor-topic") {
        result = await this.handleHumorTopic(payload);
      } else if (path === "/humor-select") {
        result = await this.handleHumorSelect(payload);
      } else if (path === "/hourly-settings") {
        const expectedId = String(this.env.TELEGRAM_CHAT_ID || "");
        if (String(payload.chat_id || "") !== expectedId || String(payload.user_id || "") !== expectedId) {
          result = { ok: false, error: "Unauthorized" };
        } else {
          const key = "social:hourly:enabled";
          let enabled = await this.ctx.storage.get(key);
          if (enabled === undefined || enabled === null) enabled = true;
          if (payload.action === "toggle") {
            enabled = !enabled;
            await this.ctx.storage.put(key, enabled);
          } else if (payload.action === "enable") {
            enabled = true;
            await this.ctx.storage.put(key, true);
          }
          if (enabled === true) await this.ctx.storage.setAlarm(Date.now() + 1000);
          result = { ok: true, enabled: enabled === true };
        }
      } else if (path === "/hourly-auto-publish") {
        const hourlyEnabled = await this.ctx.storage.get("social:hourly:enabled");
        if (hourlyEnabled === false) result = { ok: true, skipped: true, reason: "hourly_rubric_disabled" };
        else {
          // Recover failures created by the previous deployment, before durable retries existed.
          const slotPrefix = "social:hourly:auto_slot:";
          const previousSlots = await this.ctx.storage.list({ prefix: slotPrefix });
          let recovered = false;
          for (const [key, previous] of previousSlots.entries()) {
            if (!previous || !["failed", "skipped"].includes(previous.status)) continue;
            if (previous.status === "skipped" && previous.reason !== "threads_not_connected") continue;
            const slot = key.slice(slotPrefix.length);
            const scheduledAt = Date.parse(slot + ":00.000Z");
            if (!Number.isFinite(scheduledAt) || Date.now() - scheduledAt > 48 * 60 * 60 * 1000) continue;
            const retryKey = "social:hourly:auto_retry:" + slot;
            if (await this.ctx.storage.get(retryKey)) continue;
            await this.ctx.storage.put(retryKey, {
              status: "pending", slot, scheduled_at: scheduledAt, attempt: 0,
              last_error: String(previous.error || previous.reason || "Recovered failed hourly slot").slice(0, 700),
              next_attempt_at: Date.now() + 1000,
              recovered_from_previous_deployment: true,
              updated_at: new Date().toISOString()
            });
            recovered = true;
          }
          if (recovered) await this.ctx.storage.setAlarm(Date.now() + 1000);
          result = await runHourlyAutoPublish(this, payload, { geminiGenerate, groqGenerate, tavilySearch, telegram });
        }
      } else if (path === "/hourly-trend") {
        const hourlyEnabled = await this.ctx.storage.get("social:hourly:enabled");
        if (hourlyEnabled === false && payload?.preview !== true) {
          result = { ok: true, skipped: true, reason: "hourly_rubric_disabled" };
        } else {
          result = await runHourlyTrend(this, payload, { groqGenerate, geminiGenerate, tavilySearch, telegram });
          if (result.preview && result.session_id) {
            await this.ctx.storage.setAlarm(Date.now() + 3 * 60 * 1000);
          }
        }
      } else if (path === "/hourly-expire") {
        const expectedId = String(this.env.TELEGRAM_CHAT_ID || "");
        if (String(payload.chat_id || "") !== expectedId || String(payload.user_id || "") !== expectedId) {
          result = { ok: false, error: "Unauthorized" };
        } else {
          const entries = await this.ctx.storage.list({ prefix: "social:hourly:preview:" });
          let active = null;
          for (const [key, session] of entries.entries()) {
            if (session?.status !== "awaiting_choice") continue;
            if (Number(session.expires_at || 0) <= Date.now()) {
              await this.ctx.storage.put(key, { ...session, status: "expired", expired_at: new Date().toISOString() });
            } else if (!active || Number(session.created_at_ms || Date.parse(session.created_at) || 0) > Number(active.created_at_ms || Date.parse(active.created_at) || 0)) {
              active = { ...session, session_id: key.split(":").pop() };
            }
          }
          result = { ok: true, active };
        }
      } else if (path === "/hourly-select" || path === "/hourly-reject") {
        const expectedId = String(this.env.TELEGRAM_CHAT_ID || "");
        if (String(payload.chat_id || "") !== expectedId || String(payload.user_id || "") !== expectedId) {
          result = { ok: false, error: "Unauthorized" };
        } else {
          const key = "social:hourly:preview:" + String(payload.session_id || "");
          const session = await this.ctx.storage.get(key);
          if (!session || session.status !== "awaiting_choice" || Number(session.expires_at || 0) <= Date.now()) {
            if (session?.status === "awaiting_choice") await this.ctx.storage.put(key, { ...session, status: "expired", expired_at: new Date().toISOString() });
            result = { ok: true, published: false, rejected: false, error: "Время выбора истекло или подборка уже закрыта." };
          } else if (path === "/hourly-reject") {
            await this.ctx.storage.put(key, { ...session, status: "rejected", rejected_at: new Date().toISOString() });
            result = { ok: true, rejected: true };
          } else {
            const selected = (session.variants || []).find(item => item.index === Number(payload.index));
            const token = await this.ctx.storage.get("threads:oauth:token");
            if (!selected) {
              result = { ok: true, published: false, error: "Вариант не найден." };
            } else if (!token?.access_token || !token?.user_id || Number(token.expires_at || 0) <= Date.now()) {
              result = { ok: true, published: false, error: "Токен Threads отсутствует или истёк." };
            } else {
              await this.ctx.storage.put(key, { ...session, status: "publishing", selected_index: selected.index, publishing_started_at: new Date().toISOString() });
              try {
                const published = await publishThreads(this.env, token, selected.text);
                const at = new Date().toISOString();
                const history = await this.ctx.storage.get("social:hourly:history") || [];
                history.push({ trend: session.trend, trend_id: "NONE", text: selected.text, threads_post_id: published.id, threads_permalink: published.permalink, published_at: at });
                await this.ctx.storage.put("social:hourly:history", history.slice(-100));
                const liked = await this.ctx.storage.get("social:hourly:liked") || [];
                liked.push({ text: selected.text, trend: session.trend, liked_at: at });
                await this.ctx.storage.put("social:hourly:liked", liked.slice(-30));
                await this.ctx.storage.put(key, { ...session, status: "published", selected_index: selected.index, published_at: at, threads_post_id: published.id, threads_permalink: published.permalink });
                result = { ok: true, published: true, text: selected.text, post_id: published.id, permalink: published.permalink };
              } catch (error) {
                await this.ctx.storage.put(key, { ...session, status: "failed", selected_index: selected.index, error: String(error.message || error).slice(0, 500) });
                result = { ok: true, published: false, error: String(error.message || error) };
              }
            }
          }
        }
      } else if (path === "/hourly-preview-feedback") {
        const expectedId = String(this.env.TELEGRAM_CHAT_ID || "");
        if (String(payload.chat_id || "") !== expectedId || String(payload.user_id || "") !== expectedId) {
          result = { ok: false, error: "Unauthorized" };
        } else {
          const key = "social:hourly:preview:" + String(payload.session_id || "");
          const session = await this.ctx.storage.get(key);
          const selected = (session?.variants || []).find(item => item.index === Number(payload.index));
          if (!session || session.status !== "awaiting_feedback" || !selected) {
            result = { ok: true, saved: false, error: "Подборка устарела или вариант не найден." };
          } else {
            const liked = await this.ctx.storage.get("social:hourly:liked") || [];
            liked.push({ text: selected.text, trend: session.trend, liked_at: new Date().toISOString() });
            await this.ctx.storage.put("social:hourly:liked", liked.slice(-30));
            await this.ctx.storage.put(key, { ...session, status: "feedback_saved", selected_index: selected.index });
            result = { ok: true, saved: true, text: selected.text };
          }
        }
      } else {
        result = await this.handleCallback(payload);
      }

      if (!result.ok) {
        return json(result, 403);
      }

      await this.ctx.storage.setAlarm(
        Date.now() + OUTBOX_RETRY_MS
      );

      await this.flushOutbox();

      return json(result);

    } catch (error) {
      if (path === "/generate" && payload?.schedule_key) {
        await this.ctx.storage.put("schedule-run:" + String(payload.schedule_key), {
          status: "failed", failed_at: new Date().toISOString(),
          error: String(error.message || error).slice(0, 500)
        }).catch(storageError => console.error("Could not persist failed schedule state:", storageError.message));
      }
      console.error("Coordinator error:", error.message, error.stack || "");
      return json({
        ok: false, error: "Processing failed",
        detail: String(error.message || error).slice(0, 700)
      }, 500);
    }
  }

  // ==================================================
  // OUTBOX
  // ==================================================

  async enqueue(txn, method, data, options = {}) {
    let payloads = [data];

    if (
      method === "sendMessage" &&
      typeof data?.text === "string"
    ) {
      const chunks = splitTelegramText(data.text);

      payloads = chunks.map((chunk, index) => {
        const payload = {
          ...data,
          text: chunk
        };

        if (index !== chunks.length - 1) {
          delete payload.reply_markup;
        }

        return payload;
      });
    }

    const createdAt =
      options.created_at || new Date().toISOString();

    for (const payload of payloads) {
      const sequenceKey = "outbox_sequence";
      const previousSequence = await txn.get(sequenceKey);

      const sequence = Number(previousSequence || 0) + 1;

      await txn.put(sequenceKey, sequence);

      const id = String(sequence).padStart(16, "0");

      await txn.put(`outbox:${id}`, {
        method,
        data: payload,
        sequence,
        created_at: createdAt
      });
    }
  }

  // ==================================================
  // AUDIT EVENTS
  // ==================================================

  async addEvent(txn, event) {
    const id = crypto.randomUUID();

    await txn.put(
      `event:${Date.now()}:${id}`,
      {
        ...event,
        timestamp: new Date().toISOString()
      }
    );
  }


  async handleHumorTopic(payload) {
    const expectedId = String(this.env.TELEGRAM_CHAT_ID || "");
    const chatId = String(payload.chat_id || "");
    const userId = String(payload.user_id || "");
    if (!expectedId || chatId !== expectedId || userId !== expectedId) return { ok: false, error: "Unauthorized" };
    const key = "social:humor:session:" + chatId;
    const action = String(payload.action || "");
    if (action === "start") {
      await this.ctx.storage.put(key, { status: "awaiting_topic", user_id: userId, created_at: new Date().toISOString() });
      return { ok: true, started: true };
    }
    if (action === "cancel") {
      const session = await this.ctx.storage.get(key);
      if (session && (!payload.session_id || session.session_id === String(payload.session_id))) await this.ctx.storage.delete(key);
      return { ok: true, cancelled: true };
    }
    const session = await this.ctx.storage.get(key);
    if (!session) return { ok: true, ignored: true };
    if (action === "input") {
      if (session.status !== "awaiting_topic") return { ok: true, awaiting_choice: session.status === "awaiting_choice" };
      const topic = String(payload.text || "").replace(/\s+/g, " ").trim().slice(0, 240);
      if (topic.length < 2) return { ok: true, failed: true, error: "Напиши тему чуть подробнее — хотя бы два символа." };
      const history = await this.ctx.storage.get("social:humor:history") || [];
      try {
        const variants = await generateHumorVariants(this.env, topic, history.map(item => item.text).concat(session.variants || []), geminiGenerate);
        const sessionId = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
        const next = { status: "awaiting_choice", user_id: userId, session_id: sessionId, topic, variants, created_at: new Date().toISOString(), generation: 1 };
        await this.ctx.storage.put(key, next);
        return { ok: true, generated: true, session_id: sessionId, topic, variants };
      } catch (error) {
        return { ok: true, failed: true, error: String(error.message || error) };
      }
    }
    if (action === "regenerate") {
      if (session.status !== "awaiting_choice" || session.session_id !== String(payload.session_id || "")) return { ok: true, failed: true, error: "Эта подборка уже недействительна. Начни новую генерацию через меню." };
      const history = await this.ctx.storage.get("social:humor:history") || [];
      try {
        const previous = history.map(item => item.text).concat((session.variants || []).map(item => item.text));
        const variants = await generateHumorVariants(this.env, session.topic, previous, geminiGenerate);
        const next = { ...session, variants, generation: Number(session.generation || 1) + 1, updated_at: new Date().toISOString() };
        await this.ctx.storage.put(key, next);
        return { ok: true, generated: true, session_id: next.session_id, topic: next.topic, variants };
      } catch (error) {
        return { ok: true, failed: true, error: String(error.message || error) };
      }
    }
    return { ok: true, ignored: true };
  }

  async handleHumorSelect(payload) {
    const expectedId = String(this.env.TELEGRAM_CHAT_ID || "");
    const chatId = String(payload.chat_id || "");
    const userId = String(payload.user_id || "");
    if (!expectedId || chatId !== expectedId || userId !== expectedId) return { ok: false, error: "Unauthorized" };
    const key = "social:humor:session:" + chatId;
    const session = await this.ctx.storage.get(key);
    if (!session || session.status !== "awaiting_choice" || session.session_id !== String(payload.session_id || "")) {
      return { ok: true, failed: true, error: "Подборка устарела или уже обработана. Запусти новую через меню." };
    }
    const index = Number(payload.index);
    const selected = (session.variants || []).find(item => item.index === index);
    if (!selected) return { ok: true, failed: true, error: "Вариант не найден." };
    if (String(this.env.THREADS_PUBLISHING_ENABLED || "false").toLowerCase() !== "true") {
      return { ok: true, failed: true, error: "Публикации Threads отключены в настройках Worker." };
    }
    const token = await this.ctx.storage.get("threads:oauth:token");
    if (!token?.access_token || !token?.user_id || Number(token.expires_at || 0) <= Date.now()) {
      return { ok: true, failed: true, error: "Токен Threads отсутствует или истёк. Переподключи аккаунт." };
    }
    await this.ctx.storage.put(key, { ...session, status: "publishing", selected_index: index });
    try {
      const published = await publishThreads(this.env, token, selected.text);
      const publishedAt = new Date().toISOString();
      const history = await this.ctx.storage.get("social:humor:history") || [];
      history.push({ topic: session.topic, text: selected.text, published_at: publishedAt, threads_post_id: published.id, threads_permalink: published.permalink });
      await this.ctx.storage.put("social:humor:history", history.slice(-100));
      await this.ctx.storage.put(key, { ...session, status: "published", selected_index: index, threads_post_id: published.id, threads_permalink: published.permalink, published_at: publishedAt });
      return { ok: true, published: true, text: selected.text, post_id: published.id, permalink: published.permalink };
    } catch (error) {
      await this.ctx.storage.put(key, { ...session, status: "publish_unknown", selected_index: index, publish_error: String(error.message || error).slice(0, 500), attempted_at: new Date().toISOString() });
      return { ok: true, failed: true, error: String(error.message || error) + ". Повторная отправка заблокирована во избежание дубля." };
    }
  }

  // ==================================================
  // AI TOPIC GENERATOR
  // ==================================================

  async handleGenerate(payload) {
    const expectedChatId = String(
      this.env.TELEGRAM_CHAT_ID ?? ""
    );

    const chatId = String(payload.chat_id ?? "");
    const userId = String(payload.user_id ?? "");

    if (
      !expectedChatId ||
      chatId !== expectedChatId ||
      userId !== expectedChatId
    ) {
      return {
        ok: false,
        error: "Unauthorized"
      };
    }

    const scheduleKey = String(payload.schedule_key || "");
    const jobId = scheduleKey || ("manual:" + crypto.randomUUID());
    const jobKey = "topic-generation:" + jobId;

    if (scheduleKey) {
      const scheduleStorageKey = "schedule-run:" + scheduleKey;
      const existingSchedule = await this.ctx.storage.get(scheduleStorageKey);
      const existingJobId = existingSchedule?.job_id || jobId;
      const existingJob = await this.ctx.storage.get("topic-generation:" + existingJobId);
      const startedAt = Date.parse(existingSchedule?.started_at || "");
      const staleStarted = existingSchedule?.status === "started" &&
        (!Number.isFinite(startedAt) || Date.now() - startedAt > 12 * 60 * 1000);

      if (existingSchedule?.status === "created") {
        return { ok: true, duplicate: true, item_id: existingSchedule.item_id || "" };
      }
      if (existingJob?.status === "pending") {
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        return { ok: true, status: "generating", duplicate: true, job_id: existingJobId };
      }
      // A legacy "started" schedule without a persisted job is an orphaned run.
      // Recover it instead of treating it as a successful duplicate.
      if (existingSchedule?.status === "started" && !staleStarted && existingJob) {
        return { ok: true, duplicate: true, item_id: existingSchedule.item_id || "" };
      }
      await this.ctx.storage.put(scheduleStorageKey, {
        status: "started", job_id: jobId, started_at: new Date().toISOString(),
        attempts: Number(existingSchedule?.attempts || 0) + 1
      });
    }

    const topics = SETTINGS.content_strategy.topic_rotation;

    if (!Array.isArray(topics) || topics.length === 0) {
      throw new Error("Topic rotation is not configured");
    }

    const rotationKey = "topic_rotation_index";
    const savedIndex = await this.ctx.storage.get(rotationKey);

    const index = Number.isInteger(savedIndex)
      ? savedIndex % topics.length
      : 0;

    const category = topics[index];

    const prompt =
      `Ты — выпускающий редактор OSINTNER, профессионального медиа об OSINT, комплаенсе, AML и антифроде. Твоя задача — предлагать темы, которые редакция действительно сможет раскрыть на конкретных примерах и методах.\n\n` +
      `Создай ОДНУ оригинальную тему для категории: ${category}.\n\n` +
      `РЕДАКЦИОННЫЕ ТРЕБОВАНИЯ — ОБЯЗАТЕЛЬНЫ К ИСПОЛНЕНИЮ:\n` +
      `1. Одна тема = одна конкретная проблема, один объект проверки или один метод расследования. Не объединяй несколько самостоятельных сюжетов.\n` +
      `2. Заголовок должен быть ясным специалисту смежной области без необходимости расшифровывать нагромождение терминов.\n` +
      `3. Используй естественный профессиональный русский язык. Избегай искусственных оборотов, канцелярита и псевдоэкспертных формулировок.\n` +
      `4. Предпочитай конкретные объекты и действия: проверка контрагента, анализ связей, выявление подмены реквизитов, проверка цепочки поставок и т.п.\n` +
      `5. Заголовок — ориентировочно 8–14 слов, максимум 16 слов. Не превращай его в описание всей методологии статьи.\n` +
      `6. Не используй длинные конструкции вида «через анализ A, B и C для выявления X, Y и Z». Не перечисляй более двух инструментов или источников в заголовке.\n` +
      `7. Тема должна иметь практическую ценность: читатель должен понимать, какую угрозу, схему или контрольную задачу он разберёт.\n` +
      `8. Чередуй сюжеты внутри категории: не зацикливайся на санкциях, бенефициарах, фиктивных контрактах или цифровой инфраструктуре. Выбирай разные типы задач и объектов.\n` +
      `9. Для OSINT опирайся на законные сценарии работы с открытыми источниками; для Комплаенса — на проверку и управление рисками; для Антифрода — на механизмы мошенничества и меры противодействия.\n` +
      `10. Не выдавай индикаторы и вероятностные совпадения за доказанные факты или установленную аффилированность. Не выдумывай реальные события, компании, статистику или расследования.\n\n` +
      `Перед ответом проверь: тема раскрывает один сюжет, заголовок понятен, формулировка звучит естественно, нет лишних терминов и перечислений. Если хотя бы одно условие не выполнено — переформулируй.\n\n` +
      `Верни только один заголовок на русском языке, без кавычек, пояснений и нумерации.`;

    const recentTopics = await getRecentEditorialTopics(this.ctx.storage);
    const job = {
      id: jobId,
      schedule_key: scheduleKey,
      category,
      prompt,
      recent_topics: recentTopics.slice(0, 120),
      rejected_candidates: [],
      attempts: 0,
      transient_failures: 0,
      user_id: userId,
      expected_chat_id: expectedChatId,
      rotation_key: rotationKey,
      rotation_index: index,
      rotation_length: topics.length,
      status: "pending",
      created_at: new Date().toISOString(),
      next_attempt_at: Date.now()
    };

    await this.ctx.storage.put(jobKey, job);
    if (scheduleKey) {
      await this.ctx.storage.put("schedule-run:" + scheduleKey, {
        status: "started", job_id: jobId, started_at: new Date().toISOString(),
        attempts: Number((await this.ctx.storage.get("schedule-run:" + scheduleKey))?.attempts || 1)
      });
    }
    await this.ctx.storage.setAlarm(Date.now() + 1000);

    console.log("Editorial topic generation queued for durable processing:", {
      category, job_id: jobId, schedule_key: scheduleKey || null
    });
    return { ok: true, status: "generating", job_id: jobId, category };
  }

  async processTopicGenerationJob(jobKey) {
    const job = await this.ctx.storage.get(jobKey);
    if (!job || job.status !== "pending") return null;

    const now = Date.now();
    if (Number(job.next_attempt_at || 0) > now) return Number(job.next_attempt_at);

    const attempt = Number(job.attempts || 0) + 1;

    try {
      const latestTopics = await getRecentEditorialTopics(this.ctx.storage, job.item_id || "");
      const blockedTopics = [...new Set([
        ...(Array.isArray(job.recent_topics) ? job.recent_topics : []),
        ...latestTopics,
        ...(Array.isArray(job.rejected_candidates) ? job.rejected_candidates : [])
      ].filter(Boolean))];

      const generatedTopic = await geminiGenerate(
        this.env,
        job.prompt +
          "\n\nТЕМЫ РЕДАКЦИИ И ОТКЛОНЁННЫЕ ВАРИАНТЫ — НЕ ПОВТОРЯТЬ ПО СМЫСЛУ: " +
          JSON.stringify(blockedTopics.slice(-120)) +
          "\nПопытка " + attempt + ". Предложи принципиально другой самостоятельный сюжет.",
        { task: "topic", maxAttempts: 3, fallbackModels: ["gemini-3.1-flash-lite"] }
      );
      const candidate = generatedTopic.replace(/^["«]|["»]$/g, "").trim();

      const moderationFailure = editorialTopicModerationFailure(candidate);
      if (!candidate || moderationFailure || isSimilarEditorialTopic(candidate, blockedTopics)) {
        job.attempts = attempt;
        job.rejected_candidates = [...(job.rejected_candidates || []), candidate || "(пустой ответ модели " + attempt + ")"].slice(-120);
        job.last_error = moderationFailure || (candidate ? "Тема повторяет ранее предложенную" : "Gemini generated an empty topic");
        job.next_attempt_at = Date.now() + 1000;
        await this.ctx.storage.put(jobKey, job);
        await this.ctx.storage.setAlarm(job.next_attempt_at);
        console.warn("Durable topic candidate rejected; retry scheduled:", {
          category: job.category, job_id: job.id, attempt, rejected_count: job.rejected_candidates.length
        });
        return job.next_attempt_at;
      }

      const duplicateByMeaning = await isSemanticDuplicateEditorialTopic(this.env, candidate, blockedTopics);
      if (duplicateByMeaning) {
        job.attempts = attempt;
        job.rejected_candidates = [...(job.rejected_candidates || []), candidate].slice(-120);
        job.last_error = "Тема повторяет или слишком близка по смыслу: " + candidate;
        job.next_attempt_at = Date.now() + 1000;
        await this.ctx.storage.put(jobKey, job);
        await this.ctx.storage.setAlarm(job.next_attempt_at);
        console.warn("Durable semantic duplicate rejected; retry scheduled:", {
          category: job.category, job_id: job.id, attempt, rejected_count: job.rejected_candidates.length
        });
        return job.next_attempt_at;
      }

      if (job.mode === "alternative") {
        const timestamp = new Date().toISOString();
        let applied = false;
        await this.ctx.storage.transaction(async (txn) => {
          const itemKey = "item:" + job.item_id;
          const current = await txn.get(itemKey);
          if (!current || current.status !== "generating_alternative_topic") {
            await txn.put(jobKey, { ...job, status: "cancelled", completed_at: timestamp });
            return;
          }

          current.title = candidate;
          current.content = "КАТЕГОРИЯ: " + current.category + "\n\nТЕМА: " + candidate;
          current.stage = "topic";
          current.status = "pending";
          current.approval_id = crypto.randomUUID();
          current.updated_at = timestamp;
          current.alternative_topic_count = Number(current.alternative_topic_count || 0) + 1;
          await txn.put("editorial:topic_history",
            [...(await txn.get("editorial:topic_history") || []), {
              title: candidate, category: current.category, created_at: timestamp
            }].slice(-200)
          );
          await txn.put(itemKey, current);
          await this.addEvent(txn, {
            item_id: current.id, stage: "topic", action: "ai_alternative_topic_generated",
            category: current.category, title: candidate, user_id: job.user_id
          });
          await this.enqueue(txn, "sendMessage", {
            chat_id: job.expected_chat_id,
            text: "Предлагаю другой вариант темы. Проверь его:"
          });
          await this.enqueue(txn, "sendMessage", approvalMessage(current, job.expected_chat_id));
          await txn.put(jobKey, {
            ...job, status: "completed", item_id: current.id, title: candidate,
            attempts: attempt, completed_at: timestamp, next_attempt_at: 0
          });
          applied = true;
        });

        if (applied) {
          console.log("Durable alternative topic generation completed:", {
            item_id: job.item_id, job_id: job.id, attempt, title: candidate
          });
          await this.flushOutbox();
        }
        return null;
      }

      const timestamp = new Date().toISOString();
      const item = {
        id: "material-" + crypto.randomUUID().slice(0, 8),
        content: "КАТЕГОРИЯ: " + job.category + "\n\nТЕМА: " + candidate,
        category: job.category, title: candidate, stage: "topic", status: "pending",
        history: [], created_at: timestamp, updated_at: timestamp, approval_id: crypto.randomUUID()
      };

      await this.ctx.storage.transaction(async (txn) => {
        await txn.put("item:" + item.id, item);
        await txn.put("editorial:topic_history",
          [...(await txn.get("editorial:topic_history") || []), {
            title: candidate, category: job.category, created_at: timestamp
          }].slice(-200)
        );
        await txn.put(job.rotation_key, (Number(job.rotation_index || 0) + 1) % Number(job.rotation_length || 1));
        await this.addEvent(txn, {
          item_id: item.id, stage: "topic", action: "ai_topic_generated",
          category: job.category, user_id: job.user_id
        });
        await this.enqueue(txn, "sendMessage", approvalMessage(item, job.expected_chat_id));
        if (job.schedule_key) {
          await txn.put("schedule-run:" + job.schedule_key, {
            status: "created", item_id: item.id, job_id: job.id, created_at: timestamp
          });
        }
        await txn.put(jobKey, {
          ...job, status: "completed", item_id: item.id, title: candidate,
          attempts: attempt, completed_at: timestamp, next_attempt_at: 0
        });
      });

      console.log("Durable editorial topic generation completed:", {
        category: job.category, job_id: job.id, attempt, item_id: item.id, title: candidate
      });
      await this.flushOutbox();
      return null;
    } catch (error) {
      const persistedJob = await this.ctx.storage.get(jobKey);
      if (persistedJob?.status === "completed" || persistedJob?.status === "cancelled") {
        await this.flushOutbox();
        return null;
      }
      const failures = Number(job.transient_failures || 0) + 1;
      const delayMs = Math.min(5 * 60_000, 2_000 * (2 ** Math.min(failures - 1, 8)));
      job.attempts = attempt;
      job.transient_failures = failures;
      job.last_error = String(error.message || error).slice(0, 700);
      job.next_attempt_at = Date.now() + delayMs;
      await this.ctx.storage.put(jobKey, job);
      await this.ctx.storage.setAlarm(job.next_attempt_at);
      console.error("Durable editorial topic generation/check failed; retry persisted:", {
        category: job.category, job_id: job.id, attempt, failures, delay_ms: delayMs, error: job.last_error
      });
      return job.next_attempt_at;
    }
  }

  async generateAlternativeTopic(itemId) {
    const itemKey = "item:" + itemId;
    const item = await this.ctx.storage.get(itemKey);
    if (!item || item.status !== "generating_alternative_topic") {
      return { ok: false, skipped: true };
    }

    const rejectedTopics = Array.isArray(item.rejected_topics) ? item.rejected_topics : [];
    const recentTopics = await getRecentEditorialTopics(this.ctx.storage, itemId);
    const prompt =
      "Ты — выпускающий редактор OSINTNER, профессионального медиа об OSINT, комплаенсе, AML и антифроде.\n\n" +
      "Предложи ОДНУ новую тему взамен отклонённой. Это должен быть другой самостоятельный сюжет, а не перефразирование или сужение прежней темы.\n\n" +
      "КАТЕГОРИЯ: " + (item.category || "OSINT") + "\n" +
      "ОТКЛОНЁННЫЕ ТЕМЫ — НЕ ПОВТОРЯТЬ ПО СМЫСЛУ: " + rejectedTopics.join(" | ") + "\n\n" +
      "Требования: одна конкретная проблема или объект проверки; естественный профессиональный русский язык; 8–14 слов, максимум 16; без канцелярита, искусственных терминов и перечисления нескольких сюжетов. Не выдумывай факты, компании или статистику. Выбери другой предмет и другой сценарий. Верни только один заголовок.";

    const jobId = "alternative:" + itemId + ":" + crypto.randomUUID().slice(0, 8);
    const jobKey = "topic-generation:" + jobId;
    const job = {
      id: jobId,
      mode: "alternative",
      item_id: itemId,
      category: item.category || "OSINT",
      prompt,
      recent_topics: recentTopics.slice(0, 120),
      rejected_candidates: [...new Set([item.title, ...rejectedTopics].filter(Boolean))].slice(-120),
      attempts: 0,
      transient_failures: 0,
      user_id: String(this.env.TELEGRAM_CHAT_ID || ""),
      expected_chat_id: this.env.TELEGRAM_CHAT_ID,
      status: "pending",
      created_at: new Date().toISOString(),
      next_attempt_at: Date.now()
    };

    await this.ctx.storage.put(jobKey, job);
    await this.ctx.storage.setAlarm(Date.now() + 1000);
    console.log("Alternative editorial topic queued for durable processing:", {
      item_id: itemId, job_id: jobId
    });
    return { ok: true, status: "generating_alternative_topic", job_id: jobId };
  }

  async handleTest(payload) {
    const expectedId = String(
      this.env.TELEGRAM_CHAT_ID ?? ""
    );

    if (
      !expectedId ||
      String(payload.chat_id ?? "") !== expectedId
    ) {
      console.error("Coordinator test unauthorized");

      return {
        ok: false,
        error: "Unauthorized"
      };
    }

    const timestamp = new Date().toISOString();

    const item = {
      id: `test-${crypto.randomUUID().slice(0, 8)}`,
      content:
        "ТЕСТОВАЯ ТЕМА: Как проверить подлинность корпоративного сайта и выявить сайт-клон",
      title: "Как проверить подлинность корпоративного сайта и выявить сайт-клон",
      category: "OSINT",
      is_test: true,
      stage: "topic",
      status: "pending",
      history: [],
      created_at: timestamp,
      updated_at: timestamp,
      approval_id: crypto.randomUUID()
    };

    await this.ctx.storage.transaction(async (txn) => {
      await txn.put(`item:${item.id}`, item);

      await this.addEvent(txn, {
        item_id: item.id,
        stage: "topic",
        action: "test_created",
        user_id: String(payload.user_id ?? "")
      });

      await this.enqueue(
        txn,
        "sendMessage",
        approvalMessage(item, this.env.TELEGRAM_CHAT_ID)
      );
    });

    return {
      ok: true,
      status: "pending",
      item_id: item.id
    };
  }

  // ==================================================
  // AI TEXT GENERATOR
  // ==================================================

  async generateDraftText(item, rejectedVersions = []) {
    const topicContext = String(
      item.topic_context ||
      (item.text_content && item.content === item.text_content
        ? item.title
        : item.content || item.title || "")
    ).slice(0, 5000);
    const rejected = rejectedVersions
      .slice(-3)
      .map((value, index) => `ОТКЛОНЁННАЯ РЕДАКЦИЯ ${index + 1}:\n${String(value).slice(0, 700)}`)
      .join("\n\n");
    const isRevision = rejectedVersions.length > 0;
    const revisionInstructions = isRevision
      ? "\n\nРЕЖИМ РЕДАКТОРСКОЙ ДОРАБОТКИ: предыдущая редакция была отклонена. Отклонённые редакции ниже приведены ИСКЛЮЧИТЕЛЬНО как примеры того, что нельзя повторять. Не используй их как фактический контекст и не копируй их структуру или формулировки. Сначала самостоятельно определи слабые места предыдущих версий: неточные термины, логические ошибки, неподтверждённые выводы, пропущенные важные оговорки, повторы и неестественный язык. Затем создай действительно новую, более точную редакцию. Сохрани тему, но измени формулировки и логику изложения там, где это необходимо. Если в отклонённых версиях есть спорное утверждение, исправь его, а не перефразируй. Не возвращайся к формулировкам вроде «свежий возраст домена». Для темы о сайтах-клонах обязательно различай регистрацию домена, историю домена и назначение SSL-сертификата: SSL подтверждает защищённое соединение, но сам по себе не подтверждает подлинность сайта."
      : "";
    const rejectedTextBlock = rejected
      ? "\n\nОТКЛОНЁННЫЕ РЕДАКЦИИ — ТОЛЬКО ДЛЯ АНАЛИЗА ОШИБОК, НЕ ПОВТОРЯТЬ:\n" + rejected
      : "";
    const prompt =
      "Ты редактор OSINTNER — профессионального медиа об OSINT, комплаенсе и антифроде. Подготовь один законченный пост Threads на русском языке.\n" +
      "ТЕМА: " + String(item.title || "") + "\n" +
      "КАТЕГОРИЯ: " + String(item.category || "") + "\n" +
      "ИСХОДНЫЙ КОНТЕКСТ ТЕМЫ (это единственный контекст для содержания): " + topicContext + "\n\n" +
      "ОБЯЗАТЕЛЬНО: максимум 470 символов с пробелами. Один пост, не цепочка и не серия. Начни с конкретного тезиса, кратко объясни суть темы, дай одно практическое действие и точный вывод. Текст должен быть самостоятельным и содержательным, не просто рекламным тизером. " +
      "Строго соответствуй теме. Не подменяй её соседним сюжетом и не добавляй сведения, которых нет в контексте или в общеизвестной методологии. Не выдумывай компании, цифры, события, документы, судебные дела, источники или результаты проверок. " +
      "Разделяй факт, индикатор риска и гипотезу. Не выдавай совпадение или косвенный признак за доказательство. Для риска кратко обозначь, что именно требуется перепроверить. Не раскрывай персональные данные и не предлагай незаконный доступ. " +
      "Профессиональный естественный русский язык, без канцелярита, хештегов, ссылок на продолжение, слов «часть 1», длинных заголовков и структуры большой статьи. " +
      "Верни только текст одного поста без кавычек и редакторских пояснений. Проверь фактическую осторожность, завершённость мысли и длину до 470 символов." +
      revisionInstructions +
      rejectedTextBlock;
    const result = (await geminiGenerate(this.env, prompt, {
      task: isRevision ? "threads_editorial_revision" : "threads_single_post",
      temperature: isRevision ? 0.35 : 0.45,
      maxOutputTokens: 500
    })).trim();
    if (!result || [...result].length < 80) {
      throw new Error("Generated Threads post is too short");
    }
    if ([...result].length > 500) {
      throw new Error("Generated Threads post exceeds 500 characters");
    }
    if (/#\\w/u.test(result)) {
      throw new Error("Generated Threads post contains a hashtag");
    }
    return result;
  }

  // ==================================================
  // VISUAL STYLE SETTINGS
  // ==================================================

  // ==================================================
  // GENERATION FAILURE HANDLER
  // ==================================================

  async markGenerationFailed(itemId, expectedStatus, stage, error) {
    const itemKey = `item:${itemId}`;

    await this.ctx.storage.transaction(async (txn) => {
      const item = await txn.get(itemKey);

      if (!item || item.status !== expectedStatus) {
        return;
      }

      const timestamp = new Date().toISOString();

      item.status = "generation_failed";
      item.updated_at = timestamp;
      item.generation_error = String(error.message || error).slice(0, 1000);

      await txn.put(itemKey, item);

      await this.addEvent(txn, {
        item_id: item.id,
        stage,
        action: "ai_generation_failed",
        error: item.generation_error
      });

      await this.enqueue(
        txn,
        "sendMessage",
        {
          chat_id: this.env.TELEGRAM_CHAT_ID,
          text:
            `Не удалось подготовить этап «${STAGE_NAMES[stage]}».\n\n` +
            `Материал: ${item.id}\n` +
            `Статус: generation_failed\n` +
            `Причина: ${item.generation_error}\n\n` +
            `Создай новую тему командой /generate.`
        }
      );
    });
  }

  // ==================================================
  // ALTERNATIVE TEXT ON REVISION
  // ==================================================

  async generateAlternativeText(itemId) {
    const itemKey = `item:${itemId}`;
    const item = await this.ctx.storage.get(itemKey);
    if (!item || item.status !== "generating_alternative_text") return { ok: false, skipped: true };

    try {
      const rejected = Array.isArray(item.rejected_texts) ? item.rejected_texts : [];
      const generatedText = await this.generateDraftText(item, rejected);
      await this.ctx.storage.transaction(async (txn) => {
        const current = await txn.get(itemKey);
        if (!current || current.status !== "generating_alternative_text") return;
        const timestamp = new Date().toISOString();
        current.topic_context = current.topic_context || (current.content === current.text_content ? current.title : current.content) || current.title || "";
        current.text_content = generatedText;
        current.content = generatedText;
        current.stage = "text";
        current.status = "pending";
        current.approval_id = crypto.randomUUID();
        current.updated_at = timestamp;
        current.text_generated_at = timestamp;
        current.alternative_text_count = Number(current.alternative_text_count || 0) + 1;
        await txn.put(itemKey, current);
        await this.addEvent(txn, { item_id: current.id, stage: "text", action: "ai_alternative_text_generated", category: current.category });
        await this.enqueue(txn, "sendMessage", approvalMessage(current, this.env.TELEGRAM_CHAT_ID));
      });
      return { ok: true };
    } catch (error) {
      console.error("Alternative text generation failed:", error.message);
      await this.markGenerationFailed(itemId, "generating_alternative_text", "text", error);
      return { ok: false, error: "alternative_text_generation_failed" };
    }
  }

  // ==================================================
  // GENERATE TEXT AND MOVE TO TEXT APPROVAL
  // ==================================================

  async runTextGeneration(itemId) {
    const itemKey = `item:${itemId}`;

    try {
      const sourceItem = await this.ctx.storage.get(itemKey);

      if (!sourceItem) {
        throw new Error("Material not found");
      }

      console.log("AI TEXT GENERATION STARTED:", itemId);

      const generatedText = await this.generateDraftText(sourceItem);

      await this.ctx.storage.transaction(async (txn) => {
        const item = await txn.get(itemKey);

        if (!item || item.status !== "generating_text") {
          return;
        }

        const timestamp = new Date().toISOString();

        item.topic_context = item.topic_context || item.content || item.title || "";
        item.text_content = generatedText;
        item.content = generatedText;
        item.stage = "text";
        item.status = "pending";
        item.approval_id = crypto.randomUUID();
        item.updated_at = timestamp;
        item.text_generated_at = timestamp;

        await txn.put(itemKey, item);

        await this.addEvent(txn, {
          item_id: item.id,
          stage: "text",
          action: "ai_text_generated",
          category: item.category
        });

        await this.enqueue(
          txn,
          "sendMessage",
          approvalMessage(item, this.env.TELEGRAM_CHAT_ID)
        );
      });

      console.log("AI TEXT GENERATION COMPLETED:", itemId);

    } catch (error) {
      console.error("AI TEXT GENERATION FAILED:", error.message);

      await this.markGenerationFailed(
        itemId,
        "generating_text",
        "text",
        error
      );
    }
  }

  // ==================================================
  // APPROVAL CALLBACK
  // ==================================================

  async handleCallback(payload) {
    const q = payload.callback;

    if (!q?.id) {
      return {
        ok: false,
        error: "Missing callback ID"
      };
    }

    const chatId = String(
      q.message?.chat?.id ?? ""
    );

    const userId = String(
      q.from?.id ?? ""
    );

    const authorized =
      Boolean(this.env.TELEGRAM_CHAT_ID) &&
      chatId === String(this.env.TELEGRAM_CHAT_ID) &&
      q.message?.chat?.type === "private" &&
      userId === chatId;

    if (!authorized) {
      await telegram(this.env, "answerCallbackQuery", {
        callback_query_id: q.id,
        text: "Нет доступа"
      });

      return {
        ok: true,
        status: "unauthorized"
      };
    }

    const [action, itemId, approvalId] =
      String(q.data ?? "").split(":");

    if (
      !["approve", "reject", "revise"].includes(action) ||
      !itemId ||
      !approvalId
    ) {
      await telegram(this.env, "answerCallbackQuery", {
        callback_query_id: q.id,
        text: "Некорректная кнопка"
      });

      return {
        ok: true,
        status: "invalid_callback"
      };
    }

    const result = await this.ctx.storage.transaction(async (txn) => {
      const callbackKey = `callback:${q.id}`;
      const processed = await txn.get(callbackKey);

      if (processed) {
        return {
          duplicate: true
        };
      }

      const itemKey = `item:${itemId}`;
      const item = await txn.get(itemKey);
      const timestamp = new Date().toISOString();

      if (!item) {
        await txn.put(callbackKey, {
          processed_at: timestamp
        });

        return {
          status: "not_found"
        };
      }

      if (
        item.status !== "pending" ||
        item.approval_id !== approvalId ||
        !STAGES.includes(item.stage)
      ) {
        await txn.put(callbackKey, {
          processed_at: timestamp
        });

        return {
          status: "stale"
        };
      }

      const currentStage = item.stage;

      item.history = Array.isArray(item.history)
        ? item.history
        : [];

      item.history.push({
        stage: currentStage,
        action,
        user_id: userId,
        approval_id: approvalId,
        timestamp
      });

      item.updated_at = timestamp;

      let nextItem = null;

      if (action === "approve") {
        const index = STAGES.indexOf(currentStage);

        if (currentStage === "final") {
          if (item.is_test) {
            item.status = "test_completed";
            item.test_completed_at = timestamp;
          } else {
            item.status = "publication_approved";
            item.publication_approved_at = timestamp;
          }
          delete item.approval_id;

        } else if (currentStage === "topic") {
          item.status = "generating_text";
          delete item.approval_id;

        } else {
          item.stage = STAGES[index + 1];
          item.status = "pending";
          item.approval_id = crypto.randomUUID();

          nextItem = { ...item };
        }

      } else if (action === "reject") {
        // Reject always terminates this material; no alternative is generated.
        item.status = "rejected";
        item.rejected_at = timestamp;
        item.decision_at = timestamp;
        delete item.approval_id;

      } else if (action === "revise") {
        // Revision is the only action that asks AI for another version.
        if (currentStage === "topic") {
          item.rejected_topics = Array.isArray(item.rejected_topics) ? item.rejected_topics : [];
          item.rejected_topics.push(item.title);
          item.rejected_topics = item.rejected_topics.slice(-10);
          item.status = "generating_alternative_topic";
        } else if (currentStage === "text") {
          item.rejected_texts = Array.isArray(item.rejected_texts) ? item.rejected_texts : [];
          item.rejected_texts.push(String(item.text_content || "").slice(0, 5000));
          item.rejected_texts = item.rejected_texts.slice(-5);
          item.status = "generating_alternative_text";
        } else if (currentStage === "final") {
          item.rejected_texts = Array.isArray(item.rejected_texts) ? item.rejected_texts : [];
          if (item.text_content) item.rejected_texts.push(String(item.text_content).slice(0, 5000));
          item.rejected_texts = item.rejected_texts.slice(-5);
          item.status = "generating_alternative_text";
        } else {
          item.status = "revision_requested";
        }
        item.decision_at = timestamp;
        delete item.approval_id;
      }

      await txn.put(itemKey, item);

      await txn.put(callbackKey, {
        processed_at: timestamp
      });

      await this.addEvent(txn, {
        item_id: item.id,
        stage: currentStage,
        action,
        user_id: userId,
        callback_id: q.id
      });

      const acknowledgement =
        action === "approve"
          ? (
              item.status === "test_completed"
                ? "Тестовый цикл согласования завершён. Публикация в Threads не выполнялась."
                : item.status === "publication_approved"
                  ? "ФИНАЛЬНОЕ РАЗРЕШЕНИЕ ПОЛУЧЕНО. Публикация одобрена."
                  : currentStage === "topic" && !item.is_test
                  ? "Тема одобрена. Начинаю подготовку текста..."
                  : currentStage === "text" && !item.is_test
                    ? "Текст одобрен. Передаю материал на финальное согласование..."
                    : `Этап «${STAGE_NAMES[currentStage]}» одобрен.`
            )
          : (
              action === "reject"
                ? "Материал отклонён. Работа по нему остановлена; новые варианты создаваться не будут."
                : currentStage === "topic"
                  ? "Материал отправлен на доработку. Подготавливаю другой вариант темы..."
                  : currentStage === "text"
                    ? "Материал отправлен на доработку. Подготавливаю другую редакцию текста..."
                      : currentStage === "final"
                        ? "Материал отправлен на доработку. Подготавливаю новую редакцию..."
                        : "Материал отправлен на доработку. Подготавливаю другой вариант."
            );

      await this.enqueue(txn, "answerCallbackQuery", {
        callback_query_id: q.id,
        text: "Решение сохранено"
      });

      await this.enqueue(txn, "sendMessage", {
        chat_id: this.env.TELEGRAM_CHAT_ID,
        text: acknowledgement
      });

      if (nextItem) {
        await this.enqueue(
          txn,
          "sendMessage",
          approvalMessage(nextItem, this.env.TELEGRAM_CHAT_ID)
        );
      }

      return {
        status: item.status,
        stage: item.stage,
        item_id: item.id,
        current_stage: currentStage,
        action
      };
    });

    if (result.duplicate) {
      await telegram(this.env, "answerCallbackQuery", {
        callback_query_id: q.id,
        text: "Это решение уже обработано"
      });

      return {
        ok: true,
        duplicate: true
      };
    }

    if (
      result.status === "stale" ||
      result.status === "not_found"
    ) {
      await telegram(this.env, "answerCallbackQuery", {
        callback_query_id: q.id,
        text:
          result.status === "stale"
            ? "Кнопка устарела или решение уже принято"
            : "Материал не найден"
      });

      return {
        ok: true,
        status: result.status
      };
    }

    if (result.status === "generating_text") {
      await this.flushOutbox();
      await this.runTextGeneration(result.item_id);
    }

    if (result.status === "generating_alternative_topic") {
      await this.flushOutbox();
      await this.generateAlternativeTopic(result.item_id);
    }

    if (result.status === "generating_alternative_text") {
      await this.flushOutbox();
      await this.generateAlternativeText(result.item_id);
    }

    if (result.status === "publication_approved") {
      await this.publishApprovedThreadsPost(result.item_id);
    }

    return {
      ok: true,
      status: result.status,
      stage: result.stage,
      item_id: result.item_id
    };
  }

  // ==================================================
  // THREADS PUBLISHING — ONLY AFTER FINAL APPROVAL
  // ==================================================

  async publishApprovedThreadsPost(itemId) {
    const itemKey = `item:${itemId}`;
    if (String(this.env.THREADS_PUBLISHING_ENABLED || "false").toLowerCase() !== "true") {
      const pausedItem = await this.ctx.storage.get(itemKey);
      if (pausedItem && pausedItem.status === "publication_approved") {
        await this.ctx.storage.put(itemKey, {
          ...pausedItem,
          threads_publication_status: "paused",
          threads_publication_error: "Text-only publishing is awaiting end-to-end verification"
        });
      }
      await telegram(this.env, "sendMessage", {
        chat_id: this.env.TELEGRAM_CHAT_ID,
        text: "Публикация в Threads пока приостановлена до завершения тестового текстового цикла. Материал сохранён, ничего не опубликовано: " + itemId
      });
      return { ok: false, paused: true };
    }
    const reservation = await this.ctx.storage.transaction(async txn => {
      const item = await txn.get(itemKey);
      if (!item || item.status !== "publication_approved") return { skipped: true };
      if (item.threads_publication_status === "published") return { duplicate: true };
      if (["creating", "publishing", "publish_unknown", "create_unknown"].includes(item.threads_publication_status)) {
        return { pending_review: true, status: item.threads_publication_status };
      }
      if (item.threads_publication_status === "created" && item.threads_container_id) {
        item.threads_publication_status = "creating";
        item.threads_resume_started_at = new Date().toISOString();
        await txn.put(itemKey, item);
        return { resume: true, item };
      }
      item.threads_publication_status = "creating";
      item.threads_publication_started_at = new Date().toISOString();
      await txn.put(itemKey, item);
      return { reserved: true, item };
    });

    if (reservation.skipped) return { ok: false, skipped: true };
    if (reservation.duplicate) return { ok: true, duplicate: true };
    if (reservation.pending_review) {
      await telegram(this.env, "sendMessage", {
        chat_id: this.env.TELEGRAM_CHAT_ID,
        text: "Публикация уже начата или её результат требует проверки вручную. Автоматический повтор заблокирован во избежание дубля. Материал: " + itemId + " (" + reservation.status + ")"
      });
      return { ok: false, pending_review: true };
    }

    let item = reservation.item;
    const token = await this.ctx.storage.get("threads:oauth:token");
    if (!token?.access_token || !token?.user_id) {
      await this.ctx.storage.put(itemKey, { ...item, threads_publication_status: "failed", threads_publication_error: "Threads account is not connected" });
      await telegram(this.env, "sendMessage", {
        chat_id: this.env.TELEGRAM_CHAT_ID,
        text: "Финальное одобрение получено, но публикация не выполнена: аккаунт Threads не подключён. Материал: " + itemId
      });
      return { ok: false, error: "Threads account is not connected" };
    }
    if (Number(token.expires_at || 0) <= Date.now()) {
      await this.ctx.storage.put(itemKey, { ...item, threads_publication_status: "failed", threads_publication_error: "Threads access token expired" });
      await telegram(this.env, "sendMessage", {
        chat_id: this.env.TELEGRAM_CHAT_ID,
        text: "Финальное одобрение получено, но токен Threads истёк. Переподключи аккаунт. Материал: " + itemId
      });
      return { ok: false, error: "Threads access token expired" };
    }

    const fullText = String(item.text_content || "").trim();
    if (!fullText || [...fullText].length > 500) {
      await this.ctx.storage.put(itemKey, { ...item, threads_publication_status: "failed", threads_publication_error: "Threads caption must contain 1–500 characters" });
      await telegram(this.env, "sendMessage", {
        chat_id: this.env.TELEGRAM_CHAT_ID,
        text: "Публикация остановлена: подпись должна содержать не более 500 символов. Материал: " + itemId
      });
      return { ok: false, error: "Threads caption exceeds 500-character limit" };
    }

    try {
      let containerId = reservation.resume ? String(item.threads_container_id) : "";
      if (!containerId) {
        const createUrl = new URL(`https://graph.threads.net/v1.0/${encodeURIComponent(token.user_id)}/threads`);
        const createForm = new URLSearchParams({
          media_type: "TEXT",
          text: fullText,
          access_token: token.access_token
        });
        const createResponse = await fetch(createUrl.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: createForm
        });
        const createResult = await createResponse.json().catch(() => ({}));
        if (!createResponse.ok || !createResult.id) {
          const message = createResult.error?.message || "Threads text container creation failed (" + createResponse.status + ")";
          await this.ctx.storage.put(itemKey, {
            ...item,
            threads_publication_status: "create_unknown",
            threads_publication_error: String(message).slice(0, 500),
            threads_publication_failed_at: new Date().toISOString()
          });
          throw new Error(message);
        }
        containerId = String(createResult.id);
        item = {
          ...item,
          threads_publication_status: "created",
          threads_container_id: containerId,
          threads_publication_started_at: new Date().toISOString()
        };
        await this.ctx.storage.put(itemKey, item);
      }

      let containerStatus = "";
      let containerError = "";
      for (let attempt = 0; attempt < 15; attempt++) {
        const statusUrl = new URL(`https://graph.threads.net/v1.0/${encodeURIComponent(containerId)}`);
        statusUrl.searchParams.set("fields", "status,error_message");
        statusUrl.searchParams.set("access_token", token.access_token);
        const statusResponse = await fetch(statusUrl.toString());
        const statusResult = await statusResponse.json().catch(() => ({}));
        if (!statusResponse.ok) {
          throw new Error(statusResult.error?.message || "Threads container status check failed (" + statusResponse.status + ")");
        }
        containerStatus = String(statusResult.status || "");
        containerError = String(statusResult.error_message || "");
        if (containerStatus === "FINISHED") break;
        if (containerStatus === "PUBLISHED") {
          await this.ctx.storage.put(itemKey, {
            ...item,
            threads_publication_status: "publish_unknown",
            threads_container_id: containerId,
            threads_publication_error: "Container reports PUBLISHED before this workflow received a publish ID"
          });
          throw new Error("Threads container is already PUBLISHED; automatic retry is blocked to prevent a duplicate");
        }
        if (["ERROR", "EXPIRED"].includes(containerStatus)) {
          await this.ctx.storage.put(itemKey, {
            ...item,
            threads_publication_status: "failed",
            threads_container_id: containerId,
            threads_publication_error: "Threads container status " + containerStatus + (containerError ? ": " + containerError : "")
          });
          throw new Error("Threads container status " + containerStatus + (containerError ? ": " + containerError : ""));
        }
        if (attempt < 14) await new Promise(resolve => setTimeout(resolve, 2000));
      }

      if (containerStatus !== "FINISHED") {
        await this.ctx.storage.put(itemKey, {
          ...item,
          threads_publication_status: "created",
          threads_container_id: containerId,
          threads_publication_error: "Text container is still processing; retry can resume this container"
        });
        await telegram(this.env, "sendMessage", {
          chat_id: this.env.TELEGRAM_CHAT_ID,
          text: "Threads ещё обрабатывает текстовый пост. Контейнер сохранён. Через минуту отправь команду /publish_retry " + itemId + " — повторно будет проверен тот же контейнер, без создания дубля."
        });
        return { ok: true, pending_processing: true, container_id: containerId };
      }

      await this.ctx.storage.put(itemKey, {
        ...item,
        threads_publication_status: "publishing",
        threads_container_id: containerId,
        threads_publish_started_at: new Date().toISOString()
      });

      const publishUrl = new URL(`https://graph.threads.net/v1.0/${encodeURIComponent(token.user_id)}/threads_publish`);
      publishUrl.searchParams.set("creation_id", containerId);
      publishUrl.searchParams.set("access_token", token.access_token);
      const publishResponse = await fetch(publishUrl.toString(), { method: "POST" });
      const publishResult = await publishResponse.json().catch(() => ({}));
      if (!publishResponse.ok || !publishResult.id) {
        const message = publishResult.error?.message || "Threads publish failed (" + publishResponse.status + ")";
        await this.ctx.storage.put(itemKey, {
          ...item,
          threads_publication_status: "publish_unknown",
          threads_container_id: containerId,
          threads_publication_error: String(message).slice(0, 500),
          threads_publication_failed_at: new Date().toISOString()
        });
        throw new Error(message);
      }

      let permalink = "";
      try {
        const mediaUrl = new URL(`https://graph.threads.net/v1.0/${encodeURIComponent(publishResult.id)}`);
        mediaUrl.searchParams.set("fields", "id,permalink");
        mediaUrl.searchParams.set("access_token", token.access_token);
        const mediaResponse = await fetch(mediaUrl.toString());
        if (mediaResponse.ok) {
          const media = await mediaResponse.json();
          permalink = String(media.permalink || "");
        }
      } catch (permalinkError) {
        console.error("Threads permalink lookup failed:", permalinkError.message);
      }

      const latestItem = await this.ctx.storage.get(itemKey);
      await this.ctx.storage.put(itemKey, {
        ...latestItem,
        threads_publication_status: "published",
        threads_post_id: String(publishResult.id),
        threads_permalink: permalink,
        threads_published_at: new Date().toISOString(),
        threads_publication_error: ""
      });
      await telegram(this.env, "sendMessage", {
        chat_id: this.env.TELEGRAM_CHAT_ID,
        text: "ПОСТ ОПУБЛИКОВАН В THREADS\nАккаунт: @" + String(token.username || "OSINTNER") +
          "\nМатериал: " + itemId +
          (permalink ? "\nСсылка: " + permalink : "\nID публикации: " + String(publishResult.id))
      });
      return { ok: true, post_id: String(publishResult.id), permalink };
    } catch (error) {
      const latestItem = await this.ctx.storage.get(itemKey);
      if (latestItem?.threads_publication_status === "published") {
        return { ok: true, post_id: latestItem.threads_post_id || "", permalink: latestItem.threads_permalink || "" };
      }
      if (latestItem?.threads_publication_status === "publishing") {
        await this.ctx.storage.put(itemKey, {
          ...latestItem,
          threads_publication_status: "publish_unknown",
          threads_publication_error: String(error.message || error).slice(0, 500),
          threads_publication_failed_at: new Date().toISOString()
        });
      } else if (latestItem?.threads_publication_status === "created") {
        // Keep the known container so /publish_retry can resume it without creating another.
      } else if (latestItem?.threads_publication_status === "creating" && latestItem.threads_container_id) {
        await this.ctx.storage.put(itemKey, {
          ...latestItem,
          threads_publication_status: "created",
          threads_publication_error: String(error.message || error).slice(0, 500)
        });
      } else if (latestItem?.threads_publication_status === "creating") {
        await this.ctx.storage.put(itemKey, {
          ...latestItem,
          threads_publication_status: "create_unknown",
          threads_publication_error: String(error.message || error).slice(0, 500),
          threads_publication_failed_at: new Date().toISOString()
        });
      } else if (!["create_unknown", "publish_unknown"].includes(latestItem?.threads_publication_status)) {
        await this.ctx.storage.put(itemKey, {
          ...latestItem,
          threads_publication_status: "failed",
          threads_publication_error: String(error.message || error).slice(0, 500),
          threads_publication_failed_at: new Date().toISOString()
        });
      }
      console.error("Threads publishing failed:", error.message);
      await telegram(this.env, "sendMessage", {
        chat_id: this.env.TELEGRAM_CHAT_ID,
        text: "Финальное одобрение получено, но публикация в Threads не завершилась.\nМатериал: " + itemId +
          "\nПричина: " + String(error.message || error).slice(0, 700) +
          "\nАвтоматический повтор заблокирован, чтобы исключить дубликат. Проверь статус контейнера в Threads."
      });
      return { ok: false, error: String(error.message || error) };
    }
  }

  // ==================================================
  // OUTBOX DELIVERY
  // ==================================================

  async flushOutbox() {
    const messages = await this.ctx.storage.list({
      prefix: "outbox:"
    });

    const orderedMessages = [...messages.entries()].sort(
      (a, b) => {
        const timeA = String(a[1].created_at || "");
        const timeB = String(b[1].created_at || "");

        if (timeA !== timeB) {
          return timeA.localeCompare(timeB);
        }

        const seqA = Number(
          a[1].sequence ?? Number.MAX_SAFE_INTEGER
        );

        const seqB = Number(
          b[1].sequence ?? Number.MAX_SAFE_INTEGER
        );

        if (seqA !== seqB) {
          return seqA - seqB;
        }

        return String(a[0]).localeCompare(String(b[0]));
      }
    );

    for (const [key, message] of orderedMessages) {
      try {
        await telegram(
          this.env,
          message.method,
          message.data
        );

        await this.ctx.storage.delete(key);

      } catch (error) {
        const errorMessage = String(error.message || error);

        console.error("Outbox delivery failed:", {
          key,
          method: message.method,
          error: errorMessage
        });

        if (errorMessage.includes("message is too long")) {
          await this.ctx.storage.transaction(async (txn) => {
            await txn.delete(key);

            await this.enqueue(
              txn,
              message.method,
              message.data,
              {
                created_at: message.created_at
              }
            );
          });

          console.log("Oversized message split into smaller messages");

          await this.ctx.storage.setAlarm(
            Date.now() + 1000
          );

          return;
        }

        if (errorMessage.includes("status 400")) {
          await this.ctx.storage.put(
            `failed:${key.slice("outbox:".length)}`,
            {
              ...message,
              error: errorMessage,
              failed_at: new Date().toISOString()
            }
          );

          await this.ctx.storage.delete(key);

          console.error(
            "Permanent Telegram error moved to failed storage"
          );

          continue;
        }

        await this.ctx.storage.setAlarm(
          Date.now() + OUTBOX_RETRY_MS
        );

        return;
      }
    }

    const remaining = await this.ctx.storage.list({
      prefix: "outbox:"
    });

    if (remaining.size > 0) {
      await this.ctx.storage.setAlarm(
        Date.now() + OUTBOX_RETRY_MS
      );
    }
  }

  // ==================================================
  // AUTOMATIC RETRY
  // ==================================================

  async alarm() {
    const now = Date.now();
    const entries = await this.ctx.storage.list({ prefix: "social:hourly:preview:" });
    let nextAlarmAt = 0;

    for (const [key, session] of entries.entries()) {
      if (session?.status !== "awaiting_choice") continue;
      const expiry = Number(session.expires_at || 0);
      if (expiry && expiry <= now) {
        await this.ctx.storage.put(key, { ...session, status: "expired", expired_at: new Date().toISOString() });
        await telegram(this.env, "sendMessage", {
          chat_id: this.env.TELEGRAM_CHAT_ID,
          text: "Время выбора шутки истекло. Пятёрка автоматически отклонена. Следующая подборка придёт в следующий час."
        });
      } else if (expiry && (!nextAlarmAt || expiry < nextAlarmAt)) {
        nextAlarmAt = expiry;
      }
    }

    // Durable hourly publication retries: failed slots stay queued until Threads
    // confirms publication. Retries reuse the original slot to prevent duplicate posts.
    const hourlyEnabledForRetry = await this.ctx.storage.get("social:hourly:enabled");
    const hourlyRetryEntries = await this.ctx.storage.list({ prefix: "social:hourly:auto_retry:" });
    const pendingHourlyRetries = [...hourlyRetryEntries.entries()]
      .filter(([, job]) => job?.status === "pending")
      .sort((a, b) => Number(a[1].next_attempt_at || 0) - Number(b[1].next_attempt_at || 0));

    if (hourlyEnabledForRetry !== false && pendingHourlyRetries.length) {
      const [retryKey, retryJob] = pendingHourlyRetries[0];
      const dueAt = Number(retryJob.next_attempt_at || 0);
      if (!dueAt || dueAt <= now) {
        try {
          const retryResult = await runHourlyAutoPublish(
            this,
            { scheduled_at: Number(retryJob.scheduled_at || now), slot: retryJob.slot, retry: true },
            { geminiGenerate, groqGenerate, tavilySearch, telegram }
          );
          if (retryResult?.published || retryResult?.pending_approval || retryResult?.reason === "slot_already_published") {
            await this.ctx.storage.delete(retryKey);
          } else if (retryResult?.reason === "interval_not_elapsed" && Number(retryResult.next_at || 0) > now) {
            await this.ctx.storage.put(retryKey, {
              ...retryJob, status: "pending",
              next_attempt_at: Number(retryResult.next_at),
              updated_at: new Date().toISOString()
            });
          } else if (retryResult?.reason !== "retry_scheduled") {
            const attempt = Number(retryJob.attempt || 0) + 1;
            const delay = Math.min(30 * 60 * 1000, 2 * 60 * 1000 * (2 ** Math.min(attempt - 1, 3)));
            await this.ctx.storage.put(retryKey, {
              ...retryJob, status: "pending", attempt,
              last_error: String(retryResult?.detail || retryResult?.reason || "Hourly retry did not publish").slice(0, 700),
              next_attempt_at: Date.now() + delay,
              updated_at: new Date().toISOString()
            });
          }
        } catch (retryError) {
          const attempt = Number(retryJob.attempt || 0) + 1;
          const rateLimited = /429|quota|rate.?limit|resource_exhausted/iu.test(String(retryError.message || retryError));
          const baseDelay = rateLimited ? 5 * 60 * 1000 : 2 * 60 * 1000;
          const delay = Math.min(30 * 60 * 1000, baseDelay * (2 ** Math.min(attempt - 1, 3)));
          await this.ctx.storage.put(retryKey, {
            ...retryJob, status: "pending", attempt,
            last_error: String(retryError.message || retryError).slice(0, 700),
            next_attempt_at: Date.now() + delay,
            updated_at: new Date().toISOString()
          });
        }
      } else if (!nextAlarmAt || dueAt < nextAlarmAt) {
        nextAlarmAt = dueAt;
      }
    }

    // Durable topic generation survives request/cron time limits. Each alarm performs
    // one generation + moderation attempt, then persists the next retry time.
    const topicJobs = await this.ctx.storage.list({ prefix: "topic-generation:" });
    const pendingJobs = [...topicJobs.entries()]
      .filter(([, job]) => job?.status === "pending")
      .sort((a, b) => Number(a[1].next_attempt_at || 0) - Number(b[1].next_attempt_at || 0));

    if (pendingJobs.length) {
      const [jobKey, job] = pendingJobs[0];
      const dueAt = Number(job.next_attempt_at || 0);
      if (!dueAt || dueAt <= now) {
        await this.processTopicGenerationJob(jobKey);
      } else if (!nextAlarmAt || dueAt < nextAlarmAt) {
        nextAlarmAt = dueAt;
      }
    }

    await this.flushOutbox();

    const remainingHourlyRetries = await this.ctx.storage.list({ prefix: "social:hourly:auto_retry:" });
    const nextHourlyRetry = hourlyEnabledForRetry === false ? 0 : [...remainingHourlyRetries.values()]
      .filter(job => job?.status === "pending")
      .reduce((earliest, job) => {
        const dueAt = Number(job.next_attempt_at || 0) || (Date.now() + 1000);
        return !earliest || dueAt < earliest ? dueAt : earliest;
      }, 0);
    if (nextHourlyRetry && (!nextAlarmAt || nextHourlyRetry < nextAlarmAt)) {
      nextAlarmAt = Math.max(Date.now() + 1000, nextHourlyRetry);
    }

    const remainingJobs = await this.ctx.storage.list({ prefix: "topic-generation:" });
    const nextPendingJob = [...remainingJobs.values()]
      .filter(job => job?.status === "pending")
      .reduce((earliest, job) => {
        const dueAt = Number(job.next_attempt_at || 0) || (Date.now() + 1000);
        return !earliest || dueAt < earliest ? dueAt : earliest;
      }, 0);

    if (nextPendingJob && (!nextAlarmAt || nextPendingJob < nextAlarmAt)) {
      nextAlarmAt = Math.max(Date.now() + 1000, nextPendingJob);
    }

    const remainingOutbox = await this.ctx.storage.list({ prefix: "outbox:" });
    if (remainingOutbox.size > 0) {
      const outboxRetryAt = Date.now() + OUTBOX_RETRY_MS;
      if (!nextAlarmAt || outboxRetryAt < nextAlarmAt) nextAlarmAt = outboxRetryAt;
    }

    if (nextAlarmAt) await this.ctx.storage.setAlarm(nextAlarmAt);
  }
}
