# PostgreSQL setup and restart verification (SKAO-17)

The server now stores meals, ingredients, recipe links, the current confirmed menu,
and the latest shelf check in PostgreSQL. Draft shopping calculations still work
without saving the menu. A server or database restart preserves committed records.

This guide uses your Ubuntu VMware VM and repository at
`~/workspace/ska_organizer`. Chrome continues to run on Windows.

## 1. Install PostgreSQL once in Ubuntu

Use Node.js 20.19 or newer (Node 22 or 24 is suitable):

```bash
node --version
sudo apt update
sudo apt install postgresql
sudo systemctl enable --now postgresql
```

Create the application role and two separate databases. Skip creation for names
that you have already created; do not delete an existing database to repeat setup.

```bash
sudo -u postgres createuser --pwprompt ska_app
sudo -u postgres createdb --owner=ska_app ska_organizer
sudo -u postgres createdb --owner=ska_app ska_organizer_test
```

The password prompt belongs to the new `ska_app` database role. Keep that password
for the next step. It is separate from your Ubuntu login password.

## 2. Configure the server once

```bash
cd ~/workspace/ska_organizer/server
npm ci
cp -n .env.example .env
nano .env
```

Set the two URLs using your database role password:

```dotenv
DB_ADAPTER=sequelize
DATABASE_URL=postgresql://ska_app:YOUR_PASSWORD@127.0.0.1:5432/ska_organizer
TEST_DATABASE_URL=postgresql://ska_app:YOUR_PASSWORD@127.0.0.1:5432/ska_organizer_test
PORT=3001
NODE_ENV=development
```

URL-encode special characters in the password (`@` becomes `%40`, for example).
Do not commit `.env` or paste credentials into Jira or chat. `cp -n` preserves an
existing `.env`; add the missing settings when editing it. Existing shell
environment variables take precedence over `.env`.

`127.0.0.1` is correct here because Node and PostgreSQL both run inside Ubuntu.
Your existing **client** `.env` still uses the VM network IP for Windows Chrome.

## 3. Create the tables

```bash
npm run db:migrate
```

This applies registered, numbered migrations from `server/database/migrations/`
and records their names in `SequelizeMeta`. Run the same command after an update
that includes new migrations. Repeating it does not clear data. Startup requires
all registered migrations to have been applied; it never runs `sync({ force: true })`
or changes table structures automatically. The older templates in
`server/migrations/` are not used by this command.

For a fresh development database, optional example meals and recipes are available:

```bash
npm run db:seed
```

Seeding is explicit, disabled in production, and skipped if any meal-domain
records already exist. Startup never inserts example data. Example ingredient
quantities are test fixtures, not a production menu specification.

The previous mock adapter kept data only in Node memory. This change cannot
recover data already lost from a stopped mock server and does not import a running
mock server automatically. Record any examples you need before stopping that old
server, then recreate them through Meal Setup. Existing PostgreSQL records are
preserved by repeat migrations.

## 4. Normal startup stays the same

First Ubuntu terminal:

```bash
cd ~/workspace/ska_organizer/client
npm run dev
```

Second Ubuntu terminal:

```bash
cd ~/workspace/ska_organizer/server
node index.js
```

The server should report `PostgreSQL storage initialized` before
`Server running on port 3001`. In Windows Chrome, open the **Network** address
printed by Vite. Keep both terminals open; `Ctrl+C` stops each process.

Missing configuration, an unavailable database or unapplied migrations prevents
the server from listening. There is no automatic fallback to memory storage.

## 5. Run the acceptance checks

Run from `server/`:

```bash
npm test
npm run test:postgres
```

The first command uses the mock adapter in Jest unless you explicitly override
`DB_ADAPTER` in the shell. Jest does not load your development `.env`.
The second loads `TEST_DATABASE_URL`, requires a database name ending in `_test`,
and runs the API suite plus persistence checks. Each suite creates and cleans up
its own random test schema. Neither command resets the application database.

For the database-and-Node restart check, use the separate test database:

```bash
npm run test:restart:prepare
sudo systemctl restart postgresql
npm run test:restart:verify
```

Prepare creates fixtures through the API in a new Node process, saves their exact
IDs and values to a local checkpoint, and closes the process and connections.
After you restart PostgreSQL, verify starts another Node process and compares all
records plus shopping calculations. Success removes only that check's random
test schema and checkpoint. A failed comparison preserves them for inspection.
The script does not restart the database for you. Run this during development
because the service restart also briefly disconnects your running application.

The GitHub **Server persistence tests** workflow runs the mock suite, PostgreSQL
suite and an actual PostgreSQL container restart on pushes to the SKAO-17 feature
branch, relevant pull requests and `development` updates.

## 6. Check it in the application

1. Start the server in PostgreSQL mode and open the app in Windows Chrome.
2. Add a meal and ingredient in Meal Setup; link the ingredient to its recipe.
3. Generate a weekly menu, select the saved meal and choose **Save Menu**.
4. Stop Node with `Ctrl+C`, restart PostgreSQL, then run `node index.js` again.
5. Confirm the meal, ingredient and recipe still appear in Meal Setup.
6. Open `http://YOUR_VM_IP:3001/api/menu/current` to inspect the saved menu.

SKAO-17 persists the current server menu and shelf-check API data. The planner's
automatic loading of a saved plan, dates and saved headcounts is **SKAO-18**.
Unsaved browser drafts and the planner's unsaved “in house” inputs are not
automatically persisted by this story. The restart acceptance script explicitly
saves shelf quantities through `/api/shelf/check`. Dashboard, inventory and other
prototype modules still have mock-backed services; this is the meal persistence
foundation, not completion of those later stories.

## Troubleshooting

- **Connection failed:** check `sudo systemctl status postgresql`, the role
  password and the server URLs. For a direct check, run
  `psql -h 127.0.0.1 -U ska_app -d ska_organizer` and enter the password at its prompt.
- **Migrations missing/pending:** stop Node, run `npm run db:migrate`, then start
  Node again. Back up operational databases before applying future migrations.
- **No meals available:** a fresh database is empty. Add meals through Meal Setup
  or run the optional seed while the meal tables are empty.
- **Restart checkpoint already exists:** continue with
  `npm run test:restart:verify` against the same test database. Do not delete the
  application database to resolve a test failure.
- **Temporary memory-only development:** explicitly start
  `DB_ADAPTER=mock node index.js`. Its records disappear on restart; production
  rejects this mode.

PostgreSQL installation reference:
[official Ubuntu packages](https://www.postgresql.org/download/linux/ubuntu/).
