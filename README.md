# OSINTNER Publisher

Threads-only editorial publishing workflow for OSINTNER.

## Editorial schedule
- Five editorial drafts per day: 09:00, 12:00, 15:00, 18:00 and 21:00 (Europe/Moscow).
- Topic rotation is sequential and continuous: OSINT → Комплаенс → Антифрод → repeat.
- Each publication is one standalone Russian text-only Threads post (up to 500 characters).
- No image, video, carousel, hashtags or multi-post thread generation.
- A separate autonomous Threads stream publishes one OSINT/compliance/anti-fraud post every hour (24 topic posts/day, Europe/Moscow), without Telegram approval.
- The hourly topic track rotates sequentially across OSINT → Комплаенс → Антифрод.
- Five additional posts run independently of the hourly topic stream: famous-person quotes at 08:00, 14:00 and 20:00; Russian millennial childhood nostalgia at 11:00 and 17:00.
- Each nostalgia post must be exactly one short Russian sentence phrased as a question and ending with one question mark.
- If fresh sources are unavailable, the hourly topic stream publishes original evergreen professional content instead of waiting for approval.

## Editorial approval
- Each material passes topic approval, text approval and final publication approval in Telegram.
- «Отклонить — стоп» terminates the material.
- «На доработку — ещё вариант» generates an alternative for the current text or topic stage.
- Test materials can never be published.
- A post is sent to Threads only after explicit final approval.

## Safety and publishing
- The separate approval-based editorial feed remains gated until its own text-only approval cycle is tested end to end; the hourly topic and special streams are autonomous and do not request Telegram approval.
- Duplicate-safe container and publication state handling is retained.
- Ambiguous publishing outcomes are locked against automatic retries to prevent duplicate posts.
- /publish_retry material-id is available only for safely retryable publication attempts.
