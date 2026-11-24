# Aardvarkland WMS

[Česká verze](#cesky)

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
- Password: see `ADMIN_INITIAL_PASSWORD` in the [local Compose configuration](docker-compose.yml).

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

---

<a name="cesky"></a>

## Česká verze

Skladový systém pro provoz na vlastním serveru. Pokrývá příjem zboží, evidenci zásob, vychystání, balení a expedici. Webové rozhraní používá React, serverové API NestJS a databáze PostgreSQL.

[Veřejný náhled](https://michalmachalik.github.io/Aardvarkland-WMS/) · [Průvodce objednávkou a mapa databáze](https://michalmachalik.github.io/Aardvarkland-WMS/database-schema.html) · [Vyzkoušet objednávku](https://michalmachalik.github.io/Aardvarkland-WMS/?walkthrough=order&lang=cs) · [WMS Mini](https://github.com/MichalMachalik/Aardvarkland-WMS-Mini)

V prohlížeči si vyberte roli skladníka, vedoucího nebo správce. Průvodce vás provede vychystáním, zabalením a expedicí fiktivní objednávky. Tisk, integrace a odeslání zásilky se v náhledu simulují místně.

V roli vedoucího otevřete průběžné inventury (**Cycle counts**), vytvořte a uvolněte plán, zadejte výsledek počítání bez zobrazení očekávané zásoby a schvalte rozdíl. Nové množství ověříte v přehledu zásob (**Inventory**).

### Funkce

- Produkty, sklady, pozice a stav zásob.
- Příjem, zaskladnění a průběžné inventury.
- Rezervace zásob, vlnové vychystávání, balení a expedice.
- Role skladníka, vedoucího a správce.
- Práce s čárovými kódy pomocí klávesnice, kamery a RF terminálu.
- Šablony štítků, tiskové fronty a místní služba pro tisk ZPL.
- Upozornění, incidenty, analýzy a exporty pro audit.
- Rozhraní v češtině, angličtině, ukrajinštině, francouzštině, němčině a španělštině.

### Spuštění v Dockeru

Potřebujete Docker Desktop s Compose.

```bash
git clone https://github.com/MichalMachalik/Aardvarkland-WMS.git
cd Aardvarkland-WMS
docker compose up --build
```

- Webové rozhraní běží na `http://localhost:4000`.
- API je na `http://localhost:4001/api`.

První spuštění provede databázové migrace a vytvoří místní účet správce `admin@example.com`. Výchozí vývojové heslo najdete v proměnné `ADMIN_INITIAL_PASSWORD` v [místní konfiguraci Compose](docker-compose.yml). Před použitím mimo místní vývoj změňte `ADMIN_INITIAL_PASSWORD`, `POSTGRES_PASSWORD` a tajné hodnoty aplikace.

### Místní vývoj

Vyžaduje Node.js 24.15+ a PostgreSQL 18. Zkopírujte `backend/.env.example` do `backend/.env` a před spuštěním databázových příkazů nastavte `DATABASE_URL`.

```bash
cd backend
npm ci
npm run prisma:generate
npm run prisma:deploy
npm run db:seed
npm run start:dev
```

V dalším terminálu spusťte webové rozhraní.

```bash
cd frontend
npm ci
npm run dev
```

Před nasazením do sdíleného prostředí nahraďte všechny vývojové hodnoty. Produkční nastavení popisuje [vzor konfigurace backendu](backend/.env.production.example).

### Konektor objednávek Base.com

V prostředí backendu nastavte `BASE_COM_API_TOKEN` pro účet Base.com propojený s touto databází WMS. Do `BASE_COM_SHIPPED_STATUS_ID` zadejte ID cílového stavu objednávky, aby šlo odeslat změnu po expedici. Token zůstává na serveru.

V nabídce **Integrations → Base.com** vyberte sklad a zadejte číselné ID objednávky z Base.com. Konektor načte jednu potvrzenou objednávku a podle SKU přiřadí položky k aktivním produktům ve WMS. Při opakovaném importu vrátí existující objednávku. Po dokončení expedice ve WMS nastaví tlačítko **Send dispatch status** objednávce v Base.com zvolený stav. Obě operace vyžadují oprávnění spravovat integrace a výdej z vybraného skladu.

Při místním testu nastavte `BASE_COM_API_URL` na simulované API na místní smyčce a použijte testovací token a fiktivní objednávky. Produkční konektor používá [oficiální API Base.com](https://api.base.com/).

### Ověření

Pro místní ověření zveřejněného průvodce sestavte statický náhled z kořene repozitáře a otevřete [ukázkovou objednávku](http://127.0.0.1:4176/?walkthrough=order&lang=cs). Vychystání, balení a expedice v náhledu používají fiktivní záznamy v prohlížeči. Serverový průchod přes Base.com používá výše popsané API v NestJS a PostgreSQL.

```sh
node demo/scripts/build-pages-artifact.mjs
python -m http.server 4176 --bind 127.0.0.1 --directory demo/_site
```

Po instalaci závislostí backendu a frontendu spusťte kontroly aplikace.

```bash
cd backend && npm run verify
cd ../frontend && npm run typecheck && npm run lint && npm run build && npm test
cd ../print-agent && npm ci && npm run check
```

GitHub Actions navíc spouští aplikaci s testovací PostgreSQL. Testy procházejí obrazovky správce, vedoucího a skladníka na počítači i telefonu. API testy vytvářejí fiktivní objednávky a ověřují příjem, vychystání, balení, expedici i schválení inventurního rozdílu.

Pro opakování použijte samostatnou místní instanci s prázdnou databází, demo uživateli a testovacím dopravcem. Spouštějte z kořene repozitáře po instalaci Playwrightu a Chromia.

```sh
WMS_E2E_WRITE_URL=http://127.0.0.1:4001/api node --test backend/scripts/warehouse-lifecycle.test.mjs
cd demo
WMS_LIVE_UI_URL=http://127.0.0.1:4000/ npm test -- live
```

Samostatná sada v `backend/scripts/api-operations.test.mjs` prochází všechny operace z OpenAPI. Ověřuje autorizaci, parametry, odmítnutí neplatných zápisů a vybrané scénáře včetně uložených změn, opakovaných požadavků a stavů zásob. Spouští vlastní místní API nad připravenou testovací databází. Z adresáře `backend` spusťte po sestavení backendu a naplnění testovací databáze příkaz `node --env-file=.env.example --test scripts/api-operations.test.mjs` s proměnnou `WMS_TEST_DATABASE_URL` nastavenou na tuto databázi.

Čtečky a tiskárny ověřte na fyzickém hardwaru.

### Struktura repozitáře

- `backend/` — API, schéma databáze a testy
- `frontend/` — webová aplikace a základ PWA
- `print-agent/` — místní služba pro tiskárny ZPL
- `demo/` — náhled pro GitHub Pages
- [Hlášení bezpečnostních problémů](SECURITY.md)
- [Jak přispět](CONTRIBUTING.md)

### Licence

[MIT](LICENSE)
