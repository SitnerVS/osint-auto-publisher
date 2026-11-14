# OSINTNER Publisher

Threads-only editorial publishing workflow for OSINTNER.

## Editorial flow
- Two scheduled editorial drafts per day (09:00 and 18:30, Europe/Moscow).
- Every draft passes topic, text, visual and final approval in Telegram.
- The publication format is exactly one Threads IMAGE post: one topic-specific illustration and one Russian caption in the same post.
- No editorial carousels, no Instagram workflow, no hashtags.
- The hourly humor stream is separate from editorial approvals.

## Visual identity
Premium investigative editorial vector graphics in the approved OSINTNER palette:
- Background: #0B0D0F, #15181B
- Light: #E7E9EA
- Secondary: #858B91
- Accent: #FF5A36
- Verification accent: #A7D65C

## Mandatory visual quality gate
Before a visual can reach approval, the generated image is independently inspected by a multimodal reviewer for:
- direct relevance to the material's exact subject;
- flat editorial vector appearance;
- compliance with the fixed OSINTNER palette;
- complete absence of text, pseudo-text, logos and watermarks;
- intact geometry and non-merged objects;
- a single coherent composition.

A failed image is regenerated once. If it fails again, the material is stopped and is not sent for approval.

## Safety and publishing
- Test materials are blocked from publication.
- Preview shows exactly one image with the final Threads caption.
- The visual approval step also displays the caption that will accompany that same image.
- Live editorial publishing is temporarily disabled until the visual quality gate passes a real test.
- Publishing after re-enabling requires explicit final approval.
- Image containers are checked before publishing.
- Ambiguous publish outcomes are locked against automatic retries to prevent duplicate posts.
- Pending image containers can be resumed with `/publish_retry <material-id>`.
