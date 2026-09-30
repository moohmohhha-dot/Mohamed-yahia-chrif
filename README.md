# ARUMA MARKET

منظومة تجارة إلكترونية قابلة للتوسع عالميًا (متعددة المتاجر والتجار والدول والعملات واللغات).
أول تطبيق فيها: **MB Parfum** للعطور.

- البنية التقنية وقراراتها: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- خارطة الطريق: [docs/ROADMAP.md](docs/ROADMAP.md)

## التشغيل محليًا (للمطوّرين)

المتطلبات: Node.js 22+، pnpm 10+، PostgreSQL 16 (أو Docker).

```bash
pnpm install
docker compose up -d          # يشغّل PostgreSQL (قاعدة aruma + aruma_test)
cp .env.example .env
export $(grep -v '^#' .env | xargs)

pnpm db:migrate               # إنشاء الجداول
pnpm db:seed                  # بيانات MB Parfum التجريبية
pnpm dev                      # الخادم على http://localhost:3000
```

جرّب مثلًا:

```bash
curl "http://localhost:3000/v1/stores/mb-parfum/products?locale=fr&currency=EUR"
```

## الأوامر

| الأمر | الوظيفة |
|---|---|
| `pnpm dev` | تشغيل الخادم مع إعادة التحميل التلقائي |
| `pnpm test` | تشغيل الاختبارات (تمسح قاعدة `aruma_test` وتعيد إنشاءها) |
| `pnpm typecheck` | فحص الأنواع في كل الحزم |
| `pnpm db:generate` | إنشاء ملف migration بعد تعديل `packages/db/src/schema.ts` |
| `pnpm db:migrate` | تطبيق الـmigrations |
| `pnpm db:seed` | إدخال البيانات التجريبية |
