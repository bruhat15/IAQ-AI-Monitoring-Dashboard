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

  // --- Ensure profiles table exists (ADD near DB init) ---
  db.run(`CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_name TEXT,
    members_json TEXT,       -- JSON array of { name, relation, age, conditions:[], notes }
    preferences_json TEXT,   -- JSON like { shareWithGemini: true, receiveNotifications: true }
    updated_ts INTEGER
  )`);
});

// ---------------------------------------------------------------------------
// DISPLAY OVERRIDE HOOKS
// We want to SHOW predicted_iaq reduced by 100 *to the frontend* while keeping
// the raw value as stored from the ESP32 in the database for integrity.
// ---------------------------------------------------------------------------
function adjustForFrontend(row) {
  if (!row || typeof row !== "object") return row;
  const out = { ...row };
  if (typeof out.predicted_iaq === "number" && isFinite(out.predicted_iaq)) {
    out.predicted_iaq = out.predicted_iaq - 180; // <-- hardcoded display tweak
  }
  return out;
}

// ----- SSE (Server-Sent Events) -----
const sseClients = new Set();
app.get("/stream", (req, res) => {
  console.log("[SSE] New client connected, total clients:", sseClients.size + 1);
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
  req.on("close", () => {
    sseClients.delete(res);
    console.log("[SSE] Client disconnected, remaining:", sseClients.size);
  });
});

function broadcast(dataObj) {
  const payload = `data: ${JSON.stringify(dataObj)}\n\n`;
  console.log(`[SSE] Broadcasting to ${sseClients.size} clients:`, JSON.stringify(dataObj).slice(0, 100));
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (e) {
      console.warn("[SSE] Write error, removing client:", e.message);
      sseClients.delete(client);
    }
  }
}

// ----- Profiles helpers -----
// Helper: fetch latest profile
function getProfile(callback) {
  db.get("SELECT * FROM profiles ORDER BY updated_ts DESC LIMIT 1", (err, row) => {
    if (err || !row) return callback(null);
    try {
      callback({
        id: row.id,
        owner_name: row.owner_name,
        members: JSON.parse(row.members_json || "[]"),
        preferences: JSON.parse(row.preferences_json || "{}"),
        updated_ts: row.updated_ts,
      });
    } catch (e) {
      callback(null);
    }
  });
}

function buildProfileSummary(profile) {
  if (!profile) return "";
  const parts = [];
  if (profile.owner_name) parts.push(`Household owner: ${profile.owner_name}`);
  const members = (profile.members || []).map((m) => {
    const cond = (m.conditions || []).length ? `conditions: ${m.conditions.join(", ")}` : "";
    return `${m.relation || "Member"} ${m.name || ""} (age: ${m.age || "?"}) ${cond}`.trim();
  });
  if (members.length) parts.push(`Members: ${members.join(" | ")}`);
  const prefs = profile.preferences || {};
  if (prefs.receiveNotifications === false) parts.push(`Notifications: OFF`);
  return parts.join(". ");
}

function personalizeTextForProfile(text, profile) {
  if (!profile) return text;
  const members = profile.members || [];
  const hasRespiratory = members.some((m) => (m.conditions || []).some((c) => /asthma|copd|bronch/i.test(c)));
  if (hasRespiratory) {
    text +=
      " Note: Because someone in your home has a respiratory condition, prioritize protective steps and consult a healthcare provider if symptoms occur.";
  }
  const hasElder = members.some((m) => Number(m.age) >= 60);
  if (hasElder)
    text +=
      " Also, keep elderly family members out of exposure and seek medical help for dizziness or breathing difficulty.";
  return text;
}

// Simple server-side context analysis and advice for lifestyle fallback
function analyzeLifestyleContext(latest, recent) {
  const ctx = {
    latest,
    recentCount: (recent || []).length,
    peaks: {},
    categories: {},
  };
  if (!latest) return ctx;
  const pm = Number(latest.pm25);
  const voc = Number(latest.voc);
  const etoh = Number(latest.c2h5oh);
  const co = Number(latest.co);
  const iaq = Number(latest.predicted_iaq);

  ctx.categories.iaq = iaq >= 300 ? "hazardous" : iaq >= 200 ? "very-unhealthy" : iaq >= 150 ? "unhealthy" : iaq >= 100 ? "usg" : iaq >= 50 ? "moderate" : "good";
  ctx.categories.pm25 = pm > 100 ? "high" : pm > 50 ? "elevated" : "ok";
  ctx.categories.voc = voc > 600 ? "high" : voc > 300 ? "elevated" : "ok";
  ctx.categories.etoh = etoh > 500 ? "high" : etoh > 200 ? "elevated" : "ok";
  ctx.categories.co = co > 20 ? "high" : co > 9 ? "elevated" : "ok";
  return ctx;
}

function getResearchBasedAdvice(latest, ctx) {
  // Minimal, cautious, non-diagnostic tips
  const lines = [];
  const items = [];
  const iaq = Number(latest?.predicted_iaq);
  if (Number.isFinite(iaq)) {
    if (iaq >= 300) {
      lines.push("Emergency: Move to fresh air if feeling unwell. Increase ventilation immediately (open windows, use exhaust fans). Avoid sources like cooking or solvents.");
    } else if (iaq >= 200) {
      lines.push("Air quality is very unhealthy. Ventilate now, pause activities that emit fumes, and consider wearing a well-fitted mask while ventilating.");
    } else if (iaq >= 150) {
      lines.push("Air quality is unhealthy. Open windows, run kitchen/bath exhaust, and reduce indoor emission sources for the next hour.");
    } else if (iaq >= 100) {
      lines.push("Air quality may affect sensitive individuals. Ventilate and avoid strong cleaners or aerosols for a while.");
    } else {
      lines.push("Air quality looks acceptable. Keep light ventilation and monitor for changes.");
    }
  }
  if (ctx?.categories?.pm25 === "high") items.push("Reduce dust and cooking smoke; use exhaust hoods during cooking.");
  if (ctx?.categories?.voc !== "ok") items.push("Minimize VOC sources (paints, cleaners, aerosols); ventilate during and after use.");
  if (ctx?.categories?.co !== "ok") items.push("Ensure no combustion sources indoors; ventilate and step outside if headaches or dizziness occur.");
  return { primary: lines[0] || "Maintain light ventilation and monitor.", tips: items.slice(0, 3) };
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

  // Choose value for NOT NULL predicted_iaq column (store RAW as sent by device)
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

      const storedRow = {
        id: this.lastID,
        ts, pm25, voc, c2h5oh, co,
        predicted_iaq: predToStore,
        current_iaq: (typeof current_iaq === "number" && isFinite(current_iaq)) ? current_iaq : null
      };

      // IMPORTANT: Broadcast the *adjusted* value to frontend consumers
      broadcast(adjustForFrontend(storedRow));

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
      // Return the *adjusted* view to the frontend
      res.json({ ok: true, data: row ? adjustForFrontend(row) : null });
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
      // Chronological order + adjusted view for the frontend
      const chronological = (rows || []).reverse().map(adjustForFrontend);
      res.json({ ok: true, data: chronological });
    }
  );
});

// ----- Profile CRUD endpoints -----
// GET /profile
app.get("/profile", (req, res) => {
  getProfile((profile) => res.json({ ok: true, profile }));
});

// POST /profile (insert new record; history preserved)
app.post("/profile", express.json(), (req, res) => {
  const body = req.body || {};
  const owner_name = String(body.owner_name || "").slice(0, 128);
  const members = Array.isArray(body.members) ? body.members : [];
  const preferences = typeof body.preferences === "object" && body.preferences ? body.preferences : {};
  const now = Date.now();
  const members_json = JSON.stringify(members);
  const preferences_json = JSON.stringify(preferences);
  db.run(
    "INSERT INTO profiles (owner_name, members_json, preferences_json, updated_ts) VALUES (?, ?, ?, ?)",
    [owner_name, members_json, preferences_json, now],
    function (err) {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      return res.json({ ok: true, id: this.lastID, owner_name, members, preferences, updated_ts: now });
    }
  );
});

// DELETE /profile (remove all)
app.delete("/profile", (req, res) => {
  db.run("DELETE FROM profiles", (err) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json({ ok: true, deleted: true });
  });
});

// ----- AI Chat endpoint (Gemini proxy) -----
app.post("/chat", async (req, res) => {
  try {
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

    // Load profile and decide privacy
    getProfile(async (profile) => {
      const profileSummary = profile ? buildProfileSummary(profile) : "";
      const shareWithGemini = !!(profile?.preferences?.shareWithGemini && GEMINI_API_KEY);

      // If not sharing or no key, do local fallback answer
      if (!shareWithGemini) {
        const ctx = analyzeLifestyleContext(latest, tail);
        const adviceObj = getResearchBasedAdvice(latest, ctx);
        let answer = `Here’s what I see. ${ctx.categories?.iaq ? `Projected IAQ is ${ctx.categories.iaq}.` : ""} ${adviceObj.primary}`.trim();
        if (adviceObj.tips?.length) answer += `\n\nOther tips:\n- ${adviceObj.tips.join("\n- ")}`;
        answer = personalizeTextForProfile(answer, profile);
        return res.json({
          ok: true,
          answer: `${answer}\n\nThis is educational guidance, not medical advice. If symptoms occur, seek professional care.`,
          meta: {
            usedGemini: false,
            personalized: !!profile,
            profileSummary: profileSummary || null,
            disclaimer: "Personalized locally. No household details were sent to external services.",
          },
        });
      }

      // Build remote prompt with privacy controls
      const basePrompt = `You are a friendly home wellness assistant for an Indoor Air Quality (IAQ) dashboard.\n` +
        `Sensors: PM2.5, VoC (MQ-135), Ethanol proxy (MQ-3), CO (MQ-7). IAQ prediction is 5 minutes ahead.\n` +
        `Answer clearly in 1-2 short paragraphs. Offer cautious, non-diagnostic lifestyle tips when appropriate.\n` +
        `Do NOT provide medical diagnoses. Encourage consulting professionals for health concerns.\n` +
        `Latest/Trend JSON follows; you may mention key trends.\n`;
      let prompt = basePrompt +
        `\nUser question: "${question}"\n` +
        `Latest and trend:\n${JSON.stringify(context, null, 2)}\n`;
      if (profileSummary) {
        prompt += `\nHousehold profile: ${profileSummary}\nIMPORTANT: Use this profile to personalize language and prioritize vulnerable members. Keep it non-diagnostic and safety-first.`;
      }
      prompt += `\n\nFinish with a brief educational disclaimer.`;

      const modelsToTry = Array.from(new Set([GEMINI_MODEL, "gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash-latest"]));
      const doFetch = await getFetch();
      let lastError = null;
      for (const model of modelsToTry) {
        const url = `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(model)}:generateContent?key=${GEMINI_API_KEY}`;
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
            // Try next model if this one is overloaded, not found, or unavailable
            if (/overloaded|not found|unsupported|unavailable|unrecognized|quota|rate limit/i.test(String(message)) || resp.status === 404 || resp.status === 429 || resp.status === 503) continue;
            return res.status(502).json({ ok: false, error: message });
          }
          const blockedReason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
          if (blockedReason && String(blockedReason).toUpperCase().includes("SAFETY")) {
            return res.status(200).json({ ok: false, error: `Response blocked by safety filter (${blockedReason}). Try rephrasing the question.` });
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
          return res.json({ ok: true, answer, meta: { usedGemini: true, personalized: !!profileSummary, profileSummary: profileSummary || null, disclaimer: "Profile summary was shared with Gemini for personalization." } });
        } catch (e) {
          lastError = e.message;
          console.warn(`[chat] model ${model} exception: ${e.message}`);
          continue;
        }
      }
      // If Gemini fails, fallback locally
      const ctx = analyzeLifestyleContext(latest, tail);
      const adviceObj = getResearchBasedAdvice(latest, ctx);
      let answer = personalizeTextForProfile(`${adviceObj.primary}`, profile);
      return res.json({ ok: true, answer: `${answer}\n\n(Temporary fallback because AI model was unavailable)`, meta: { usedGemini: false, personalized: !!profile, profileSummary: profileSummary || null, disclaimer: "Personalized locally due to AI service issue." } });
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ----- Lifestyle advice endpoint -----
app.get("/lifestyle-advice", async (req, res) => {
  db.get("SELECT * FROM readings ORDER BY ts DESC, id DESC LIMIT 1", (err, latest) => {
    if (err || !latest) return res.status(500).json({ ok: false, error: "no data" });
    db.all("SELECT * FROM readings ORDER BY ts DESC, id DESC LIMIT 20", async (err2, recent) => {
      const context = analyzeLifestyleContext(latest, recent || []);
      getProfile(async (profile) => {
        const profileSummary = profile ? buildProfileSummary(profile) : "";
        const shareWithGemini = !!(profile?.preferences?.shareWithGemini && GEMINI_API_KEY);
        if (shareWithGemini) {
          // Build Gemini prompt (single tip + prioritization)
          const doFetch = await getFetch();
          const modelsToTry = Array.from(new Set([GEMINI_MODEL, "gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash-latest"]));
          let lastError = null;
          const prompt = `You are a friendly home wellness advisor. Based on the latest IAQ data (JSON below), give one research-informed tip tailored to this household. ` +
            `Prioritize vulnerable members if present. Keep it non-diagnostic and safety-first. End with a brief educational disclaimer.\n` +
            `Household profile: ${profileSummary}\n` +
            `Context JSON: ${JSON.stringify({ latest: adjustForFrontend(latest), trendSummary: context?.categories }, null, 2)}`;
          for (const model of modelsToTry) {
            const url = `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(model)}:generateContent?key=${GEMINI_API_KEY}`;
            try {
              const resp = await doFetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, topP: 0.9, maxOutputTokens: 320 } }),
              });
              const data = await resp.json();
              if (!resp.ok || data?.error) {
                const message = data?.error?.message || `Upstream error (status ${resp.status})`;
                lastError = message;
                // Try next model if this one is overloaded, not found, or unavailable
                if (/overloaded|not found|unsupported|unavailable|unrecognized|quota|rate limit/i.test(String(message)) || resp.status === 404 || resp.status === 429 || resp.status === 503) continue;
                return res.status(502).json({ ok: false, error: message });
              }
              let text = "";
              const parts = data?.candidates?.[0]?.content?.parts || [];
              for (const p of parts) if (typeof p.text === "string") text += p.text;
              if (!text.trim()) { lastError = "Empty response"; continue; }
              return res.json({ ok: true, context, advice: { text, source: "gemini" }, meta: { usedGemini: true, profileSummary } });
            } catch (e) {
              lastError = e.message;
            }
          }
          // fallthrough to local
          console.warn("/lifestyle-advice: Gemini unavailable, using fallback: ", lastError);
        }
        const adviceObj = getResearchBasedAdvice(latest, context);
        const finalText = personalizeTextForProfile(adviceObj.primary, profile);
        res.json({ ok: true, context, advice: { ...adviceObj, text: `${finalText} This is educational guidance, not medical advice.` , source: "local" }, meta: { usedGemini: false, profileSummary } });
      });
    });
  });
});

// ----- Lifestyle advice (client-provided context) -----
app.post("/lifestyle-advice", async (req, res) => {
  try {
    const { latest = null, recent = [] } = req.body || {};
    const context = analyzeLifestyleContext(latest, recent || []);
    getProfile(async (profile) => {
      const profileSummary = profile ? buildProfileSummary(profile) : "";
      const shareWithGemini = !!(profile?.preferences?.shareWithGemini && GEMINI_API_KEY);
      if (shareWithGemini) {
        const doFetch = await getFetch();
        const modelsToTry = Array.from(new Set([GEMINI_MODEL, "gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash-latest"]));
        let lastError = null;
        const tail = (Array.isArray(recent) ? recent : []).slice(-20);
        const payload = {
          latest: adjustForFrontend(latest || {}),
          recentSummary: tail.map((r) => ({ ts: r.ts, pm25: r.pm25, voc: r.voc, c2h5oh: r.c2h5oh, co: r.co, predicted_iaq: r.predicted_iaq, current_iaq: r.current_iaq })),
          categories: context?.categories || {},
        };
        const prompt = `You are a friendly home wellness advisor. Based on the latest IAQ data (JSON below), give one research-informed tip tailored to this household. ` +
          `Prioritize vulnerable members if present. Keep it non-diagnostic and safety-first. End with a brief educational disclaimer.\n` +
          `Household profile: ${profileSummary}\n` +
          `Context JSON: ${JSON.stringify(payload, null, 2)}`;
        for (const model of modelsToTry) {
          const url = `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(model)}:generateContent?key=${GEMINI_API_KEY}`;
          try {
            const resp = await doFetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, topP: 0.9, maxOutputTokens: 320 } }),
            });
            const data = await resp.json();
            if (!resp.ok || data?.error) {
              const message = data?.error?.message || `Upstream error (status ${resp.status})`;
              lastError = message;
              // Try next model if this one is overloaded, not found, or unavailable
              if (/overloaded|not found|unsupported|unavailable|unrecognized|quota|rate limit/i.test(String(message)) || resp.status === 404 || resp.status === 429 || resp.status === 503) continue;
              return res.status(502).json({ ok: false, error: message });
            }
            let text = "";
            const parts = data?.candidates?.[0]?.content?.parts || [];
            for (const p of parts) if (typeof p.text === "string") text += p.text;
            if (!text.trim()) { lastError = "Empty response"; continue; }
            return res.json({ ok: true, context, advice: { text, source: "gemini" }, meta: { usedGemini: true, profileSummary } });
          } catch (e) {
            lastError = e.message;
          }
        }
        console.warn("/lifestyle-advice (POST): Gemini unavailable, using fallback: ", lastError);
      }
      const adviceObj = getResearchBasedAdvice(latest, context);
      const finalText = personalizeTextForProfile(adviceObj.primary, profile);
      res.json({ ok: true, context, advice: { ...adviceObj, text: `${finalText} This is educational guidance, not medical advice.` , source: "local" }, meta: { usedGemini: false, profileSummary } });
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ----- Emergency check (simple) -----
app.get("/emergency-check", (req, res) => {
  db.get("SELECT * FROM readings ORDER BY ts DESC, id DESC LIMIT 1", (err, latest) => {
    if (err || !latest) return res.json({ ok: true, emergency: false });
    getProfile((profile) => {
      const pred = Number(latest.predicted_iaq);
      const emergency = Number.isFinite(pred) && pred >= 300;
      let message = emergency
        ? "Predicted IAQ is hazardous. Move to fresh air, ventilate strongly, and stop emission sources."
        : "No emergency detected.";
      if (emergency) message = personalizeTextForProfile(message, profile);
      res.json({ ok: true, emergency, message });
    });
  });
});

// ----- Data export as CSV -----
// NOTE: CSV export keeps RAW values as stored; change to adjustForFrontend(row)
// if you also want downloads to reflect the -100 display tweak.
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
    res.json({ ok: true, models: (data.models || []) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
  console.log(`POST data to http://<your-ip>:${PORT}/data`);
});
