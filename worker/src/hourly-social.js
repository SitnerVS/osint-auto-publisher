function parseJsonObject(raw) {
  const source = String(raw || "").trim();
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI response is not valid JSON");
  return JSON.parse(source.slice(start, end + 1));
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/^["«]|["»]$/g, "").trim();
}

export function localSafetyFailure(text) {
  const value = normalizeText(text);
  if (!value) return "пустой текст";
  if (!/[А-Яа-яЁё]/u.test(value)) return "текст должен быть полностью на русском языке";
  const latinWord = value.match(/[A-Za-z]{3,}/u);
  if (latinWord) return "обнаружено латинское слово «" + latinWord[0] + "» — нужен русский вариант";
  if (value.length > 500) return "превышен лимит Threads в 500 символов";
  if (/[#@]|https?:\/\//i.test(value)) return "хештеги, упоминания и ссылки в этой рубрике отключены";
  // Editorial exclusions: no insults targeting women or children.
  const targetedInsult = /(?:\b(?:туп(?:ая|ые|ую)|дура|идиотк|овца|сучк|шлюх)\w*\b.{0,35}\b(?:женщин|девуш|девоч|дет|реб[её]нк)|\b(?:женщин|девуш|девоч|дет|реб[её]нк)\w*\b.{0,35}\b(?:туп|дура|идиот|овца|сучк|шлюх))/iu;
  if (targetedInsult.test(value)) return "оскорбления женщин и детей запрещены";
  return "";
}

export function isLocallySafe(text) {
  return !localSafetyFailure(text);
}

export async function publishThreads(env, token, text) {
  const createUrl = new URL("https://graph.threads.net/v1.0/" + encodeURIComponent(token.user_id) + "/threads");
  const createForm = new URLSearchParams({
    media_type: "TEXT",
    text,
    access_token: token.access_token
  });
  const createResponse = await fetch(createUrl.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: createForm
  });
  const created = await createResponse.json().catch(() => ({}));
  if (!createResponse.ok || !created.id) {
    throw new Error(created.error?.message || "Threads container creation failed: " + createResponse.status);
  }

  const publishUrl = new URL("https://graph.threads.net/v1.0/" + encodeURIComponent(token.user_id) + "/threads_publish");
  publishUrl.searchParams.set("creation_id", String(created.id));
  publishUrl.searchParams.set("access_token", token.access_token);
  const publishResponse = await fetch(publishUrl.toString(), { method: "POST" });
  const published = await publishResponse.json().catch(() => ({}));
  if (!publishResponse.ok || !published.id) {
    throw new Error(published.error?.message || "Threads publish failed: " + publishResponse.status);
  }

  let permalink = "";
  try {
    const mediaUrl = new URL("https://graph.threads.net/v1.0/" + encodeURIComponent(published.id));
    mediaUrl.searchParams.set("fields", "id,permalink");
    mediaUrl.searchParams.set("access_token", token.access_token);
    const mediaResponse = await fetch(mediaUrl.toString());
    if (mediaResponse.ok) permalink = String((await mediaResponse.json()).permalink || "");
  } catch (error) {
    console.error("Hourly Threads permalink lookup failed:", error.message);
  }
  return { id: String(published.id), permalink };
}



export async function generateHumorVariants(env, topic, previousTexts, geminiGenerate) {
  const cleanTopic = normalizeText(topic).slice(0, 240);
  if (!cleanTopic || cleanTopic.length < 2) throw new Error("Тема слишком короткая");
  const previous = (Array.isArray(previousTexts) ? previousTexts : []).slice(-20);
  const prompt =
    "Ты — редактор короткой русскоязычной сатиры для Threads. Используй общие принципы сильного российского стендапа: узнаваемая правда жизни, социальное наблюдение, точная деталь, парадокс и резкий, но логичный переворот ожидания. Не подражай конкретным авторам. " +
    "ТЕМА: " + JSON.stringify(cleanTopic) + ". Работай только с известным содержанием темы. Не выдумывай события, цитаты, цифры, мотивы и факты. Если контекста недостаточно, шути над самой формулировкой или типичной человеческой реакцией, не выдавая предположения за факты. Не используй внешний поиск. " +
    "Сразу придумай до 12 внутренних черновых заходов, мысленно отредактируй их и верни РОВНО ПЯТЬ вариантов. Не возвращай четыре, три или меньше: если первые заходы слабые, придумай новые, пока не будет пяти. Не показывай черновики и редакторские рассуждения. " +
    "Каждая шутка — одно законченное предложение НЕ БОЛЕЕ 10 СЛОВ, включая предлоги и частицы. Лучше 5–8 слов. Без вступления и пояснений. Панчлайн должен вскрывать конкретное противоречие или неожиданно менять смысл. " +
    "Ищи юмор в человеческой реакции, бюрократии, официальной формулировке, несоответствии масштаба и реакции, бытовом последствии, общественном лицемерии или абсурде самой темы. Выбирай только то, что органично связано с темой. " +
    "Запрещено: случайные ассоциации с ипотекой, криптой, эмиграцией, стартапами, грин-картами, Пентагоном, конгрессменами и любыми посторонними предметами; сюрреализм вместо мысли; случайные действия объектов; затёртые каламбуры и штампы. " +
    "Пиши как живой образованный человек: без канцелярита, искусственных метафор, рекламного тона и повторяющихся конструкций. Варианты должны отличаться по комическому углу. " +
    "Жёстко отсеивай всё, что непонятно с первого прочтения, звучит неестественно, требует объяснения или просто странно. Подготовь все пять вариантов; каждый должен быть понятен с первого прочтения, звучать естественно и отличаться по комическому углу. " +
    "Без угроз, призывов к насилию, травли, дискриминации, сексуального унижения и шуток за счёт жертв трагедий. Можно резко критиковать публичные институты, власть, компании, медиа и общественные явления. Не выдумывай порочащие факты о реальных людях. " +
    "Без хештегов, ссылок, упоминаний и эмодзи. Не копируй чужие тексты дословно. " +
    "Верни строго JSON: {\"variants\":[{\"text\":\"...\",\"angle\":\"кратко\"}]}. РОВНО ПЯТЬ объектов. В каждом поле text — не более 10 слов. " +
    "Предыдущие публикации, которые нельзя повторять: " + JSON.stringify(previous);
  const raw = await geminiGenerate(env, prompt, {
    task: "manual_humor_variants",
    temperature: 0.95,
    maxOutputTokens: 1800,
    responseMimeType: "application/json"
  });
  const parsed = parseJsonObject(raw);
  if (!Array.isArray(parsed.variants) || parsed.variants.length < 1 || parsed.variants.length > 5) {
    throw new Error("Gemini не подготовил ни одного сильного варианта. Нажми «Повторная генерация».");
  }
  const variants = parsed.variants.map((item, index) => ({
    index,
    text: normalizeText(item.text),
    angle: normalizeText(item.angle || "")
  }));
  return variants;
}

export async function runHourlyTrend(coordinator, payload, deps) {
  const storage = coordinator.ctx.storage;
  const env = coordinator.env;
  const preview = payload?.preview === true;
  const bootstrapPending = payload?.bootstrap === true && (await storage.get("social:hourly:bootstrap_published")) !== true;
  const forceManual = payload?.force_manual === true;

  if (!preview && String(env.THREADS_PUBLISHING_ENABLED || "false").toLowerCase() !== "true") {
    return { ok: true, skipped: true, reason: "threads_publishing_disabled" };
  }

  const scheduledAt = Number(payload?.scheduled_at || Date.now());
  const slot = forceManual ? "manual-" + String(payload?.manual_id || crypto.randomUUID()) : new Date(scheduledAt).toISOString().slice(0, 13);
  const slotKey = forceManual ? "social:hourly:manual:" + slot : "social:hourly:slot:" + slot;
  if (!preview && !forceManual && !payload?.manual) {
    const lastPublishedAt = Number(await storage.get("social:hourly:last_published_at") || 0);
    if (lastPublishedAt && Date.now() - lastPublishedAt < 60 * 60 * 1000) {
      return { ok: true, skipped: true, reason: "interval_not_elapsed", next_at: lastPublishedAt + 60 * 60 * 1000 };
    }
  }
  const existing = await storage.get(slotKey);
  if (existing && !preview && !forceManual) {
    const alreadyPublished =
      existing.status === "published" ||
      Boolean(existing.threads_post_id);

    if (alreadyPublished) {
      return { ok: true, skipped: true, reason: "slot_already_published" };
    }

    const startedAt = Date.parse(existing.created_at || "");
    const isRunning =
      existing.status === "started" &&
      Number.isFinite(startedAt) &&
      Date.now() - startedAt < 10 * 60 * 1000;

    if (isRunning) {
      return { ok: true, skipped: true, reason: "slot_in_progress" };
    }

    if (!payload?.manual) {
      return { ok: true, skipped: true, reason: "slot_already_processed" };
    }
  }

  const threadsToken = await storage.get("threads:oauth:token");
  const now = Date.now();

  if (!threadsToken?.access_token || !threadsToken?.user_id || Number(threadsToken.expires_at || 0) <= now) {
    if (!preview) await storage.put(slotKey, { status: "skipped", reason: "threads_not_connected", created_at: new Date().toISOString() });
    const noticeKey = "social:hourly:threads_notice:" + new Date(now).toISOString().slice(0, 10);
    if (!(await storage.get(noticeKey))) {
      await storage.put(noticeKey, true);
      await deps.telegram(env, "sendMessage", {
        chat_id: env.TELEGRAM_CHAT_ID,
        text: "Ежечасная рубрика приостановлена: аккаунт Threads не подключён или токен истёк."
      });
    }
    return { ok: true, skipped: true, reason: "threads_not_connected" };
  }

  if (!preview) await storage.put(slotKey, { status: "started", created_at: new Date().toISOString() });

  try {
    let trendsResult = {};
    try {
      const trendsUrl = new URL("https://graph.threads.com/v1.0/trending_topics");
      trendsUrl.searchParams.set("country_code", "US");
      trendsUrl.searchParams.set("access_token", threadsToken.access_token);
      const trendsResponse = await fetch(trendsUrl.toString());
      const responseData = await trendsResponse.json().catch(() => ({}));
      if (trendsResponse.ok) {
        trendsResult = responseData;
      } else {
        console.warn("Threads trends unavailable; generating humor without trend data:", trendsResponse.status, responseData.error?.message || "");
      }
    } catch (trendError) {
      console.warn("Threads trends request failed; generating humor without trend data:", trendError.message);
    }

    const rawTrends = Array.isArray(trendsResult.trends)
      ? trendsResult.trends
      : Array.isArray(trendsResult.data)
        ? trendsResult.data
        : Array.isArray(trendsResult.trending_topics)
          ? trendsResult.trending_topics
          : [];
    const history = await storage.get("social:hourly:history") || [];
    const usedTrendIds = new Set(
      history.filter(item => item.threads_post_id).slice(-48).map(item => String(item.trend_id || ""))
    );
    const trends = rawTrends
      .map((item, index) => {
        const name = normalizeText(
          typeof item === "string" ? item :
          item.title || item.name || item.topic || item.trend_name || item.topic_name
        );
        const explicitId = item && typeof item === "object"
          ? (item.trend_id || item.id || item.topic_id || item.identifier || "")
          : "";
        // A stable name-based key keeps valid API trends usable when the
        // endpoint omits an ID field in an individual record.
        const id = String(explicitId || (name ? "name:" + name.toLowerCase() : ""));
        return {
          id,
          name,
          description: normalizeText(item && typeof item === "object" ? item.description || "" : ""),
          rank: Number(item && typeof item === "object" ? item.rank || item.position || index + 1 : index + 1)
        };
      })
      .filter(item => item.name && item.id && !/^(threads?|instagram|facebook|social media)$/iu.test(item.name) && !usedTrendIds.has(item.id))
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 20);

    // Trend data is optional; humor generation continues even without a fresh trend.
    const itemEntries = await storage.list({ prefix: "item:" });
    const editorialHistory = [...itemEntries.values()]
      .filter(item => item && (item.title || item.text_content))
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
      .slice(0, 18)
      .map(item => String(item.title || item.text_content || "").replace(/\s+/g, " ").slice(0, 180));
    const recentFunnyHistory = history
      .filter(item => item.threads_post_id)
      .slice(-18)
      .map(item => String(item.text || "").slice(0, 220))
      .filter(item => !/[A-Za-z]{3,}/u.test(item));
    // Pass only Russian-language trend labels into the model; English labels
    // can leak into the generated post and correctly fail the local filter.
    const russianTrends = trends.filter(item =>
      /[А-Яа-яЁё]/u.test(item.name) && !/[A-Za-z]{3,}/u.test(item.name)
    );

const likedHumor = await storage.get("social:hourly:liked") || [];
    const likedExamples = likedHumor.slice(-12).map(item => item.text).filter(Boolean);
    const generationPrompt = preview
      ? [
          "Ты — автор короткой, взрослой, едкой русскоязычной сатиры для Threads. Нужны меткие и действительно смешные формулировки, а не длинные мини-истории.",
          "Каждый вариант — одна короткая фраза или одно предложение длиной примерно 55–120 символов. Сокращай идеи примерно втрое относительно обычного поста: оставляй только узнаваемый типаж, конкретную деталь и сильную саркастическую концовку. Никаких вступлений, пояснений, длинных сравнений и второго предложения.",
          "Строго запрещено первое лицо и рассказ от лица автора: не используй «я», «мне», «мой», «мы», «наш», формы «заказал», «прочитал», «сегодня у меня» и любые выдуманные личные ситуации. Формулируй со стороны: «Люди, которые…», «Эксперты…», «Корпоративная семья…», «Курс…».",
          "Единственный ориентир из последней пятёрки, который пользователь оценил положительно: «Эксперты ЗОЖ-диет обещают стройность, но их меню состоит из воды, воздуха и обещаний.» Разбери механику: понятный объект насмешки, конкретная претензия, короткая тройная концовка с неожиданным, но логичным словом. Используй этот уровень точности, не копируй фразу и не зацикливайся на ЗОЖ.",
          "Пользователь отверг остальные варианты последней пятёрки. Не повторяй их недостатки: не используй натянутые образы вроде «волшебного кристалла дедлайна», не смешивай несвязанные смыслы, не заканчивай очевидной банальностью про долгую доставку, не подменяй шутку общим саркастическим наблюдением. Корпоративные шутки про кружки, сертификаты и отсутствие премии уже слишком часто повторялись — ищи новые ситуации.",
          "Перед выдачей мысленно оцени каждый вариант: понятен ли он с первого прочтения; есть ли конкретная мишень; вызывает ли концовка улыбку или узнавание; звучит ли фраза естественно по-русски. Если хотя бы один пункт не выполнен — полностью замени вариант. Не заполняй пятёрку слабым материалом ради количества.",
          "Не используй искусственные метафоры, случайные предметы, псевдоостроумные обороты и слова, которые просто звучат необычно. Смешное должно рождаться из узнаваемого противоречия, лицемерия, нелепого правила или поведения, а не из странной формулировки.",

          "Тема: " + JSON.stringify(russianTrends.slice(0, 12)) + ". Если тренды не подходят, используй тему «Повседневная жизнь» и сам выбери узнаваемые ситуации: работа, деньги, отношения, ЗОЖ, офис, сервисы, интернет-эксперты, бытовые привычки, потребительство, саморазвитие.",
          "Учитывай ранее одобренные пользователем варианты, если они есть: " + JSON.stringify(likedExamples) + ".",
          "Верни РОВНО ПЯТЬ вариантов — массив из пяти отдельных объектов. Каждый вариант должен быть коротким, самостоятельным, одной фразой (55–120 символов), с разными темами и мишенями насмешки. Не используй первое лицо ни в одном варианте.",
          "Юмор должен быть действительно смешным, а не просто язвительным. Избегай банальностей, бессмысленных метафор, случайных ассоциаций, псевдофилософии, канцелярита и шаблонных фраз.",
          "Не выдумывай факты о реальных людях и событиях. Без угроз, призывов к насилию, травли, дискриминации, сексуального унижения и шуток за счёт жертв трагедий. Не унижай человеческое достоинство. Политическая сатира — в рамках закона РФ.",
          "Без хештегов, ссылок, упоминаний и эмодзи. Только русский язык. Каждый вариант — 55–120 символов, одно предложение, без первого лица.",
          "Верни строго JSON с полями trend_id и variants. В variants должно быть ровно пять объектов, каждый с полями text и angle."
        ].join("\\n")      : [
          "Ты пишешь короткую, едкую, взрослую русскоязычную саркастическую шутку.",
          "Ориентиры по тону: «Вайбкодеры — это бывшие селлеры». «Те, кто говорит „нишевый“, обычно продают воздух». «Гениально. Особенно результат». Не копируй.",
          "Учитывай ранее одобренные примеры пользователя: " + JSON.stringify(likedExamples) + ".",
          "Тренды для вдохновения, но не обязательная тема: " + JSON.stringify(russianTrends.slice(0, 12)) + ".",
          "Не ограничивай количество слов искусственно. Не пиши банальности, детские истории и псевдофилософию. Если нет сильной идеи — попробуй другой угол.",
          "Без угроз, травли, дискриминации, унижения человеческого достоинства и шуток за счёт жертв трагедий. Политическая сатира — в рамках закона.",
          "Верни одну шутку и только текст."
        ].join("\\n");
    const generatedRaw = await deps.groqGenerate(env, generationPrompt, {
      task: "hourly_social_joke_generation_and_review",
      maxAttempts: 2,
      temperature: 0.85,
      maxOutputTokens: 1200
    });
    const rawResponse = String(generatedRaw || "").trim();
    if (preview) {
      let previewData;
      try {
        previewData = parseJsonObject(rawResponse);
      } catch (_) {
        console.warn("Hourly preview returned invalid variants JSON:", rawResponse.slice(0, 1200));
        return { ok: true, skipped: true, reason: "preview_variants_invalid" };
      }
      const trendId = String(previewData.trend_id || previewData.trendId || "NONE");
      const matched = /^NONE$/i.test(trendId) ? null : russianTrends.find(item => item.id === trendId);
      const selectedTrend = matched || { id: "NONE", name: "Повседневная жизнь" };
      let rawVariants = Array.isArray(previewData.variants) ? previewData.variants : [];
      const mapPreviewVariants = items => items.map((item, index) => ({
        index,
        text: normalizeText(typeof item === "string" ? item : item?.text || item?.joke || item?.content || ""),
        angle: normalizeText(typeof item === "object" ? item?.angle || "" : "")
      }));
      let variants = mapPreviewVariants(rawVariants);
      const validationIssues = items => {
        const issues = [];
        if (items.length !== 5) issues.push("Нужно ровно пять объектов; сейчас: " + items.length + ".");
        items.forEach((item, index) => {
          const failure = localSafetyFailure(item.text);
          if (failure) issues.push("Вариант " + (index + 1) + ": " + failure + ".");
          if (item.text.length < 45 || item.text.length > 140) issues.push("Вариант " + (index + 1) + ": длина должна быть 45–140 символов, сейчас " + item.text.length + ".");
          if (/[.!?].*[.!?]/u.test(item.text)) issues.push("Вариант " + (index + 1) + ": нужно ровно одно короткое предложение.");
          if (/(^|[\s«„])(?:я|мне|меня|мой|моя|моё|мои|мы|нам|нас|наш|наша|наше|наши)(?=$|[\s,.:;!?»”])/iu.test(item.text) || /\b(?:заказал|заказала|прочитал|прочитала|купил|купила|сходил|сходила|увидел|увидела)\b/iu.test(item.text)) issues.push("Вариант " + (index + 1) + ": запрещено первое лицо и личный рассказ.");
        });
        return issues;
      };
      let issues = validationIssues(variants);
      if (issues.length) {
        console.warn("Hourly preview validation failed; requesting one repair pass:", issues);
        const repairPrompt = generationPrompt + "\\n\\nПРЕДЫДУЩИЙ ОТВЕТ НЕ ПРОШЁЛ ПРОВЕРКУ. Исправь его и верни заново РОВНО ПЯТЬ полноценных вариантов. Не объясняй исправления. Ошибки проверки: " + issues.join(" ") + " Верни только корректный JSON. Каждый текст должен быть на русском языке, без ссылок, хештегов, упоминаний и запрещённых оскорблений; длина каждого текста — до 500 символов.";
        const repairedRaw = await deps.groqGenerate(env, repairPrompt, {
          task: "hourly_humor_validation_repair",
          maxAttempts: 2,
          temperature: 0.9,
          maxOutputTokens: 1800
        });
        try {
          const repairedData = parseJsonObject(String(repairedRaw || ""));
          rawVariants = Array.isArray(repairedData.variants) ? repairedData.variants : [];
          variants = mapPreviewVariants(rawVariants);
          issues = validationIssues(variants);
        } catch (repairError) {
          console.warn("Hourly preview repair returned invalid JSON:", repairError.message);
          issues = ["модель не вернула корректный JSON после повторной попытки"];
        }
      }
      if (issues.length) {
        console.warn("Hourly preview remains invalid after repair:", issues);
        return { ok: true, skipped: true, reason: "preview_validation_failed_after_repair", detail: issues.join(" ") };
      }
      const sessionId = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
      await storage.put("social:hourly:preview:" + sessionId, {
        status: "awaiting_choice", trend: selectedTrend.name, variants,
        created_at: new Date().toISOString(), expires_at: Date.now() + 10 * 60 * 1000
      });
      return { ok: true, preview: true, trend: selectedTrend.name, variants, session_id: sessionId };
    }
    const generatedLines = rawResponse
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    let trendId = "";
    let finalText = "";
    // Accept the instructed two-line format, harmless Markdown wrappers,
    // and structured JSON responses without rejecting a usable joke.
    const trendMatch = rawResponse.match(/TREND_ID\s*:\s*([^\r\n]+)/i);
    if (trendMatch) {
      trendId = trendMatch[1].trim().replace(/^["'`]+|["'`]+$/g, "");
      finalText = rawResponse
        .replace(trendMatch[0], "")
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .split(/\r?\n/)
        .map(line => line.trim().replace(/^(?:[-*•]|\d+[.)])\s*/, "").replace(/^["«]|["»]$/g, "").trim())
        .filter(Boolean)
        .join(" ");
    } else {
      try {
        const structured = parseJsonObject(rawResponse);
        trendId = String(structured.trend_id || structured.trendId || structured.trend || "");
        finalText = normalizeText(structured.text || structured.joke || structured.content || "");
      } catch (_) {}
    }
    const isSkip = /^SKIP(?:\s|$)/i.test(generatedLines[0] || "") || /^SKIP(?:\s|$)/i.test(finalText);
    if (isSkip) {
      const skipReason = "Модель решила пропустить выпуск: не нашла достаточно удачную шутку";
      console.warn("Hourly joke deliberately skipped:", rawResponse.slice(0, 1200));
      if (!preview) await storage.put(slotKey, { status: "skipped", reason: "editorial_quality_rejected", detail: skipReason, created_at: new Date().toISOString() });
      return { ok: true, skipped: true, reason: "editorial_quality_rejected", detail: skipReason };
    }
    // The model may return a clean one-line joke instead of the requested
    // metadata wrapper. Treat that as a valid joke candidate and use NONE;
    // trend selection is optional and must never block an otherwise usable post.
    if (!finalText && !trendId) {
      finalText = normalizeText(rawResponse
        .replace(/^\s*```(?:\w+)?/i, "")
        .replace(/```\s*$/i, "")
        .replace(/^(?:ответ|шутка|текст)\s*:\s*/i, ""));
      if (finalText && finalText.length <= 500) {
        trendId = "NONE";
        console.warn("Hourly joke accepted without optional trend metadata:", rawResponse.slice(0, 1200));
      }
    }
    if (!finalText) {
      const skipReason = "Модель не вернула текст шутки";
      console.warn("Hourly joke response was empty or unrecognized:", rawResponse.slice(0, 1600));
      if (!preview) await storage.put(slotKey, { status: "skipped", reason: "editorial_quality_rejected", detail: skipReason, created_at: new Date().toISOString() });
      return { ok: true, skipped: true, reason: "editorial_quality_rejected", detail: skipReason };
    }
    if (!trendId) trendId = "NONE";
    // Platform names are not part of the joke; translate accidental mentions
    // into neutral Russian wording before the Cyrillic-only safety check.
    finalText = normalizeText(finalText.replace(/\bThreads\b/giu, "соцсеть"));
    const matchedTrend = /^NONE$/i.test(trendId)
      ? null
      : russianTrends.find(item => item.id === trendId);
    // Trend metadata is optional. If the model invents or slightly alters an
    // ID, keep the usable joke and classify it as everyday life instead of
    // rejecting the whole preview/publication.
    if (trendId && !/^NONE$/i.test(trendId) && !matchedTrend) {
      console.warn("Hourly joke returned an unknown trend ID; falling back to NONE:", trendId);
    }
    const selectedTrend = matchedTrend || { id: "NONE", name: "Повседневная жизнь" };
    const reviewedText = normalizeText(finalText);
    const text = finalText;
    const localFailure = localSafetyFailure(finalText);
    if (localFailure) {
      if (!preview) await storage.put(slotKey, { status: "skipped", reason: "local_safety_filter", detail: localFailure, created_at: new Date().toISOString() });
      await deps.telegram(env, "sendMessage", {
        chat_id: env.TELEGRAM_CHAT_ID,
        text: "Черновик ежечасной рубрики не прошёл первичный фильтр. Причина: " + localFailure + ". Ничего не опубликовано."
      });
      return { ok: true, skipped: true, reason: "local_safety_filter", detail: localFailure };
    }

    if (preview) {
      return { ok: true, preview: true, trend: selectedTrend.name, text: finalText };
    }


    let threadsResult = null;
    let threadsError = "";

    try {
      threadsResult = await publishThreads(env, threadsToken, finalText);
    } catch (error) {
      threadsError = String(error.message || error);
      console.error("Hourly Threads publishing failed:", threadsError);
    }

    const eventAt = new Date().toISOString();
    const record = {
      slot,
      trend_id: selectedTrend.id,
      trend: selectedTrend.name,
      text: finalText,
      ...(threadsResult ? { published_at: eventAt } : { failed_at: eventAt }),
      threads_post_id: threadsResult?.id || "",
      threads_permalink: threadsResult?.permalink || "",
      threads_error: threadsError
    };

    if (threadsResult) {
      const latestHistory = await storage.get("social:hourly:history") || [];
      latestHistory.push(record);
      await storage.put("social:hourly:history", latestHistory.slice(-100));
      await storage.put("social:hourly:last_published_at", Date.parse(eventAt));
      if (bootstrapPending) await storage.put("social:hourly:bootstrap_published", true);
    }
    await storage.put(slotKey, {
      status: threadsResult ? "published" : "failed",
      ...record
    });

    const lines = [
      threadsResult ? "Threads: опубликовано" : "Threads: ошибка — " + (threadsError || "неизвестно")
    ];
    const links = [
      threadsResult?.permalink ? "Threads: " + threadsResult.permalink : ""
    ].filter(Boolean);
    await deps.telegram(env, "sendMessage", {
      chat_id: env.TELEGRAM_CHAT_ID,
      text: "ЕЖЕЧАСНАЯ ЮМОРИСТИЧЕСКАЯ РУБРИКА\n\nТренд: " + selectedTrend.name + "\n\n" + text + "\n\n" +
        lines.join("\n") + (links.length ? "\n\n" + links.join("\n") : "")
    });

    return {
      ok: true,
      threads: threadsResult,
      text
    };
  } catch (error) {
    if (!preview) await storage.put(slotKey, {
      status: "failed",
      error: String(error.message || error).slice(0, 700),
      failed_at: new Date().toISOString()
    });
    console.error("Hourly trend workflow failed:", error.message, error.stack || "");
    await deps.telegram(env, "sendMessage", {
      chat_id: env.TELEGRAM_CHAT_ID,
      text: "Ежечасная рубрика не выполнена.\nПричина: " + String(error.message || error).slice(0, 700)
    });
    return { ok: true, failed: true, error: String(error.message || error) };
  }
}
