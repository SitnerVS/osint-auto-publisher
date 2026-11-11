
const STAGES = ["topic", "text", "visual", "final"];

const STAGE_NAMES = {
  topic: "ТЕМА",
  text: "ТЕКСТ",
  visual: "ВИЗУАЛ",
  final: "ФИНАЛЬНОЕ РАЗРЕШЕНИЕ"
};

const OUTBOX_RETRY_MS = 30_000;

function json(data, status = 200) {
  return Response.json(data, { status });
}

async function telegram(env, method, data) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(`Telegram API error: ${method}`);
  }

  return result;
}

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

async function callCoordinator(env, path, payload) {
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

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(
      `Approval Coordinator error: ${result.error || response.status}`
    );
  }

  return result;
}

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
      suppliedSecret !== env.TELEGRAM_WEBHOOK_SECRET
    ) {
      return new Response("Unauthorized", {
        status: 401
      });
    }

    let update;

    try {
      update = await request.json();
    } catch {
      return new Response("Invalid JSON", {
        status: 400
      });
    }

    try {
      if (update.message) {
        const message = update.message;

        const chatId = String(
          message.chat?.id ?? ""
        );

        const userId = String(
          message.from?.id ?? ""
        );

        const allowed =
          chatId === String(env.TELEGRAM_CHAT_ID) &&
          userId === String(env.TELEGRAM_CHAT_ID) &&
          message.chat?.type === "private";

        if (allowed && message.text === "/start") {
          await telegram(env, "sendMessage", {
            chat_id: env.TELEGRAM_CHAT_ID,
            text:
              "OSINT Editorial подключён.\n" +
              "Система согласований готова."
          });
        } else if (
          allowed &&
          message.text === "/test"
        ) {
          await callCoordinator(env, "/test", {
            user_id: userId,
            chat_id: chatId
          });
        }
      }

      if (update.callback_query) {
        await callCoordinator(env, "/callback", {
          callback: update.callback_query
        });
      }

      return new Response("OK");
    } catch (error) {
      console.error(
        "Webhook processing failed:",
        error.message
      );

      return new Response("Internal error", {
        status: 500
      });
    }
  }
};

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

      // Сначала гарантируем наличие повторной попытки,
      // затем пробуем отправить накопленные сообщения.
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

  async enqueue(txn, method, data) {
    const id = crypto.randomUUID();

    await txn.put(`outbox:${id}`, {
      method,
      data,
      created_at: new Date().toISOString()
    });
  }

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

  async handleTest(payload) {
    const expectedId = String(
      this.env.TELEGRAM_CHAT_ID
    );

    if (
      String(payload.user_id ?? "") !== expectedId ||
      String(payload.chat_id ?? "") !== expectedId
    ) {
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
          user_id: expectedId
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
      chatId === String(this.env.TELEGRAM_CHAT_ID) &&
      userId === String(this.env.TELEGRAM_CHAT_ID) &&
      q.message?.chat?.type === "private";

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

  async alarm() {
    await this.flushOutbox();
  }
}
