# Smart Goods backend

Small Node.js 24 / Express API for the existing Global Electronic Store. Postgress Auth authenticates administrators; the existing `public.users` table holds a separate `store_admin` permission. `public.product` contains added products, `public.analytic` contains visit records, and the public Storage bucket is `product`. The original 190 frontend products remain in the frontend repository.

## Local setup

1. Install Node.js **24 LTS** and run `npm ci` in this folder.
2. Copy `.env.example` to `.env` if you do not already have one. Set `Postgress_URL`, `Postgress_ANON_KEY` and `Postgress_SERVICE_ROLE_KEY`. Do not overwrite your existing secrets. No custom JWT secret is needed; Postgress verifies and rotates its own tokens.
3. Run `Postgress/migrations/202610290001_store_admin.sql` in the existing project's Postgress SQL Editor. It adds dedicated product/analytics tables and store-admin fields, retains existing data, and keeps public image downloads available. If `product` or `analytic` already exists with a different schema, review it before applying; `CREATE TABLE IF NOT EXISTS` does not upgrade an unrelated table's columns.
4. Create an email/password user in **Postgress → Authentication → Users**. Run `npm run admin`, enter that existing Auth email, and sign in at the frontend's `/admin/login`. The requested initial account was created during implementation; its password is not stored in source or documentation.
5. Run `npm run check:config` and `npm run dev`. Health: `http://localhost:4000/health`.
6. Set `VITE_API_URL=http://localhost:4000` in the sibling frontend `.env` and run its dev server.

The provided migration supports both a new `users` table and the existing table in this project (including its required email/name/password_hash columns). Postgress Auth manages passwords. The existing application's `password_hash` field gets a non-password sentinel for this new store-only account; other accounts are untouched. `store_admin` does not promote the user's role in another application. Both `disabled=true` and `is_active=false` block store access on the next request. Never let a public client write `store_admin`; the migration adds a trigger to prevent that even with existing permissive policies. For a table named `user`, adapt the migration's `public.users` references and set `Postgress_USERS_TABLE=user`.

## Render deployment

The `render.yaml` Blueprint is ready for a free Node web service. It installs with `npm ci --omit=dev`, starts with `npm start`, uses Node 24, binds `0.0.0.0:$PORT`, and checks `/health`. No local disk or SQLite state is used. The Postgress database and Storage remain persistent when Render sleeps or restarts.

Hosting references: [Render free-service behavior](https://render.com/docs/free), [Render health checks](https://render.com/docs/health-checks), and [Postgress public buckets](https://Postgress.com/docs/guides/storage/buckets/fundamentals).

For this backend as its **own Git repository**, connect that repository to Render and use the Blueprint at its root. Alternatively create a Web Service manually: runtime Node, build `npm ci --omit=dev`, start `npm start`, health `/health`, plan Free. If deploying from a parent monorepo, set the service's Root Directory to `smart-goods-backend` and select this Blueprint there, or set `rootDir: smart-goods-backend` in a parent Blueprint. Do not use that root directory for the standalone backend repository.

Set these environment values in Render (do not upload `.env`):

| Setting | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `24` |
| `TRUST_PROXY` | `1` (Render's proxy; local default is `0`) |
| `FRONTEND_ORIGINS` | Exact production frontend origin, e.g. `https://store.example.com`; comma-separate multiple trusted origins, with no trailing slash or wildcard |
| `Postgress_URL` | Existing Postgress project URL |
| `Postgress_ANON_KEY` | Existing anon/publishable key |
| `Postgress_SERVICE_ROLE_KEY` | Backend service_role/secret key |
| `Postgress_STORAGE_BUCKET` | `product` |
| `Postgress_USERS_TABLE` | `users` |
| `ANALYTICS_RETENTION_DAYS` | `90` |

After the backend is healthy, set **`VITE_API_URL=https://YOUR_SERVICE.onrender.com` on the frontend host and rebuild/redeploy the frontend**. Never put service-role or JWT secrets into `VITE_*` variables. Preserve the frontend SPA rewrite so `/admin`, product URLs and other routes work on refresh. Add every real frontend origin to the backend CORS setting; preview domains are not automatically trusted.

Render free services sleep after inactivity. The frontend waits up to three minutes for a safe health/catalog read, retries transient startup failures, then sends login or another mutation once with a 30-second request timeout. Admins see an explanation after eight seconds. Shoppers immediately see the bundled catalog and cached additional products, with a loading indicator while more arrive. Shopping never requires an account. No scheduled pings are used to defeat sleep.

## API and behavior

- Public: `GET /health`, `GET /api/products?page=1&pageSize=100`, `POST /api/analytics` (explicit consent required). Public product results exclude hidden products and private admin fields.
- Auth: `POST /api/auth/login`, `POST /api/auth/refresh`, `GET /api/auth/me`, `POST /api/auth/logout`. Access/refresh tokens stay in the admin tab's session storage. Every private request verifies the Postgress token **and** the current database permission.
- Admin: paginated `GET`, `POST`, `PUT /:id`, `DELETE /:id`, and confirmed `DELETE` collection under `/api/admin/products`. `POST /api/admin/images` accepts a single `image` multipart upload. It validates and re-encodes images into WebP and writes only under `product/admin/YYYY/MM/`.
- Visits: paginated `GET /api/admin/analytics`, `PATCH /:id` for notes, `DELETE /:id`, confirmed `DELETE` collection. Captured facts stay immutable; admin notes are editable. Search covers page, city, country, device, browser and notes.
- Product name, category and nonnegative SAR price are required. Description, brand, availability, options, specifications and images are optional. Up to ten images, 10 MB / 40 megapixels each; first image is the cover. The editor offers full-image fitting or aspect-ratio cropping and an exact upload preview. Public cards and gallery use `object-fit: contain`.
- Removing a product/image unlinks it from the catalog. Uploaded Storage objects are retained to avoid breaking shared URLs; unused files can be removed separately in Postgress Storage. Other objects already in the bucket are untouched.

## Analytics boundaries

Analytics record consented page visits, server IP, approximate country/city from a local GeoIP database, browser/OS/device details, exposed model (when present), screen size, language, timezone and referring **origin**. Query strings and fragments are excluded. No phone number, identity, precise GPS, account registration or hidden device identifiers are obtained. Private admin pages are excluded, and Do Not Track / Global Privacy Control are respected. The dashboard shows full paginated visit records; many visits from the same session are expected. IP location can be unavailable or reflect a VPN/network provider. Each event UUID is idempotent.

Rows older than the configured retention are purged at most once an hour when a new visit arrives, including after a Render wake-up. Old rows can remain physically stored during inactivity until the next request. Admins can delete or clear them earlier. GeoIP uses the bundled `geoip-lite` database (MaxMind GeoLite attribution: https://www.maxmind.com); update the dependency/database periodically. No external geolocation service receives visitor IP addresses.

## Validation and scaling

`npm test` runs API/security/validation tests without network credentials. `npm run check:config` checks real table/bucket access. `npm run test:live` needs temporary `SMOKE_ADMIN_EMAIL` and `SMOKE_ADMIN_PASSWORD` environment variables; it creates uniquely tagged temporary records/images, checks live Auth/CRUD/storage/analytics/session refresh, and removes only those exact test IDs/objects. Do not persist those login variables in source.

Config, Postgress clients, auth enforcement, validation, analytics enrichment and application startup live in separate modules. Tables have pagination indexes; the public catalog is loaded in pages beyond Postgress's 1,000-row default. Split routes into routers/services as features grow. Rate limits currently use process memory, appropriate for one free instance; move them to a shared store when scaling to multiple instances. Render deployment and actual sleeping-service/browser/device behavior require independent checks after deployment.
# smart-goods-backend
