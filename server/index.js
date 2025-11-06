import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import sqlite3 from "sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash-latest"; // override if needed

async function getFetch() {
  if (typeof fetch === "function") return fetch;
  const mod = await import("node-fetch");
  return mod.default;
}

// CORS: allow ESP32 to POST from LAN and dev frontends
app.use(cors());
app.use(express.json());

// ----- SQLite setup -----
sqlite3.verbose();
const db = new sqlite3.Database(path.join(__dirname, "iaq.db"));

db.serialize(() => {
  // Base table (keeps predicted_iaq NOT NULL to avoid complex migrations)
  db.run(`CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    pm25 REAL NOT NULL,
    voc REAL NOT NULL,
    c2h5oh REAL NOT NULL,
    co REAL NOT NULL,
    predicted_iaq REAL NOT NULL
  );`);

  // Add current_iaq if missing (ignore duplicate-column error)
  db.run(`ALTER TABLE readings ADD COLUMN current_iaq REAL`, (err) => {
    if (err) {
      if (!/(duplicate column|already exists|duplicate column name)/i.test(err.message)) {
        console.warn("[DB] Failed to add current_iaq column:", err.message);
      }
    } else {
      console.log("[DB] Added current_iaq column.");
    }
  });
});

// ----- SSE (Server-Sent Events) -----
const sseClients = new Set();
app.get("/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*"
  });
  res.flushHeaders();
  // Named event (client listens on default 'message', so this is just a keepalive)
  res.write(`event: ping\ndata: "ok"\n\n`);
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

function broadcast(dataObj) {
  const payload = `data: ${JSON.stringify(dataObj)}\n\n`;
  for (const client of sseClients) client.write(payload);
}

// ----- API: ESP32 posts here -----
app.post("/data", (req, res) => {
  // Expected JSON from ESP32:
  // { ts?, pm25, voc, c2h5oh, co, current_iaq, predicted_iaq? }
  const now = Math.floor(Date.now() / 1000);
  const {
    ts = now,
    pm25,
    voc,
    c2h5oh,
    co,
    predicted_iaq,
    current_iaq
  } = req.body || {};

  // Validate sensors
  const sensorsOk = [pm25, voc, c2h5oh, co].every(
    (x) => typeof x === "number" && isFinite(x)
  );
  if (!sensorsOk) {
    return res.status(400).json({ ok: false, error: "Invalid numeric sensor fields" });
  }

  // Choose value for NOT NULL predicted_iaq column
  let predToStore = null;
  if (typeof predicted_iaq === "number" && isFinite(predicted_iaq)) {
    predToStore = predicted_iaq;
  } else if (typeof current_iaq === "number" && isFinite(current_iaq)) {
    predToStore = current_iaq; // fallback keeps schema happy
  }

  if (predToStore === null) {
    return res.status(400).json({ ok: false, error: "Missing predicted_iaq and no valid current_iaq fallback" });
  }

  const stmt = db.prepare(
    "INSERT INTO readings (ts, pm25, voc, c2h5oh, co, predicted_iaq, current_iaq) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  stmt.run(
    ts, pm25, voc, c2h5oh, co, predToStore,
    (typeof current_iaq === "number" && isFinite(current_iaq)) ? current_iaq : null,
    function (err) {
      if (err) return res.status(500).json({ ok: false, error: err.message });

      const row = {
        id: this.lastID,
        ts, pm25, voc, c2h5oh, co,
        predicted_iaq: predToStore,
        current_iaq: (typeof current_iaq === "number" && isFinite(current_iaq)) ? current_iaq : null
      };
      broadcast(row);
      res.json({ ok: true, id: this.lastID });
    }
  );
});

// ----- API: latest & history -----
app.get("/latest", (req, res) => {
  db.get(
    "SELECT * FROM readings ORDER BY ts DESC, id DESC LIMIT 1",
    (err, row) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true, data: row || null });
    }
  );
});

app.get("/history", (req, res) => {
  const n = parseInt(req.query.limit || "500", 10);
  const limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), 5000) : 500;
  db.all(
    "SELECT * FROM readings ORDER BY ts DESC, id DESC LIMIT ?",
    [limit],
    (err, rows) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true, data: rows.reverse() }); // chronological
    }
  );
});

// ----- AI Chat endpoint (Gemini proxy) -----
app.post("/chat", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ ok: false, error: "Missing GEMINI_API_KEY" });
    }
    const { question, recentData = [], latest = null } = req.body || {};
    if (!question || typeof question !== "string") {
      return res.status(400).json({ ok: false, error: "Missing question" });
    }
    console.log(`[chat] Q: ${question.slice(0, 120)}${question.length > 120 ? "…" : ""}`);

    // Compact context
    const tail = (Array.isArray(recentData) ? recentData : []).slice(-16);

    function trend(values) {
      if (!values || values.length < 4) return "insufficient";
      const first = values[0];
      const last = values[values.length - 1];
      const delta = last - first;
      const mag = Math.abs(delta);
      const base = Math.max(1, Math.abs(first));
      const rel = mag / base;
      if (mag < 0.01) return "steady";
      if (rel < 0.05) return delta > 0 ? "slightly rising" : "slightly falling";
      return delta > 0 ? "rising" : "falling";
    }

    const pm25Trend = trend(tail.map((r) => Number(r.pm25)));
    const vocTrend = trend(tail.map((r) => Number(r.voc)));
    const etohTrend = trend(tail.map((r) => Number(r.c2h5oh)));
    const coTrend = trend(tail.map((r) => Number(r.co)));
    const iaqTrend = trend(tail.map((r) => Number(r.predicted_iaq)));
    const trendSummary = `PM2.5: ${pm25Trend}; VoC: ${vocTrend}; Ethanol: ${etohTrend}; CO: ${coTrend}; Pred. IAQ: ${iaqTrend}.`;

    const context = {
      latest,
      recentSummary: tail.map((r) => ({
        ts: r.ts,
        pm25: r.pm25,
        voc: r.voc,
        c2h5oh: r.c2h5oh,
        co: r.co,
        predicted_iaq: r.predicted_iaq,
        current_iaq: r.current_iaq,
      })),
      trendSummary,
    };

    const prompt = `You are an expert assistant for an Indoor Environmental Quality (IEQ) dashboard.
The device is an ESP32 with sensors: PM2.5, MQ-135 (VoC), MQ-3 (ethanol proxy), MQ-7 (CO). It also predicts an IAQ index 5 minutes ahead using a TinyML 1D-CNN.
Answer clearly and concisely for non-technical users. If safety is relevant, include actionable advice.

User question: "${question}"

Latest reading and recent trend (JSON):\n${JSON.stringify(context, null, 2)}\n`;

    const modelsToTry = Array.from(
      new Set([
        GEMINI_MODEL,
        "gemini-2.5-flash",
        "gemini-2.0-flash",
        "gemini-1.5-flash-latest",
      ])
    );
    const doFetch = await getFetch();

    let lastError = null;
    for (const model of modelsToTry) {
      const url = `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(
        model
      )}:generateContent?key=${GEMINI_API_KEY}`;
      try {
        console.log(`[chat] trying model: ${model}`);
        const resp = await doFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.4, topP: 0.9, maxOutputTokens: 512 },
          }),
        });
        const data = await resp.json();
        if (!resp.ok || data?.error) {
          const message = data?.error?.message || `Upstream error (status ${resp.status})`;
          lastError = message;
          console.warn(`[chat] model ${model} error: ${message}`);
          if (/not found|unsupported|unavailable|unrecognized/i.test(String(message)) || resp.status === 404) {
            continue;
          }
          return res.status(502).json({ ok: false, error: message });
        }

        const blockedReason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
        if (blockedReason && String(blockedReason).toUpperCase().includes("SAFETY")) {
          return res.status(200).json({
            ok: false,
            error: `Response blocked by safety filter (${blockedReason}). Try rephrasing the question.`,
          });
        }

        let answer = "";
        const parts = data?.candidates?.[0]?.content?.parts || [];
        for (const p of parts) if (typeof p.text === "string") answer += p.text;
        if (!answer.trim()) {
          lastError = "Empty response from model";
          console.warn(`[chat] model ${model} returned empty text; trying next`);
          continue;
        }
        console.log(`[chat] answered with model: ${model}`);
        return res.json({ ok: true, answer });
      } catch (e) {
        lastError = e.message;
        console.warn(`[chat] model ${model} exception: ${e.message}`);
        continue;
      }
    }

    return res.status(502).json({ ok: false, error: lastError || "No model produced a response" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ----- Data export as CSV -----
app.get("/export.csv", (req, res) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=iaq_export.csv");
  res.write("id,ts,pm25,voc,c2h5oh,co,predicted_iaq,current_iaq\n");

  let firstError = null;
  db.each(
    "SELECT id, ts, pm25, voc, c2h5oh, co, predicted_iaq, current_iaq FROM readings ORDER BY ts ASC",
    (err, row) => {
      if (err) {
        firstError = err;
        return;
      }
      const vals = [
        row.id, row.ts, row.pm25, row.voc, row.c2h5oh, row.co, row.predicted_iaq, row.current_iaq
      ].map((v) => (v === null || v === undefined ? "" : String(v)));
      res.write(vals.join(",") + "\n");
    },
    (err) => {
      if (err || firstError) {
        if (!res.headersSent) res.status(500);
        res.end(`# Error exporting CSV: ${(err || firstError).message}`);
      } else {
        res.end();
      }
    }
  );
});

// ----- Serve built frontend (after you build client) -----
const staticDir = path.join(__dirname, "../client/dist");
if (fs.existsSync(staticDir) && fs.existsSync(path.join(staticDir, "index.html"))) {
  app.use(express.static(staticDir));
  app.get("*", (req, res) => res.sendFile(path.join(staticDir, "index.html")));
} else {
  console.warn("[server] client/dist not found; skipping static file serving.");
}

// Optional: list available models (debug)
app.get("/models", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) return res.status(500).json({ ok: false, error: "Missing GEMINI_API_KEY" });
    const doFetch = await getFetch();
    const url = `https://generativelanguage.googleapis.com/v1/models?key=${GEMINI_API_KEY}`;
    const resp = await doFetch(url);
    const data = await resp.json();
    if (!resp.ok || data?.error) {
      const message = data?.error?.message || `Upstream error (status ${resp.status})`;
      return res.status(502).json({ ok: false, error: message });
    }
    res.json({ ok: true, models: data.models || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
  console.log(`POST data to http://<your-ip>:${PORT}/data`);
});
