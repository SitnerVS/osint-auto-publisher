function parseJsonObject(raw) {
  const source = String(raw || "").trim();
  // Find a complete JSON object without being confused by braces inside strings.
  for (let start = source.indexOf("{"); start >= 0; start = source.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i++) {
      const ch = source[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(source.slice(start, i + 1));
            if (parsed && typeof parsed === "object") return parsed;
          } catch (_) {}
          break;
        }
      }
    }
  }
  throw new Error("AI response is not valid JSON");
}

function parsePreviewVariants(raw) {
  const source = String(raw || "").trim();
  try {
    const parsed = parseJsonObject(source);
    if (parsed && Array.isArray(parsed.variants)) return parsed;
  } catch (_) {}

  // Recover numbered options even when the model adds headings, blank lines,
  // Markdown fences, or a short explanation around the five actual options.
  const cleaned = source
    .replace(/```(?:json)?/giu, "")
    .replace(/\r/gu, "");
  const numbered = [];
  for (const line of cleaned.split("\n")) {
    const match = line.trim().match(/^(?:вариант\s*)?([1-5])[.)\-:]\s*(.+)$/iu);
    if (!match) continue;
    const text = match[2].trim().replace(/^["«„]|["»”]$/gu, "").trim();
    if (text) numbered.push({ number: Number(match[1]), text });
  }
  const unique = [];
  for (const item of numbered) {
    if (!unique.some(existing => existing.number === item.number)) unique.push(item);
  }
  unique.sort((a, b) => a.number - b.number);
  if (unique.length === 5 && unique.every((item, index) => item.number === index + 1)) {
    return { trend_id: "NONE", variants: unique.map(item => ({ text: item.text, angle: "" })) };
  }

  // Also accept exactly five plain non-empty lines, excluding explanatory labels.
  const lines = cleaned.split("\n")
    .map(line => line.trim().replace(/^(?:[-*•])\s*/, "").replace(/^["«„]|["»”]$/gu, "").trim())
    .filter(Boolean)
    .filter(line => !/^(?:вот|варианты|результат|готово|trend_id|angle)\b/iu.test(line));
  if (lines.length === 5) {
    return { trend_id: "NONE", variants: lines.map(text => ({ text, angle: "" })) };
  }
  throw new Error("AI response is neither valid JSON nor five numbered options");
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

const REJECTED_HOURLY_HUMOR_EXAMPLES = [
  "Инфоцыгане продают пустой Wi‑Fi воздух",
  "Коучи измеряют успех линейкой воронок",
  "Гуру продуктивности обещают тайм‑менеджмент в таблетках",
  "Бренд‑менеджеры рекламируют масштабирование мышления без мозгов",
  "Псевдо‑эксперты ставят лайки вместо знаний"
];

function previousRejectedHumorExamples() {
  return REJECTED_HOURLY_HUMOR_EXAMPLES;
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

const generationPrompt = [
      "Ты — научный редактор русскоязычной рубрики «Интересные и малоизвестные факты». Подготовь ровно пять коротких, содержательных и достоверных фактов для Threads.",
      "Подбирай интересные, малоизвестные, но хорошо документированные факты. Не ищи исключительно редкие или сенсационные сведения: если факт трудно подтвердить, замени его более доступным и надёжно описанным.",
      "Охвати пять разных областей, например: природа и животные, космос, история, география, технологии, медицина, язык, культура, архитектура или наука. Не зацикливайся на одной области.",
      "Каждый факт — одно утвердительное предложение на русском языке, максимум 12 слов. Без вопросов, оценок, вступлений, пояснений и эмоциональных слов.",
      "Обязательно используй Google Search через Gemini. Для каждого факта найди минимум два независимых подтверждения в результатах поиска. Подходят первичные научные публикации, университеты, государственные учреждения, музеи, научные журналы и авторитетные энциклопедии.",
      "Не используй Википедию, форумы, рекламные сайты, агрегаторы и непроверенные блоги. Не делай выводов, которых прямо не подтверждают источники.",
      "Если у факта нет двух независимых подтверждений, не включай его — найди другой факт. Не придумывай цифры, даты, имена, причинно-следственные связи или URL. Не выдавай гипотезы и легенды за установленные факты.",
      "Не повторяй недавние публикации: " + JSON.stringify(recentFunnyHistory) + ".",
      "Верни только корректный JSON: {\"variants\":[{\"text\":\"Факт не более двенадцати слов\",\"source_urls\":[\"точный URL 1\",\"точный URL 2\"]}]}. Ровно пять объектов, у каждого минимум два URL из реально использованных результатов Google Search Gemini.",
      "Не добавляй хештеги, упоминания, эмодзи, ссылки в текст факта или латинские слова. Если кандидат не подтверждается, замени его другим, пока не соберёшь пять проверяемых фактов. Не выдумывай факты ради выполнения задания."
    ].join("\\n");
    let rawResponse = "";
    let groundedSources = [];
    if (preview) {
      if (typeof deps.geminiGenerate !== "function") throw new Error("Не подключён Gemini с поиском Google для проверки фактов.");
      const grounded = await deps.geminiGenerate(env, generationPrompt, {
        task: "hourly_verified_facts_generation",
        model: "gemini-3.1-flash-lite",
        fallbackModels: ["gemini-3.5-flash-lite"],
        maxAttempts: 1,
        temperature: 0.2,
        maxOutputTokens: 1400,
        googleSearch: true,
        returnMetadata: true
      });
      rawResponse = String(grounded?.text || "").trim();
      groundedSources = Array.isArray(grounded?.sources) ? grounded.sources : [];
    } else {
      const generatedRaw = await deps.geminiGenerate(env, generationPrompt, {
        task: "hourly_fact_generation",
        model: "gemini-3.1-flash-lite",
        fallbackModels: ["gemini-3.5-flash-lite"],
        maxAttempts: 1,
        temperature: 0.2,
        maxOutputTokens: 800,
        googleSearch: true
      });
      rawResponse = String(generatedRaw || "").trim();
    }
    if (preview) {
      let previewData;
      try {
        previewData = parsePreviewVariants(rawResponse);
      } catch (firstParseError) {
        // Recover from a model refusal caused by an overly restrictive search prompt.
        // Keep Browser Search and two independent sources per fact mandatory.
        const firstResponse = rawResponse;
        const recoveryPrompt = [
          "Подготовь ровно пять интересных, малоизвестных, но хорошо документированных фактов для русскоязычного Threads.",
          "Выбери факты из пяти разных областей. Не ищи редкие сенсации: используй темы, по которым легко найти надёжные публикации — особенности животных, космос, географические явления, исторические артефакты, открытия науки или технологии.",
          "Для каждого факта обязательны два независимых точных URL из результатов Google Search Gemini. Используй официальные государственные и университетские сайты, научные журналы, музеи и авторитетные энциклопедии. Не используй Википедию, форумы, рекламные сайты и непроверенные блоги.",
          "Если кандидат не подтверждается двумя источниками, замени его другим. Не требуй исключительной редкости. Не выдумывай факты, детали и ссылки.",
          "Каждый текст — одно утвердительное предложение на русском языке, не более 12 слов. Без вопросов, ссылок в тексте, хештегов, упоминаний и эмодзи.",
          "Верни только JSON: {\"variants\":[{\"text\":\"...\",\"source_urls\":[\"URL 1\",\"URL 2\"]}]}. Ровно пять объектов. Никаких пояснений или отказов."
        ].join("\\n");
        const recovered = await deps.geminiGenerate(env, recoveryPrompt, {
          task: "hourly_verified_facts_recovery",
          model: "gemini-3.1-flash-lite",
        fallbackModels: ["gemini-3.5-flash-lite"],
          maxAttempts: 1,
          temperature: 0.2,
          maxOutputTokens: 1400,
          googleSearch: true,
          returnMetadata: true
        });
        rawResponse = String(recovered?.text || "").trim();
        groundedSources = Array.isArray(recovered?.sources) ? recovered.sources : [];
        try {
          previewData = parsePreviewVariants(rawResponse);
        } catch (recoveryError) {
          const diagnostic = {
            first_error: firstParseError?.message || "unknown_parse_error",
            recovery_error: recoveryError?.message || "unknown_recovery_error",
            first_response: firstResponse.slice(0, 500),
            recovery_response: rawResponse.slice(0, 1200)
          };
          console.error("Hourly preview recovery failed:", diagnostic);
          return {
            ok: true,
            skipped: true,
            reason: "preview_variants_invalid",
            detail: "Первичная генерация не сформировала JSON; резервный поиск тоже не вернул пять фактов. Ответ: " + diagnostic.recovery_response
          };
        }
      }
      const selectedTrend = { id: "FACTS", name: "Интересные и малоизвестные факты" };
      let rawVariants = Array.isArray(previewData.variants) ? previewData.variants : [];
      const trustedSource = url => {
        try {
          const host = new URL(url).hostname.toLowerCase().replace(/^www\./u, "");
          return host.endsWith(".gov") || host.endsWith(".edu") || host.endsWith(".int") ||
            host.endsWith(".museum") || host.endsWith(".gov.uk") || host.endsWith(".ac.uk") ||
            ["britannica.com","nature.com","science.org","pnas.org","cell.com","si.edu",
             "smithsonianmag.com","nationalgeographic.com","unesco.org","rsc.org","aps.org",
             "jstor.org","ox.ac.uk","cam.ac.uk","harvard.edu","stanford.edu"].some(domain =>
              host === domain || host.endsWith("." + domain));
        } catch (_) { return false; }
      };
      const mapPreviewVariants = items => items.map((item, index) => ({
        index,
        text: normalizeText(typeof item === "string" ? item : item?.text || ""),
        source_urls: Array.isArray(item?.source_urls) ? item.source_urls.map(normalizeText).filter(Boolean) : []
      }));
      let variants = mapPreviewVariants(rawVariants);
      const validationIssues = items => {
        const issues = [];
        if (items.length !== 5) issues.push("Нужно ровно пять объектов; сейчас: " + items.length + ".");
        items.forEach((item, index) => {
          const failure = localSafetyFailure(item.text);
          if (failure) issues.push("Вариант " + (index + 1) + ": " + failure + ".");
          const wordCount = item.text.trim().split(/\s+/u).filter(Boolean).length;
          if (wordCount > 12) issues.push("Вариант " + (index + 1) + ": максимум двенадцать слов, сейчас " + wordCount + ".");
          if (/[.!?].*[.!?]/u.test(item.text)) issues.push("Вариант " + (index + 1) + ": только одно предложение.");
          if (/[?]/u.test(item.text)) issues.push("Вариант " + (index + 1) + ": нужен утвердительный факт.");
          if (/\b(?:возможно|вероятно|считается|предположительно|якобы|по легенде|говорят)\b/iu.test(item.text)) issues.push("Вариант " + (index + 1) + ": предположение или легенда не подходят.");
          const verifiedUrls = item.source_urls.filter(url => groundedSources.includes(url) && trustedSource(url));
          const verifiedDomains = new Set(verifiedUrls.map(url => {
            try { return new URL(url).hostname.toLowerCase().replace(/^www\./u, ""); } catch (_) { return ""; }
          }).filter(Boolean));
          if (verifiedDomains.size < 2) issues.push("Вариант " + (index + 1) + ": нужны два независимых авторитетных источника из результатов Google Search Gemini.");
          if (item.source_urls.some(url => !groundedSources.includes(url))) issues.push("Вариант " + (index + 1) + ": ссылка не подтверждена поиском Google Gemini.");
        });
        return issues;
      };
      let issues = validationIssues(variants);
      if (issues.length) {
        console.warn("Hourly preview validation failed; requesting one repair pass:", issues);
        const repairPrompt = generationPrompt + "\\n\\nПРЕДЫДУЩИЙ ОТВЕТ НЕ ПРОШЁЛ ФАКТЧЕК. Подготовь заново ровно пять фактов и укажи только реальные source_urls из Google Search Gemini. Исправь ошибки: " + issues.join(" ") + " Не выдумывай ссылки и утверждения.";
        const repairedRaw = await deps.geminiGenerate(env, repairPrompt, {
          task: "hourly_verified_facts_recheck",
          model: "gemini-3.1-flash-lite",
        fallbackModels: ["gemini-3.5-flash-lite"],
          maxAttempts: 1,
          temperature: 0.1,
          maxOutputTokens: 1400,
          googleSearch: true,
          returnMetadata: true
        });
        groundedSources = Array.isArray(repairedRaw?.sources) ? repairedRaw.sources : [];
        try {
          const repairedData = parsePreviewVariants(String(repairedRaw?.text || ""));
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
      const previewPrefix = "social:hourly:preview:";
      const previousPreviews = await storage.list({ prefix: previewPrefix });
      for (const [previousKey, previousSession] of previousPreviews.entries()) {
        if (previousSession?.status === "awaiting_choice") {
          await storage.put(previousKey, {
            ...previousSession,
            status: "superseded",
            superseded_at: new Date().toISOString()
          });
        }
      }
      const sessionId = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
      await storage.put(previewPrefix + sessionId, {
        status: "awaiting_choice", trend: selectedTrend.name, variants,
        created_at: new Date().toISOString(), expires_at: Date.now() + 3 * 60 * 1000
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
