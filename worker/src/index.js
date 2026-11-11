
const STAGES = ["topic", "text", "visual", "final"];

const STAGE_NAMES = {
  topic: "ТЕМА",
  text: "ТЕКСТ",
  visual: "ВИЗУАЛ",
  final: "ФИНАЛЬНОЕ РАЗРЕШЕНИЕ"
};

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

  if (!result.ok) {
    throw new Error("Telegram API error");
  }

  return result;
}

async function saveEvent(env, event) {
  const id = crypto.randomUUID();

  await env.EDITORIAL_DATA.put(
    `event:${Date.now()}:${id}`,
    JSON.stringify({
      ...event,
      timestamp: new Date().toISOString()
    })
  );
}

async function sendApproval(env, item) {
  if (!STAGES.includes(item.stage)) {
    throw new Error("Invalid approval stage");
  }

  item.approval_id = crypto.randomUUID();

  await env.EDITORIAL_DATA.put(
    `item:${item.id}`,
    JSON.stringify(item)
  );

  const approvalId = item.approval_id;

  await telegram(env, "sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID,
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
            callback_data: `approve:${item.id}:${approvalId}`
          },
          {
            text: "Отклонить",
            callback_data: `reject:${item.id}:${approvalId}`
          }
        ],
        [
          {
            text: "На доработку",
            callback_data: `revise:${item.id}:${approvalId}`
          }
        ]
      ]
    }
  });
}

async function handleCallback(env, q) {
  const chatId = String(q.message?.chat?.id || "");
  const userId = String(q.from?.id || "");

  if (
    chatId !== String(env.TELEGRAM_CHAT_ID) ||
    userId !== String(env.TELEGRAM_CHAT_ID) ||
    q.message?.chat?.type !== "private"
  ) {
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: q.id,
      text: "Нет доступа"
    });
    return;
  }

  const parts = (q.data || "").split(":");

  const action = parts[0];
  const itemId = parts[1];
  const approvalId = parts[2];

  if (
    !["approve", "reject", "revise"].includes(action) ||
    !itemId ||
    !approvalId
  ) {
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: q.id,
      text: "Некорректная кнопка"
    });
    return;
  }

  const key = `item:${itemId}`;
  const raw = await env.EDITORIAL_DATA.get(key);

  if (!raw) {
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: q.id,
      text: "Материал не найден"
    });
    return;
  }

  const item = JSON.parse(raw);

  if (
    item.status !== "pending" ||
    item.approval_id !== approvalId
  ) {
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: q.id,
      text: "Кнопка устарела или решение уже принято"
    });
    return;
  }

  const currentStage = item.stage;

  if (!STAGES.includes(currentStage)) {
    await telegram(env, "answerCallbackQuery", {
      callback_query_id: q.id,
      text: "Ошибка этапа"
    });
    return;
  }

  const timestamp = new Date().toISOString();

  if (action === "approve") {
    const index = STAGES.indexOf(currentStage);

    item.approved_at = timestamp;

    if (index === STAGES.length - 1) {
      item.status = "publication_approved";
    } else {
      item.stage = STAGES[index + 1];
      item.status = "pending";
      delete item.approval_id;
    }
  } else {
    item.status =
      action === "reject"
        ? "rejected"
        : "revision_requested";

    item.rejected_at = timestamp;
    delete item.approval_id;
  }

  await env.EDITORIAL_DATA.put(
    key,
    JSON.stringify(item)
  );

  await saveEvent(env, {
    item_id: item.id,
    stage: currentStage,
    action,
    user_id: userId,
    approval_id: approvalId
  });

  await telegram(env, "answerCallbackQuery", {
    callback_query_id: q.id,
    text: "Решение сохранено"
  });

  let responseText;

  if (action === "approve") {
    responseText =
      item.status === "publication_approved"
        ? "ФИНАЛЬНОЕ РАЗРЕШЕНИЕ ПОЛУЧЕНО. Публикация одобрена."
        : `Этап «${STAGE_NAMES[currentStage]}» одобрен.`;
  } else if (action === "reject") {
    responseText =
      "Материал отклонён. Дальнейшие этапы заблокированы.";
  } else {
    responseText =
      "Материал отправлен на доработку. Дальнейшие этапы заблокированы.";
  }

  await telegram(env, "sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID,
    text: responseText
  });

  if (action === "approve" && item.status === "pending") {
    await sendApproval(env, item);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return new Response("OSINT Editorial Gateway is running.");
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const secret = request.headers.get(
      "X-Telegram-Bot-Api-Secret-Token"
    );

    if (
      !secret ||
      secret !== env.TELEGRAM_WEBHOOK_SECRET
    ) {
      return new Response("Unauthorized", { status: 401 });
    }

    try {
      const update = await request.json();

      if (update.message) {
        const message = update.message;

        const chatId = String(message.chat?.id || "");
        const userId = String(message.from?.id || "");

        const authorized =
          chatId === String(env.TELEGRAM_CHAT_ID) &&
          userId === String(env.TELEGRAM_CHAT_ID) &&
          message.chat?.type === "private";

        if (authorized && message.text === "/start") {
          await telegram(env, "sendMessage", {
            chat_id: env.TELEGRAM_CHAT_ID,
            text:
              "OSINT Editorial подключён.\n" +
              "Система согласований готова."
          });
        }

        if (authorized && message.text === "/test") {
          const key = "item:test001";
          const raw = await env.EDITORIAL_DATA.get(key);

          let item;

          if (raw) {
            item = JSON.parse(raw);
          } else {
            item = {
              id: "test001",
              content:
                "ТЕСТОВАЯ ТЕМА: Как проверить цифровой след компании с помощью OSINT"
            };
          }

          item.stage = "topic";
          item.status = "pending";
          delete item.approval_id;

          await env.EDITORIAL_DATA.put(
            key,
            JSON.stringify(item)
          );

          await saveEvent(env, {
            item_id: item.id,
            stage: "topic",
            action: "test_reset",
            user_id: userId
          });

          await sendApproval(env, item);
        }
      }

      if (update.callback_query) {
        await handleCallback(env, update.callback_query);
      }

      return new Response("OK");
    } catch (error) {
      console.error("Webhook processing failed");
      return new Response("Internal error", { status: 500 });
    }
  }
};


export class ApprovalCoordinator {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    return new Response("Approval Coordinator is ready.");
  }
}
