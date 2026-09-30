# ARUMA MARKET

منظومة تجارة إلكترونية قابلة للتوسع عالميًا (متعددة المتاجر والتجار والدول والعملات واللغات).
أول تطبيق فيها: **MB Parfum** للعطور.

- البنية التقنية وقراراتها: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- ARUMA CORE وخريطة كل الخدمات المشتركة: [docs/CORE.md](docs/CORE.md)
- نظام التجار والتحقق: [docs/MERCHANTS.md](docs/MERCHANTS.md)
- مركز التاجر: [docs/MERCHANT_CENTER.md](docs/MERCHANT_CENTER.md)
- خارطة الطريق: [docs/ROADMAP.md](docs/ROADMAP.md)

## التشغيل محليًا (للمطوّرين)

المتطلبات: Node.js 22+، pnpm 10+، PostgreSQL 16 (أو Docker).

```bash
pnpm install
docker compose up -d          # يشغّل PostgreSQL (قاعدة aruma + aruma_test)
cp .env.example .env
# ضع في .env قيمة DATA_ENCRYPTION_KEY من: openssl rand -base64 32
export $(grep -v '^#' .env | xargs)

pnpm db:migrate               # إنشاء الجداول
pnpm db:seed                  # بيانات MB Parfum التجريبية
pnpm dev                      # ARUMA CORE على http://localhost:3000
pnpm dev:merchant             # مركز التاجر على http://localhost:5173
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
