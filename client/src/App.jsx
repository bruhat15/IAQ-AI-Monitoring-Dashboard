import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

// Detect API base for dev vs prod
const API_BASE = location.hostname === "localhost" ? "http://localhost:3000" : "";

// ---------- Small UI helpers ----------
const panelItemStyle = {
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: 12,
  background: "var(--surface)",
  boxShadow: "0 1px 6px rgba(0,0,0,0.05)",
};
const panelTitleStyle = { fontWeight: 700, marginBottom: 8 };
const panelPStyle = { margin: 0, color: "var(--muted-text)", lineHeight: 1.5 };
const ulReset = { margin: 0, paddingLeft: 18, color: "var(--muted-text)", lineHeight: 1.5 };

const btnPrimary = {
  padding: "10px 14px",
  background: "#2563eb",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
};
const btnSecondary = {
  padding: "8px 12px",
  background: "var(--surface)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  cursor: "pointer",
};
const btnPill = {
  padding: "8px 12px",
  background: "var(--surface)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 999,
  cursor: "pointer",
  fontSize: 12,
};

function getIaqLabel(v) {
  if (v === undefined || v === null || !isFinite(v)) return { label: "—", color: "var(--text)" };
  const x = Number(v);
  if (x < 50) return { label: "Good", color: "#16a34a" };
  if (x < 100) return { label: "Moderate", color: "#84cc16" };
  if (x < 150) return { label: "USG", color: "#f59e0b" };
  if (x < 200) return { label: "Unhealthy", color: "#ef4444" };
  if (x < 300) return { label: "Very Unhealthy", color: "#db2777" };
  return { label: "Hazardous", color: "#7c3aed" };
}

function deriveTrend(values) {
  const arr = (values || []).filter((x) => typeof x === "number" && isFinite(x));
  if (arr.length < 4) return "insufficient data";
  const windowed = arr.slice(-16);
  const first = windowed[0];
  const last = windowed[windowed.length - 1];
  const delta = last - first;
  const mag = Math.abs(delta);
  const base = Math.max(1, Math.abs(first));
  const rel = mag / base;
  if (mag < 0.01) return "steady";
  if (rel < 0.05) return delta > 0 ? "slightly rising" : "slightly falling";
  return delta > 0 ? "rising" : "falling";
}

// ---------- Info Panel ----------
function InfoPanel({ latest, rows }) {
  const pred = latest?.predicted_iaq;
  const cur  = latest?.current_iaq;

  const predTrend = useMemo(
    () => deriveTrend(rows.map((r) => r.predicted_iaq)),
    [rows]
  );

  const curBadge = getIaqLabel(cur);
  const exportUrl = `${API_BASE}/export.csv`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Current IAQ */}
      <div style={{ ...panelItemStyle }}>
        <div style={{ ...panelTitleStyle, marginBottom: 6 }}>Current air quality</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <div style={{ fontSize: 28, fontWeight: 800 }}>
            {cur !== undefined && cur !== null && isFinite(cur) ? Number(cur).toFixed(0) : "—"}
          </div>
          <span
            style={{
              fontSize: 12,
              fontWeight: 700,
              padding: "2px 8px",
              borderRadius: 999,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: curBadge.color,
            }}
            title="Based on sub-indices (PM2.5, CO, VoC, Ethanol); worst sub-index wins"
          >
            {curBadge.label}
          </span>
        </div>
        <div style={{ fontSize: 12, color: "var(--muted-text)" }}>
          Real-time index from the latest sensor readings.
        </div>
      </div>

      {/* Next 5-min outlook */}
      <div style={{ ...panelItemStyle }}>
        <div style={{ ...panelTitleStyle, marginBottom: 4 }}>Next 5-min outlook</div>
        <div style={{ fontSize: 14, color: "var(--muted-text)" }}>Projected index</div>
        <div style={{ fontSize: 28, fontWeight: 800 }}>
          {pred !== undefined && pred !== null && isFinite(pred) ? Number(pred).toFixed(0) : "—"}
        </div>
        <div style={{ fontSize: 12, color: "var(--muted-text)" }}>Trend: {predTrend}</div>
      </div>

      {/* Export */}
      <a
        href={exportUrl}
        style={{ textDecoration: "none", display: "inline-block", textAlign: "center", ...btnPrimary }}
      >
        Download data (CSV)
      </a>
    </div>
  );
}

// ---------- Chatbot ----------
function Chatbot({ rows, latest }) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]); // {role:'user'|'assistant', content:string}
  const scrollRef = useRef(null);

  const suggestions = [
    "Why is the predicted IAQ so high?",
    "What does MQ-135 (VoC) actually measure?",
    "What actions should I take right now?",
    "How is the 5-minute prediction computed?",
  ];

  async function ask(question) {
    if (!question) return;
    setMessages((m) => [...m, { role: "user", content: question }]);
    setInput("");
    setOpen(true);
    setSending(true);
    try {
      const recentData = rows.slice(-100);
      const chatUrl = `${API_BASE}/chat`;
      const res = await fetch(chatUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, recentData, latest }),
      });
      const j = await res.json();
      if (j.ok) {
        setMessages((m) => [...m, { role: "assistant", content: j.answer }]);
      } else {
        setMessages((m) => [...m, { role: "assistant", content: `Error: ${j.error || "Unable to answer"}` }]);
      }
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", content: `Network error: ${e.message}` }]);
    } finally {
      setSending(false);
    }
  }

  // Auto-scroll
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    try { el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); }
    catch { el.scrollTop = el.scrollHeight; }
  }, [messages, sending, open]);

  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
      <div
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
          padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 12,
          background: "var(--surface)", boxShadow: "0 2px 10px rgba(0,0,0,0.06)",
        }}
      >
        <div style={{ fontWeight: 700 }}>Gemini Assistant</div>
        <button onClick={() => setOpen((o) => !o)} style={btnSecondary}>
          {open ? "Close" : "Open"}
        </button>
      </div>

      {open && (
        <div
          style={{
            marginTop: 8, border: "1px solid var(--border)", borderRadius: 12, background: "var(--surface)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.07)", padding: 10, maxHeight: 360, overflow: "hidden",
            display: "flex", flexDirection: "column", gap: 8,
          }}
        >
          {messages.length === 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {suggestions.map((s, i) => (
                <button key={i} style={btnPill} onClick={() => ask(s)}>{s}</button>
              ))}
            </div>
          )}

          <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", paddingRight: 6 }}>
            {messages.map((m, idx) => (
              <div
                key={idx}
                style={{
                  marginBottom: 8,
                  background: m.role === "user" ? "rgba(37, 99, 235, 0.08)" : "rgba(0,0,0,0.03)",
                  border: "1px solid var(--border)", borderRadius: 8, padding: 8,
                }}
              >
                <div style={{ fontSize: 12, color: "var(--muted-text)", marginBottom: 4 }}>
                  {m.role === "user" ? "You" : "Assistant"}
                </div>
                <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
              </div>
            ))}
            {sending && <div style={{ fontSize: 12, color: "var(--muted-text)" }}>Thinking…</div>}
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <input
              placeholder="Ask about your IAQ data…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) ask(input.trim()); }}
              style={{
                flex: 1, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 8,
                outline: "none", background: "var(--surface)", color: "var(--text)",
              }}
            />
            <button onClick={() => ask(input.trim())} disabled={sending || !input.trim()} style={btnPrimary}>
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- App ----------
export default function App() {
  const [rows, setRows] = useState([]);
  const [latest, setLatest] = useState(null);
  const esRef = useRef(null);
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem("theme");
    return saved === "dark" ? "dark" : "light";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  // Initial history + latest
  useEffect(() => {
    fetch(`${API_BASE}/history?limit=720`)
      .then(r => r.json())
      .then(j => { if (j.ok) setRows(j.data || []); })
      .catch(console.error);

    fetch(`${API_BASE}/latest`)
      .then(r => r.json())
      .then(j => { if (j.ok) setLatest(j.data); })
      .catch(console.error);
  }, []);

  // Live updates via SSE
  useEffect(() => {
    const es = new EventSource(`${API_BASE}/stream`, { withCredentials: false });
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        setLatest(data);
        setRows(prev => [...prev, data].slice(-2000)); // keep last N
      } catch (e) {
        console.warn("SSE parse error", e);
      }
    };
    es.onerror = (e) => console.warn("SSE error", e);
    esRef.current = es;
    return () => es.close();
  }, []);

  const cards = useMemo(() => {
    const d = latest || {};
    return [
      { label: "PM2.5 (µg/m³)", value: d.pm25, dp: 2 },
      { label: "VoC (ppb)", value: d.voc, dp: 2 },
      { label: "Ethanol (ppb)", value: d.c2h5oh, dp: 2 },
      { label: "CO (ppm)", value: d.co, dp: 2 },
      { label: "IAQ (current)", value: d.current_iaq, dp: 0 },  // integer-like
      { label: "IAQ (pred 5m)", value: d.predicted_iaq, dp: 0 }, // integer-like
    ];
  }, [latest]);

  const chartData = useMemo(
    () =>
      rows.map((r) => ({
        ...r,
        time: new Date((r.ts ?? 0) * 1000).toLocaleTimeString()
      })),
    [rows]
  );

  return (
    <div style={{ fontFamily: "system-ui, Arial, sans-serif", padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>IAQ Edge Dashboard</h1>
          <p style={{ marginTop: 0, color: "var(--muted-text)" }}>
            Live data from ESP32 via HTTP → SQLite → SSE
          </p>
        </div>
        <button
          onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
          style={btnSecondary}
          title="Toggle dark mode"
        >
          {theme === "light" ? "Dark mode" : "Light mode"}
        </button>
      </div>

      {/* Cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px,1fr))",
          gap: 12,
          marginBottom: 18,
        }}
      >
        {cards.map((c, i) => (
          <div
            key={i}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: 14,
              boxShadow: "0 1px 6px rgba(0,0,0,0.06)",
              background: "var(--surface)",
            }}
          >
            <div style={{ fontSize: 12, color: "var(--muted-text)" }}>{c.label}</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>
              {c.value !== undefined && c.value !== null && isFinite(c.value)
                ? Number(c.value).toFixed(c.dp)
                : "—"}
            </div>
          </div>
        ))}
      </div>

      {/* Main content: Left (chart) + Right (info/chat) */}
      <div style={{ display: "flex", gap: 16, alignItems: "stretch", minHeight: 480 }}>
        {/* Left: Chart */}
        <div style={{ flex: 3, minWidth: 0 }}>
          <div
            style={{
              height: 480, width: "100%", border: "1px solid var(--border)",
              borderRadius: 12, padding: 8, background: "var(--surface)",
            }}
          >
            <ResponsiveContainer>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="time" minTickGap={28} />
                <YAxis />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="pm25" name="PM2.5" dot={false} />
                <Line type="monotone" dataKey="voc" name="VoC" dot={false} />
                <Line type="monotone" dataKey="c2h5oh" name="Ethanol" dot={false} />
                <Line type="monotone" dataKey="co" name="CO" dot={false} />
                <Line type="monotone" dataKey="current_iaq" name="IAQ (current)" dot={false} />
                <Line type="monotone" dataKey="predicted_iaq" name="IAQ (pred)" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Right: Info + Chat */}
        <div style={{ flex: 1, minWidth: 260, position: "relative" }}>
          <div
            style={{
              border: "1px solid var(--border)", borderRadius: 12, padding: 12,
              background: "var(--surface)", height: "100%", overflow: "auto", paddingBottom: 120,
            }}
          >
            <InfoPanel latest={latest} rows={rows} />
          </div>
          <Chatbot rows={rows} latest={latest} />
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <InfoDetails />
      </div>
    </div>
  );
}

// ---------- Details ----------
function InfoDetails() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
      <div style={panelItemStyle}>
        <div style={panelTitleStyle}>What you’re seeing</div>
        <p style={panelPStyle}>
          This dashboard shows live readings from the ESP32-based IAQ device and a 5-minute
          ahead prediction from an on-device 1D-CNN model (TinyML). It helps you act before
          air quality worsens.
        </p>
      </div>
      <div style={panelItemStyle}>
        <div style={panelTitleStyle}>Key Variables</div>
        <ul style={ulReset}>
          <li><b>PM2.5 (µg/m³):</b> Fine particulate matter linked to respiratory risks.</li>
          <li><b>VoC (ppb):</b> Volatile organic compounds from paints/cleaners; excess can irritate.</li>
          <li><b>Ethanol (ppb):</b> Proxy for alcohol-based vapors (sanitizers, sprays).</li>
          <li><b>CO (ppm):</b> Carbon Monoxide; high levels are dangerous—ventilate immediately.</li>
          <li><b>IAQ (pred 5m):</b> Overall IAQ index predicted 5 minutes ahead.</li>
        </ul>
      </div>
      <div style={panelItemStyle}>
        <div style={panelTitleStyle}>How predictions work</div>
        <p style={panelPStyle}>
          A compact 1D-CNN runs on the ESP32. It analyzes recent sequences of sensor readings and
          forecasts the IAQ index 5 minutes into the future.
        </p>
      </div>
      <div style={panelItemStyle}>
        <div style={panelTitleStyle}>Tips</div>
        <ul style={ulReset}>
          <li>Keep windows open if IAQ is consistently high (poor).</li>
          <li>Identify sources: cooking fumes, cleaning products, aerosols.</li>
          <li>Use localized exhaust (kitchen/bath) during peak activities.</li>
        </ul>
      </div>
    </div>
  );
}
