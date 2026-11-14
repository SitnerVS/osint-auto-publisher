
import settings from "../../config/settings.json" with { type: "json" };
import { runHourlyTrend } from "./hourly-social.js";

const SETTINGS = settings;

const STAGES = ["topic", "text", "visual", "final"];

const STAGE_NAMES = {
  topic: "ТЕМА",
  text: "ТЕКСТ",
  visual: "ВИЗУАЛ",
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

function getFinalVisualSummary(visualContent) {
  if (!visualContent) {
    return "Визуальная концепция не указана.";
  }

  const formatMatch = visualContent.match(
    /ФОРМАТ\s*:\s*([^\n]+)/i
  );

  const conceptMatch = visualContent.match(
    /КОНЦЕПЦИЯ\s*:\s*([^\n]+)/i
  );

  const format = formatMatch?.[1]?.trim() || "См. согласованный визуал";
  const concept = conceptMatch?.[1]?.trim() || "";

  return [
    `Формат: ${format}`,
    concept ? `Концепция: ${concept}` : ""
  ].filter(Boolean).join("\n");
}

function getApprovalContent(item) {
  if (item.stage === "topic") {
    return item.content || "";
  }

  if (item.stage === "text") {
    return item.text_content || item.content || "";
  }

  if (item.stage === "visual") {
    return item.visual_content || item.content || "";
  }

  if (item.stage === "final") {
    const text = item.text_content || "";
    const visualSummary = getFinalVisualSummary(
      item.visual_content
    );

    return (
      `${text}\n\n` +
      `СОГЛАСОВАННЫЙ ВИЗУАЛ\n` +
      `${visualSummary}`
    );
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

// ======================================================
// CLOUDFLARE WORKERS AI — IMAGE GENERATION
// ======================================================

async function generateCloudflareImage(env, prompt) {
  if (!env.AI || typeof env.AI.run !== "function") {
    throw new Error("Cloudflare Workers AI binding AI is not configured");
  }

  const form = new FormData();
  form.append("prompt", prompt);
  form.append("width", "1024");
  form.append("height", "1280");
  form.append("steps", "25");
  form.append("guidance", "4");

  // FLUX.2 Dev supports higher-fidelity generation and physical-world grounding.
  const serialized = new Response(form);
  const body = serialized.body;
  const contentType = serialized.headers.get("content-type");

  const result = await env.AI.run(
    "@cf/black-forest-labs/flux-2-dev",
    {
      multipart: {
        body,
        contentType
      }
    }
  );

  if (!result || typeof result.image !== "string" || !result.image) {
    throw new Error("Cloudflare AI returned no image data");
  }

  const binary = atob(result.image);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

async function telegramSendPhoto(env, chatId, imageBytes, caption) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }

  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  form.append(
    "photo",
    new Blob([imageBytes], { type: "image/png" }),
    "osint-image-test.png"
  );

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`,
    {
      method: "POST",
      body: form
    }
  );

  let result;

  try {
    result = await response.json();
  } catch {
    throw new Error(`Telegram sendPhoto returned invalid JSON: ${response.status}`);
  }

  if (!response.ok || !result.ok) {
    throw new Error(
      `Telegram sendPhoto failed: ${result.description || response.status}`
    );
  }

  return result;
}

// ======================================================

async function telegramSendMediaGroup(env, chatId, images, caption) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  if (!Array.isArray(images) || images.length < 2 || images.length > 10) throw new Error("Telegram media group must contain between 2 and 10 images");
  const form = new FormData();
  form.append("chat_id", String(chatId));
  const media = images.map((image, index) => {
    const attachment = "photo" + index;
    form.append(attachment, new Blob([image.bytes], { type: "image/png" }), "osint-slide-" + (index + 1) + ".png");
    return { type: "photo", media: "attach://" + attachment, ...(index === 0 && caption ? { caption: String(caption).slice(0, 900) } : {}) };
  });
  form.append("media", JSON.stringify(media));
  const response = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMediaGroup", { method: "POST", body: form });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error("Telegram sendMediaGroup failed: " + String(result.description || response.status));
  return result;
}

async function telegramSendVisualPreview(env, chatId, images, caption) {
  if (!Array.isArray(images) || images.length === 0) throw new Error("Visual preview has no images");
  if (images.length === 1) return telegramSendPhoto(env, chatId, images[0].bytes, String(caption || "").slice(0, 900));
  return telegramSendMediaGroup(env, chatId, images, caption);
}

function parseVisualPlan(raw) {
  const source = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = source.indexOf("{"), end = source.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Visual plan is not valid JSON");
  const plan = JSON.parse(source.slice(start, end + 1));
  if (!plan || typeof plan !== "object" || Array.isArray(plan) || !["single", "carousel"].includes(plan.format) || !Array.isArray(plan.slides)) throw new Error("Visual plan has an invalid structure");
  const validCount = plan.format === "single" ? plan.slides.length === 1 : plan.slides.length >= 3 && plan.slides.length <= 5;
  if (!validCount) throw new Error("Visual plan has an invalid number of slides");
  for (const slide of plan.slides) if (!slide || typeof slide.prompt !== "string" || slide.prompt.trim().length < 40) throw new Error("Visual plan contains an incomplete image prompt");
  return plan;
}

function formatVisualPlan(plan) {
  return [
    "ФОРМАТ: " + (plan.format === "carousel" ? "КАРУСЕЛЬ" : "ОДИНОЧНЫЙ ПОСТ"),
    "КОНЦЕПЦИЯ: " + String(plan.concept || "").trim(),
    "ОБОСНОВАНИЕ: " + String(plan.rationale || "").trim(),
    "ОБЩИЕ ПАРАМЕТРЫ: вертикальный формат 4:5; холодная тёмная navy/blue-gray документальная фотография; белая русская типографика; оранжевый акцент #F26A1B; без логотипов и водяных знаков",
    "СЛАЙДЫ:",
    ...plan.slides.map((slide, index) => (index + 1) + ". " + String(slide.title || ("Слайд " + (index + 1))).trim() + (slide.subtitle ? " — " + String(slide.subtitle).trim() : ""))
  ].join("\n");
}

async function generateAndStoreVisualAssets(env, itemId, plan) {
  if (!env.EDITORIAL_DATA) throw new Error("EDITORIAL_DATA KV binding is not configured");
  const baseUrl = "https://osint-telegram-gateway-staging.vssitner.workers.dev";
  const assets = [];
  for (let index = 0; index < plan.slides.length; index++) {
    const slide = plan.slides[index];
    const prompt = [
      "СЦЕНА ДЛЯ ФОТОГРАФИИ: " + String(slide.prompt).trim(),
      "ФОРМАТ: строго вертикальный 4:5, 1024x1280 пикселей.",
      "СТИЛЬ OSINTNER: премиальная фотореалистичная редакционная документальная фотография уровня международного расследовательского журнала и серьёзного business-crime documentary. Холодная тёмная navy / blue-gray цветокоррекция, приглушённые стальные оттенки, глубокие естественные тени, контролируемый направленный свет, реалистичная оптика и материалы, тонкое естественное зерно. Строго фотографический реализм, не цифровая иллюстрация и не CGI.",
      "КОМПОЗИЦИЯ: одна ясная визуальная идея и минимальное число необходимых объектов. Каждый предмет должен быть полностью сформирован, иметь правильную физическую форму, естественные пропорции и понятную конструкцию. Объекты должны быть отдельными, с реалистичными границами и естественными точками контакта; запрещены слияние, взаимное проникновение, сращивание, дублирование и деформация предметов. Если в сцене есть парные или составные предметы, сохраняй все их обязательные части и правильные соединения. Не добавляй предметы, которых нет в описании сцены. Оставь спокойное свободное пространство слева для последующей отдельной вёрстки. Не добавляй рамки, плашки, инфографику или интерфейсы.",
      "АБСОЛЮТНО НИКАКОГО ТЕКСТА: не создавать ни букв, ни цифр, ни слов, ни заголовков, ни подзаголовков, ни подписей, ни псевдотекста, ни случайных символов, ни маркировок. Никаких надписей на документах, бумагах, экранах, телефонах, компьютерах, вывесках, зданиях, одежде и предметах. Не имитировать текст нечитаемыми линиями или символами. Изображение должно быть полностью без текста.",
      "Никаких логотипов, брендов, названий компаний, OSINTNER, водяных знаков, социальных никнеймов, брендовых подписей или символов.",
      "ИСКЛЮЧИТЬ: cyberpunk, hacker in hoodie, matrix green rain, neon RGB, futuristic holograms, sci-fi interface, technical dashboards, complex HUD, warm brown color grading, golden cinematic lighting, cartoon, anime, plastic CGI, generic stock photography, visual clutter.",
      "Белая жирная русская типографика, оранжевые выделения #F26A1B и тонкая оранжевая линия относятся только к последующему отдельному этапу вёрстки и НЕ должны присутствовать в генерируемой фотографии."
    ].join("\n");
    const bytes = await generateCloudflareImage(env, prompt);
    const id = crypto.randomUUID().replace(/-/g, "");
    await env.EDITORIAL_DATA.put("social-image:" + id, bytes, { expirationTtl: 60 * 60 * 24 * 90 });
    assets.push({
      id, url: baseUrl + "/media/" + id,
      title: String(slide.title || ("Слайд " + (index + 1))).slice(0, 180),
      subtitle: String(slide.subtitle || "").slice(0, 250),
      alt_text: String(slide.alt_text || slide.title || "Редакционная иллюстрация OSINTNER").slice(0, 1000),
      item_id: itemId, slide: index + 1
    });
  }
  return assets;
}

// GEMINI AI
// ======================================================

async function geminiGenerate(env, prompt, options = {}) {
  if (!env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  console.log("Gemini request started:", options.task || "generation");

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: prompt
              }
            ]
          }
        ],
        generationConfig: {
          temperature: options.temperature ?? 0.7,
          maxOutputTokens: options.maxOutputTokens ?? 2500
        }
      })
    }
  );

  let result;

  try {
    result = await response.json();
  } catch {
    throw new Error(
      `Gemini returned invalid JSON: ${response.status}`
    );
  }

  if (!response.ok) {
    const errorMessage =
      result.error?.message || "Unknown Gemini error";

    console.error("Gemini API error:", {
      status: response.status,
      message: errorMessage
    });

    throw new Error(
      `Gemini API ${response.status}: ${errorMessage}`
    );
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

  return answer;
}

// ======================================================
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

      if (path.startsWith("/media/")) {
        const mediaId = path.slice("/media/".length);
        if (!/^[a-f0-9]{32}$/i.test(mediaId) || !env.EDITORIAL_DATA) {
          return new Response("Not found", { status: 404 });
        }
        const imageBytes = await env.EDITORIAL_DATA.get("social-image:" + mediaId, "arrayBuffer");
        if (!imageBytes) return new Response("Not found", { status: 404 });
        return new Response(imageBytes, {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "public, max-age=3600",
            "X-Content-Type-Options": "nosniff"
          }
        });
      }

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

          let username = "";
          try {
            const profileUrl = new URL("https://graph.threads.net/v1.0/me");
            profileUrl.searchParams.set("fields", "id,username");
            profileUrl.searchParams.set("access_token", longToken.access_token);
            const profileResponse = await fetch(profileUrl.toString());
            if (profileResponse.ok) {
              const profile = await profileResponse.json();
              username = String(profile.username || "");
            }
          } catch (profileError) {
            console.error("Threads profile lookup failed:", profileError.message);
          }

          const expiresIn = Number(longToken.expires_in || 5184000);
          await callCoordinator(env, "/threads/oauth/save-token", {
            access_token: longToken.access_token,
            user_id: String(shortToken.user_id),
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
          await telegram(env, "sendMessage", {
            chat_id: chatId,
            text:
              "OSINT Editorial подключён.\n" +
              "Система согласований готова.\n\n" +
              "Доступные команды:\n" +
              "/test — тест согласования\n" +
              "/visual_test — безопасный тест генерации визуала\n" +
              "/generate — генерация новой темы\n" +
              "/ai_test — проверка Gemini\n" +
              "/image_test — тест генерации изображения\n" +
              "/settings — просмотр настроек\n" +
              "/id — проверка Telegram ID"
          });
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
              `Account: ${SETTINGS.account}\n` +
              `Timezone: ${SETTINGS.timezone}\n` +
              `Feed posts per day: ${SETTINGS.publishing.feed_posts_per_day}\n` +
              `Feed schedule: ${SETTINGS.publishing.feed_schedule.join(", ")}\n` +
              `Reels per day: ${SETTINGS.publishing.reels_per_day}\n` +
              `Topic rotation: ${SETTINGS.content_strategy.topic_rotation.join(" → ")}\n` +
              `Hashtags: ${SETTINGS.content_strategy.hashtags ? "enabled" : "disabled"}`
          });
        }

        else if (command === "/test") {
          console.log("Approval test started");

          await callCoordinator(env, "/test", {
            user_id: userId,
            chat_id: chatId
          });
        }

        else if (command === "/visual_test") {
          console.log("VISUAL GENERATION TEST REQUESTED");
          await telegram(env, "sendMessage", {
            chat_id: chatId,
            text: "Запускаю безопасный тест генерации визуала. Тестовый материал не может быть опубликован в Threads."
          });
          await callCoordinator(env, "/visual-test", {
            user_id: userId,
            chat_id: chatId
          });
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

        else if (command === "/image_test") {
          console.log("CLOUDFLARE IMAGE TEST STARTED");

          await telegram(env, "sendMessage", {
            chat_id: chatId,
            text: "Запускаю тест генерации изображения FLUX.2 Dev. Это может занять некоторое время..."
          });

          try {
            const prompt =
              "Premium investigative documentary photography for a serious OSINT and corporate anti-fraud editorial publication. " +
              "A realistic, carefully composed dark corporate office desk with authentic printed financial audit documents, " +
              "a closed dark laptop and a restrained orange evidence marker. Cold dark navy and blue-gray photographic atmosphere, " +
              "dramatic but natural documentary lighting, subtle film grain, realistic materials, sophisticated forensic journalism, " +
              "high-end editorial photography. Vertical portrait composition, 4:5 aspect ratio. " +
              "No readable text, no letters, no numbers, no logos, no watermark, no people, no cyberpunk, no neon, " +
              "no holograms, no dashboards, no HUD, no security camera interface, no hacker clichés, no visual clutter.";

            const imageBytes = await generateCloudflareImage(env, prompt);

            await telegramSendPhoto(
              env,
              chatId,
              imageBytes,
              "ТЕСТ ГЕНЕРАЦИИ ИЗОБРАЖЕНИЙ\nМодель: FLUX.2 Dev\nФормат: 1024 × 1280 (4:5)\nСреда: Cloudflare Workers Free"
            );

            console.log("CLOUDFLARE IMAGE TEST COMPLETED", {
              bytes: imageBytes.byteLength
            });

          } catch (error) {
            console.error("CLOUDFLARE IMAGE TEST FAILED:", error.message);

            await telegram(env, "sendMessage", {
              chat_id: chatId,
              text:
                "Не удалось сгенерировать тестовое изображение.\n\n" +
                `Причина: ${String(error.message || error).slice(0, 1200)}`
            });
          }
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

        else if (command.startsWith("/")) {
          await telegram(env, "sendMessage", {
            chat_id: chatId,
            text:
              "Неизвестная команда.\n\n" +
              "Доступные команды:\n" +
              "/start\n" +
              "/test\n" +
              "/visual_test\n" +
              "/generate\n" +
              "/settings\n" +
              "/ai_test\n" +
              "/image_test\n" +
              "/id"
          });
        }
      }

      // ==================================================
      // INLINE BUTTON CALLBACKS
      // ==================================================

      if (update.callback_query) {
        console.log("Callback query received");

        await callCoordinator(env, "/callback", {
          callback: update.callback_query
        });
      }

      return new Response("OK");

    } catch (error) {
      console.error(
        "Webhook processing failed:",
        error.message,
        error.stack || ""
      );

      return new Response("Internal error", {
        status: 500
      });
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const result = await callCoordinator(env, "/hourly-trend", {
          scheduled_at: controller.scheduledTime
        });
        console.log("Hourly social publishing workflow finished:", result);
      } catch (error) {
        console.error("Hourly social publishing trigger failed:", error.message);
        try {
          await telegram(env, "sendMessage", {
            chat_id: env.TELEGRAM_CHAT_ID,
            text: "Не удалось запустить ежечасную рубрику.\nПричина: " + String(error.message || error).slice(0, 500)
          });
        } catch (notifyError) {
          console.error("Hourly workflow error notification failed:", notifyError.message);
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
      path !== "/visual-test" &&
      path !== "/generate" &&
      path !== "/threads/oauth/save-state" &&
      path !== "/threads/oauth/consume-state" &&
      path !== "/threads/oauth/save-token" &&
      path !== "/hourly-trend"
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
      } else if (path === "/visual-test") {
        result = await this.handleVisualTest(payload);
      } else if (path === "/generate") {
        result = await this.handleGenerate(payload);
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
      } else if (path === "/hourly-trend") {
        result = await runHourlyTrend(this, payload, { geminiGenerate, generateCloudflareImage, telegram });
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
        "ТЕСТОВАЯ ТЕМА: Как проверить цифровой след компании с помощью OSINT",
      title: "Тест согласования",
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

  async handleVisualTest(payload) {
    const expectedId = String(this.env.TELEGRAM_CHAT_ID ?? "");
    if (!expectedId || String(payload.chat_id ?? "") !== expectedId || String(payload.user_id ?? "") !== expectedId) {
      return { ok: false, error: "Unauthorized" };
    }

    const timestamp = new Date().toISOString();
    const item = {
      id: "visual-test-" + crypto.randomUUID().slice(0, 8),
      title: "Тест генерации визуала",
      category: "OSINT",
      content: "ТЕСТОВАЯ ТЕМА: Как проверить цифровой след компании с помощью OSINT",
      text_content: "Учебный материал для проверки визуального конвейера. Проверка цифрового следа компании включает анализ домена, публичных регистрационных сведений, связанных ресурсов и открытых корпоративных источников. Отдельные совпадения являются только индикаторами и требуют независимой проверки.",
      is_test: true,
      stage: "visual",
      status: "generating_visual",
      history: [],
      created_at: timestamp,
      updated_at: timestamp
    };

    await this.ctx.storage.transaction(async txn => {
      await txn.put("item:" + item.id, item);
      await this.addEvent(txn, {
        item_id: item.id,
        stage: "visual",
        action: "visual_test_created",
        user_id: String(payload.user_id ?? "")
      });
    });

    await this.runVisualGeneration(item.id);
    return { ok: true, status: "visual_test_started", item_id: item.id };
  }

  // ==================================================
  // AI TEXT GENERATOR
  // ==================================================

  async generateDraftText(item, rejectedVersions = []) {
    const rejectedTextBlock = rejectedVersions.length ? `\n\nОТКЛОНЁННЫЕ ВЕРСИИ — НЕ ПОВТОРЯТЬ И НЕ ПЕРЕФРАЗИРОВАТЬ:\n${rejectedVersions.slice(-3).map((value, index) => `${index + 1}. ${String(value).slice(0, 1200)}`).join("\n\n")}\n` : "";
    const prompt =
      `Ты главный редактор премиального расследовательского медиа OSINT Editorial.\n\n` +
      `Подготовь полноценный черновик публикации на русском языке.\n\n` +
      `КАТЕГОРИЯ: ${item.category}\n` +
      `ТЕМА: ${item.title}\n\n` +
      `ОБЯЗАТЕЛЬНЫЕ РЕДАКЦИОННЫЕ ТРЕБОВАНИЯ:\n` +
      `1. Строго раскрывай утверждённую тему, не подменяй её смежным сюжетом.\n` +
      `2. Одна статья — одна центральная проблема и последовательная логика разбора.\n` +
      `3. Используй естественный профессиональный русский язык без канцелярита и нагромождения терминов.\n` +
      `4. Разделяй подтверждённые факты, индикаторы риска, гипотезы и выводы; объясняй ограничения методов.\n` +
      `5. Отсутствие записи в одном реестре само по себе не доказывает незаконность деятельности или владения.\n` +
      `6. Не выдумывай реальные события, компании, статистику, документы, цитаты и результаты расследований.\n` +
      `7. Практический пример обозначай как условный учебный сценарий; не добавляй вымышленные детали под видом фактов. Если пример нельзя дать достоверно, приведи алгоритм проверки.\n` +
      `8. Давай воспроизводимую последовательность: что проверить, в каком источнике, что сопоставить и что означает результат.\n` +
      `9. Для существенных выводов указывай, какая дополнительная проверка нужна; не делай безосновательных юридических выводов.\n` +
      `10. Объясняй сложные термины, не используй их ради эффекта.\n` +
      `11. Не раскрывай персональные данные частных лиц и не предлагай незаконный доступ к закрытым данным.\n` +
      `12. Не добавляй хештеги.\n` +
      `13. КРИТИЧЕСКОЕ ПРАВИЛО ДОКАЗАТЕЛЬНОСТИ: не называй компанию номинальной, фиктивной или технической только по одному либо нескольким слабым косвенным признакам. Не делай такой вывод из малого уставного капитала, недавней регистрации, небольшого штата, отсутствия сайта/офиса/собственных активов, массового адреса, отсутствия судебной истории или крупного контракта относительно уставного капитала. Каждый из этих признаков сам по себе нейтрален или неоднозначен.\n` +
      `14. Для каждого индикатора риска обязательно укажи альтернативное законное объяснение и способ его проверить: аренда и лизинг вместо собственности; привлечение субподрядчиков и самозанятых вместо собственного штата; общий офис или юридический адрес; отсутствие публичного сайта; отсутствие споров у новой компании. Не трактуй отсутствие публичных сведений как доказательство отсутствия ресурса или деятельности.\n` +
      `15. Не используй формулировки «номинальный директор», «обналичивание», «транзит средств», «фиктивная деятельность», «необоснованный налоговый вычет» и подобные как установленные факты без конкретных подтверждений. Если подтверждений нет, обозначай это только как проверяемую гипотезу и объясняй, какие документы или независимые сведения нужны.\n` +
      `16. Не делай вывод «высокая вероятность номинальности» по набору условных признаков без оценки их качества, независимости и связи с предметом проверки. Вместо ярлыка формулируй конкретный риск: например, «не подтверждена способность исполнить заявленный объём работ».\n` +
      `17. В строительстве не утверждай, что подрядчик обязан иметь собственные штат, технику или универсальный «допуск СРО». Разделяй собственные и привлечённые ресурсы; проверяй применимость требований о членстве в СРО к конкретному виду договора, работ, стоимости и правовому статусу участника. Не смешивай членство в СРО с лицензией, аттестацией или допуском к отдельным видам работ.\n` +
      `18. При анализе судебной истории раскрывай роль компании в деле, предмет спора, сумму, стадию и результат. Сам факт наличия иска не подтверждает нарушение; отсутствие дел не подтверждает благонадёжность и не является самостоятельным индикатором фиктивности. Аналогично, исполнительное производство проверяй по статусу, основанию и результату, а не только по наличию записи.\n` +
      `19. Практический пример должен быть воспроизводимым и методологически корректным. Не придумывай конкретные цифры, судебные дела, результаты проверки или название реальной компании. Условные цифры явно помечай как учебные. Для каждого шага укажи точное название источника (если юрисдикция известна), что именно в нём искать, дату/актуальность сведений и как перепроверить результат. Если точный источник неизвестен или доступ к данным ограничен, честно обозначь ограничение, не подменяй его расплывчатым названием «госреестр».\n` +
      `20. Не используй уставный капитал как замену оценке финансовой устойчивости или операционных возможностей. Не сравнивай его напрямую с суммой контракта для вывода о риске. Для оценки ресурсов сопоставляй подтверждённые сведения о выручке, активах, обязательствах, персонале, договорах аренды/лизинга, привлечённых исполнителях, опыте и фактическом ходе работ. Учитывай период отчётности и то, что публичные данные могут быть неполными или устаревшими.\n\n` +
      `${rejectedTextBlock}` +
      `ОСОБЫЕ ТРЕБОВАНИЯ:\n`
      `- Для OSINT описывай законные методы работы с открытыми источниками.\n` +
      `- Для Комплаенса раскрывай практические механизмы контроля и проверки.\n` +
      `- Для Антифрода объясняй механизмы мошенничества и противодействия.\n` +
      `- Если тема касается санкций, различай подтверждённые сведения, совпадения и аналитические гипотезы.\n` +
      `- Не предлагай незаконный доступ к закрытым системам или данным.\n\n` +
      `СТРУКТУРА ОТВЕТА:\n` +
      `ЗАГОЛОВОК\n` +
      `ВВЕДЕНИЕ\n` +
      `ОСНОВНАЯ ЧАСТЬ\n` +
      `ПРАКТИЧЕСКИЙ ПРИМЕР\n` +
      `ВЫВОД\n` +
      `ИСТОЧНИКИ ДЛЯ ПРОВЕРКИ\n\n` +
      `В последнем разделе укажи конкретные названия подходящих первичных источников и поясни, какие сведения в них проверять. Не придумывай URL, номера документов и не утверждай, что источники уже проверены. Если юрисдикция не задана, не выдавай ресурс одной страны за универсальный.\n\n` +
      `Не называй условный сценарий реальным кейсом. Перед ответом проверь фактическую осторожность, связность, соответствие утверждённой теме и отсутствие повторов. Объём — примерно 2500–3000 знаков. Верни только текст публикации.`;

    const result = await geminiGenerate(
      this.env,
      prompt,
      { task: "publication_text" }
    );

    if (!result || result.trim().length < 300) {
      throw new Error("Generated publication text is too short");
    }

    if (Array.from(result).length > 3700) {
      const shortened = await geminiGenerate(
        this.env,
        `Сократи следующий материал до 3000 символов максимум, сохранив структуру, ограничения методов, различие фактов и гипотез, альтернативные законные объяснения индикаторов, запрет делать вывод о номинальности по слабым признакам, корректную оценку ресурсов и воспроизводимый практический алгоритм с конкретными источниками. Не добавляй фактов, не превращай гипотезы в утверждения и не удаляй методологические оговорки. Верни только сокращённый текст:\n\n${result}`,
        { task: "shorten_publication" }
      );

      if (Array.from(shortened).length > 3700) {
        throw new Error("Generated text exceeds Telegram single-message limit");
      }

      return shortened.trim();
    }

    return result.trim();
  }

  // ==================================================
  // VISUAL STYLE SETTINGS
  // ==================================================

  getVisualStyleInstructions() {
    const identity = SETTINGS.brand_identity || {};
    const negativePrompt = SETTINGS.negative_style_prompt || [];

    return (
      `ВИЗУАЛЬНАЯ ИДЕНТИЧНОСТЬ OSINTNER — ТОЛЬКО ДЛЯ ФОТОГРАФИЧЕСКОГО СЛОЯ:\n` +
      `Позиционирование: ${identity.brand_positioning || "Premium investigative editorial media"}.\n` +
      `Визуальный принцип: ${identity.visual_principle || "Premium investigative documentary photography"}.\n` +
      `Ключевые темы: ${(identity.visual_keywords || []).join(", ")}.\n` +
      `Визуальный язык: премиальная фотография для обложки серьёзного документального фильма-расследования или делового расследования; холодная тёмная navy и blue-gray палитра; реалистичная корпоративная документальная съёмка; сдержанный драматичный свет; фактурность, глубина, точная композиция, естественные материалы и правдоподобные детали. Изображение должно выглядеть как профессиональная редакционная фотография, а не как иллюстрация, рекламный сток или CGI.\n\n` +
      `АБСОЛЮТНЫЙ ЗАПРЕТ НА ЛЮБОЙ ТЕКСТ В ИЗОБРАЖЕНИИ:\n` +
      `Не генерировать вообще никакие символы или надписи: ни букв, ни цифр, ни слов, ни заголовков, ни подзаголовков, ни подписей, ни меток, ни псевдотекста, ни типографики, ни текста на бумагах, экранах, документах, табличках, вывесках, зданиях, одежде или предметах. Не создавать имитацию букв, нечитаемые символы, случайные знаки или водяные знаки. Изображение должно быть полностью свободно от текста.\n` +
      `Не создавать логотип OSINTNER, любые другие логотипы, брендовые символы, названия компаний, социальные никнеймы, подписи или декоративные брендовые элементы.\n` +
      `Композиция: вертикальный кадр 4:5; выразительная, ясная, не перегруженная сцена; оставлять спокойное свободное пространство слева для последующего внешнего оформления, но не размещать там текст или графические элементы.\n\n` +
      `СТИЛИСТИЧЕСКИЕ ЗАПРЕТЫ: ${negativePrompt.join(", ")}.\n` +
      `Важно: правила типографики бренда применяются только на отдельном этапе внешней вёрстки после генерации фотографии. Они НЕ являются инструкцией рисовать текст внутри изображения.`
    );
  }

  // ==================================================
  // AI VISUAL CONCEPT GENERATOR
  // ==================================================

  async generateVisualBrief(item, rejectedVersions = item.rejected_visuals || []) {
    const styleInstructions = this.getVisualStyleInstructions();
    const rejectedVisualBlock = rejectedVersions.length
      ? "\nОТКЛОНЁННЫЕ КОНЦЕПЦИИ — НЕ ПОВТОРЯТЬ: " + rejectedVersions.slice(-3).map(value => String(value).slice(0, 900)).join("\n")
      : "";
    const prompt =
      "Ты арт-директор премиального расследовательского медиа OSINT Editorial. Подготовь план реальной генерации изображений.\n" +
      "ТЕМА: " + item.title + "\nКАТЕГОРИЯ: " + item.category + "\nТЕКСТ: " + (item.text_content || item.content) + "\n\n" +
      styleInstructions + "\n\n" +
      "Выбери single для одной обложки или carousel для последовательного раскрытия темы. Для single ровно один слайд; для carousel от 3 до 5 слайдов. " +
      "Каждый слайд должен иметь короткий русский заголовок и подзаголовок только как МЕТАДАННЫЕ для будущей отдельной вёрстки, а также самостоятельный подробный prompt и alt_text. " +
      "Каждый prompt описывает одну конкретную, простую и физически правдоподобную документальную фотографическую сцену по статье. Используй минимум предметов, избегай сложных натюрмортов и нагромождения реквизита. Укажи расположение каждого важного предмета относительно других, передний/средний/задний план и точки контакта. Предметы не должны пересекаться, сливаться или быть встроены друг в друга, если это не соответствует реальной конструкции. У составных предметов должны быть все обязательные части и правильные соединения. Не добавляй декоративный реквизит ради заполнения кадра. Вертикальная композиция 4:5, спокойное свободное пространство слева для будущей внешней вёрстки. " +
      "КРИТИЧЕСКИ ВАЖНО: результат генератора изображений — только чистая фотография БЕЗ ЛЮБОГО ТЕКСТА. Запрещены все буквы, цифры, слова, заголовки, подписи, псевдотекст, символы, маркировки и надписи на любых объектах, документах, экранах и вывесках. Не генерируй типографику даже если она упоминается в бренд-гайде. " +
      "Не выдумывай реальные документы, цифры, логотипы, интерфейсы, компании, доказательства или виновность. Не превращай косвенные признаки в доказанный факт. " +
      "Сохраняй холодную тёмную navy/blue-gray документальную фотографическую эстетику, реализм, сдержанный драматичный свет и визуальный язык премиального расследовательского фильма. Белый текст и оранжевый #F26A1B — только для отдельной внешней вёрстки, никогда не внутри изображения. " +
      "Запрещены OSINTNER, любые логотипы, водяные знаки, хакеры в капюшонах, матричный дождь, киберпанк, неон, sci-fi интерфейсы, HUD, тёплая коричневая тонировка, золотистый свет, мультяшность, аниме, пластиковый CGI, generic stock photography и визуальный мусор." +
      rejectedVisualBlock + "\n\n" +
      'Верни только JSON без markdown: {"format":"single|carousel","concept":"...","rationale":"...","slides":[{"title":"...","subtitle":"...","prompt":"...","alt_text":"..."}]}.';
    const raw = await geminiGenerate(this.env, prompt, { task: "visual_brief", temperature: 0.7, maxOutputTokens: 3000 });
    const plan = parseVisualPlan(raw);
    plan.concept = String(plan.concept || "").trim();
    plan.rationale = String(plan.rationale || "").trim();
    return plan;
  }

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
  // ALTERNATIVE VISUAL ON REVISION
  // ==================================================

  async generateAlternativeVisual(itemId) {
    const itemKey = `item:${itemId}`;
    const item = await this.ctx.storage.get(itemKey);
    if (!item || item.status !== "generating_alternative_visual") return { ok: false, skipped: true };
    try {
      const plan = await this.generateVisualBrief(item, Array.isArray(item.rejected_visuals) ? item.rejected_visuals : []);
      const assets = await generateAndStoreVisualAssets(this.env, itemId, plan);
      const images = await Promise.all(assets.map(async asset => ({ ...asset, bytes: await this.env.EDITORIAL_DATA.get("social-image:" + asset.id, "arrayBuffer") })));
      await telegramSendVisualPreview(this.env, this.env.TELEGRAM_CHAT_ID, images, "ПРЕДПРОСМОТР НОВОГО ВИЗУАЛА\n" + String(plan.concept || "").slice(0, 700));
      await this.ctx.storage.transaction(async txn => {
        const current = await txn.get(itemKey);
        if (!current || current.status !== "generating_alternative_visual") return;
        const timestamp = new Date().toISOString();
        current.visual_content = formatVisualPlan(plan);
        current.visual_plan = plan;
        current.visual_assets = assets;
        current.content = current.visual_content;
        current.stage = "visual";
        current.status = "pending";
        current.approval_id = crypto.randomUUID();
        current.updated_at = timestamp;
        current.visual_generated_at = timestamp;
        current.alternative_visual_count = Number(current.alternative_visual_count || 0) + 1;
        await txn.put(itemKey, current);
        await this.addEvent(txn, { item_id: current.id, stage: "visual", action: "ai_alternative_visual_generated", category: current.category });
        await this.enqueue(txn, "sendMessage", approvalMessage(current, this.env.TELEGRAM_CHAT_ID));
      });
      return { ok: true };
    } catch (error) {
      console.error("Alternative visual generation failed:", error.message);
      await this.markGenerationFailed(itemId, "generating_alternative_visual", "visual", error);
      return { ok: false, error: "alternative_visual_generation_failed" };
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
  // GENERATE VISUAL AND MOVE TO VISUAL APPROVAL
  // ==================================================

  async runVisualGeneration(itemId) {
    const itemKey = `item:${itemId}`;
    try {
      const sourceItem = await this.ctx.storage.get(itemKey);
      if (!sourceItem) throw new Error("Material not found");
      console.log("AI VISUAL GENERATION STARTED:", itemId);
      const plan = await this.generateVisualBrief(sourceItem, Array.isArray(sourceItem.rejected_visuals) ? sourceItem.rejected_visuals : []);
      const assets = await generateAndStoreVisualAssets(this.env, itemId, plan);
      const images = await Promise.all(assets.map(async asset => ({ ...asset, bytes: await this.env.EDITORIAL_DATA.get("social-image:" + asset.id, "arrayBuffer") })));
      await telegramSendVisualPreview(this.env, this.env.TELEGRAM_CHAT_ID, images, "ПРЕДПРОСМОТР ВИЗУАЛА\n" + String(plan.concept || "").slice(0, 700));
      await this.ctx.storage.transaction(async txn => {
        const item = await txn.get(itemKey);
        if (!item || item.status !== "generating_visual") return;
        const timestamp = new Date().toISOString();
        item.visual_content = formatVisualPlan(plan);
        item.visual_plan = plan;
        item.visual_assets = assets;
        item.content = item.visual_content;
        item.stage = "visual";
        item.status = "pending";
        item.approval_id = crypto.randomUUID();
        item.updated_at = timestamp;
        item.visual_generated_at = timestamp;
        await txn.put(itemKey, item);
        await this.addEvent(txn, { item_id: item.id, stage: "visual", action: "ai_visual_generated", category: item.category });
        await this.enqueue(txn, "sendMessage", approvalMessage(item, this.env.TELEGRAM_CHAT_ID));
      });
      console.log("AI VISUAL GENERATION COMPLETED:", itemId);
    } catch (error) {
      console.error("AI VISUAL GENERATION FAILED:", error.message);
      await this.markGenerationFailed(itemId, "generating_visual", "visual", error);
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

        } else if (
          currentStage === "topic" &&
          !item.is_test
        ) {
          item.status = "generating_text";
          delete item.approval_id;

        } else if (
          currentStage === "text" &&
          !item.is_test
        ) {
          item.status = "generating_visual";
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
        } else if (currentStage === "visual") {
          item.rejected_visuals = Array.isArray(item.rejected_visuals) ? item.rejected_visuals : [];
          item.rejected_visuals.push(String(item.visual_content || "").slice(0, 4000));
          item.rejected_visuals = item.rejected_visuals.slice(-5);
          item.status = "generating_alternative_visual";
        } else if (currentStage === "final") {
          item.rejected_texts = Array.isArray(item.rejected_texts) ? item.rejected_texts : [];
          item.rejected_visuals = Array.isArray(item.rejected_visuals) ? item.rejected_visuals : [];
          if (item.text_content) item.rejected_texts.push(String(item.text_content).slice(0, 5000));
          if (item.visual_content) item.rejected_visuals.push(String(item.visual_content).slice(0, 4000));
          item.rejected_texts = item.rejected_texts.slice(-5);
          item.rejected_visuals = item.rejected_visuals.slice(-5);
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
                    ? "Текст одобрен. Начинаю подготовку визуальной концепции..."
                    : `Этап «${STAGE_NAMES[currentStage]}» одобрен.`
            )
          : (
              action === "reject"
                ? "Материал отклонён. Работа по нему остановлена; новые варианты создаваться не будут."
                : currentStage === "topic"
                  ? "Материал отправлен на доработку. Подготавливаю другой вариант темы..."
                  : currentStage === "text"
                    ? "Материал отправлен на доработку. Подготавливаю другую редакцию текста..."
                    : currentStage === "visual"
                      ? "Материал отправлен на доработку. Разрабатываю другую визуальную концепцию..."
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

    if (result.status === "generating_visual") {
      await this.flushOutbox();
      await this.runVisualGeneration(result.item_id);
    }

    if (result.status === "generating_alternative_topic") {
      await this.flushOutbox();
      await this.generateAlternativeTopic(result.item_id);
    }

    if (result.status === "generating_alternative_text") {
      await this.flushOutbox();
      await this.generateAlternativeText(result.item_id);
    }

    if (result.status === "generating_alternative_visual") {
      await this.flushOutbox();
      await this.generateAlternativeVisual(result.item_id);
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
    const item = await this.ctx.storage.get(itemKey);

    if (!item || item.status !== "publication_approved") {
      return { ok: false, skipped: true };
    }

    if (item.threads_publication_status === "published") {
      return { ok: true, duplicate: true };
    }

    if (["creating", "publishing"].includes(item.threads_publication_status)) {
      await telegram(this.env, "sendMessage", {
        chat_id: this.env.TELEGRAM_CHAT_ID,
        text: "Публикация в Threads уже была начата, но её итог не подтверждён. Автоматический повтор отключён, чтобы не создать дубликат. Материал: " + itemId
      });
      return { ok: false, pending_review: true };
    }

    const token = await this.ctx.storage.get("threads:oauth:token");
    if (!token?.access_token || !token?.user_id) {
      await telegram(this.env, "sendMessage", {
        chat_id: this.env.TELEGRAM_CHAT_ID,
        text: "Финальное одобрение получено, но публикация в Threads не выполнена: аккаунт не подключён. Материал: " + itemId
      });
      return { ok: false, error: "Threads account is not connected" };
    }

    if (Number(token.expires_at || 0) <= Date.now()) {
      await telegram(this.env, "sendMessage", {
        chat_id: this.env.TELEGRAM_CHAT_ID,
        text: "Финальное одобрение получено, но токен Threads истёк. Нужно переподключить аккаунт. Материал: " + itemId
      });
      return { ok: false, error: "Threads access token expired" };
    }

    const fullText = String(item.text_content || "").trim();
    if (!fullText) {
      await telegram(this.env, "sendMessage", {
        chat_id: this.env.TELEGRAM_CHAT_ID,
        text: "Финальное одобрение получено, но текст материала не найден. В Threads ничего не опубликовано. Материал: " + itemId
      });
      return { ok: false, error: "Approved item has no text_content" };
    }

    const codePoints = [...fullText];
    let mainText = "";
    let usedPoints = 0;
    for (const point of codePoints) {
      if (new TextEncoder().encode(mainText + point).length > 450) break;
      mainText += point;
      usedPoints += 1;
    }

    if (usedPoints < codePoints.length && mainText.includes(" ")) {
      const lastSpace = mainText.lastIndexOf(" ");
      if (lastSpace > 180) {
        usedPoints = [...mainText.slice(0, lastSpace)].length;
        mainText = mainText.slice(0, lastSpace).trimEnd();
      }
    }

    const attachmentText = codePoints.slice(usedPoints).join("").trim();
    if (new TextEncoder().encode(attachmentText).length > 9500) {
      await telegram(this.env, "sendMessage", {
        chat_id: this.env.TELEGRAM_CHAT_ID,
        text: "Публикация в Threads остановлена: текст длиннее безопасного лимита текстового вложения. Ничего не опубликовано. Материал: " + itemId
      });
      return { ok: false, error: "Threads text attachment exceeds safe limit" };
    }

    await this.ctx.storage.put(itemKey, {
      ...item,
      threads_publication_status: "creating",
      threads_publication_started_at: new Date().toISOString()
    });

    try {
      const createUrl = new URL(`https://graph.threads.net/v1.0/${encodeURIComponent(token.user_id)}/threads`);
      const createForm = new URLSearchParams({
        media_type: "TEXT",
        text: mainText || fullText.slice(0, 450),
        access_token: token.access_token
      });

      if (attachmentText) {
        createForm.set("text_attachment", JSON.stringify({
          plaintext: attachmentText
        }));
      }

      const createResponse = await fetch(createUrl.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: createForm
      });
      const createResult = await createResponse.json().catch(() => ({}));

      if (!createResponse.ok || !createResult.id) {
        throw new Error(createResult.error?.message || "Threads media container creation failed (" + createResponse.status + ")");
      }

      await this.ctx.storage.put(itemKey, {
        ...item,
        threads_publication_status: "created",
        threads_container_id: String(createResult.id),
        threads_publication_started_at: new Date().toISOString()
      });

      const publishUrl = new URL(`https://graph.threads.net/v1.0/${encodeURIComponent(token.user_id)}/threads_publish`);
      publishUrl.searchParams.set("creation_id", String(createResult.id));
      publishUrl.searchParams.set("access_token", token.access_token);

      await this.ctx.storage.put(itemKey, {
        ...(await this.ctx.storage.get(itemKey)),
        threads_publication_status: "publishing"
      });

      const publishResponse = await fetch(publishUrl.toString(), { method: "POST" });
      const publishResult = await publishResponse.json().catch(() => ({}));

      if (!publishResponse.ok || !publishResult.id) {
        throw new Error(publishResult.error?.message || "Threads publish failed (" + publishResponse.status + ")");
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
        threads_published_at: new Date().toISOString()
      });

      await telegram(this.env, "sendMessage", {
        chat_id: this.env.TELEGRAM_CHAT_ID,
        text: "ПОСТ ОПУБЛИКОВАН В THREADS\nАккаунт: @" + String(token.username || "osintner") +
          "\nМатериал: " + itemId +
          (permalink ? "\nСсылка: " + permalink : "\nID публикации: " + String(publishResult.id))
      });

      return { ok: true, post_id: String(publishResult.id), permalink };
    } catch (error) {
      const latestItem = await this.ctx.storage.get(itemKey);
      await this.ctx.storage.put(itemKey, {
        ...latestItem,
        threads_publication_status: "failed",
        threads_publication_error: String(error.message || error).slice(0, 500),
        threads_publication_failed_at: new Date().toISOString()
      });

      console.error("Threads publishing failed:", error.message);
      await telegram(this.env, "sendMessage", {
        chat_id: this.env.TELEGRAM_CHAT_ID,
        text: "Финальное одобрение получено, но публикация в Threads завершилась ошибкой.\nМатериал: " + itemId +
          "\nПричина: " + String(error.message || error).slice(0, 700) +
          "\nАвтоматический повтор отключён во избежание дубликатов."
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
    await this.flushOutbox();
  }
}
