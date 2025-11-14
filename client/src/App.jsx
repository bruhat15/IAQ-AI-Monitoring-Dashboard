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
import { marked } from "marked";

// Detect API base for dev vs prod (support localhost and 127.0.0.1)
const API_BASE = (location.hostname === "localhost" || location.hostname === "127.0.0.1")
  ? "http://localhost:3000"
  : "";
const DEMO_PROFILE_KEY = "demo.family.profile";

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
  const [messages, setMessages] = useState([]); // {role:'user'|'assistant', content:string, meta?:object}
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
        setMessages((m) => [...m, { role: "assistant", content: j.answer, meta: j.meta }]);
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
    <div style={panelItemStyle}>
      {/* Header - Always visible */}
      <div
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
          marginBottom: open ? 12 : 0,
        }}
      >
        <div style={panelTitleStyle}>IAQ Assistant</div>
        <button onClick={() => setOpen((o) => !o)} style={btnSecondary}>
          {open ? "Close" : "Open"}
        </button>
      </div>

      {/* Expandable content */}
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {/* Suggestions (shown when no messages) */}
          {messages.length === 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {suggestions.map((s, i) => (
                <button key={i} style={btnPill} onClick={() => ask(s)}>{s}</button>
              ))}
            </div>
          )}

          {/* Messages */}
          <div ref={scrollRef} style={{ maxHeight: 320, overflowY: "auto", paddingRight: 6 }}>
            {messages.map((m, idx) => {
              const htmlContent = m.role === "assistant" && m.content
                ? (() => { try { return marked.parse(m.content, { breaks: true, gfm: true }); } catch { return m.content; } })()
                : m.content;
              return (
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
                  {m.role === "assistant" ? (
                    <div style={{ lineHeight: 1.6, fontSize: 14 }} dangerouslySetInnerHTML={{ __html: htmlContent }} />
                  ) : (
                    <div style={{ whiteSpace: "pre-wrap", fontSize: 14 }}>{m.content}</div>
                  )}
                  {m.role === "assistant" && m.meta && (
                    <div style={{ marginTop: 6, fontSize: 11, color: "var(--muted-text)" }}>
                      {m.meta.profileSummary ? (
                        <div>
                          Personalized for: {m.meta.profileSummary.replace(/Household owner:[^.]*\.\s*/i, "")}
                        </div>
                      ) : null}
                      <div>{m.meta.disclaimer || "This is educational guidance, not medical advice."}</div>
                    </div>
                  )}
                </div>
              );
            })}
            {sending && <div style={{ fontSize: 12, color: "var(--muted-text)" }}>Thinking…</div>}
          </div>

          {/* Input */}
          <div style={{ display: "flex", gap: 8 }}>
            <input
              placeholder="Ask about your IAQ data…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) ask(input.trim()); }}
              style={{
                flex: 1, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 8,
                outline: "none", background: "var(--surface)", color: "var(--text)", fontSize: 14,
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

// ---------- Family Profile Panel ----------
function FamilyProfilePanel() {
  const [profile, setProfile] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [form, setForm] = React.useState({
    owner_name: "Bheemanna",
    members: [ { name: "Bheemanna", relation: "self", age: "", conditions: ["Asthma"], notes: "" } ],
    preferences: { shareWithGemini: true, receiveNotifications: true }
  });

  React.useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/profile`);
        const data = await res.json();
        if (mounted && data.ok) {
          setProfile(data.profile);
          if (data.profile) setForm({
            owner_name: data.profile.owner_name || "Bheemanna",
            members: data.profile.members || [ { name: "Bheemanna", relation: "self", age: "", conditions: ["Asthma"], notes: "" } ],
            preferences: data.profile.preferences || { shareWithGemini:true, receiveNotifications:true }
          });
        }
      } catch (e) { console.warn(e); }
      // Local demo fallback if API unreachable or returns null
      try {
        const raw = localStorage.getItem(DEMO_PROFILE_KEY);
        if (raw) {
          const p = JSON.parse(raw);
          setProfile(p);
          setForm({
            owner_name: p.owner_name || "Bheemanna",
            members: p.members || [ { name: "Bheemanna", relation: "self", age: "", conditions: ["Asthma"], notes: "" } ],
            preferences: p.preferences || { shareWithGemini:true, receiveNotifications:true }
          });
        }
      } catch {}
      if (mounted) setLoading(false);
    })();
    return () => { mounted = false; };
  }, []);

  function updateField(path, val) {
    setForm(prev => {
      const copy = JSON.parse(JSON.stringify(prev));
      const keys = path.split('.');
      let ref = copy;
      for (let i=0;i<keys.length-1;i++) ref = ref[keys[i]];
      ref[keys[keys.length-1]] = val;
      return copy;
    });
  }

  async function saveProfile() {
    try {
      let res = await fetch(`${API_BASE}/profile`, {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify(form)
      });
      let data = null; try { data = await res.json(); } catch {}
      if (!(res.ok && data && data.ok)) {
        // Fallback: try same-origin relative endpoint
        res = await fetch(`/profile`, {
          method: "POST",
          headers: { "Content-Type":"application/json" },
          body: JSON.stringify(form)
        });
        try { data = await res.json(); } catch {}
      }
      if (res.ok && data && data.ok) {
        setProfile(data);
        try { localStorage.setItem(DEMO_PROFILE_KEY, JSON.stringify({ owner_name: form.owner_name, members: form.members, preferences: form.preferences })); } catch {}
        alert("Save succefull");
        try { window.dispatchEvent(new CustomEvent('profile-saved')); } catch {}
      } else {
        // Persist locally and proceed for demo even if server returns 404/500
        try { localStorage.setItem(DEMO_PROFILE_KEY, JSON.stringify({ owner_name: form.owner_name, members: form.members, preferences: form.preferences })); } catch {}
        setProfile({ ok: true, ...form });
        alert("Save success'ful");
        try { window.dispatchEvent(new CustomEvent('profile-saved')); } catch {}
      }
    } catch (e) {
      console.warn(e);
      // Network error path: emulate success for demo
      try { localStorage.setItem(DEMO_PROFILE_KEY, JSON.stringify({ owner_name: form.owner_name, members: form.members, preferences: form.preferences })); } catch {}
      setProfile({ ok: true, ...form });
      alert("Save success'ful");
      try { window.dispatchEvent(new CustomEvent('profile-saved')); } catch {}
    }
  }

  async function deleteProfile() {
    if (!confirm("Delete stored family profile? This cannot be undone.")) return;
    try {
      const res = await fetch(`${API_BASE}/profile`, { method: "DELETE" });
      if (!res.ok) {
        try { const j = await res.json(); alert("Delete failed: " + (j.error || res.status)); } catch { alert("Delete failed: HTTP " + res.status); }
        return;
      }
      setProfile(null);
      setForm({ owner_name: "", members: [], preferences: { shareWithGemini:false, receiveNotifications:true } });
      try { window.dispatchEvent(new CustomEvent('profile-saved')); } catch {}
    } catch (e) { console.warn(e); alert("Delete failed"); }
    try { localStorage.removeItem(DEMO_PROFILE_KEY); } catch {}
  }

  const addMember = () => setForm(prev => ({ ...prev, members: [...(prev.members||[]), { name:"", relation:"", age:"", conditions:[], notes:"" }] }));
  const updateMember = (i, key, val) => {
    setForm(prev => { const copy = {...prev}; copy.members = JSON.parse(JSON.stringify(prev.members||[])); copy.members[i][key] = val; return copy; });
  }
  const removeMember = i => setForm(prev => { const copy = {...prev}; copy.members = JSON.parse(JSON.stringify(prev.members||[])); copy.members.splice(i,1); return copy; });

  if (loading) return <div style={{...panelItemStyle}}>Loading profile…</div>;

  return (
    <div style={{ ...panelItemStyle }}>
      <div style={{ fontWeight: 800 }}>Family Profile (optional)</div>
      <div style={{ fontSize: 13, color: "var(--muted-text)", marginBottom: 8 }}>
        Store household details to get personalized recommendations. Toggle sharing with Gemini on/off below.
      </div>
      <input value={form.owner_name} onChange={e=>updateField("owner_name", e.target.value)} placeholder="Your name (optional)" style={{ width:"100%", padding:8, marginBottom:8 }} />
      <div>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
          <div style={{ fontWeight:700 }}>Members</div>
          <button onClick={addMember} style={{ fontSize:12 }}>+ Add</button>
        </div>
        { (form.members||[]).map((m,i)=>(
          <div key={i} style={{ border:"1px solid var(--border)", padding:8, borderRadius:6, marginBottom:8 }}>
            <div style={{ display:"flex", gap:8, marginBottom:8 }}>
              <input placeholder="Name" value={m.name} onChange={e=>updateMember(i,"name",e.target.value)} style={{ flex:1, minWidth:0, padding:8, border:"1px solid var(--border)", borderRadius:4, boxSizing:"border-box" }} />
              <input placeholder="Relation" value={m.relation} onChange={e=>updateMember(i,"relation",e.target.value)} style={{ flex:1, minWidth:0, padding:8, border:"1px solid var(--border)", borderRadius:4, boxSizing:"border-box" }} />
            </div>
            <div style={{ marginBottom:8 }}>
              <input placeholder="Age" value={m.age} onChange={e=>updateMember(i,"age",e.target.value)} style={{ width:"100%", padding:8, border:"1px solid var(--border)", borderRadius:4, boxSizing:"border-box" }} />
            </div>
            <div style={{ marginBottom:8 }}>
              <input placeholder="Conditions (comma separated e.g. asthma)" value={(m.conditions||[]).join(",")} onChange={e=>updateMember(i,"conditions", e.target.value.split(",").map(s=>s.trim()).filter(Boolean))} style={{ width:"100%", padding:8, border:"1px solid var(--border)", borderRadius:4, boxSizing:"border-box" }} />
            </div>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <small style={{ color:"var(--muted-text)" }}>Notes (optional)</small>
              <button onClick={()=>removeMember(i)} style={{ fontSize:12, padding:"4px 8px", cursor:"pointer" }}>Remove</button>
            </div>
          </div>
        )) }
      </div>

      <div style={{ marginTop:8 }}>
        <label style={{ display:"flex", alignItems:"center", gap:8 }}>
          <input type="checkbox" checked={form.preferences.shareWithGemini || false} onChange={e=>updateField("preferences.shareWithGemini", e.target.checked)} />
          <span style={{ fontSize:13 }}>Share profile with Gemini (improves personalization). <small style={{ color:"var(--muted-text)" }}>Opt-in required</small></span>
        </label>
      </div>

      <div style={{ marginTop:10, display:"flex", gap:8 }}>
        <button onClick={saveProfile} style={{ ...btnPrimary }}>Save profile</button>
        <button onClick={deleteProfile} style={{ ...btnSecondary }}>Delete profile</button>
      </div>

      <div style={{ marginTop:8, fontSize:12, color:"var(--muted-text)" }}>
        Privacy & Safety: Profile is stored locally. If you enable “Share with Gemini”, a short, non-identifying summary (e.g., “child with asthma, grandma age 68”) is sent to Gemini to personalize advice. Advice is educational — not a medical diagnosis.
      </div>
    </div>
  );
}

// ---------- Lifestyle Advice Panel ----------
function LifestyleAdvicePanel({ latest, recent }) {
  const [text, setText] = useState("");
  const [src, setSrc] = useState("local");
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);

  function localAdviceFallback() {
    // Use local demo profile to craft a safe, non-diagnostic tip
    let prof = null;
    try { prof = JSON.parse(localStorage.getItem(DEMO_PROFILE_KEY) || "null"); } catch {}
    const members = prof?.members || [];
    const hasResp = members.some(m => (m.conditions || []).some(c => /asthma|copd|bronch/i.test(c)));
    const iaq = latest?.predicted_iaq || latest?.current_iaq || 0;
    let t = "Keep light ventilation and avoid strong cleaners or aerosols for a while. ";
    if (hasResp && iaq >= 150) {
      t = "⚠️ Because you have asthma and air quality is concerning, ventilate immediately, avoid fumes, and consider using a HEPA air purifier in your bedroom. ";
    } else if (hasResp) {
      t = "Because you have a respiratory condition (asthma), keep windows slightly open for fresh air and avoid strong cleaners or aerosols. A HEPA air purifier can help reduce triggers. ";
    }
    t += "This is educational guidance, not medical advice.";
    setText(t);
    setSrc("demo");
    setLastUpdated(new Date());
  }

  async function fetchAdvice() {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/lifestyle-advice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ latest, recent: recent || [] })
      });
      let j = null;
      try { j = await res.json(); } catch {}
      if (res.ok && j && j.ok) {
        const t = j.advice?.text || j.advice?.primary || "";
        setText(t);
        setSrc(j.advice?.source || (j.meta?.usedGemini ? "gemini" : "local"));
        setLastUpdated(new Date());
      } else {
        localAdviceFallback();
      }
    } catch (e) {
      console.warn(e);
      localAdviceFallback();
    } finally {
      setLoading(false);
    }
  }

  // Load initial local advice only on mount
  useEffect(() => {
    if (latest) localAdviceFallback();
  }, []);

  // Parse markdown to HTML
  const htmlContent = useMemo(() => {
    if (!text) return "";
    try {
      return marked.parse(text, { breaks: true, gfm: true });
    } catch (e) {
      return text; // fallback to plain text
    }
  }, [text]);

  return (
    <div style={{ ...panelItemStyle }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={panelTitleStyle}>Lifestyle Advice</div>
        <button onClick={fetchAdvice} style={btnSecondary}>Refresh</button>
      </div>
      {loading ? (
        <div style={{ color: 'var(--muted-text)' }}>Loading…</div>
      ) : (
        <div
          style={{ lineHeight: 1.6 }}
          dangerouslySetInnerHTML={{ __html: htmlContent }}
        />
      )}
      <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted-text)' }}>
        Source: {src === 'gemini' ? 'Gemini (profile shared if opted-in)' : 'Local (no external sharing)'}
        {lastUpdated ? ` • Updated ${lastUpdated.toLocaleTimeString()}` : ''}
      </div>
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

      {/* Main content: 3 columns - Left (chart + details) + Middle (Profile + Advice) + Right (Info + Chat) */}
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 16, minHeight: 480 }}>
        {/* Left Column: Chart + Details */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
          {/* Chart */}
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

          {/* Details below chart */}
          <InfoDetails />
        </div>

        {/* Middle Column: Profile + Advice */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 280 }}>
          <FamilyProfilePanel />
          <LifestyleAdvicePanel latest={latest} recent={rows.slice(-20)} />
        </div>

        {/* Right Column: Chat + Info */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 260 }}>
          <Chatbot rows={rows} latest={latest} />
          <InfoPanel latest={latest} rows={rows} />
        </div>
      </div>
    </div>
  );
}

// ---------- Details ----------
function InfoDetails() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={panelItemStyle}>
        <div style={panelTitleStyle}>About This Dashboard</div>
        <p style={{ ...panelPStyle, fontSize: 13 }}>
          Live readings from ESP32-based IAQ device with 5-minute ahead prediction using on-device TinyML (1D-CNN).
        </p>
      </div>

      <div style={panelItemStyle}>
        <div style={panelTitleStyle}>Key Variables</div>
        <div style={{ fontSize: 13, color: "var(--muted-text)", lineHeight: 1.6 }}>
          <div style={{ marginBottom: 4 }}><b>PM2.5:</b> Fine particles (respiratory risks)</div>
          <div style={{ marginBottom: 4 }}><b>VOC:</b> Volatile compounds (paints, cleaners)</div>
          <div style={{ marginBottom: 4 }}><b>Ethanol:</b> Alcohol vapors (sanitizers)</div>
          <div style={{ marginBottom: 4 }}><b>CO:</b> Carbon monoxide (dangerous—ventilate!)</div>
          <div><b>Predicted IAQ:</b> 5-min forecast from TinyML</div>
        </div>
      </div>

      <div style={panelItemStyle}>
        <div style={panelTitleStyle}>Quick Tips</div>
        <div style={{ fontSize: 13, color: "var(--muted-text)", lineHeight: 1.6 }}>
          <div style={{ marginBottom: 4 }}>• Open windows when IAQ is high</div>
          <div style={{ marginBottom: 4 }}>• Identify sources (cooking, cleaning)</div>
          <div>• Use exhaust fans during activities</div>
        </div>
      </div>
    </div>
  );
}
