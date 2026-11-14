
const STAGES = ["topic", "text", "visual", "final"];

const STAGE_NAMES = {
  topic: "ТЕМА",
  text: "ТЕКСТ",
  visual: "ВИЗУАЛ",
  final: "ФИНАЛЬНОЕ РАЗРЕШЕНИЕ"
};

const OUTBOX_RETRY_MS = 30_000;

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
    console.error("Telegram API error:", {
      method,
      status: response.status,
      description: result.description || "Unknown error"
    });

    throw new Error(
      `Telegram API error: ${method}, status ${response.status}`
    );
  }

  return result;
}

// ======================================================
// GEMINI AI
// ======================================================

async function geminiGenerate(env, prompt) {
  if (!env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  console.log("Gemini request started");

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent",
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
          temperature: 0.7,
          maxOutputTokens: 1500
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

  console.log("Gemini generation successful");

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
      `${item.content}\n\n` +
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
    // HEALTH CHECK

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

    // WEBHOOK SECURITY

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
          chatIdPresent: Boolean(chatId),
          userIdPresent: Boolean(userId),
          chatAllowed: allowed,
          chatIdConfigured: Boolean(env.TELEGRAM_CHAT_ID),
          geminiKeyConfigured: Boolean(env.GEMINI_API_KEY)
        });

        // ACCESS DENIED

        if (!allowed) {
          console.error(
            "MESSAGE REJECTED: unauthorized chat",
            {
              chatType: message.chat?.type,
              chatIdPresent: Boolean(chatId)
            }
          );

          return new Response("OK");
        }

        // /START

        if (command === "/start") {
          await telegram(env, "sendMessage", {
            chat_id: chatId,
            text:
              "OSINT Editorial подключён.\n" +
              "Система согласований готова.\n\n" +
              "Доступные команды:\n" +
              "/test — тест согласования\n" +
              "/ai_test — проверка Gemini\n" +
              "/id — проверка Telegram ID"
          });
        }

        // /ID

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

        // /TEST

        else if (command === "/test") {
          console.log("Approval test started");

          await callCoordinator(env, "/test", {
            user_id: userId,
            chat_id: chatId
          });
        }

        // /AI_TEST

        else if (command === "/ai_test") {
          console.log("GEMINI TEST STARTED");

          await telegram(env, "sendMessage", {
            chat_id: chatId,
            text: "Запускаю Gemini. Подожди немного..."
          });

          try {
            const answer = await geminiGenerate(
              env,
              "Ты OSINT-аналитик. Напиши краткий тестовый материал на русском языке: три способа проверить цифровой след компании из открытых источников. Не выдумывай факты. Используй нумерованный список."
            );

            await telegram(env, "sendMessage", {
              chat_id: chatId,
              text: answer
            });

            console.log("GEMINI TEST COMPLETED");

          } catch (error) {
            console.error(
              "GEMINI COMMAND FAILED:",
              error.message
            );

            await telegram(env, "sendMessage", {
              chat_id: chatId,
              text:
                "Не удалось получить ответ от Gemini.\n\n" +
                `Причина: ${error.message}`
            });
          }
        }

        // UNKNOWN COMMAND

        else if (command.startsWith("/")) {
          await telegram(env, "sendMessage", {
            chat_id: chatId,
            text:
              "Неизвестная команда.\n\n" +
              "Доступные команды:\n" +
              "/start\n" +
              "/test\n" +
              "/ai_test\n" +
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
      path !== "/test"
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
      const result =
        path === "/test"
          ? await this.handleTest(payload)
          : await this.handleCallback(payload);

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
        error.message
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

  async enqueue(txn, method, data) {
    const id = crypto.randomUUID();

    await txn.put(`outbox:${id}`, {
      method,
      data,
      created_at: new Date().toISOString()
    });
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
      stage: "topic",
      status: "pending",
      history: [],
      created_at: timestamp,
      updated_at: timestamp,
      approval_id: crypto.randomUUID()
    };

    await this.ctx.storage.transaction(
      async (txn) => {
        await txn.put(
          `item:${item.id}`,
          item
        );

        await this.addEvent(txn, {
          item_id: item.id,
          stage: "topic",
          action: "test_created",
          user_id: String(payload.user_id ?? "")
        });

        await this.enqueue(
          txn,
          "sendMessage",
          approvalMessage(
            item,
            this.env.TELEGRAM_CHAT_ID
          )
        );
      }
    );

    return {
      ok: true,
      status: "pending",
      item_id: item.id
    };
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
      await telegram(
        this.env,
        "answerCallbackQuery",
        {
          callback_query_id: q.id,
          text: "Нет доступа"
        }
      );

      return {
        ok: true,
        status: "unauthorized"
      };
    }

    const [
      action,
      itemId,
      approvalId
    ] = String(q.data ?? "").split(":");

    if (
      !["approve", "reject", "revise"].includes(action) ||
      !itemId ||
      !approvalId
    ) {
      await telegram(
        this.env,
        "answerCallbackQuery",
        {
          callback_query_id: q.id,
          text: "Некорректная кнопка"
        }
      );

      return {
        ok: true,
        status: "invalid_callback"
      };
    }

    const result = await this.ctx.storage.transaction(
      async (txn) => {
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
          const index = STAGES.indexOf(
            currentStage
          );

          if (index === STAGES.length - 1) {
            item.status = "publication_approved";
            item.publication_approved_at = timestamp;

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
                  : `Этап «${STAGE_NAMES[currentStage]}» одобрен.`
              )
            : (
                action === "reject"
                  ? "Материал отклонён. Дальнейшие этапы заблокированы."
                  : "Материал отправлен на доработку. Дальнейшие этапы заблокированы."
              );

        await this.enqueue(
          txn,
          "answerCallbackQuery",
          {
            callback_query_id: q.id,
            text: "Решение сохранено"
          }
        );

        await this.enqueue(
          txn,
          "sendMessage",
          {
            chat_id: this.env.TELEGRAM_CHAT_ID,
            text: acknowledgement
          }
        );

        if (nextItem) {
          await this.enqueue(
            txn,
            "sendMessage",
            approvalMessage(
              nextItem,
              this.env.TELEGRAM_CHAT_ID
            )
          );
        }

        return {
          status: item.status,
          stage: item.stage,
          item_id: item.id,
          current_stage: currentStage,
          action
        };
      }
    );

    if (result.duplicate) {
      await telegram(
        this.env,
        "answerCallbackQuery",
        {
          callback_query_id: q.id,
          text: "Это решение уже обработано"
        }
      );

      return {
        ok: true,
        duplicate: true
      };
    }

    if (
      result.status === "stale" ||
      result.status === "not_found"
    ) {
      await telegram(
        this.env,
        "answerCallbackQuery",
        {
          callback_query_id: q.id,
          text:
            result.status === "stale"
              ? "Кнопка устарела или решение уже принято"
              : "Материал не найден"
        }
      );

      return {
        ok: true,
        status: result.status
      };
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

    for (const [key, message] of messages) {
      try {
        await telegram(
          this.env,
          message.method,
          message.data
        );

        await this.ctx.storage.delete(key);

      } catch (error) {
        console.error(
          "Outbox delivery failed:",
          error.message
        );

        await this.ctx.storage.setAlarm(
          Date.now() + OUTBOX_RETRY_MS
        );

        return;
      }
    }
  }

  // ==================================================
  // AUTOMATIC RETRY
  // ==================================================

  async alarm() {
    await this.flushOutbox();
  }
}
