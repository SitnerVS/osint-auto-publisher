# OSINTNER Publisher

Threads-only editorial publishing workflow for OSINTNER.

## Editorial flow
- Two scheduled editorial drafts per day (09:00 and 18:30, Europe/Moscow).
- Every draft passes topic, text, visual and final approval in Telegram.
- A final-approved editorial item publishes as exactly one Threads IMAGE post: one topic-specific vector illustration plus one Russian caption in the same post.
- No editorial carousels, no Instagram workflow, no hashtags.
- The hourly humor stream is separate from editorial approvals.

## Visual identity
Premium investigative editorial vector graphics in the approved OSINTNER palette:
- Background: #0B0D0F, #15181B
- Light: #E7E9EA
- Secondary: #858B91
- Accent: #FF5A36
- Verification accent: #A7D65C

Generated images contain no text, letters, numbers, logos or watermarks. Each illustration must represent the exact subject of its own post.

## Safety
- Test materials are blocked from publication.
- Publishing happens only after explicit final approval.
- Image containers are checked before publishing.
- Ambiguous publish outcomes are locked against automatic retries to prevent duplicate posts.
- Pending image containers can be resumed with `/publish_retry <material-id>`.
