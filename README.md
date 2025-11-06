# IAQ AI Monitoring Dashboard

End-to-end local-first IAQ dashboard with live sensing (ESP32), SQLite backend (Node/Express), and a React/Vite frontend. Includes a Gemini-backed chatbot for explanations.

## Structure

- `server/` — Node.js + Express + SQLite (SSE stream, /data, /history, /latest, /export.csv, /chat proxy)
- `client/` — React + Vite dashboard (live chart, right sidebar, Gemini chatbot)

## Prerequisites

- Node.js 18+
- npm
- A Google Gemini API key (for the optional chatbot)

## Setup

1. Install deps
   - Server:
     - `cd server`
     - `npm install`
   - Client:
     - `cd ../client`
     - `npm install`

2. Configure environment (server)
   - Copy `server/.env.example` to `server/.env` and set:
     - `GEMINI_API_KEY=your_key_here`
     - `# Optional: GEMINI_MODEL=gemini-2.5-flash`

## Development

- Start the server:
  - `cd server`
  - `npm start`
- Start the client (dev):
  - `cd ../client`
  - `npm run dev`

The client will proxy API requests to the server in dev (see `vite.config.js`).

## Production build (optional)

- `cd client && npm run build`
- The server can serve the built files from `client/dist` when present.

## Data ingestion

ESP32 posts JSON to `POST /data` with fields:
- `pm25`, `voc`, `c2h5oh`, `co` (numbers, required)
- `current_iaq` (number, optional but recommended)
- `predicted_iaq` (number, optional; if missing, server falls back to `current_iaq`)

## Export

- Download all data as CSV: `GET /export.csv`

## Chat

- `POST /chat` proxies to Gemini using the server’s `GEMINI_API_KEY`.
- `GET /models` lists available models for debugging.

## Notes

- Make sure `.env` and `server/iaq.db` are excluded from git (see `.gitignore`).
- Dashboard includes a dark mode toggle.
