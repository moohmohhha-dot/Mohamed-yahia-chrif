# The Shoe Shine Boy | ولد مسح الأحذية

**Format:** YouTube Shorts / Reels / TikTok, 1080x1920, ~34s
**Style:** 3D Pixar-style animation, cinematic lighting, warm colors
**Voice:** English (global audience)
**Subtitles:** Arabic only (yellow), burned into the video
**Formula:** humiliation → failure → rock bottom → shocking twist → "Part 2?"

## Characters (keep the same prompt in every scene so faces stay consistent)

- **SAM (child, 10 y/o):** thin boy, messy curly black hair, big brown eyes, patched grey jacket, worn sneakers, wooden shoe-shine box.
- **SAM (adult, 25 y/o):** same curly black hair (styled), short beard, navy tailored suit, calm confident smile.
- **MR. GRANT (CEO, 55 y/o):** heavy man, slicked-back grey hair, thin mustache, expensive black suit, gold watch, arrogant smirk.

## Scenes (final cut: 6 scenes, ~34s)

Scene 1 is a Seedance 2.5 clip (720p); scenes 2-6 are Gemini Flash start frames animated with Kling 2.5 Turbo to keep credits low.

| # | Time | Visual | Line (EN voice) | Subtitle (AR) |
|---|------|--------|-----------------|----------------|
| 1 | 0–4s | Grant kicks Sam's shoe-shine box over and laughs. | **GRANT:** "You'll be shining shoes your whole life, kid." | ستبقى تمسح الأحذية طوال حياتك يا ولد. |
| 2 | 4–9s | Night, snow, Sam reads under a street lamp. | **NARRATOR:** "But every night... he studied under the same street lamp." | لكن كل ليلة، كان يدرس تحت نفس عمود الإنارة. |
| 3 | 9–14s | Teen Sam at a red-glowing laptop, pile of REJECTED letters, wipes a tear and keeps typing. | **NARRATOR:** "He failed eleven times... Fifteen years later..." | فشل إحدى عشرة مرة. / بعد 15 سنة |
| 4 | 14–19s | Grant's office: bankrupt report, doors open, silhouette walks in. | **ASSISTANT:** "Sir... we're bankrupt. There's only one buyer left." | سيدي، لقد أفلسنا. بقي مشترٍ واحد فقط. |
| 5 | 19–29s | Adult Sam kneels and polishes Grant's shoe with the old brush, looks up smiling. | **GRANT:** "Who are you?" **SAM:** "You told me I'd shine shoes my whole life." "You were right... but now, I own the building." | من أنت؟ / قلت لي إنني سأمسح الأحذية طوال حياتي. / كنت محقاً... لكنني الآن أملك المبنى. |
| 6 | 29–34s | Extreme close-up of Grant's shocked face, pen falls. | **NARRATOR:** "Part two? Follow, so you don't miss it." | الجزء الثاني؟ تابعني حتى لا يفوتك |

Voices (ElevenLabs v4): narrator Mark Vale, Grant Obsidian, Sam Bradley, assistant Eryn.

## Publishing

**Title:** He mocked a poor boy… 15 years later he regretted it 😳
**العنوان بالعربية:** احتقر طفلاً فقيراً... وبعد 15 سنة ندم 😳

**Description:**
Never judge anyone by where they start. 👞➡️🏢
لا تحكم على أحد من بدايته.
Follow for Part 2 👀

**Hashtags:** #shorts #motivation #animation #story #success #قصص #تحفيز #نجاح

## Production steps

1. Put the scene clips at `clips/01.mp4` … `clips/06.mp4`.
2. Put the voice lines in `audio/` (`l01_grant.mp3`, `l03_narrator.mp3`, `l05_narrator.mp3`, `l06_assistant.mp3`, `l07_grant.mp3`, `l08_sam.mp3`, `l09_sam.mp3`, `l10_narrator.mp3`) and the score at `audio/music.mp3`.
3. Run `./render.sh` → `output/final.mp4` with the Arabic subtitles burned in.
