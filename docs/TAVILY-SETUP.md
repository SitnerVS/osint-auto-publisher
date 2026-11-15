# Tavily Search setup for hourly facts

The hourly facts workflow now uses Tavily for web search and Gemini for text generation. Google Search grounding is no longer requested from Gemini.

## One-time setup (Staging first)

1. Create a free Tavily account at https://app.tavily.com and copy the API key.
   - The free Researcher plan currently includes 1,000 search credits per month and does not require a payment card.
   - This workflow makes one basic search request per hourly run (1 credit), so the nominal allowance covers up to 1,000 runs/month. Manual previews and retries also consume credits.
2. Open Cloudflare Dashboard → Workers & Pages → `osint-telegram-gateway-staging`.
3. Open Settings → Variables and Secrets → Add → Secret.
4. Set the variable name to `TAVILY_API_KEY`, paste the key as its value, and save.
5. Run `/hourly_preview` in the Telegram bot and inspect the five candidates and their two-source references.

Do not paste the API key into Telegram, GitHub issues, source code, or this chat.

## Production

Do not add the secret to `osint-telegram-gateway` or deploy this change to Production until Staging has passed the real Telegram preview test and the owner explicitly approves the Production rollout.

## Safety behavior

- Search results are restricted to a curated set of institutional, scientific, museum, and reference domains.
- The model receives the returned titles, URLs, and source snippets; it is instructed to use only those sources.
- Preview validation rejects URLs not returned by Tavily and requires two trusted, distinct source hosts for every fact.
- If Tavily is unavailable or returns too few sources, the workflow stops rather than generating unsupported facts.
