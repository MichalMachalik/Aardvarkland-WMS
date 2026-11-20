# Aardvarkland WMS

Self-hosted warehouse software for receiving, stock control, picking, packing and shipping. The application uses a React frontend, a NestJS API and PostgreSQL.

[Live Preview](https://michalmachalik.github.io/Aardvarkland-WMS/) · [Order guide and interactive database map](https://michalmachalik.github.io/Aardvarkland-WMS/database-schema.html) · [Order walkthrough](https://michalmachalik.github.io/Aardvarkland-WMS/?walkthrough=order&lang=en) · [WMS Mini](https://github.com/MichalMachalik/Aardvarkland-WMS-Mini)

Choose a sample worker, manager or administrator to explore the browser preview. The guided order runs through picking, packing and dispatch with fictional data. Printing, integrations and dispatch are simulated locally.

In the manager preview, open **Cycle counts** to create and release a plan, record a blind count, approve the variance and verify the updated quantity in **Inventory**.

## What it does

- products, warehouses, locations and stock
- receiving, putaway and cycle counts
- allocation, wave picking, packing and shipping
- worker, manager and administrator roles
- keyboard, camera and RF barcode workflows
- label templates, print queues and a local ZPL print agent
- alerts, incidents, analytics and audit exports
- Czech, English, Ukrainian, French, German and Spanish UI

## Run with Docker

Requires Docker Desktop with Compose.

```bash
git clone https://github.com/MichalMachalik/Aardvarkland-WMS.git
cd Aardvarkland-WMS
docker compose up --build
```

- Frontend: `http://localhost:4000`
- API: `http://localhost:4001/api`

The first start applies the database migrations and creates a local administrator account:

- Email: `admin@example.com`
- Password: `Local-Seed-42!`

Change `ADMIN_INITIAL_PASSWORD`, `POSTGRES_PASSWORD` and the application secrets before using WMS outside local development.

## Local development

Requires Node.js 24.15+ and PostgreSQL 18.
Copy `backend/.env.example` to `backend/.env` and set `DATABASE_URL` before running the database commands.

```bash
cd backend
npm ci
npm run prisma:generate
npm run prisma:deploy
npm run db:seed
npm run start:dev
```

In another terminal:

```bash
cd frontend
npm ci
npm run dev
```

Replace all development placeholders before using a shared environment. Production options are documented in [`backend/.env.production.example`](backend/.env.production.example).

## Base.com order connector

Set `BASE_COM_API_TOKEN` in the backend environment for the Base.com account connected to this WMS database. Set `BASE_COM_SHIPPED_STATUS_ID` to the account's target order status to enable dispatch updates. The token stays on the server.

In **Integrations → Base.com**, select a warehouse and enter the numeric Base.com order ID. The connector imports one confirmed order with SKUs matched to active WMS products. A repeat import returns the existing order. Once dispatch is complete in WMS, **Send dispatch status** applies the configured status in Base.com. Both actions require integration management permission plus outbound management access to the selected warehouse.

For local testing, set `BASE_COM_API_URL` to a loopback mock and use a test token and fictional orders. The production connector uses [the official Base.com API](https://api.base.com/).

## Checks

To run the published walkthrough on localhost, build the static preview from the repository root and open the [guided order](http://127.0.0.1:4176/?walkthrough=order&lang=en). Picking, packing and dispatch in this build use fictional records in the browser. The server-side Base.com flow uses the NestJS API and PostgreSQL described above.

```sh
node demo/scripts/build-pages-artifact.mjs
python -m http.server 4176 --bind 127.0.0.1 --directory demo/_site
```

Run the application checks after installing the backend and frontend dependencies.

```bash
cd backend && npm run verify
cd ../frontend && npm run typecheck && npm run lint && npm run build && npm test
cd ../print-agent && npm ci && npm run check
```

Scanner and printer checks still need real hardware.

## Repository layout

- `backend/` — API, database schema and tests
- `frontend/` — web application and PWA shell
- `print-agent/` — local ZPL printer bridge
- `demo/` — GitHub Pages preview
- Security reports: [SECURITY.md](SECURITY.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)

## License

[MIT](LICENSE)
