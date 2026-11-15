
import settings from "../../config/settings.json" with { type: "json" };
import { runHourlyTrend, generateHumorVariants, publishThreads } from "./hourly-social.js";

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

async function geminiGenerate(env, prompt, options = {}) {
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
    response = await requestGemini(activeModel, requestBody);

    try {
      result = await response.json();
    } catch {
      throw new Error(`Gemini returned invalid JSON: ${response.status}`);
    }

    if (response.ok) break;

    const details = Array.isArray(result.error?.details) ? result.error.details : [];
    const quotaDetails = details
      .filter(item => item?.["@type"]?.includes("QuotaFailure"))
      .flatMap(item => Array.isArray(item.violations) ? item.violations : []);
    const retryInfo = details.find(item => item?.["@type"]?.includes("RetryInfo"));
    const retryDelay = retryInfo?.retryDelay || details.find(item => item?.retryDelay)?.retryDelay || "";
    const retryMatch = String(retryDelay).match(/^(\\d+(?:\\.\\d+)?)s$/);
    retryDelaySeconds = retryMatch ? Number(retryMatch[1]) : null;
    const quotaText = quotaDetails.map(item =>
      [item.quotaMetric, item.quotaId, item.description].filter(Boolean).join(" ")
    ).join(" ");
    const dailyQuota = /RequestsPerDay|requests_per_day|generate_content_free_tier_requests/i.test(quotaText);

    // Quotas are model-specific in Gemini. On 429, move to another free
    // Flash model instead of repeatedly calling the exhausted model.
    if (response.status === 429 && fallbackModels.length) {
      const previousModel = activeModel;
      activeModel = fallbackModels.shift();
      attempt = 0;
      console.warn("Gemini quota fallback:", {
        from: previousModel,
        to: activeModel,
        dailyQuota,
        quotaText
      });
      continue;
    }

    // A daily quota cannot be repaired by immediate retries. Honour Google's
    // RetryInfo for transient throttling, with bounded exponential backoff.
    const retryable = response.status === 429 || response.status === 503;
    const waitSeconds = retryDelaySeconds ?? Math.min(2 ** (attempt - 1), 8);

    if (!retryable || dailyQuota || attempt === maxAttempts || waitSeconds > 20) {
      const errorMessage = result.error?.message || "Unknown Gemini error";
      const quotaInfo = [
        ...quotaDetails.map(item => {
          const parts = [];
          if (item.quotaMetric) parts.push("quotaMetric=" + item.quotaMetric);
          if (item.quotaId) parts.push("quotaId=" + item.quotaId);
          if (item.description) parts.push("description=" + item.description);
          if (item.quotaValue) parts.push("quotaValue=" + item.quotaValue);
          if (item.quotaDimensions) parts.push("dimensions=" + JSON.stringify(item.quotaDimensions));
          return parts.join(", ");
        }),
        ...details.filter(item => item?.retryDelay).map(item => "retryDelay=" + item.retryDelay)
      ].filter(Boolean).join("; ");
      const retryAfter = response.headers.get("retry-after");
      const diagnostic = [
        "Модель: " + activeModel,
        quotaInfo ? "Детали лимита: " + quotaInfo : "",
        retryAfter ? "Повторить через: " + retryAfter + " сек." : "",
        dailyQuota ? "Дневная квота исчерпана; повтор до сброса не поможет" : "",
        !quotaInfo ? "Провайдер не передал детализацию квоты" : ""
      ].filter(Boolean).join(". ");

      console.error("Gemini API error:", {
        status: response.status,
        model: activeModel,
        message: errorMessage,
        quotaInfo,
        retryAfter,
        attempt,
        dailyQuota
      });

      throw new Error(
        `Gemini API ${response.status}: ${errorMessage}${diagnostic ? ". " + diagnostic : ""}`
      );
    }

    const jitterMs = Math.floor(Math.random() * 500);
    const delayMs = Math.max(1000, waitSeconds * 1000) + jitterMs;
    console.warn("Gemini transient throttle; retrying:", {
      model: activeModel,
      attempt,
      maxAttempts,
      waitMs: delayMs,
      status: response.status
    });
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

async function tavilySearch(env, query) {
  if (!env.TAVILY_API_KEY) {
    throw new Error("TAVILY_API_KEY is not configured. Add the Tavily key as a Cloudflare Worker secret.");
  }

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + env.TAVILY_API_KEY
    },
    body: JSON.stringify({
      query,
      topic: "general",
      search_depth: "basic",
      max_results: 20,
      include_answer: false,
      include_raw_content: false,
      include_domains: [
        "nasa.gov", "noaa.gov", "usgs.gov", "nps.gov", "nih.gov", "loc.gov",
        "si.edu", "smithsonianmag.com", "britannica.com", "nature.com",
        "science.org", "pnas.org", "nationalgeographic.com", "unesco.org",
        "rsc.org", "aps.org", "jstor.org", "ox.ac.uk", "cam.ac.uk",
        "harvard.edu", "stanford.edu", "who.int", "esa.int",
        "royalsocietypublishing.org", "nationalacademies.org", "metmuseum.org",
        "amnh.org", "history.com", "noirlab.edu", "science.nasa.gov"
      ]
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = String(data.detail || data.message || data.error || "Unknown Tavily error").slice(0, 500);
    throw new Error("Tavily Search API " + response.status + ": " + message);
  }

  const results = Array.isArray(data.results) ? data.results : [];
  const unique = [];
  const seen = new Set();
  for (const item of results) {
    const url = String(item.url || "").trim();
    let host = "";
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;
      host = parsed.hostname.toLowerCase().replace(/^www\./u, "");
    } catch (_) { continue; }
    if (!url || !item.content || seen.has(host)) continue;
    seen.add(host);
    unique.push({
      title: String(item.title || "").slice(0, 240),
      url,
      content: String(item.content || "").slice(0, 1800)
    });
  }

  console.log("Tavily hourly fact search completed:", {
    results: unique.length,
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
  const lines = (result.variants || []).map((item, index) => {
    const sources = Array.isArray(item.source_urls) && item.source_urls.length
      ? "\nИсточники: " + item.source_urls.slice(0, 2).join(" | ")
      : "";
    return (index + 1) + ". " + item.text + sources;
  }).join("\n\n");
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
    throw new Error(
      `Approval Coordinator error: ${result.error || response.status}`
    );
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
          const editorialResult = await callCoordinator(env, "/generate", {
            user_id: env.TELEGRAM_CHAT_ID,
            chat_id: env.TELEGRAM_CHAT_ID,
            scheduled_at: controller.scheduledTime,
            schedule_key: "editorial:" + new Date(controller.scheduledTime).toISOString()
          });
          console.log("Scheduled editorial approval workflow started:", editorialResult);
        }
        const hourlyState = await callCoordinator(env, "/hourly-expire", {
          user_id: env.TELEGRAM_CHAT_ID, chat_id: env.TELEGRAM_CHAT_ID
        });
        const hourlySettings = await callCoordinator(env, "/hourly-settings", {
          action: "get", user_id: env.TELEGRAM_CHAT_ID, chat_id: env.TELEGRAM_CHAT_ID
        });
        if (hourlyState.active) {
          console.log("Hourly facts are awaiting the user's choice:", hourlyState.active.session_id);
        } else if (localTime.endsWith(":00") && hourlySettings.enabled === true) {
          const hourlyResult = await callCoordinator(env, "/hourly-trend", {
            scheduled_at: controller.scheduledTime, manual: true, preview: true
          });
          if (hourlyResult.preview && hourlyResult.session_id) {
            await telegram(env, "sendMessage", hourlyVariantsPayload(env.TELEGRAM_CHAT_ID, hourlyResult));
            console.log("Hourly fact options sent for approval:", hourlyResult.session_id);
          } else {
            await telegram(env, "sendMessage", {
              chat_id: env.TELEGRAM_CHAT_ID,
              text: "Не удалось подготовить ежечасную подборку фактов. Причина: " + String(hourlyResult.reason || hourlyResult.error || "неизвестная ошибка")
            });
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
          result = { ok: true, enabled: enabled === true };
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
      console.error(
        "Coordinator error:",
        error.message,
        error.stack || ""
      );

      return json({
        ok: false,
        error: "Processing failed"
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
    if (scheduleKey) {
      const existingSchedule = await this.ctx.storage.get("schedule-run:" + scheduleKey);
      if (existingSchedule) return { ok: true, duplicate: true, item_id: existingSchedule.item_id || "" };
      await this.ctx.storage.put("schedule-run:" + scheduleKey, {
        status: "started",
        started_at: new Date().toISOString()
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

    const generatedTopic = await geminiGenerate(
      this.env,
      prompt,
      { task: "topic" }
    );

    const title = generatedTopic
      .replace(/^["«]|["»]$/g, "")
      .trim();

    if (!title) {
      throw new Error("Gemini generated an empty topic");
    }

    const timestamp = new Date().toISOString();

    const item = {
      id: `material-${crypto.randomUUID().slice(0, 8)}`,
      content: `КАТЕГОРИЯ: ${category}\n\nТЕМА: ${title}`,
      category,
      title,
      stage: "topic",
      status: "pending",
      history: [],
      created_at: timestamp,
      updated_at: timestamp,
      approval_id: crypto.randomUUID()
    };

    if (scheduleKey) {
      await this.ctx.storage.put("schedule-run:" + scheduleKey, {
        status: "created",
        item_id: item.id,
        created_at: timestamp
      });
    }

    await this.ctx.storage.transaction(async (txn) => {
      await txn.put(`item:${item.id}`, item);

      await txn.put(
        rotationKey,
        (index + 1) % topics.length
      );

      await this.addEvent(txn, {
        item_id: item.id,
        stage: "topic",
        action: "ai_topic_generated",
        category,
        user_id: userId
      });

      await this.enqueue(
        txn,
        "sendMessage",
        approvalMessage(item, expectedChatId)
      );
    });

    return {
      ok: true,
      status: "pending",
      item_id: item.id,
      category,
      title
    };
  }

  // ==================================================
  // ALTERNATIVE TOPIC ON REVISION
  // ==================================================

  async generateAlternativeTopic(itemId) {
    const itemKey = `item:${itemId}`;
    const item = await this.ctx.storage.get(itemKey);

    if (!item || item.status !== "generating_alternative_topic") {
      return { ok: false, skipped: true };
    }

    const rejectedTopics = Array.isArray(item.rejected_topics)
      ? item.rejected_topics
      : [];

    const prompt =
      `Ты — выпускающий редактор OSINTNER, профессионального медиа об OSINT, комплаенсе, AML и антифроде.\n\n` +
      `Предложи ОДНУ новую тему взамен отклонённой. Это должен быть другой самостоятельный сюжет, а не перефразирование или сужение прежней темы.\n\n` +
      `КАТЕГОРИЯ: ${item.category || "OSINT"}\n` +
      `ОТКЛОНЁННЫЕ ТЕМЫ — НЕ ПОВТОРЯТЬ ПО СМЫСЛУ: ${rejectedTopics.join(" | ")}\n\n` +
      `ОБЯЗАТЕЛЬНЫЕ РЕДАКЦИОННЫЕ ТРЕБОВАНИЯ:\n` +
      `1. Одна тема = одна конкретная проблема, один объект проверки или один метод расследования.\n` +
      `2. Заголовок должен быть понятным, естественным и профессиональным, без канцелярита и искусственных терминов.\n` +
      `3. Ориентир — 8–14 слов, абсолютный максимум — 16 слов.\n` +
      `4. Не объединяй несколько сюжетов и не перечисляй более двух инструментов или источников.\n` +
      `5. Не используй конструкции «через анализ A, B и C для выявления X, Y и Z». Не превращай заголовок в план статьи.\n` +
      `6. Выбирай практически значимый сюжет для специалистов по OSINT, комплаенсу, AML и антифроду с учётом категории материала.\n` +
      `7. Не обещай доказать личность, аффилированность или нарушение, если доступны только косвенные признаки. Не выдумывай факты, компании и статистику.\n` +
      `8. Чередуй предметные области и типы задач; не предлагай снова тот же объект расследования под другими словами.\n\n` +
      `Перед ответом проверь длину, ясность, естественность и отличие от всех отклонённых тем. При несоответствии придумай другой сюжет.\n\n` +
      `Верни только один короткий заголовок на русском языке, без кавычек, пояснений и нумерации.`;

    try {
      const generatedTopic = await geminiGenerate(
        this.env,
        prompt,
        { task: "topic" }
      );

      const title = generatedTopic
        .replace(/^["«]|["»]$/g, "")
        .trim();

      if (!title) {
        throw new Error("Gemini generated an empty alternative topic");
      }

      const timestamp = new Date().toISOString();

      await this.ctx.storage.transaction(async (txn) => {
        const current = await txn.get(itemKey);

        if (!current || current.status !== "generating_alternative_topic") {
          return;
        }

        current.title = title;
        current.content = `КАТЕГОРИЯ: ${current.category}\n\nТЕМА: ${title}`;
        current.stage = "topic";
        current.status = "pending";
        current.approval_id = crypto.randomUUID();
        current.updated_at = timestamp;
        current.alternative_topic_count =
          Number(current.alternative_topic_count || 0) + 1;

        await txn.put(itemKey, current);

        await this.addEvent(txn, {
          item_id: current.id,
          stage: "topic",
          action: "ai_alternative_topic_generated",
          category: current.category,
          title,
          user_id: String(this.env.TELEGRAM_CHAT_ID || "")
        });

        await this.enqueue(
          txn,
          "sendMessage",
          {
            chat_id: this.env.TELEGRAM_CHAT_ID,
            text: "Предлагаю другой вариант темы. Проверь его:",
          }
        );

        await this.enqueue(
          txn,
          "sendMessage",
          approvalMessage(current, this.env.TELEGRAM_CHAT_ID)
        );
      });

      await this.flushOutbox();

      return { ok: true, status: "pending", item_id: itemId, title };
    } catch (error) {
      console.error("Alternative topic generation failed:", error.message);

      await this.ctx.storage.transaction(async (txn) => {
        const current = await txn.get(itemKey);
        if (!current || current.status !== "generating_alternative_topic") {
          return;
        }

        current.status = "alternative_topic_generation_failed";
        current.updated_at = new Date().toISOString();
        await txn.put(itemKey, current);

        await this.enqueue(txn, "sendMessage", {
          chat_id: this.env.TELEGRAM_CHAT_ID,
          text: "Не удалось автоматически подготовить другую тему. Отправь /generate, чтобы создать новый материал."
        });
      });

      await this.flushOutbox();
      return { ok: false, error: "alternative_topic_generation_failed" };
    }
  }

  // ==================================================
  // TEST MATERIAL
  // ==================================================

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
    const entries = await this.ctx.storage.list({ prefix: "social:hourly:preview:" });
    let nextExpiry = 0;
    for (const [key, session] of entries.entries()) {
      if (session?.status !== "awaiting_choice") continue;
      const expiry = Number(session.expires_at || 0);
      if (expiry && expiry <= Date.now()) {
        await this.ctx.storage.put(key, { ...session, status: "expired", expired_at: new Date().toISOString() });
        await telegram(this.env, "sendMessage", {
          chat_id: this.env.TELEGRAM_CHAT_ID,
          text: "Время выбора шутки истекло. Пятёрка автоматически отклонена. Следующая подборка придёт в следующий час."
        });
      } else if (expiry && (!nextExpiry || expiry < nextExpiry)) {
        nextExpiry = expiry;
      }
    }
    await this.flushOutbox();
    if (nextExpiry) await this.ctx.storage.setAlarm(nextExpiry);
  }
}
