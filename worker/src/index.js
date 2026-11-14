
import settings from "../../config/settings.json" with { type: "json" };

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

  // FLUX.2 Klein 4B expects multipart/form-data, including prompt-only calls.
  const serialized = new Response(form);
  const body = serialized.body;
  const contentType = serialized.headers.get("content-type");

  const result = await env.AI.run(
    "@cf/black-forest-labs/flux-2-klein-4b",
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
    \`https://api.telegram.org/bot\${env.TELEGRAM_BOT_TOKEN}/sendPhoto\`,
    {
      method: "POST",
      body: form
    }
  );

  let result;

  try {
    result = await response.json();
  } catch {
    throw new Error(\`Telegram sendPhoto returned invalid JSON: \${response.status}\`);
  }

  if (!response.ok || !result.ok) {
    throw new Error(
      \`Telegram sendPhoto failed: \${result.description || response.status}\`
    );
  }

  return result;
}

// ======================================================
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
            text: "Одобрить",
            callback_data: `approve:${item.id}:${item.approval_id}`
          },
          {
            text: "Отклонить",
            callback_data: `reject:${item.id}:${item.approval_id}`
          }
        ],
        [
          {
            text: "На доработку",
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
      return new Response(
        "OSINT Editorial Gateway is running."
      );
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
            text: "Запускаю тест генерации изображения FLUX.2 Klein 4B. Это может занять некоторое время..."
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
              "ТЕСТ ГЕНЕРАЦИИ ИЗОБРАЖЕНИЙ\nМодель: FLUX.2 Klein 4B\nФормат: 1024 × 1280 (4:5)\nСреда: Cloudflare Workers Free"
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
                \`Причина: \${String(error.message || error).slice(0, 1200)}\`
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
      path !== "/generate"
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
      `Ты редактор профессионального расследовательского медиа OSINT Editorial.\n\n` +
      `Придумай одну оригинальную тему для публикации в категории: ${category}.\n\n` +
      `Требования:\n` +
      `- Язык: русский.\n` +
      `- Тема должна быть конкретной, содержательной и интересной.\n` +
      `- Для OSINT используй реальные сценарии применения открытых источников.\n` +
      `- Для Комплаенса раскрывай практические вопросы контроля, проверки и управления рисками.\n` +
      `- Для Антифрода раскрывай реальные механизмы мошенничества и способы противодействия.\n` +
      `- Не выдумывай конкретные события, компании, статистику или расследования.\n` +
      `- Не повторяй банальные темы.\n` +
      `- Верни только название темы, без пояснений и нумерации.`;

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

  // ==================================================
  // AI TEXT GENERATOR
  // ==================================================

  async generateDraftText(item) {
    const prompt =
      `Ты главный редактор премиального расследовательского медиа OSINT Editorial.\n\n` +
      `Подготовь полноценный черновик публикации на русском языке.\n\n` +
      `КАТЕГОРИЯ: ${item.category}\n` +
      `ТЕМА: ${item.title}\n\n` +
      `ТРЕБОВАНИЯ К МАТЕРИАЛУ:\n` +
      `1. Начни с сильного, но профессионального заголовка.\n` +
      `2. Объясни проблему и её практическое значение.\n` +
      `3. Раскрой тему последовательно, с конкретными примерами применения.\n` +
      `4. Используй профессиональную терминологию, объясняя сложные понятия.\n` +
      `5. Не выдумывай реальные события, компании, статистику и результаты расследований.\n` +
      `6. Не выдавай предположения за установленные факты.\n` +
      `7. Не раскрывай персональные данные частных лиц.\n` +
      `8. Не добавляй хештеги.\n\n` +
      `ОСОБЫЕ ТРЕБОВАНИЯ:\n` +
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
      `В последнем разделе укажи названия подходящих первичных источников и официальных ресурсов. Не придумывай URL и не утверждай, что источники уже проверены.\n\n` +
      `Подготовь содержательный материал объёмом примерно 2500–3000 знаков. Верни только текст публикации.`;

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
        `Сократи следующий материал до 3000 символов максимум, сохранив его структуру, основные выводы, практический пример и источники для проверки. Не добавляй новых фактов. Верни только сокращённый текст:\n\n${result}`,
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
    const typography = SETTINGS.typography || {};
    const negativePrompt = SETTINGS.negative_style_prompt || [];

    return (
      `ВИЗУАЛЬНАЯ ИДЕНТИЧНОСТЬ:\n` +
      `Позиционирование: ${identity.brand_positioning || "Premium investigative editorial media"}.\n` +
      `Визуальный принцип: ${identity.visual_principle || "Premium investigative documentary photography"}.\n` +
      `Ключевые слова: ${(identity.visual_keywords || []).join(", ")}.\n\n` +
      `ТИПОГРАФИКА:\n` +
      `Стиль: ${typography.style || "bold modern editorial sans-serif"}.\n` +
      `Заголовок: ${typography.headline_style || "extra bold Russian sans-serif"}.\n` +
      `Цвет заголовка: ${typography.headline_color || "#F5F5F5"}.\n` +
      `Цвет выделений: ${typography.highlight_color || "#F26A1B"}.\n` +
      `Цвет подзаголовка: ${typography.subtitle_color || "#F5F5F5"}.\n` +
      `Правила: ${(typography.rules || []).join("; ")}.\n\n` +
      `ОБЯЗАТЕЛЬНЫЕ ЗАПРЕТЫ:\n` +
      `${(identity.branding_rules || []).join("; ")}.\n` +
      `Не использовать: ${negativePrompt.join(", ")}.\n` +
      `Правило постоянства: ${identity.consistency_rule || ""}`
    );
  }

  // ==================================================
  // AI VISUAL CONCEPT GENERATOR
  // ==================================================

  async generateVisualBrief(item) {
    const styleInstructions = this.getVisualStyleInstructions();

    const prompt =
      `Ты арт-директор премиального расследовательского медиа OSINT Editorial.\n\n` +
      `Твоя задача — подготовить готовое техническое задание и промпты для генерации изображений публикации.\n\n` +
      `ТЕМА: ${item.title}\n` +
      `КАТЕГОРИЯ: ${item.category}\n\n` +
      `ТЕКСТ ПУБЛИКАЦИИ:\n${item.text_content || item.content}\n\n` +
      `${styleInstructions}\n\n` +
      `ПРАВИЛА ФОРМАТА:\n` +
      `1. Самостоятельно выбери один формат: ОДИНОЧНЫЙ ПОСТ или КАРУСЕЛЬ.\n` +
      `2. Выбирай карусель только тогда, когда тема действительно требует последовательного раскрытия нескольких самостоятельных смысловых частей.\n` +
      `3. Для одиночного поста используй формат 4:5 и создай один полноценный промпт.\n` +
      `4. Для карусели создай от 3 до 5 слайдов. Каждый слайд — отдельное изображение 4:5 и отдельный промпт.\n` +
      `5. Все изображения должны быть выполнены в единой визуальной системе, но не должны быть одинаковыми или повторять одну композицию.\n` +
      `6. Не добавляй вымышленные факты, цифры, документы, логотипы или названия организаций.\n` +
      `7. Текст на изображении должен быть коротким, грамотным, читаемым и на русском языке.\n` +
      `8. Не используй хештеги.\n` +
      `9. Не добавляй OSINTNER, логотип, водяной знак, название бренда или подпись.\n` +
      `10. Каждый промпт должен быть самостоятельным и пригодным для передачи в генератор изображений без дополнительного контекста.\n\n` +
      `СТРУКТУРА ОТВЕТА:\n\n` +
      `ФОРМАТ: [ОДИНОЧНЫЙ ПОСТ или КАРУСЕЛЬ]\n\n` +
      `КОНЦЕПЦИЯ: [краткое описание общей визуальной идеи]\n\n` +
      `ОБОСНОВАНИЕ: [почему выбран этот формат]\n\n` +
      `ОБЩИЕ ПАРАМЕТРЫ: [соотношение сторон, палитра, атмосфера, типографика]\n\n` +
      `ТЕКСТ НА ИЗОБРАЖЕНИИ: [точный заголовок и короткий подзаголовок]\n\n` +
      `ПРОМПТ ДЛЯ ГЕНЕРАЦИИ:\n` +
      `Для одиночного поста — один полный промпт.\n` +
      `Для карусели — отдельный промпт для каждого слайда с номером, заголовком, содержанием и визуальной композицией.\n\n` +
      `Верни только готовое техническое задание. Не добавляй вступлений и заключений.`;

    const result = await geminiGenerate(
      this.env,
      prompt,
      {
        task: "visual_brief",
        temperature: 0.7,
        maxOutputTokens: 2500
      }
    );

    if (!result || result.trim().length < 200) {
      throw new Error("Generated visual brief is too short");
    }

    return result.trim();
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

      if (!sourceItem) {
        throw new Error("Material not found");
      }

      console.log("AI VISUAL GENERATION STARTED:", itemId);

      const generatedVisual = await this.generateVisualBrief(sourceItem);

      await this.ctx.storage.transaction(async (txn) => {
        const item = await txn.get(itemKey);

        if (!item || item.status !== "generating_visual") {
          return;
        }

        const timestamp = new Date().toISOString();

        item.visual_content = generatedVisual;
        item.content = generatedVisual;
        item.stage = "visual";
        item.status = "pending";
        item.approval_id = crypto.randomUUID();
        item.updated_at = timestamp;
        item.visual_generated_at = timestamp;

        await txn.put(itemKey, item);

        await this.addEvent(txn, {
          item_id: item.id,
          stage: "visual",
          action: "ai_visual_generated",
          category: item.category
        });

        await this.enqueue(
          txn,
          "sendMessage",
          approvalMessage(item, this.env.TELEGRAM_CHAT_ID)
        );
      });

      console.log("AI VISUAL GENERATION COMPLETED:", itemId);

    } catch (error) {
      console.error("AI VISUAL GENERATION FAILED:", error.message);

      await this.markGenerationFailed(
        itemId,
        "generating_visual",
        "visual",
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
          item.status = "publication_approved";
          item.publication_approved_at = timestamp;
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

      } else {
        item.status =
          action === "reject"
            ? "rejected"
            : "revision_requested";

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
              item.status === "publication_approved"
                ? "ФИНАЛЬНОЕ РАЗРЕШЕНИЕ ПОЛУЧЕНО. Публикация одобрена."
                : currentStage === "topic" && !item.is_test
                  ? "Тема одобрена. Начинаю подготовку текста..."
                  : currentStage === "text" && !item.is_test
                    ? "Текст одобрен. Начинаю подготовку визуальной концепции..."
                    : `Этап «${STAGE_NAMES[currentStage]}» одобрен.`
            )
          : (
              action === "reject"
                ? "Материал отклонён. Дальнейшие этапы заблокированы."
                : "Материал отправлен на доработку. Дальнейшие этапы заблокированы."
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

    return {
      ok: true,
      status: result.status,
      stage: result.stage,
      item_id: result.item_id
    };
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
