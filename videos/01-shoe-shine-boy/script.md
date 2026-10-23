# The Shoe Shine Boy | ولد مسح الأحذية

**Format:** YouTube Shorts / Reels / TikTok, 1080x1920, ~43s
**Style:** 3D Pixar-style animation, cinematic lighting, warm colors
**Voice:** English (global audience)
**Subtitles:** English (white) + Arabic (yellow), burned into the video
**Formula:** humiliation → failure → rock bottom → shocking twist → "Part 2?"

## Characters (keep the same prompt in every scene so faces stay consistent)

- **SAM (child, 10 y/o):** thin boy, messy curly black hair, big brown eyes, patched grey jacket, worn sneakers, wooden shoe-shine box.
- **SAM (adult, 25 y/o):** same curly black hair (styled), short beard, navy tailored suit, calm confident smile.
- **MR. GRANT (CEO, 55 y/o):** heavy man, slicked-back grey hair, thin mustache, expensive black suit, gold watch, arrogant smirk.

## Scenes

| # | Time | Visual (image/video prompt) | Line (EN) | Subtitle (AR) |
|---|------|------------------------------|-----------|----------------|
| 1 | 0–4s | Busy city sidewalk in front of a glass skyscraper. MR. GRANT kicks SAM's shoe-shine box over and laughs. | **GRANT:** "You'll be shining shoes your whole life, kid." | ستبقى تمسح الأحذية طوال حياتك يا ولد. |
| 2 | 4–8s | SAM on his knees picking up coins from the ground; people around point and laugh. | **NARRATOR:** "Everyone laughed. Even the security guard." | الجميع ضحك... حتى الحارس. |
| 3 | 8–12s | Night. SAM studying an old torn book under a single street lamp, breath visible in the cold. | **NARRATOR:** "But every night, he studied under the same street lamp." | لكن كل ليلة، كان يدرس تحت نفس عمود الإنارة. |
| 4 | 12–16s | Teenage SAM opening letters one after another, each stamped red "REJECTED". | **NARRATOR:** "Rejected. Rejected. Rejected." | مرفوض. مرفوض. مرفوض. |
| 5 | 16–20s | SAM in a tiny room, old laptop, fail screens; a tear, then he wipes it and keeps typing. Text "ATTEMPT 11" on screen. | **NARRATOR:** "He failed eleven times." | فشل إحدى عشرة مرة. |
| 6 | 20–24s | Title card "15 YEARS LATER". Luxury office at the top of the same skyscraper; MR. GRANT sweating, an assistant holds a red report. | **ASSISTANT:** "Sir, we're bankrupt. There's only one buyer left." | سيدي، لقد أفلسنا. بقي مشترٍ واحد فقط. |
| 7 | 24–29s | Office door opens; silhouette of a young man in a suit walking in, face in shadow. | **GRANT:** "Who are you?" | من أنت؟ |
| 8 | 29–34s | Close-up of adult SAM stepping into the light, calm smile. | **SAM:** "You told me I'd shine shoes my whole life." | قلت لي إنني سأمسح الأحذية طوال حياتي. |
| 9 | 34–39s | SAM kneels, takes the same old wooden brush from his pocket, polishes GRANT's shoe. | **SAM:** "You were right... but now I own the building." | كنت محقاً... لكنني الآن أملك المبنى. |
| 10 | 39–43s | Extreme close-up of GRANT's shocked face, pen falls from his hand. Text on screen. | **NARRATOR:** "Part 2? Follow so you don't miss it." | الجزء الثاني؟ تابعني حتى لا يفوتك. |

## Publishing

**Title:** He mocked a poor boy… 15 years later he regretted it 😳
**العنوان بالعربية:** احتقر طفلاً فقيراً... وبعد 15 سنة ندم 😳

**Description:**
Never judge anyone by where they start. 👞➡️🏢
لا تحكم على أحد من بدايته.
Follow for Part 2 👀

**Hashtags:** #shorts #motivation #animation #story #success #قصص #تحفيز #نجاح

## Production steps

1. Generate one reference image per character (the prompts above).
2. Generate each scene image with the character references, then animate each into a 4–5s clip → `clips/01.mp4` … `clips/10.mp4`.
3. Record the lines (one voice per character) → `audio/voice.mp3`; optional background music → `audio/music.mp3`.
4. Run `./render.sh` → `output/final.mp4` with both subtitle lines burned in.
