# OSINTNER Publisher

Threads-only editorial publishing workflow for OSINTNER.

## Editorial schedule
- Five editorial drafts per day: 09:00, 12:00, 15:00, 18:00 and 21:00 (Europe/Moscow).
- Topic rotation is sequential and continuous: OSINT → Комплаенс → Антифрод → repeat.
- Each publication is one standalone Russian text-only Threads post (up to 500 characters).
- No image, video, carousel, hashtags or multi-post thread generation.
- The hourly humor stream remains separate from the editorial approval workflow.

## Editorial approval
- Each material passes topic approval, text approval and final publication approval in Telegram.
- «Отклонить — стоп» terminates the material.
- «На доработку — ещё вариант» generates an alternative for the current text or topic stage.
- Test materials can never be published.
- A post is sent to Threads only after explicit final approval.

## Safety and publishing
- Live publishing remains disabled until the text-only approval cycle is tested end to end.
- Duplicate-safe container and publication state handling is retained.
- Ambiguous publishing outcomes are locked against automatic retries to prevent duplicate posts.
- /publish_retry material-id is available only for safely retryable publication attempts.
