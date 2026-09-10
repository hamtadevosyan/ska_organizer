> **Sign-in is now required (SKAO-20).** After updating an existing checkout, follow
> [authentication setup](docs/authentication.md) to configure the frontend origin,
> run the additive migration and create the first administrator. Preserve your
> existing `.env` and database. Existing curl/API examples now need a session cookie;
> writes also need the CSRF token and allowed Origin described in that guide.

# ska_organizer
📚 Smart Kids Organizer (ska_organizer)

Smart Kids Organizer is a full-stack web application for managing child care operations including:

📊 Dashboard

📦 Inventory

🧒 Attendance

🗓 Activity Planner

🍽 Meal Planner

👩‍🏫 Staff

📑 Reports

Built with:

Frontend: React + Vite + TypeScript + TailwindCSS
Backend: Node.js + Express
API-ready architecture (future mobile app support)

Meal data now uses PostgreSQL. Before starting the backend for the first time,
follow [PostgreSQL setup and restart verification](docs/postgresql-setup.md).
This includes the Ubuntu VMware / Windows Chrome workflow, migrations, optional
sample data and isolated database tests.

The meal planner now saves and reopens separate calendar weeks with headcounts,
stock and historical recipe quantities. See [Saved weekly menus](docs/saved-weekly-menus.md)
for the SKAO-18 update commands, dated API and usage instructions.

🚀 Project Structure
ska_organizer/
│
├── client/        # React frontend (Vite)
├── server/        # Express backend API
├── package.json
└── README.md

🛠 Requirements

Make sure you have installed:
Node.js (v20.19+ required; 22 or 24 supported)
npm (comes with Node)

Check versions:

node -v
npm -v

🔧 Backend Setup (Server)
1️⃣ Go to server folder
cd server
2️⃣ Install dependencies
npm install
3️⃣ Configure PostgreSQL and run `npm run db:migrate` using the guide above.
4️⃣ Start backend server
node index.js

You should see:
Server running on port 3001

Backend will run on:
http://localhost:3001

Example test:
curl http://localhost:3001/api/dashboard

💻 Frontend Setup (Client)
1️⃣ Open new terminal
cd client
2️⃣ Install dependencies
npm install
3️⃣ Create .env file

Inside client/ create:
.env

Add:
VITE_API_BASE_URL=http://localhost:3001

If running from another machine in your network:
VITE_API_BASE_URL=http://YOUR_VM_IP:3001


Example:

VITE_API_BASE_URL=http://192.168.33.132:3001

4️⃣ Start frontend
npm run dev

You will see:
Local:   http://localhost:5173/
Network: http://192.168.xx.xx:5173/


Open in browser:
http://localhost:5173

🌐 Access From Other Devices (Optional)
If running in VM:
Use VM IP (example 192.168.33.132)
Make sure port 3001 and 5173 are allowed
Use:
http://192.168.33.132:5173

📡 API Endpoints (Current)
Dashboard
GET /api/dashboard
Attendance
GET /api/attendance

Inventory
GET /api/inventory
GET /api/inventory/status
GET /api/inventory/items

Schedule
GET /api/schedule

Activity
GET /api/activity
POST /api/activity/generate

📱 Mobile Ready

The backend is designed as a REST API and can be consumed by:
Web frontend (current)
Future mobile app (React Native / Flutter / iOS / Android)
Third-party integrations
All data is served as JSON.

🧪 Development Tips

Restart server after backend changes:
CTRL + C
node index.js

Restart frontend after .env changes:
CTRL + C
npm run dev


Quick start

1. Strat frontend (Client)
cd client
npm install #first time only
npm run dev

2. Backend (Server)
cd server
npm install #first time only
node index.js

3. Open Browser
http://localhost:5173 or http://YOUR_IP:5173
