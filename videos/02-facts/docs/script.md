# هل تعلم؟ ست حقائق ستغيّر نظرتك للعالم

**Format:** YouTube 16:9, 1920x1080 (+ 4K upscale for upload), 30 fps, 60 s
**Style:** 3D raymarched scenes rendered in code, gold Arabic kinetic type, cinematic bars, synthesized epic score
**Voice:** ElevenLabs v4, "Mohammed – Deep Narrator & Documentary" (Arabic)
**Channel:** MOHAMED

## Shot list (90 bpm, one beat = 0.667 s; every cut on a beat, whip-pan transitions)

| # | Time | 3D set | On screen | Voice line |
|---|------|--------|-----------|------------|
| 1 | 0.0–6.0 | Golden ringed planet in a purple nebula, slow push | **هل تعلم؟** / ست حقائق ستغيّر نظرتك للعالم | هل تعلم؟ ست حقائق... ستغيّر نظرتك للعالم. |
| 2 | 6.0–13.3 | The Sun and Earth; a pulse of light travels between them | ضوء الشمس الذي تراه الآن / غادرها قبل **٨ دقائق** (counter) | ضوء الشمس الذي تراه الآن... غادرها قبل ثماني دقائق. |
| 3 | 13.3–20.0 | Beating 3D heart, blood cells drifting | قلبك ينبض أكثر من **١٠٠٬٠٠٠** مرة كل يوم (counter) | قلبك ينبض أكثر من مئة ألف مرة... كل يوم. |
| 4 | 20.0–26.7 | Octopus in the deep, three hearts glow blue | الأخطبوط يملك **٣ قلوب** / ودمه أزرق! | الأخطبوط يملك ثلاثة قلوب... ودمه أزرق. |
| 5 | 26.7–34.7 | Flight over a honeycomb full of honey | العسل لا يفسد أبداً / **+٣٠٠٠ سنة** | العسل لا يفسد أبداً... عمرها أكثر من ثلاثة آلاف سنة. |
| 6 | 34.7–42.7 | Cut-away ocean block: Everest sinks into the Mariana Trench | إيفرست ٨٬٨٤٩ م / عمق الخندق ١٠٬٩٣٥ م / **قمته تبقى تحت الماء بـ ٢ كم!** | لو وضعت جبل إيفرست في خندق ماريانا... بأكثر من كيلومترين. |
| 7 | 42.7–49.3 | Night storm over the sea, three strikes | البرق أسخن من سطح الشمس **×٥** ≈ ٣٠٬٠٠٠ درجة مئوية | والبرق... أسخن من سطح الشمس بخمس مرات. |
| 8 | 49.3–60.0 | Earth from orbit, sunrise on the limb | اشترك في قناة **MOHAMED** + subscribe button click / وزد علمك كل يوم | اشترك في قناة محمد... وزد علمك كل يوم. |

## Facts (checked)
- Sunlight takes about 8 min 20 s to reach Earth.
- A resting adult heart beats ~60–100 times a minute: roughly 100,000 beats a day.
- Octopuses have three hearts and copper-based (hemocyanin) blue blood.
- Edible honey has been found in ancient Egyptian tombs over 3,000 years old.
- Everest 8,849 m; Challenger Deep ~10,935 m: the summit would sit ~2 km under water.
- A lightning channel reaches ~30,000 °C, about five times the Sun's surface (~5,500 °C).

## Publishing
**العنوان:** هل تعلم؟ ٦ حقائق مذهلة ستغيّر نظرتك للعالم 🤯 | معلومات عامة
**الوصف:** ست حقائق علمية مذهلة في دقيقة واحدة: الشمس، القلب، الأخطبوط، العسل، إيفرست والبرق. اشترك في قناة MOHAMED ليزداد علمك كل يوم 🔔
**Hashtags:** #هل_تعلم #معلومات_عامة #حقائق #معلومات #ثقافة_عامة #shorts_ar

## Build
From `videos/`:
1. `node 02-facts/audio/score.mjs` (music), then the skill's `sfx.mjs 02-facts` (effects from the film's hit list).
2. Put the narration at `02-facts/audio/vo/take.mp3`, run `node 02-facts/audio/place_vo.mjs` (cuts it into the 8 lines and places each on its scene).
3. `render.mjs --film 02-facts --fps 30 --video-only`, then `mix.mjs 02-facts` → `out/02-facts/final.mp4`.
4. 4K upload copy: `ffmpeg -i out/02-facts/final.mp4 -vf scale=3840:2160:flags=lanczos -c:v libx264 -crf 16 -preset slow -c:a copy out/02-facts/final_4k.mp4`.
