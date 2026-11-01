/**
 * Sample catalogue for the demo build only (never used by the real shop). Brands, sellers, customers and
 * reviews are invented for the demonstration; prices are plausible Algerian prices in DZD.
 */
type L = { ar: string; fr: string; en: string };
export type DemoProduct = {
  slug: string;
  brand: string;
  category: string;
  gender: 'men' | 'women' | 'unisex';
  concentration: string;
  notes: { top: string[]; heart: string[]; base: string[] };
  name: L;
  description: L;
  variants: { ml: number; price: number; stock: number; compareAt?: number }[];
  seller: string;
  /** Other sellers of the same perfume (price difference in DZD). */
  alsoSoldBy?: { seller: string; delta: number }[];
  popularity: number;
  daysOld: number;
  reviews: { rating: number; author: string; body: L; daysAgo: number; reply?: L }[];
  summary?: { summary: L; pros: L[]; cons: L[] };
};

export const BRANDS: Record<string, string> = {
  'mb-signature': 'MB Signature',
  'maison-sahara': 'Maison Sahara',
  'atlas-parfums': 'Atlas Parfums',
  'kasbah-oud': 'Kasbah Oud',
  rimal: 'Rimal',
};

export const SELLERS: Record<string, string> = {
  'mb-parfum': 'MB Parfum',
  'oran-senteurs': 'Oran Senteurs',
  'dar-el-attar': 'Dar El Attar',
};

export const CATEGORIES: { slug: string; name: L }[] = [
  { slug: 'oriental', name: { ar: 'شرقي', fr: 'Oriental', en: 'Oriental' } },
  { slug: 'floral', name: { ar: 'زهري', fr: 'Floral', en: 'Floral' } },
  { slug: 'fresh', name: { ar: 'منعش', fr: 'Frais', en: 'Fresh' } },
  { slug: 'woody', name: { ar: 'خشبي', fr: 'Boisé', en: 'Woody' } },
  { slug: 'gourmand', name: { ar: 'حلو', fr: 'Gourmand', en: 'Gourmand' } },
];

const r = (rating: number, author: string, ar: string, fr: string, en: string, daysAgo: number, reply?: L) => ({ rating, author, body: { ar, fr, en }, daysAgo, reply });

export const PRODUCTS: DemoProduct[] = [
  {
    slug: 'oud-royal',
    brand: 'mb-signature',
    category: 'oriental',
    gender: 'unisex',
    concentration: 'EDP',
    notes: { top: ['saffron', 'bergamot'], heart: ['rose', 'oud'], base: ['amber', 'musk'] },
    name: { ar: 'عود رويال', fr: 'Oud Royal', en: 'Oud Royal' },
    description: {
      ar: 'عطر شرقي فاخر يفتتح بالزعفران والبرغموت، ثم يتعمق بالورد والعود، ويستقر على العنبر والمسك. ثباته طويل ويناسب السهرات والمناسبات.',
      fr: 'Un oriental somptueux : safran et bergamote en ouverture, cœur de rose et de oud, fond d’ambre et de musc. Longue tenue, idéal pour le soir et les grandes occasions.',
      en: 'A sumptuous oriental: saffron and bergamot open onto rose and oud, settling on amber and musk. Long-lasting, made for evenings and special occasions.',
    },
    variants: [
      { ml: 50, price: 8500, stock: 20 },
      { ml: 100, price: 14000, stock: 12, compareAt: 15500 },
    ],
    seller: 'mb-parfum',
    alsoSoldBy: [{ seller: 'dar-el-attar', delta: 400 }],
    popularity: 96,
    daysOld: 120,
    reviews: [
      r(5, 'Karim B.', 'ثبات رهيب، يبقى على الملابس يومين. رائحة فخمة جدًا.', 'Tenue incroyable, il reste deux jours sur les vêtements. Très luxueux.', 'Amazing longevity, stays on clothes for two days. Very luxurious.', 6),
      r(5, 'Amina S.', 'اشتريته هدية لزوجي وأعجبه كثيرًا. التغليف أنيق.', 'Acheté en cadeau pour mon mari, il a adoré. Emballage soigné.', 'Bought it as a gift for my husband, he loved it. Nice packaging.', 14, { ar: 'شكرًا لك! سعداء أن الهدية أعجبته.', fr: 'Merci ! Ravis que le cadeau lui ait plu.', en: 'Thank you! Glad he liked the gift.' }),
      r(4, 'Yacine M.', 'جميل لكن قوي قليلًا للعمل، أفضّله للمساء.', 'Très beau mais un peu fort pour le bureau, je le garde pour le soir.', 'Beautiful but a bit strong for the office; I keep it for evenings.', 21),
      r(5, 'Sofiane K.', 'أفضل عود جربته بهذا السعر.', 'Le meilleur oud que j’ai essayé à ce prix.', 'The best oud I have tried at this price.', 33),
    ],
    summary: {
      summary: {
        ar: 'يُجمع المشترون على فخامة الرائحة وثباتها الطويل، ويرونه خيارًا ممتازًا للسهرات والهدايا. بعضهم يجده قويًا للاستعمال اليومي في العمل.',
        fr: 'Les acheteurs saluent un parfum luxueux et une tenue remarquable, parfait pour le soir et à offrir. Certains le trouvent trop puissant pour le bureau.',
        en: 'Buyers praise a luxurious scent and remarkable longevity, perfect for evenings and as a gift. Some find it too strong for the office.',
      },
      pros: [
        { ar: 'ثبات طويل جدًا', fr: 'Tenue très longue', en: 'Very long-lasting' },
        { ar: 'رائحة فخمة', fr: 'Sillage luxueux', en: 'Luxurious scent' },
        { ar: 'مناسب كهدية', fr: 'Idéal à offrir', en: 'Great as a gift' },
      ],
      cons: [{ ar: 'قوي للعمل', fr: 'Fort pour le bureau', en: 'Strong for the office' }],
    },
  },
  {
    slug: 'fleur-de-jasmin',
    brand: 'mb-signature',
    category: 'floral',
    gender: 'women',
    concentration: 'EDP',
    notes: { top: ['pear'], heart: ['jasmine', 'orange blossom'], base: ['vanilla'] },
    name: { ar: 'زهرة الياسمين', fr: 'Fleur de Jasmin', en: 'Jasmine Blossom' },
    description: {
      ar: 'عطر زهري ناعم يغلب عليه الياسمين وزهر البرتقال، بلمسة كمثرى منعشة وقاعدة فانيليا دافئة. أنثوي وراقٍ لكل يوم.',
      fr: 'Un floral délicat dominé par le jasmin et la fleur d’oranger, une touche de poire et un fond de vanille chaude. Féminin et élégant au quotidien.',
      en: 'A soft floral led by jasmine and orange blossom, with a fresh pear top and a warm vanilla base. Feminine and elegant for every day.',
    },
    variants: [
      { ml: 50, price: 5900, stock: 25 },
      { ml: 75, price: 6900, stock: 30 },
    ],
    seller: 'mb-parfum',
    popularity: 88,
    daysOld: 90,
    reviews: [
      r(5, 'Lina H.', 'رائحة الياسمين طبيعية جدًا، أحبه.', 'Le jasmin est très naturel, j’adore.', 'The jasmine smells very natural, I love it.', 3),
      r(4, 'Meriem A.', 'جميل وخفيف، لكن الثبات متوسط.', 'Joli et léger, tenue moyenne.', 'Pretty and light, average longevity.', 18),
      r(5, 'Sarah D.', 'تلقيت الكثير من المجاملات.', 'J’ai reçu beaucoup de compliments.', 'I got lots of compliments.', 27),
    ],
    summary: {
      summary: {
        ar: 'تحبه المشتريات لرائحة الياسمين الطبيعية وطابعه الأنثوي الخفيف المناسب لكل يوم. الثبات متوسط حسب بعض التقييمات.',
        fr: 'Apprécié pour son jasmin naturel et son caractère féminin et léger, parfait au quotidien. La tenue est jugée moyenne par certaines.',
        en: 'Loved for its natural jasmine and light feminine character, perfect for every day. Some find the longevity average.',
      },
      pros: [
        { ar: 'ياسمين طبيعي', fr: 'Jasmin naturel', en: 'Natural jasmine' },
        { ar: 'مناسب لكل يوم', fr: 'Pour tous les jours', en: 'Everyday wear' },
      ],
      cons: [{ ar: 'ثبات متوسط', fr: 'Tenue moyenne', en: 'Average longevity' }],
    },
  },
  {
    slug: 'bois-marin',
    brand: 'mb-signature',
    category: 'fresh',
    gender: 'men',
    concentration: 'EDT',
    notes: { top: ['lemon', 'sea salt'], heart: ['lavender'], base: ['cedar', 'vetiver'] },
    name: { ar: 'خشب البحر', fr: 'Bois Marin', en: 'Marine Wood' },
    description: {
      ar: 'نسيم بحري منعش بالليمون وملح البحر، يمر باللافندر وينتهي بخشب الأرز ونجيل الهند. مثالي لصيف الجزائر.',
      fr: 'Une brise marine au citron et au sel, un cœur de lavande et un fond de cèdre et de vétiver. Idéal pour l’été algérien.',
      en: 'A sea breeze of lemon and sea salt, a lavender heart and a base of cedar and vetiver. Made for the Algerian summer.',
    },
    variants: [{ ml: 100, price: 5900, stock: 18 }],
    seller: 'mb-parfum',
    popularity: 74,
    daysOld: 60,
    reviews: [
      r(5, 'Nassim T.', 'منعش جدًا في الحر، أستعمله كل يوم.', 'Très frais par la chaleur, je le porte tous les jours.', 'Very fresh in the heat, I wear it daily.', 9),
      r(4, 'Omar F.', 'رائحة نظيفة، أتمنى ثباتًا أطول.', 'Odeur propre, j’aimerais plus de tenue.', 'Clean scent, I wish it lasted longer.', 40),
    ],
  },
  {
    slug: 'nuit-du-desert',
    brand: 'maison-sahara',
    category: 'oriental',
    gender: 'men',
    concentration: 'Parfum',
    notes: { top: ['cardamom', 'pink pepper'], heart: ['incense', 'leather'], base: ['oud', 'patchouli'] },
    name: { ar: 'ليل الصحراء', fr: 'Nuit du Désert', en: 'Desert Night' },
    description: {
      ar: 'عطر رجالي عميق مستوحى من ليالي الهقار: هيل وفلفل وردي، بخور وجلد، وعود وباتشولي. تركيز عالٍ وحضور قوي.',
      fr: 'Un masculin profond inspiré des nuits du Hoggar : cardamome et poivre rose, encens et cuir, oud et patchouli. Haute concentration, forte présence.',
      en: 'A deep masculine inspired by Hoggar nights: cardamom and pink pepper, incense and leather, oud and patchouli. High concentration, strong presence.',
    },
    variants: [
      { ml: 50, price: 12500, stock: 8 },
      { ml: 100, price: 19800, stock: 5 },
    ],
    seller: 'oran-senteurs',
    popularity: 81,
    daysOld: 25,
    reviews: [
      r(5, 'Riad L.', 'رائحة رجولية قوية وثبات ممتاز.', 'Très viril, excellente tenue.', 'Very masculine, excellent longevity.', 5),
      r(5, 'Hichem G.', 'البخور والجلد متوازنان بشكل رائع.', 'Encens et cuir parfaitement équilibrés.', 'Incense and leather perfectly balanced.', 12),
      r(4, 'Adel Z.', 'غالٍ قليلًا لكنه يستحق.', 'Un peu cher mais il le vaut.', 'A bit pricey but worth it.', 19),
    ],
    summary: {
      summary: {
        ar: 'يصفه المشترون بأنه رجولي وقوي بتوازن جميل بين البخور والجلد، مع ثبات ممتاز. سعره مرتفع قليلًا لكنهم يرونه يستحق.',
        fr: 'Décrit comme viril et puissant, avec un bel équilibre encens-cuir et une excellente tenue. Un peu cher, mais jugé à la hauteur.',
        en: 'Described as masculine and powerful, with a fine incense-leather balance and excellent longevity. A little pricey but considered worth it.',
      },
      pros: [
        { ar: 'ثبات ممتاز', fr: 'Excellente tenue', en: 'Excellent longevity' },
        { ar: 'بخور وجلد متوازنان', fr: 'Encens et cuir équilibrés', en: 'Balanced incense and leather' },
      ],
      cons: [{ ar: 'سعر مرتفع', fr: 'Prix élevé', en: 'Higher price' }],
    },
  },
  {
    slug: 'rose-de-tlemcen',
    brand: 'maison-sahara',
    category: 'floral',
    gender: 'women',
    concentration: 'EDP',
    notes: { top: ['pink pepper', 'bergamot'], heart: ['rose', 'peony'], base: ['white musk', 'sandalwood'] },
    name: { ar: 'وردة تلمسان', fr: 'Rose de Tlemcen', en: 'Tlemcen Rose' },
    description: {
      ar: 'تحية لحدائق تلمسان: وردة ندية مع الفاوانيا، يلمعها الفلفل الوردي، وتدفئها قاعدة المسك الأبيض وخشب الصندل.',
      fr: 'Hommage aux jardins de Tlemcen : une rose rosée et de la pivoine, éclairées de poivre rose, réchauffées de musc blanc et de santal.',
      en: 'A tribute to the gardens of Tlemcen: a dewy rose with peony, lit by pink pepper and warmed by white musk and sandalwood.',
    },
    variants: [
      { ml: 50, price: 7800, stock: 14 },
      { ml: 100, price: 12900, stock: 9 },
    ],
    seller: 'oran-senteurs',
    alsoSoldBy: [{ seller: 'mb-parfum', delta: -300 }],
    popularity: 85,
    daysOld: 40,
    reviews: [
      r(5, 'Imene R.', 'أجمل عطر ورد عندي.', 'Le plus beau parfum à la rose que j’ai.', 'The most beautiful rose perfume I own.', 4),
      r(5, 'Wafa B.', 'راقٍ وغير مزعج، يناسب العمل.', 'Élégant et discret, parfait au bureau.', 'Elegant and not overpowering, office-friendly.', 16),
      r(4, 'Nour E.', 'جميل جدًا، التوصيل استغرق 3 أيام.', 'Très joli, livraison en 3 jours.', 'Very pretty, delivery took 3 days.', 30),
    ],
    summary: {
      summary: {
        ar: 'وردة راقية وناعمة تعجب المشتريات، ويرونها مناسبة للعمل والمناسبات معًا.',
        fr: 'Une rose élégante et douce, appréciée au bureau comme en soirée.',
        en: 'An elegant, soft rose that buyers wear both at work and for occasions.',
      },
      pros: [
        { ar: 'ورد راقٍ', fr: 'Rose élégante', en: 'Elegant rose' },
        { ar: 'مناسب للعمل', fr: 'Adapté au bureau', en: 'Office-friendly' },
      ],
      cons: [],
    },
  },
  {
    slug: 'vanille-ambree',
    brand: 'atlas-parfums',
    category: 'gourmand',
    gender: 'women',
    concentration: 'EDP',
    notes: { top: ['pear', 'cardamom'], heart: ['praline', 'iris'], base: ['vanilla', 'tonka', 'amber'] },
    name: { ar: 'فانيليا عنبرية', fr: 'Vanille Ambrée', en: 'Amber Vanilla' },
    description: {
      ar: 'عطر حلو دافئ: فانيليا وبرالين مع الإيريس، ولمسة هيل، وقاعدة تونكا وعنبر. مريح ومحبوب في الشتاء.',
      fr: 'Un gourmand chaleureux : vanille et praliné avec de l’iris, une touche de cardamome, un fond de tonka et d’ambre. Réconfortant, adoré en hiver.',
      en: 'A warm gourmand: vanilla and praline with iris, a hint of cardamom, a base of tonka and amber. Comforting and loved in winter.',
    },
    variants: [
      { ml: 50, price: 6500, stock: 22 },
      { ml: 100, price: 9900, stock: 15 },
    ],
    seller: 'mb-parfum',
    popularity: 92,
    daysOld: 75,
    reviews: [
      r(5, 'Rania K.', 'رائحة تشبه الحلويات، لذيذة!', 'On dirait une pâtisserie, délicieux !', 'Smells like a pastry shop, delicious!', 2),
      r(5, 'Feriel M.', 'ثباته ممتاز وسعره مناسب.', 'Excellente tenue et bon prix.', 'Great longevity and fair price.', 11),
      r(4, 'Kenza L.', 'حلو قليلًا لكنه جميل في الشتاء.', 'Un peu sucré mais parfait en hiver.', 'A bit sweet but perfect in winter.', 25),
    ],
    summary: {
      summary: {
        ar: 'عطر حلو ودافئ تصفه المشتريات بأنه لذيذ، بثبات ممتاز وسعر مناسب. مثالي للشتاء، وقد يكون حلوًا جدًا لمن يفضل العطور الخفيفة.',
        fr: 'Un gourmand chaleureux jugé délicieux, avec une excellente tenue et un bon prix. Parfait l’hiver, peut-être trop sucré pour les amatrices de légèreté.',
        en: 'A warm gourmand called delicious, with excellent longevity and a fair price. Perfect in winter; maybe too sweet for lovers of light scents.',
      },
      pros: [
        { ar: 'ثبات ممتاز', fr: 'Excellente tenue', en: 'Excellent longevity' },
        { ar: 'سعر مناسب', fr: 'Bon prix', en: 'Fair price' },
      ],
      cons: [{ ar: 'حلو قليلًا', fr: 'Un peu sucré', en: 'A little sweet' }],
    },
  },
  {
    slug: 'cedre-atlas',
    brand: 'atlas-parfums',
    category: 'woody',
    gender: 'men',
    concentration: 'EDP',
    notes: { top: ['grapefruit', 'pink pepper'], heart: ['cedar', 'iris'], base: ['vetiver', 'sandalwood'] },
    name: { ar: 'أرز الأطلس', fr: 'Cèdre de l’Atlas', en: 'Atlas Cedar' },
    description: {
      ar: 'خشبي أنيق من غابات الأطلس: جريب فروت وفلفل وردي، أرز وإيريس، ثم نجيل الهند والصندل. رجولي هادئ للعمل والمساء.',
      fr: 'Un boisé élégant venu des forêts de l’Atlas : pamplemousse et poivre rose, cèdre et iris, vétiver et santal. Masculin et posé, du bureau au soir.',
      en: 'An elegant woody from the Atlas forests: grapefruit and pink pepper, cedar and iris, then vetiver and sandalwood. Calm and masculine, office to evening.',
    },
    variants: [
      { ml: 50, price: 7200, stock: 16 },
      { ml: 100, price: 11500, stock: 10 },
    ],
    seller: 'dar-el-attar',
    popularity: 70,
    daysOld: 15,
    reviews: [
      r(5, 'Mehdi A.', 'أنيق جدًا، مناسب للعمل.', 'Très classe, parfait au travail.', 'Very classy, perfect for work.', 7),
      r(4, 'Bilal N.', 'جميل، أتمنى حجمًا أصغر.', 'Beau, j’aimerais un plus petit format.', 'Nice, I wish there was a smaller size.', 13),
    ],
  },
  {
    slug: 'musc-blanc',
    brand: 'rimal',
    category: 'fresh',
    gender: 'unisex',
    concentration: 'EDT',
    notes: { top: ['neroli'], heart: ['white musk', 'lily of the valley'], base: ['musk', 'sandalwood'] },
    name: { ar: 'المسك الأبيض', fr: 'Musc Blanc', en: 'White Musk' },
    description: {
      ar: 'رائحة النظافة: مسك أبيض ناعم مع زهر النارنج وزنبق الوادي. خفيف ومريح، يناسب الجميع وكل الأوقات.',
      fr: 'L’odeur du propre : un musc blanc doux avec néroli et muguet. Léger et apaisant, pour tous et à toute heure.',
      en: 'The scent of clean: soft white musk with neroli and lily of the valley. Light and soothing, for everyone, any time.',
    },
    variants: [
      { ml: 30, price: 3200, stock: 40 },
      { ml: 100, price: 6800, stock: 25 },
    ],
    seller: 'mb-parfum',
    popularity: 90,
    daysOld: 200,
    reviews: [
      r(5, 'Asma C.', 'رائحة نظيفة جدًا، أستعمله بعد الاستحمام.', 'Odeur de propre, je le mets après la douche.', 'Smells so clean, I wear it after showering.', 8),
      r(5, 'Walid H.', 'يناسب الرجال والنساء، سعره ممتاز.', 'Pour homme et femme, excellent prix.', 'Works for men and women, great price.', 20),
      r(4, 'Dounia S.', 'خفيف جدًا، أعيد وضعه في المساء.', 'Très léger, je le remets le soir.', 'Very light, I reapply in the evening.', 35),
    ],
    summary: {
      summary: {
        ar: 'يحبه المشترون لرائحته النظيفة الخفيفة التي تناسب الجميع، ولسعره الممتاز. خفته تعني أن بعضهم يعيد وضعه خلال اليوم.',
        fr: 'Apprécié pour son odeur propre et légère, unisexe, et son excellent prix. Sa légèreté oblige certains à le remettre dans la journée.',
        en: 'Loved for its clean, light, unisex scent and great price. Being light, some reapply it during the day.',
      },
      pros: [
        { ar: 'رائحة نظيفة', fr: 'Odeur de propre', en: 'Clean scent' },
        { ar: 'سعر ممتاز', fr: 'Excellent prix', en: 'Great price' },
      ],
      cons: [{ ar: 'خفيف جدًا', fr: 'Très léger', en: 'Very light' }],
    },
  },
  {
    slug: 'ambre-kasbah',
    brand: 'kasbah-oud',
    category: 'oriental',
    gender: 'unisex',
    concentration: 'EDP',
    notes: { top: ['saffron', 'cardamom'], heart: ['amber', 'honey'], base: ['vanilla', 'oud'] },
    name: { ar: 'عنبر القصبة', fr: 'Ambre de la Casbah', en: 'Casbah Amber' },
    description: {
      ar: 'دفء أزقة القصبة: زعفران وهيل، عنبر وعسل، وقاعدة فانيليا وعود. عطر دافئ وحنون للمساء.',
      fr: 'La chaleur des ruelles de la Casbah : safran et cardamome, ambre et miel, fond de vanille et de oud. Chaleureux et enveloppant pour le soir.',
      en: 'The warmth of the Casbah alleys: saffron and cardamom, amber and honey, a base of vanilla and oud. Warm and enveloping for evenings.',
    },
    variants: [
      { ml: 50, price: 9200, stock: 11 },
      { ml: 100, price: 15500, stock: 6 },
    ],
    seller: 'dar-el-attar',
    popularity: 78,
    daysOld: 10,
    reviews: [
      r(5, 'Samir O.', 'العنبر والعسل مزيج رائع.', 'Ambre et miel, un mélange superbe.', 'Amber and honey, a superb blend.', 4),
      r(4, 'Halima Y.', 'جميل ودافئ، ثباته جيد.', 'Beau et chaud, bonne tenue.', 'Lovely and warm, good longevity.', 9),
      r(5, 'Ilyes D.', 'من أجمل العطور الشرقية.', 'Un des plus beaux orientaux.', 'One of the finest orientals.', 15),
    ],
    summary: {
      summary: {
        ar: 'مزيج العنبر والعسل هو ما يحبه المشترون أكثر: عطر دافئ وجميل للمساء بثبات جيد.',
        fr: 'Le duo ambre-miel séduit : un parfum chaleureux pour le soir, avec une bonne tenue.',
        en: 'The amber-honey blend wins buyers over: a warm evening scent with good longevity.',
      },
      pros: [
        { ar: 'مزيج العنبر والعسل', fr: 'Duo ambre-miel', en: 'Amber-honey blend' },
        { ar: 'دافئ', fr: 'Chaleureux', en: 'Warm' },
      ],
      cons: [],
    },
  },
  {
    slug: 'menthe-sauvage',
    brand: 'rimal',
    category: 'fresh',
    gender: 'men',
    concentration: 'EDT',
    notes: { top: ['mint', 'grapefruit'], heart: ['lavender', 'tea'], base: ['vetiver', 'musk'] },
    name: { ar: 'نعناع بري', fr: 'Menthe Sauvage', en: 'Wild Mint' },
    description: {
      ar: 'انتعاش فوري بالنعناع والجريب فروت، مع شاي ولافندر، وقاعدة نجيل الهند والمسك. رياضي وخفيف.',
      fr: 'Un coup de fraîcheur menthe-pamplemousse, un cœur de thé et de lavande, un fond de vétiver et de musc. Sportif et léger.',
      en: 'An instant burst of mint and grapefruit, a tea and lavender heart, a base of vetiver and musk. Sporty and light.',
    },
    variants: [{ ml: 100, price: 4900, stock: 30 }],
    seller: 'oran-senteurs',
    popularity: 64,
    daysOld: 8,
    reviews: [r(4, 'Anis R.', 'منعش وسعره ممتاز.', 'Frais et pas cher.', 'Fresh and affordable.', 6)],
  },
  {
    slug: 'figue-des-aures',
    brand: 'atlas-parfums',
    category: 'woody',
    gender: 'unisex',
    concentration: 'EDP',
    notes: { top: ['fig', 'bergamot'], heart: ['fig', 'iris'], base: ['cedar', 'tonka'] },
    name: { ar: 'تين الأوراس', fr: 'Figue des Aurès', en: 'Aurès Fig' },
    description: {
      ar: 'تين أخضر وحليبي من بساتين الأوراس، مع البرغموت والإيريس، على قاعدة أرز وتونكا. أصيل وغير مألوف.',
      fr: 'La figue verte et lactée des vergers des Aurès, avec bergamote et iris, sur un fond de cèdre et de tonka. Authentique et singulier.',
      en: 'Green, milky fig from the Aurès orchards, with bergamot and iris on a base of cedar and tonka. Authentic and unusual.',
    },
    variants: [
      { ml: 50, price: 7600, stock: 9 },
      { ml: 100, price: 12200, stock: 4 },
    ],
    seller: 'mb-parfum',
    popularity: 58,
    daysOld: 5,
    reviews: [],
  },
  {
    slug: 'tubereuse-nuit',
    brand: 'maison-sahara',
    category: 'floral',
    gender: 'women',
    concentration: 'Parfum',
    notes: { top: ['neroli', 'pink pepper'], heart: ['tuberose', 'jasmine'], base: ['amber', 'sandalwood'] },
    name: { ar: 'مسك الليل', fr: 'Tubéreuse de Nuit', en: 'Night Tuberose' },
    description: {
      ar: 'مسك الليل الأبيض مع الياسمين، يلمعه زهر النارنج والفلفل الوردي، ويدفئه العنبر والصندل. أنثوي وجريء للسهرات.',
      fr: 'La tubéreuse blanche et le jasmin, éclairés de néroli et de poivre rose, réchauffés d’ambre et de santal. Féminin et audacieux pour le soir.',
      en: 'White tuberose with jasmine, lit by neroli and pink pepper, warmed by amber and sandalwood. Bold and feminine for evenings.',
    },
    variants: [{ ml: 50, price: 13500, stock: 0 }],
    seller: 'oran-senteurs',
    popularity: 69,
    daysOld: 55,
    reviews: [r(5, 'Yasmine B.', 'فاخر جدًا، أنتظر عودته للمخزون.', 'Très luxueux, j’attends son retour en stock.', 'Very luxurious, waiting for it to be back in stock.', 22)],
  },
  {
    slug: 'cafe-noir',
    brand: 'kasbah-oud',
    category: 'gourmand',
    gender: 'men',
    concentration: 'EDP',
    notes: { top: ['coffee', 'cardamom'], heart: ['caramel', 'leather'], base: ['tonka', 'patchouli'] },
    name: { ar: 'قهوة سوداء', fr: 'Café Noir', en: 'Black Coffee' },
    description: {
      ar: 'قهوة محمصة مع الهيل، كراميل وجلد، وقاعدة تونكا وباتشولي. عطر رجالي حلو ومميز للشتاء.',
      fr: 'Café torréfié et cardamome, caramel et cuir, fond de tonka et de patchouli. Un masculin gourmand et singulier pour l’hiver.',
      en: 'Roasted coffee and cardamom, caramel and leather, a base of tonka and patchouli. A distinctive gourmand for men in winter.',
    },
    variants: [
      { ml: 50, price: 8800, stock: 13 },
      { ml: 100, price: 13900, stock: 7 },
    ],
    seller: 'dar-el-attar',
    popularity: 72,
    daysOld: 30,
    reviews: [
      r(5, 'Fares M.', 'رائحة القهوة حقيقية ومميزة.', 'L’odeur de café est réelle et originale.', 'The coffee note is real and original.', 10),
      r(4, 'Tarek S.', 'جميل جدًا في الشتاء.', 'Très beau en hiver.', 'Lovely in winter.', 24),
    ],
  },
  {
    slug: 'neroli-alger',
    brand: 'mb-signature',
    category: 'fresh',
    gender: 'unisex',
    concentration: 'EDC',
    notes: { top: ['neroli', 'lemon', 'bergamot'], heart: ['orange blossom'], base: ['white musk'] },
    name: { ar: 'نيرولي الجزائر', fr: 'Néroli d’Alger', en: 'Algiers Neroli' },
    description: {
      ar: 'ماء كولونيا مشرق بزهر النارنج والليمون والبرغموت، كصباح في حدائق الحامة. منعش وخفيف لكل العائلة.',
      fr: 'Une eau de Cologne lumineuse au néroli, citron et bergamote, comme un matin au Jardin d’Essai. Fraîche et légère, pour toute la famille.',
      en: 'A bright eau de Cologne of neroli, lemon and bergamot, like a morning in the Hamma garden. Fresh and light for the whole family.',
    },
    variants: [
      { ml: 100, price: 4200, stock: 35 },
      { ml: 200, price: 6900, stock: 20 },
    ],
    seller: 'mb-parfum',
    popularity: 66,
    daysOld: 150,
    reviews: [
      r(5, 'Nadia F.', 'منعش جدًا، الكل في البيت يستعمله.', 'Très frais, toute la maison l’utilise.', 'Very fresh, the whole family uses it.', 12),
      r(4, 'Hamza B.', 'جميل بعد الحلاقة.', 'Parfait après le rasage.', 'Perfect after shaving.', 45),
    ],
  },
];

/** Products bought together in the demo shop's sample orders. */
export const BOUGHT_TOGETHER: Record<string, string[]> = {
  'oud-royal': ['ambre-kasbah', 'musc-blanc'],
  'fleur-de-jasmin': ['vanille-ambree', 'musc-blanc'],
  'vanille-ambree': ['fleur-de-jasmin', 'rose-de-tlemcen'],
  'nuit-du-desert': ['oud-royal'],
  'bois-marin': ['neroli-alger', 'menthe-sauvage'],
  'rose-de-tlemcen': ['vanille-ambree'],
  'musc-blanc': ['oud-royal', 'fleur-de-jasmin'],
};
