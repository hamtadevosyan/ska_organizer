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

🚀 Project Structure
ska_organizer/
│
├── client/        # React frontend (Vite)
├── server/        # Express backend API
├── package.json
└── README.md

🛠 Requirements

Make sure you have installed:
Node.js (v18+ recommended)
npm (comes with Node)

Check versions:

node -v
npm -v

🔧 Backend Setup (Server)
1️⃣ Go to server folder
cd server
2️⃣ Install dependencies
npm install
3️⃣ Start backend server
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
