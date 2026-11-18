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
      "Ты — редактор полноценной новостной рубрики Threads. Подготовь ровно пять самостоятельных мини-новостей, а не коротких фактов или заголовков.",
      "ТЕМАТИКА РУБРИКИ СТРОГО ОГРАНИЧЕНА ВЫСОКИМИ ТЕХНОЛОГИЯМИ И ЦИФРОВЫМ МИРОМ. Ищи интересные, малоизвестные, хорошо документированные факты о новых технологиях, искусственном интеллекте, нейросетях и языковых моделях, робототехнике, компьютерах и процессорах, чипах и полупроводниках, программном обеспечении, квантовых вычислениях, кибербезопасности, интернете, космических и инженерных технологиях. Допускаются история компьютеров и происхождение известных технологий, если они непосредственно связаны с IT. Не включай общую природу, историю, географию, медицину, культуру и другие темы вне технологической сферы. Пять вариантов должны охватывать разные технологические сюжеты.",
      "ОБЯЗАТЕЛЬНАЯ СТРУКТУРА: каждый text содержит ровно 2 или 3 ПОЛНЫХ предложения, разделённых точкой и пробелом. Первое сообщает, что произошло. Второе добавляет конкретную подтверждённую подробность и объясняет, чем событие интересно или важно. При необходимости третье даёт дополнительный контекст. Одно длинное предложение или заголовок не подходят. Пример структуры (не используй как факт): «Археологи обнаружили следы древнего поселения на берегу озера. Находка помогает уточнить, как люди осваивали этот регион тысячи лет назад.» Каждый вариант — один пост Threads длиной 180–470 символов с пробелами. Без отдельного заголовка, вопросов, хештегов, ссылок, упоминаний и эмодзи.",
      "ИСТОЧНИКИ: ниже приведён каталог результатов Tavily. У каждого источника есть числовой ID и домен. Для каждого факта выбери РОВНО ДВА ID источников, которые прямо подтверждают именно этот факт. Два источника обязательно должны иметь РАЗНЫЕ домены. Не выбирай два URL одного домена.",
      "Используй только источники из каталога. Не выдумывай ID, URL, цифры, даты, имена и причинно-следственные связи. Если не можешь найти два подходящих источника с разными доменами, выбери другой факт.",
      "Подходят государственные учреждения, университеты, научные журналы, музеи и авторитетные энциклопедии. Не используй форумы, рекламные сайты и непроверенные блоги. Не выдавай гипотезы и легенды за установленные факты.",
      "Не повторяй недавние публикации: " + JSON.stringify(recentFunnyHistory) + ".",
      "Верни только JSON: " + JSON.stringify({ variants: [{ text: "Первое предложение сообщает событие. Второе раскрывает подтверждённую подробность и объясняет его значение.", source_ids: [1, 2] }] }) + ". Ровно пять объектов. source_ids — два разных числовых ID с разными доменами. URL не возвращай.",
      "Точность важнее оригинальности. Если источники не подтверждают факт, не включай его."
    ].join("\n");
    if (typeof deps.tavilySearch !== "function") throw new Error("Внешний поиск фактов не подключён. Нужен TAVILY_API_KEY в Cloudflare Worker Secrets.");
    const searchResults = await deps.tavilySearch(env, "latest technology research interesting facts artificial intelligence AI neural networks new AI models machine learning robotics computers CPUs GPUs chips semiconductors quantum computing cybersecurity software internet breakthrough technology research");
    // Give Gemini at most one page per independent publisher domain.
    // This makes it impossible for two selected source IDs to resolve to Britannica (or any other single publisher).
    const compoundSuffixes = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "edu.au", "co.nz", "com.br", "co.jp"]);
    const rootDomain = host => {
      const labels = String(host || "").toLowerCase().replace(/^www\./u, "").split(".").filter(Boolean);
      if (labels.length < 2) return "";
      const suffix = labels.slice(-2).join(".");
      return labels.length >= 3 && compoundSuffixes.has(suffix) ? labels.slice(-3).join(".") : suffix;
    };
    const trustedHost = host => {
      const value = String(host || "").toLowerCase().replace(/^www\./u, "");
      return /\.(?:gov|edu|int|museum)$/u.test(value) ||
        /\.(?:gov|ac)\.uk$/u.test(value) ||
        ["britannica.com", "nature.com", "science.org", "pnas.org", "cell.com", "si.edu",
         "smithsonianmag.com", "nationalgeographic.com", "unesco.org", "rsc.org", "aps.org",
         "jstor.org", "ox.ac.uk", "cam.ac.uk", "harvard.edu", "stanford.edu",
         "metmuseum.org", "amnh.org", "royalsocietypublishing.org", "nationalacademies.org",
         "history.com", "nasa.gov", "noaa.gov", "usgs.gov", "nps.gov", "nih.gov",
         "loc.gov", "who.int", "esa.int", "noirlab.edu"].some(domain =>
          value === domain || value.endsWith("." + domain));
    };
    const sourceInventory = [];
    const seenPublisherDomains = new Set();
    for (const item of (searchResults || [])) {
      const url = String(item.url || "").trim();
      if (!/^https?:\/\//iu.test(url)) continue;
      let host = "";
      try { host = new URL(url).hostname.toLowerCase().replace(/^www\./u, ""); } catch (_) { continue; }
      if (!trustedHost(host)) continue;
      const publisherDomain = rootDomain(host);
      if (!publisherDomain || seenPublisherDomains.has(publisherDomain)) continue;
      seenPublisherDomains.add(publisherDomain);
      sourceInventory.push({
        id: sourceInventory.length + 1,
        host,
        publisher_domain: publisherDomain,
        url,
        title: String(item.title || ""),
        content: String(item.content || "")
      });
    }
    const groundedSources = sourceInventory.map(item => item.url);
    if (groundedSources.length < 2) throw new Error("Внешний поиск вернул меньше двух независимых доменов; найдено: " + groundedSources.length + ". Подготовка остановлена.");
    const sourceEvidence = sourceInventory.map(item =>
      "[" + item.id + "] ДОМЕН: " + item.host + "\nЗАГОЛОВОК: " + item.title +
      "\nURL: " + item.url + "\nФРАГМЕНТ: " + item.content.slice(0, 1100)
    ).join("\n\n");
    const groundedPrompt = generationPrompt
      + "\n\nКАТАЛОГ ИСТОЧНИКОВ TAVILY (используй только эти ID и URL):\n"
      + sourceEvidence;
    let rawResponse = "";
    if (preview) {
      if (typeof deps.geminiGenerate !== "function") throw new Error("Не подключён Gemini с поиском Google для проверки фактов.");
      const grounded = await deps.geminiGenerate(env, groundedPrompt, {
        task: "hourly_verified_facts_generation",
        model: "gemini-3.5-flash-lite",
        fallbackModels: ["gemini-3.1-flash-lite"],
        maxAttempts: 1,
        temperature: 0.2,
        maxOutputTokens: 2600,
        returnMetadata: true
      });
      rawResponse = String(grounded?.text || "").trim();
    } else {
      const generatedRaw = await deps.geminiGenerate(env, groundedPrompt, {
        task: "hourly_fact_generation",
        model: "gemini-3.5-flash-lite",
        fallbackModels: ["gemini-3.1-flash-lite"],
        maxAttempts: 1,
        temperature: 0.2,
        maxOutputTokens: 800,
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
          "Подготовь ровно пять интересных, хорошо документированных мини-новостей для русскоязычного Threads. Тематика исключительно: высокие технологии, искусственный интеллект, нейросети, компьютеры и смежные цифровые технологии.",
          "Для каждого факта выбери ровно два источника из каталога ниже. Источники должны прямо подтверждать факт и иметь разные домены.",
          "Верни только JSON: " + JSON.stringify({ variants: [{ text: "...", source_ids: [1, 2] }] }) + ". Ровно пять объектов. source_ids — два разных числовых ID из каталога; URL не возвращай.",
          "В КАЖДОМ text обязательно ровно 2 или 3 полных предложения, разделённых точкой и пробелом. Первое сообщает событие, второе раскрывает конкретную подтверждённую деталь и объясняет, почему оно интересно. Не возвращай одно предложение. Длина 180–470 символов. Не выдумывай факты или ID. Не используй хештеги, ссылки, упоминания и эмодзи."
        ].join("\n") + "\n\nКАТАЛОГ ИСТОЧНИКОВ TAVILY:\n" + sourceEvidence;
        const recovered = await deps.geminiGenerate(env, recoveryPrompt, {
          task: "hourly_verified_facts_recovery",
          model: "gemini-3.5-flash-lite",
        fallbackModels: ["gemini-3.1-flash-lite"],
          maxAttempts: 1,
          temperature: 0.2,
          maxOutputTokens: 2600,
            returnMetadata: true
        });
        rawResponse = String(recovered?.text || "").trim();
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
             "jstor.org","ox.ac.uk","cam.ac.uk","harvard.edu","stanford.edu",
             "arxiv.org","ieee.org","acm.org","computer.org","mit.edu","berkeley.edu",
             "openai.com","deepmind.google","ai.google","blog.google","microsoft.com",
             "blogs.microsoft.com","nvidia.com","intel.com","amd.com","ibm.com",
             "huggingface.co","github.com","metmuseum.org","amnh.org",
             "royalsocietypublishing.org","nationalacademies.org","history.com"].some(domain =>
              host === domain || host.endsWith("." + domain));
        } catch (_) { return false; }
      };
      const independentDomain = url => {
        try {
          const host = new URL(url).hostname.toLowerCase().replace(/^www\./u, "");
          const labels = host.split(".");
          const compoundSuffixes = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "edu.au", "co.nz", "com.br", "co.jp"]);
          const suffix = labels.slice(-2).join(".");
          return labels.length >= 3 && compoundSuffixes.has(suffix)
            ? labels.slice(-3).join(".")
            : labels.slice(-2).join(".");
        } catch (_) { return ""; }
      };
      const mapPreviewVariants = items => items.map((item, index) => {
        const sourceIds = Array.isArray(item?.source_ids)
          ? item.source_ids.map(value => Number(value)).filter(value => Number.isInteger(value) && value > 0)
          : [];
        const urlsFromIds = sourceIds.map(id => sourceInventory[id - 1]?.url || "").filter(Boolean);
        const suppliedUrls = Array.isArray(item?.source_urls) ? item.source_urls.map(normalizeText).filter(Boolean) : [];
        return {
          index,
          text: normalizeText(typeof item === "string" ? item : item?.text || ""),
          source_ids: sourceIds,
          source_urls: urlsFromIds.length ? urlsFromIds : suppliedUrls
        };
      });
      let variants = mapPreviewVariants(rawVariants);
      const validationIssues = items => {
        const issues = [];
        if (items.length !== 5) issues.push("Нужно ровно пять объектов; сейчас: " + items.length + ".");
        items.forEach((item, index) => {
          const failure = localSafetyFailure(item.text);
          if (failure) issues.push("Вариант " + (index + 1) + ": " + failure + ".");
          const charCount = item.text.length;
          if (charCount > 470) issues.push("Вариант " + (index + 1) + ": максимум 470 символов с пробелами, сейчас " + charCount + ".");
          const sentenceCount = (item.text.match(/[.!?]+(?=\s|$)/gu) || []).length;
          if (sentenceCount < 2 || sentenceCount > 3) issues.push("Вариант " + (index + 1) + ": нужно 2–3 связанных предложения, сейчас " + sentenceCount + ".");
          if (/[?]/u.test(item.text)) issues.push("Вариант " + (index + 1) + ": используй повествовательную форму, не вопрос.");
          if (/\b(?:возможно|вероятно|считается|предположительно|якобы|по легенде|говорят)\b/iu.test(item.text)) issues.push("Вариант " + (index + 1) + ": предположение или легенда не подходят.");
          const verifiedUrls = item.source_urls.filter(url => groundedSources.includes(url) && trustedSource(url));
          const verifiedDomains = new Set(verifiedUrls.map(independentDomain).filter(Boolean));
          if (item.source_ids.length !== 2) issues.push("Вариант " + (index + 1) + ": укажи ровно два source_ids из каталога.");
          if (verifiedDomains.size < 2) issues.push("Вариант " + (index + 1) + ": нужны два авторитетных источника с разными доменами; выбраны: " + (verifiedUrls.map(independentDomain).join(", ") || "нет проверенных источников") + ".");
          if (item.source_urls.some(url => !groundedSources.includes(url))) issues.push("Вариант " + (index + 1) + ": ссылка отсутствует в результатах Tavily Search.");
        });
        return issues;
      };
      let issues = validationIssues(variants);
      if (issues.length) {
        console.warn("Hourly preview validation failed; requesting one repair pass:", issues);
        const repairPrompt = groundedPrompt + "\n\nПРЕДЫДУЩИЙ ОТВЕТ НЕ ПРОШЁЛ ПРОВЕРКУ. Верни ровно пять вариантов. КАЖДЫЙ text обязан содержать ровно 2 ИЛИ 3 ПОЛНЫХ ПРЕДЛОЖЕНИЯ, не одно. Первое предложение сообщает событие; второе добавляет конкретную подтверждённую подробность и объясняет его значение. Длина каждого text — 180–470 символов. Разделяй предложения точкой и пробелом. Для каждого варианта укажи ровно два разных source_ids из каталога. Верни только JSON с полями text и source_ids. Ошибки: " + issues.join(" ") + "\\n\\nПРЕДЫДУЩИЕ ВАРИАНТЫ ДЛЯ ИСПРАВЛЕНИЯ: " + JSON.stringify(rawVariants);
        const repairedRaw = await deps.geminiGenerate(env, repairPrompt, {
          task: "hourly_verified_facts_recheck",
          model: "gemini-3.5-flash-lite",
        fallbackModels: ["gemini-3.1-flash-lite"],
          maxAttempts: 1,
          temperature: 0.1,
          maxOutputTokens: 2600,
            returnMetadata: true
        });
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



function normalizeHourlyStoryText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/gu, "е")
    .replace(/https?:\/\/\S+/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function hourlyStorySimilarity(left, right) {
  const a = new Set(normalizeHourlyStoryText(left).split(" ").filter(token => token.length > 2));
  const b = new Set(normalizeHourlyStoryText(right).split(" ").filter(token => token.length > 2));
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function hourlyMoscowDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return fields.year + "-" + fields.month + "-" + fields.day;
}

function hourlyRecordTime(record) {
  const parsed = Date.parse(record?.published_at || record?.created_at || record?.slot || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function hourlySourcePublishedTime(item) {
  const candidates = [item?.published_date, item?.published_at, item?.publishedAt, item?.publication_date, item?.date_published, item?.date];
  for (const value of candidates) {
    if (!value) continue;
    const parsed = Date.parse(String(value));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function isFreshHourlySource(item, now = Date.now()) {
  const publishedAt = hourlySourcePublishedTime(item);
  if (!publishedAt) return false;
  const age = now - publishedAt;
  return age >= -60 * 60 * 1000 && age <= 24 * 60 * 60 * 1000;
}

function isDuplicateHourlyStory(text, selectedSources, history, now = Date.now()) {
  const normalized = normalizeHourlyStoryText(text);
  const selectedUrls = new Set((selectedSources || []).map(source => {
    try { const url = new URL(source.url); return (url.hostname + url.pathname).toLowerCase().replace(/\/$/u, ""); }
    catch (_) { return String(source.url || "").toLowerCase(); }
  }).filter(Boolean));
  const today = hourlyMoscowDate(now);
  const stopWords = new Set(["это","что","как","для","при","или","его","ее","они","она","оно","так","уже","также","после","перед","этот","эта","эти","был","была","были","будет","могут","может","новый","новая","новые","компания","компании","данные","системы","система","россии","россия","страны","рынка","рынок","сообщили","заявили","сообщает","согласно","который","которая","которые","через","более","менее","один","одна","две","трех","трёх"]);
  const meaningful = value => normalizeHourlyStoryText(value).split(" ").filter(token => token.length >= 4 && !stopWords.has(token));
  const currentTokens = new Set(meaningful(text));
  for (const previous of (Array.isArray(history) ? history : []).slice(-300)) {
    if (!previous?.text) continue;
    const previousTime = hourlyRecordTime(previous);
    const sameDay = previousTime ? hourlyMoscowDate(previousTime) === today : false;
    const within24Hours = previousTime ? now - previousTime <= 24 * 60 * 60 * 1000 && now >= previousTime : false;
    if (!sameDay && !within24Hours) continue;
    const previousTokens = new Set(meaningful(previous.text));
    const previousTitles = Array.isArray(previous.source_titles) ? previous.source_titles : [];
    const currentTitles = (selectedSources || []).map(source => source.title || "").filter(Boolean);
    if (currentTitles.some(title => previousTitles.some(oldTitle => hourlyStorySimilarity(title, oldTitle) >= 0.30))) return true;
    let sharedTokens = 0;
    for (const token of currentTokens) if (previousTokens.has(token)) sharedTokens++;
    const containment = Math.min(currentTokens.size, previousTokens.size) ? sharedTokens / Math.min(currentTokens.size, previousTokens.size) : 0;
    if (hourlyStorySimilarity(text, previous.text) >= 0.25 || (sharedTokens >= 3 && containment >= 0.45)) return true;
    const previousUrls = new Set((previous.source_urls || []).map(value => {
      try { const url = new URL(value); return (url.hostname + url.pathname).toLowerCase().replace(/\/$/u, ""); }
      catch (_) { return String(value || "").toLowerCase(); }
    }).filter(Boolean));
    for (const url of selectedUrls) if (previousUrls.has(url)) return true;
    if (normalized && normalizeHourlyStoryText(previous.text) === normalized) return true;
  }
  return false;
}

const HOURLY_EDITORIAL_TRACKS = [
  {
    name: "OSINT",
    query: "latest OSINT investigations open source intelligence digital footprint data analysis investigative tools AI OSINT research",
    focus: "OSINT, цифровые следы, открытые данные, инструменты расследований, анализ связей, геолокация по открытым источникам и применение ИИ в расследованиях"
  },
  {
    name: "Комплаенс",
    query: "latest compliance RegTech KYC KYB AML sanctions screening regulatory technology corporate due diligence research",
    focus: "комплаенс, KYC и KYB, AML, санкционный контроль, проверка контрагентов, RegTech, автоматизация контроля и регулирование цифровых технологий"
  },
  {
    name: "Антифрод",
    query: "latest anti-fraud fraud detection deepfake social engineering cybercrime cybersecurity threat intelligence AI fraud prevention research",
    focus: "антифрод, новые схемы мошенничества, deepfake, социальная инженерия, киберугрозы, выявление аномалий, цифровая криминалистика и технологии противодействия"
  }
];

export async function runHourlyAutoPublish(coordinator, payload, deps) {
  const storage = coordinator.ctx.storage;
  const env = coordinator.env;
  if (String(env.THREADS_PUBLISHING_ENABLED || "false").toLowerCase() !== "true") {
    return { ok: true, skipped: true, reason: "threads_publishing_disabled" };
  }
  const scheduledAt = Number(payload?.scheduled_at || Date.now());
  const slot = new Date(scheduledAt).toISOString().slice(0, 13);
  const slotKey = "social:hourly:auto_slot:" + slot;
  const existing = await storage.get(slotKey);
  if (existing?.status === "published") return { ok: true, skipped: true, reason: "slot_already_published" };
  if (existing?.status === "started" && Date.now() - Number(existing.started_at_ms || 0) < 10 * 60 * 1000) {
    return { ok: true, skipped: true, reason: "slot_in_progress" };
  }
  const lastPublishedAt = Number(await storage.get("social:hourly:auto_last_published_at") || 0);
  if (lastPublishedAt && Date.now() - lastPublishedAt < 55 * 60 * 1000) {
    return { ok: true, skipped: true, reason: "interval_not_elapsed", next_at: lastPublishedAt + 60 * 60 * 1000 };
  }
  const token = await storage.get("threads:oauth:token");
  if (!token?.access_token || !token?.user_id || Number(token.expires_at || 0) <= Date.now()) {
    await storage.put(slotKey, { status: "skipped", reason: "threads_not_connected", created_at: new Date().toISOString() });
    await deps.telegram(env, "sendMessage", {
      chat_id: env.TELEGRAM_CHAT_ID,
      text: "Ежечасная публикация пропущена: аккаунт Threads не подключён или токен истёк."
    });
    return { ok: true, skipped: true, reason: "threads_not_connected" };
  }

  const utcHour = Math.floor(scheduledAt / 3600000);
  const preferredIndex = ((utcHour % HOURLY_EDITORIAL_TRACKS.length) + HOURLY_EDITORIAL_TRACKS.length) % HOURLY_EDITORIAL_TRACKS.length;
  const candidateTracks = HOURLY_EDITORIAL_TRACKS.map((_, i) => HOURLY_EDITORIAL_TRACKS[(preferredIndex + i) % HOURLY_EDITORIAL_TRACKS.length]);
  let track = candidateTracks[0];
  await storage.put(slotKey, { status: "started", started_at_ms: Date.now(), track: track.name, created_at: new Date().toISOString() });

  try {
    if (typeof deps.tavilySearch !== "function") throw new Error("Tavily не подключён: отсутствует TAVILY_API_KEY.");
    const trustedDomains = [
      "cisa.gov","fbi.gov","ic3.gov","nist.gov","ftc.gov","sec.gov","justice.gov","treasury.gov",
      "fincen.gov","ofac.treasury.gov","federalreserve.gov","occ.treas.gov","fdic.gov","finra.org","cftc.gov",
      "europa.eu","ec.europa.eu","eur-lex.europa.eu","bankingsupervision.europa.eu","edpb.europa.eu",
      "eba.europa.eu","esma.europa.eu","eiopa.europa.eu","fca.org.uk","gov.uk","fatf-gafi.org","oecd.org",
      "bis.org","fsb.org","cbr.ru","fedsfm.ru","nalog.gov.ru","minfin.gov.ru","pravo.gov.ru",
      "publication.pravo.gov.ru","eec.eaeunion.org","eaeunion.org","knf.gov.pl","gov.pl",
      "interpol.int","coe.int","enisa.europa.eu","cert.europa.eu",
      "arxiv.org","ieee.org","acm.org","computer.org","nature.com","science.org","pnas.org",
      "mit.edu","stanford.edu","berkeley.edu","ox.ac.uk","cam.ac.uk","nvidia.com","microsoft.com",
      "openai.com","deepmind.google","ai.google","ibm.com","intel.com","amd.com","cloudflare.com",
      "krebsonsecurity.com","therecord.media","bleepingcomputer.com","darkreading.com","wired.com",
      "reuters.com","apnews.com","bbc.com","ft.com","theguardian.com","wsj.com","nytimes.com",
      "bellingcat.com","occrp.org","globalwitness.org","transparency.org","amnesty.org","hrw.org",
      "techcrunch.com","arstechnica.com","theverge.com","zdnet.com","securityweek.com",
      "bloomberg.com","cnbc.com","cnn.com","france24.com","dw.com","politico.eu","aljazeera.com","nikkei.com","scmp.com","theregister.com","venturebeat.com",
      "government.ru","kremlin.ru","duma.gov.ru","rosfinmonitoring.gov.ru","minfin.gov.ru","mvd.ru","epp.genproc.gov.ru","fas.gov.ru","fns.gov.ru","publication.pravo.gov.ru",
      "rbc.ru","kommersant.ru","vedomosti.ru","interfax.ru","tass.ru","ria.ru","rg.ru","iz.ru","forbes.ru","cnews.ru","securitylab.ru","banki.ru","habr.com","1prime.ru","expert.ru"
    ];
    const rootDomain = host => {
      const labels = String(host || "").toLowerCase().replace(/^www\./u, "").split(".").filter(Boolean);
      if (labels.length < 2) return "";
      const suffix = labels.slice(-2).join(".");
      const compound = new Set(["co.uk","org.uk","ac.uk","gov.uk","com.au","edu.au","co.nz","com.br","co.jp"]);
      return labels.length >= 3 && compound.has(suffix) ? labels.slice(-3).join(".") : suffix;
    };
    const history = await storage.get("social:hourly:auto_history") || [];
    const recentHistory = history.slice(-300);
    const lastGeoScope = String(await storage.get("social:hourly:auto_last_geo_scope") || recentHistory.slice().reverse().find(item => item.geo_scope)?.geo_scope || "");
    const geoScope = lastGeoScope === "Россия" ? "Мир" : "Россия";
    const geoQuery = geoScope === "Россия"
      ? "Russia Russian Federation Russian news российские новости Россия российский регулятор "
      : "international world global news outside Russia мировые международные новости зарубежные регуляторы ";
    let sources = [];
    let searchFailure = "";
    // Never stop at a weak first topic: rotate through all three editorial tracks,
    // using several differently worded searches per track until two publishers
    // independently cover a candidate news item.
    for (const candidate of candidateTracks) {
      track = candidate;
      await storage.put(slotKey, { status: "started", started_at_ms: Date.now(), track: track.name, created_at: new Date().toISOString() });
      const queries = [
        geoQuery + track.query + " latest news investigation report 2026",
        geoQuery + track.query + " official announcement research findings incident 2026",
        geoQuery + track.focus + " recent developments primary source independent reporting",
        geoScope === "Россия"
          ? "Россия последние новости регулирование расследования комплаенс мошенничество кибербезопасность официальные источники 2026"
          : "world latest regulatory enforcement investigation fraud cybersecurity compliance international 2026",
        geoScope === "Россия"
          ? "Россия Банк России Росфинмониторинг правительство РФ РБК Коммерсант новости 2026"
          : "international regulator enforcement investigation Reuters AP BBC EU official news 2026"
      ];
      if (track.name === "OSINT") {
        queries.push(geoQuery + "open source investigation geolocation digital forensics public records investigative journalism latest 2026");
      } else if (track.name === "Комплаенс") {
        queries.push(geoQuery + "AML KYC sanctions enforcement regulator guidance FATF FinCEN FCA EBA 2026");
        queries.push(geoQuery + "ПОД ФТ комплаенс новые требования разъяснения Банк России Росфинмониторинг 2026");
      } else {
        queries.push(geoQuery + "fraud scam deepfake cybercrime threat intelligence law enforcement report 2026");
      }
      const gathered = [];
      for (const query of queries) {
        try {
          const batch = await deps.tavilySearch(env, query, { search_depth: "advanced", max_results: 20 });
          gathered.push(...(Array.isArray(batch) ? batch : []));
        } catch (error) {
          searchFailure = String(error.message || error);
          console.error("Hourly source search attempt failed:", { track: track.name, query, error: searchFailure });
        }
        const byUrl = new Map();
        for (const item of gathered) {
          // Require a verifiable original publication date; stale/undated evergreen
          // pages are excluded before they reach the generation model.
          const publishedAt = hourlySourcePublishedTime(item);
          if (!publishedAt || !isFreshHourlySource(item)) continue;
          const url = String(item.url || "").trim();
          if (!/^https?:\/\//iu.test(url)) continue;
          let host = "";
          try { host = new URL(url).hostname.toLowerCase().replace(/^www\./u, ""); } catch (_) { continue; }
          if (!trustedDomains.some(domain => host === domain || host.endsWith("." + domain))) continue;
          const domain = rootDomain(host);
          if (!domain) continue;
          const canonical = (host + new URL(url).pathname).toLowerCase().replace(/\/$/u, "");
          if (!byUrl.has(canonical)) byUrl.set(canonical, {
            host, domain, url, title: String(item.title || ""),
            published_at: new Date(publishedAt).toISOString(),
            content: String(item.content || "").slice(0, 1200)
          });
        }
        const domainUsage = new Map();
        const urlUsage = new Map();
        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        for (const item of recentHistory) {
          if (hourlyRecordTime(item) < weekAgo) continue;
          for (const domain of item.source_domains || []) domainUsage.set(domain, (domainUsage.get(domain) || 0) + 1);
          for (const sourceUrl of item.source_urls || []) {
            try {
              const u = new URL(sourceUrl);
              const key = (u.hostname + u.pathname).toLowerCase().replace(/\/$/u, "");
              urlUsage.set(key, (urlUsage.get(key) || 0) + 1);
            } catch (_) {}
          }
        }
        const candidateSources = [...byUrl.values()].sort((a, b) =>
          (domainUsage.get(a.domain) || 0) - (domainUsage.get(b.domain) || 0) ||
          (urlUsage.get((a.host + new URL(a.url).pathname).toLowerCase().replace(/\/$/u, "")) || 0) -
          (urlUsage.get((b.host + new URL(b.url).pathname).toLowerCase().replace(/\/$/u, "")) || 0)
        );
        const domainCounts = new Map();
        const diversifiedSources = [];
        for (const source of candidateSources) {
          const count = domainCounts.get(source.domain) || 0;
          if (count >= 2) continue;
          domainCounts.set(source.domain, count + 1);
          diversifiedSources.push({ ...source, id: diversifiedSources.length + 1 });
          if (diversifiedSources.length >= 30) break;
        }
        if (diversifiedSources.length >= 2) sources = diversifiedSources;
      }
      if (sources.length >= 2) break;
      console.warn("Hourly topic has insufficient trusted independent sources; switching track:", track.name);
    }
    if (sources.length < 2) {
      throw new Error("После повторного поиска по OSINT, Комплаенсу и Антифроду не удалось найти два независимых авторитетных источника. " + (searchFailure ? "Последняя ошибка поиска: " + searchFailure : "Следующий запуск повторит поиск."));
    }
    const sourceCatalogue = sources.map(s => "[" + s.id + "] " + s.host + " | опубликовано: " + s.published_at + " | " + s.title + " | " + s.url + "\n" + s.content).join("\n\n");
    const rejectedCandidates = [];
    let text = "";
    let selectedSources = [];
    let sourceIds = [];
    let duplicateGuardPassed = false;
    let lastGenerationError = "";

    // Generate and validate several candidates. A repeated story is rejected locally,
    // regardless of whether the model follows the anti-repetition instruction.
    for (let attempt = 1; attempt <= 6; attempt++) {
      const prompt = [
        "Ты — выпускающий редактор профессионального русскоязычного медиа об OSINT, комплаенсе и антифроде.",
        "ТЕКУЩЕЕ НАПРАВЛЕНИЕ: " + track.name + ". География выпуска: " + geoScope + ". Тематический фокус: " + track.focus + ".",
        "Выбери ОДНО событие, опубликованное не более 24 часов назад, из каталога источников. Используй только дату первоначальной публикации, а не дату обновления страницы. География должна строго соответствовать выпуску: " + geoScope + ". Для выпуска Россия — событие именно в России, о российском регулировании или российской организации; для выпуска Мир — международное или зарубежное событие, не российская новость.",
        "Пост: 2–3 полных связанных предложения, 180–470 символов. Первое сообщает, что произошло; второе раскрывает подтверждённую деталь и практическое значение; третье допустимо для контекста.",
        "Используй только факты, прямо подтверждаемые минимум двумя независимыми источниками. Не выдумывай факты, даты, цифры и причинно-следственные связи.",
        "Стиль профессиональный, аналитический и естественный. Без хештегов, ссылок, упоминаний, эмодзи и вопросов.",
        "КРИТИЧЕСКИ ВАЖНО: не используй ни одно событие из истории и списка отклонённых кандидатов. Если тема уже встречалась, выбери ДРУГОЕ событие из каталога, а не переписывай старую новость другими словами.",
        "Последние опубликованные новости за день: " + JSON.stringify(recentHistory.slice(-36).map(item => ({ text: item.text, geo_scope: item.geo_scope || "", source_urls: item.source_urls || [] }))),
        "Не повторяй событие, даже если оно пересказано другими словами. Используй источники из разных редакций; предпочитай домены, которые реже встречались в недавних публикациях.",
        "Отклонённые в этой сессии кандидаты и причины: " + JSON.stringify(rejectedCandidates),
        "Предыдущая ошибка проверки: " + (lastGenerationError || "это первая попытка") + ". Исправь именно эту проблему, не повторяй отклонённый текст.",
        "Попытка " + attempt + " из 6. Верни строго JSON вида " + JSON.stringify({ category: track.name, text: "Два или три предложения поста.", source_ids: [1,2] }) + ". source_ids — ровно два разных числовых ID.",
        "КАТАЛОГ ИСТОЧНИКОВ:\n" + sourceCatalogue
      ].join("\n\n");
      try {
        const generated = await deps.geminiGenerate(env, prompt, {
          task: "hourly_osint_compliance_antifraud_post",
          model: "gemini-3.5-flash-lite",
          fallbackModels: ["gemini-3.1-flash-lite"],
          maxAttempts: 1,
          temperature: 0.35,
          maxOutputTokens: 1200
        });
        const parsed = parseJsonObject(generated);
        const candidateText = normalizeText(parsed.text || parsed.post || "");
        const candidateIds = Array.isArray(parsed.source_ids) ? parsed.source_ids.map(Number) : [];
        const candidateSources = candidateIds.map(id => sources.find(source => source.id === id)).filter(Boolean);
        const sentenceCount = (candidateText.match(/[.!?]+(?=\s|$)/gu) || []).length;
        if (!candidateText || candidateText.length < 140 || candidateText.length > 470 || sentenceCount < 2 || sentenceCount > 3) {
          const reason = "требуется 2–3 предложения и 140–470 символов; получено " + candidateText.length + " символов и " + sentenceCount + " предложений";
          rejectedCandidates.push({ text: candidateText.slice(0, 500), source_ids: candidateIds, reason });
          throw new Error("Пост не прошёл редакционную проверку: " + reason + ".");
        }
        if (!/[А-Яа-яЁё]/u.test(candidateText) || /[#@]|https?:\/\//iu.test(candidateText) || /\?/u.test(candidateText)) {
          throw new Error("Пост не прошёл языковой и форматный фильтр.");
        }
        if (candidateIds.length !== 2 || candidateSources.length !== 2 || new Set(candidateSources.map(source => source.domain)).size !== 2) {
          throw new Error("Не подтверждены два независимых источника.");
        }
        if (isDuplicateHourlyStory(candidateText, candidateSources, recentHistory)) {
          rejectedCandidates.push({ text: candidateText, source_urls: candidateSources.map(source => source.url), reason: "duplicate_of_previous_publication" });
          lastGenerationError = "Обнаружен повтор ранее опубликованной новости";
          console.warn("Hourly candidate rejected as duplicate:", { attempt, category: track.name });
          continue;
        }
        text = candidateText;
        sourceIds = candidateIds;
        selectedSources = candidateSources;
        duplicateGuardPassed = true;
        break;
      } catch (error) {
        lastGenerationError = String(error.message || error);
        if (attempt === 6) throw error;
      }
    }
    if (!duplicateGuardPassed) {
      throw new Error("Не удалось подобрать новую, не повторяющую публикации за текущие сутки, новость за 6 попыток. " + lastGenerationError);
    }
    const published = await publishThreads(env, token, text);
    const at = new Date().toISOString();
    const record = {
      slot, category: track.name, geo_scope: geoScope, text,
      source_urls: selectedSources.map(s => s.url),
      source_domains: selectedSources.map(s => s.domain),
      source_titles: selectedSources.map(s => s.title),
      threads_post_id: published.id, threads_permalink: published.permalink, published_at: at
    };
    const publishHistory = await storage.get("social:hourly:auto_history") || [];
    publishHistory.push(record);
    await storage.put("social:hourly:auto_history", publishHistory.slice(-100));
    await storage.put("social:hourly:auto_last_published_at", Date.now());
    await storage.put("social:hourly:auto_last_geo_scope", geoScope);
    await storage.put(slotKey, { status: "published", ...record });
    await deps.telegram(env, "sendMessage", {
      chat_id: env.TELEGRAM_CHAT_ID,
      text: "ЕЖЕЧАСНЫЙ ПОСТ ОПУБЛИКОВАН\nНаправление: " + track.name + "\n\n" + text +
        (published.permalink ? "\n\n" + published.permalink : "")
    });
    return { ok: true, published: true, category: track.name, text, permalink: published.permalink };
  } catch (error) {
    await storage.put(slotKey, { status: "failed", track: track.name, error: String(error.message || error).slice(0, 700), failed_at: new Date().toISOString() });
    console.error("Hourly OSINT/compliance/anti-fraud auto-publish failed:", error.message);
    await deps.telegram(env, "sendMessage", {
      chat_id: env.TELEGRAM_CHAT_ID,
      text: "Ежечасный пост не опубликован — проверка остановила выпуск.\nНаправление: " + track.name + "\nПричина: " + String(error.message || error).slice(0, 600)
    });
    return { ok: true, skipped: true, reason: "editorial_validation_or_publish_failed", detail: String(error.message || error) };
  }
}
