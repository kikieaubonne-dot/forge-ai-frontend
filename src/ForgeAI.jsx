import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Flame, LayoutDashboard, FolderKanban, Wand2, Swords, Sparkles, Music2,
  PersonStanding, Code2, Bug, Link2, History, Settings, Copy, Download,
  Send, CheckCircle2, AlertTriangle, Loader2, ChevronRight, Plus, X,
  RefreshCw, FileCode2, Folder, Circle, ShieldAlert, Zap, Terminal,
  ArrowRight, Trash2, Check
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  FORGE AI — Roblox Game Development Copilot                        */
/*  Design tokens: void bg, ember/violet dual accent, forge signature */
/* ------------------------------------------------------------------ */

const FONT_IMPORT =
  "@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500&family=Inter:wght@400;500;600&display=swap');";

// Model selection now lives entirely server-side (GEMINI_MODEL env var on
// the backend) — this frontend no longer needs to know or send a model name.

// Reads the Vercel build-time env var if set (Project Settings -> Environment
// Variables -> VITE_API_BASE_URL), otherwise falls back to the hardcoded
// Render URL below. Vite only exposes vars prefixed VITE_ to the client.
const ENV_BACKEND_URL =
  (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_API_BASE_URL) || "";

// Pre-filled so the app works out of the box against your deployed backend.
// Override via the VITE_API_BASE_URL env var on Vercel, or in Settings at runtime.
const DEFAULT_BACKEND_URL = ENV_BACKEND_URL || "https://forge-ai-backend-aj9d.onrender.com/api";

const NAV = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "projects", label: "My Projects", icon: FolderKanban },
  { id: "builder", label: "AI Builder", icon: Wand2 },
  { id: "combat", label: "Combat", icon: Swords },
  { id: "vfx", label: "VFX", icon: Sparkles },
  { id: "code", label: "Code", icon: Code2 },
  { id: "debugger", label: "Debugger", icon: Bug },
  { id: "studio", label: "Roblox Studio", icon: Link2 },
  { id: "history", label: "History", icon: History },
  { id: "settings", label: "Settings", icon: Settings },
];

const STEP_DEFS = [
  { key: "analysis", label: "Analysis" },
  { key: "architecture", label: "Architecture & Core Files" },
  { key: "vfx", label: "VFX Configuration" },
  { key: "sfx", label: "SFX Configuration" },
  { key: "animations", label: "Animation Configuration" },
  { key: "validation", label: "Validation" },
];

// ------------------------------------------------------------------
// Asset Research & ID Resolution — status vocabulary
// ------------------------------------------------------------------
// VERIFIED / FOUND_UNVERIFIED are only ever set by a real lookup — nothing
// in this generation pipeline has a live Roblox Creator Store search wired
// in yet, so the generator itself will only ever produce PROCEDURAL,
// MISSING_ASSET, or OPTIONAL_MISSING honestly. The other two statuses exist
// in the vocabulary for when a real search step is added, and for assets a
// person confirms manually via chat.
const ASSET_STATUS = {
  VERIFIED: "VERIFIED",
  FOUND_UNVERIFIED: "FOUND_UNVERIFIED",
  MISSING_ASSET: "MISSING_ASSET",
  PROCEDURAL: "PROCEDURAL",
  OPTIONAL_MISSING: "OPTIONAL_MISSING",
  INVALID: "INVALID",
};

// Deterministic, non-LLM-dependent safety net. The model is instructed never
// to write placeholder-looking asset references, but instructions can be
// missed — this regex scan is what actually blocks a fake ID from reaching
// Send to Roblox Studio, independent of whether the model behaved.
const PLACEHOLDER_PATTERNS = [
  /YOUR_ASSET_ID_HERE/i,
  /YOUR_ANIMATION_ID_HERE/i,
  /rbxassetid:\/\/0+(?!\d)/i,
  /rbxassetid:\/\/YOUR_/i,
  /\bPLACEHOLDER[_A-Z]*\b/i,
];

function findPlaceholderIssues(files) {
  const issues = [];
  for (const f of files || []) {
    const codeVal = f.code ?? f.source;
    if (typeof codeVal === "string") {
      for (const pat of PLACEHOLDER_PATTERNS) {
        if (pat.test(codeVal)) {
          issues.push({ path: f.path, name: f.name, field: "code", pattern: String(pat) });
          break;
        }
      }
    }
    if (f.properties && typeof f.properties === "object") {
      for (const [key, val] of Object.entries(f.properties)) {
        if (typeof val === "string") {
          for (const pat of PLACEHOLDER_PATTERNS) {
            if (pat.test(val)) {
              issues.push({ path: f.path, name: f.name, field: `properties.${key}`, pattern: String(pat) });
              break;
            }
          }
        }
      }
    }
  }
  return issues;
}

// Same check the backend enforces (path/name/type required per file) — run
// this right after every generation step, not just before Send to Studio,
// so a malformed file shows up in Validation immediately instead of only
// surfacing as a mysterious 400 later.
function findMalformedFiles(files) {
  return (files || [])
    .map((f, i) => ({ index: i, name: f?.name || "(sans nom)", path: f?.path || "?", missing: ["path", "name", "type"].filter((k) => !f || !f[k]) }))
    .filter((f) => f.missing.length > 0);
}

const SYSTEM_PROMPT = `Tu es le moteur de génération de FORGE AI, un copilote de développement Roblox Studio spécialisé en Luau.

RÈGLES STRICTES :
- Le code doit être compilable dans Roblox Studio (Luau), propre, commenté, modulaire.
- JAMAIS de dégâts, cooldowns critiques ou récompenses validés uniquement côté client : la logique sensible vit dans ServerScriptService et est validée serveur.
- GESTION DES ASSETS (animations, sons, meshes, textures) — INTERDICTION ABSOLUE d'écrire un Asset ID inventé OU un texte placeholder (comme "YOUR_ASSET_ID_HERE") dans le champ "code" ou dans "properties" d'un fichier. Ni faux ID, ni texte qui y ressemble.
- CHAQUE fichier dans "files"/"new_files" DOIT obligatoirement inclure les trois champs "path", "name" ET "type" (Script|LocalScript|ModuleScript|Folder|RemoteEvent|RemoteFunction) — un fichier sans l'un de ces trois champs est rejeté et casse l'envoi vers Roblox Studio. Ne les omets jamais, même pour un fichier de configuration simple.
  - Si l'élément peut être créé procéduralement avec des Instances Roblox natives (ParticleEmitter, Beam, Trail, Attachment, Highlight, PointLight) : crée-le directement, sans aucun ID externe requis, et déclare-le dans "assets" avec status "PROCEDURAL" et assetId null.
  - Si l'élément nécessite un vrai Asset ID externe (son, AnimationId, mesh, texture) que tu n'as pas et ne peux pas vérifier : NE WRITE AUCUNE valeur dans le champ d'ID de la propriété (laisse-la absente ou chaîne vide ""), et déclare l'asset dans "assets" avec status "MISSING_ASSET", assetId null. Le code doit quand même créer l'Instance (Sound, Animation, etc.) — juste sans ID injecté.
  - N'attribue JAMAIS toi-même le statut "VERIFIED" ou "FOUND_UNVERIFIED" : tu n'as pas de moyen de vérifier un asset réel dans cet environnement. Utilise uniquement "PROCEDURAL", "MISSING_ASSET", ou "OPTIONAL_MISSING" (pour un élément cosmétique facultatif absent).
- Architecture cible :
  ReplicatedStorage/Remotes, ReplicatedStorage/Modules, ReplicatedStorage/Shared
  ServerScriptService/Combat, ServerScriptService/Abilities, ServerScriptService/Services
  StarterPlayer/StarterPlayerScripts/Controllers
- Réponds UNIQUEMENT en JSON valide, sans texte avant/après, sans balises markdown, correspondant exactement au schéma demandé dans chaque instruction utilisateur.
- Reste très concis : code court, commentaires brefs (une ligne max par bloc), privilégie un JSON complet et valide plutôt qu'un code long risquant d'être tronqué. En cas de doute, sacrifie des détails plutôt que la validité du JSON.`;

/* ------------------------------------------------------------------ */
/*  AI generation — STANDALONE BUILD                                   */
/*  The Claude artifact preview has a built-in proxy to api.anthropic. */
/*  com that needs no API key. That proxy does NOT exist once this app */
/*  runs outside claude.ai, so this build calls YOUR OWN backend       */
/*  instead (POST /generate), which forwards to Gemini using your own  */
/*  GEMINI_API_KEY server-side. Configure the backend URL in Settings   */
/*  before using AI Builder.                                            */
/* ------------------------------------------------------------------ */
let AI_BACKEND_URL = ""; // kept in sync with the backendUrl app state, see ForgeAI()

// No longer capped at 1000 — that limit was specific to the Claude artifact
// preview's built-in proxy. This build talks to its own backend with its
// own API key, so it can use a realistic budget and avoid most truncation-
// driven "non-JSON response" failures outright.
const MAX_OUTPUT_TOKENS = 4096;

async function rawClaudeCall(messages) {
  if (!AI_BACKEND_URL) {
    throw new Error("Configure d'abord l'URL du backend dans Settings — la génération IA passe par ton backend (voir /server/routes/generate.js).");
  }
  const base = AI_BACKEND_URL.trim().replace(/\/+$/, "");
  const res = await fetch(`${base}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SYSTEM_PROMPT,
      messages,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`API error ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = (data.content || [])
    .map((b) => (b.type === "text" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
  const truncated = data.stop_reason === "max_tokens";
  return { text, truncated };
}

function tryParseJson(raw) {
  let clean = raw.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(clean);
  } catch (_) {}
  // salvage the largest {...} block
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start !== -1 && end !== -1) {
    try { return JSON.parse(clean.slice(start, end + 1)); } catch (_) {}
  }
  // if truncated mid-stream, try closing off open braces/brackets/strings heuristically
  if (start !== -1) {
    let attempt = clean.slice(start);
    // strip a dangling incomplete string/property at the very end
    attempt = attempt.replace(/,\s*"[^"]*"?\s*:?\s*"?[^"]*$/, "");
    let openBraces = 0, openBrackets = 0, inStr = false, esc = false;
    for (const ch of attempt) {
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") openBraces++;
      if (ch === "}") openBraces--;
      if (ch === "[") openBrackets++;
      if (ch === "]") openBrackets--;
    }
    let closer = "";
    if (inStr) closer += '"';
    closer += "]".repeat(Math.max(0, openBrackets));
    closer += "}".repeat(Math.max(0, openBraces));
    try { return JSON.parse(attempt + closer); } catch (_) {}
  }
  return null;
}

async function callClaude(messages, { json = true } = {}) {
  const { text, truncated } = await rawClaudeCall(messages);
  if (!json) return text;
  if (!text.trim()) throw new Error("Réponse vide de l'API — réessaie.");

  let parsed = tryParseJson(text);
  if (parsed) return parsed;

  // auto-repair pass 1: ask the model to reformat its own (possibly truncated) output as strict, shorter JSON
  try {
    const repairMsgs = [
      ...messages,
      { role: "assistant", content: text },
      {
        role: "user",
        content:
          "Ta réponse précédente n'était pas un JSON valide (probablement tronquée par la limite de tokens). " +
          "Renvoie UNIQUEMENT un JSON valide et complet correspondant au même schéma, en réduisant fortement la taille du code " +
          "(moins de fichiers et/ou code plus court) pour tenir sous la limite. Aucun texte, aucun markdown, juste le JSON.",
      },
    ];
    const repaired = await rawClaudeCall(repairMsgs);
    const parsed2 = tryParseJson(repaired.text);
    if (parsed2) return parsed2;

    // auto-repair pass 2: drop ambition to the bare minimum — a single short file
    const repairMsgs2 = [
      ...messages,
      { role: "assistant", content: repaired.text },
      {
        role: "user",
        content:
          "Toujours invalide/tronqué. Simplifie au maximum : UN SEUL fichier, code de 10 à 20 lignes maximum, " +
          "sans commentaires superflus. Garde uniquement les champs essentiels du schéma. JSON valide et complet uniquement, rien d'autre.",
      },
    ];
    const repaired2 = await rawClaudeCall(repairMsgs2);
    const parsed3 = tryParseJson(repaired2.text);
    if (parsed3) return parsed3;
  } catch (_) {}

  const hint = truncated ? " (réponse probablement tronquée par la limite de sortie)" : "";
  throw new Error(`Réponse IA non-JSON reçue${hint}. Réessaie, ou reformule la demande de façon plus courte.`);
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

/* ------------------------------------------------------------------ */
/*  Forge backend calls (real Roblox Studio bridge — see /server)      */
/*  These hit a backend YOU deploy yourself. If backendUrl is empty or */
/*  unreachable, every call below fails cleanly and the UI stays       */
/*  honest about it — never fakes a connected state.                   */
/* ------------------------------------------------------------------ */
function normalizeBackend(url) {
  return (url || "").trim().replace(/\/+$/, "");
}

// Tracks CSP connect-src violations so we can tell a real network/CORS
// failure apart from a sandboxed browser silently blocking the request.
// This is the only reliable signal JS gets for a CSP block — fetch()'s
// catch just says "Failed to fetch" either way. Kept even outside the
// Claude preview in case this app is ever embedded somewhere else.
const cspViolationLog = [];
if (typeof document !== "undefined") {
  document.addEventListener("securitypolicyviolation", (e) => {
    if (e.violatedDirective && e.violatedDirective.startsWith("connect-src")) {
      cspViolationLog.push({ blockedURI: e.blockedURI, directive: e.violatedDirective, ts: Date.now() });
      console.warn("[Forge AI] CSP connect-src violation:", e.blockedURI, e.violatedDirective);
    }
  });
}
function recentCspViolationFor(url) {
  let host = "";
  try { host = new URL(url).host; } catch (_) { return null; }
  const cutoff = Date.now() - 4000;
  return cspViolationLog.find((v) => v.ts > cutoff && v.blockedURI && v.blockedURI.includes(host)) || null;
}

// Shared fetch wrapper for every backend call.
// - Logs URL / method / status / error exactly, every time.
// - NEVER hides a real HTTP status behind a generic "Failed to fetch" — an
//   HTTP error (res.ok === false) is thrown as its own typed error with
//   .httpStatus set, distinct from a true network-level failure.
// - Retries automatically ONLY on signals consistent with a Render cold
//   start (network-level TypeError, or 502/503/504 from the proxy while the
//   instance boots), with backoff, and reports each retry via onRetry so the
//   UI can show "Réveil du backend..." instead of a bare error.
async function fetchBackend(url, options = {}, { retries = 2, onRetry } = {}) {
  const method = options.method || "GET";
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    console.log(`[Forge AI] Fetch ${method} ${url}${attempt > 0 ? ` (retry ${attempt}/${retries})` : ""}`);
    try {
      const res = await fetch(url, { ...options, credentials: "omit" });
      console.log(`[Forge AI] Response ${res.status} ${url}`);
      if (!res.ok) {
        if ([502, 503, 504].includes(res.status) && attempt < retries) {
          console.warn(`[Forge AI] HTTP ${res.status} — treating as cold start, retrying...`);
          onRetry && onRetry(attempt + 1, retries, `HTTP ${res.status} (backend probablement en train de démarrer)`);
          await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
          continue;
        }
        const text = await res.text().catch(() => "");
        let parsedBody = null;
        try { parsedBody = text ? JSON.parse(text) : null; } catch (_) {}
        const backendMsg = parsedBody?.message || parsedBody?.error;
        const err = new Error(
          backendMsg
            ? `${backendMsg}`
            : `Le backend a répondu avec une erreur HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ""}`
        );
        err.httpStatus = res.status;
        err.body = parsedBody;
        throw err;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (e.httpStatus) throw e; // real HTTP error — already logged, no more retries beyond the 502/503/504 loop above
      console.warn(`[Forge AI] Network error on ${url}:`, e.message);
      if (attempt < retries) {
        onRetry && onRetry(attempt + 1, retries, e.message);
        await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function backendRegister(backendUrl, code, projectId, onRetry) {
  const base = normalizeBackend(backendUrl);
  const url = `${base}/studio/register`;
  console.log("[Forge AI] Backend URL:", backendUrl);
  console.log("[Forge AI] Register URL:", url);
  const res = await fetchBackend(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, project_id: projectId }),
  }, { onRetry });
  return res.json();
}

async function backendStatus(backendUrl, code, onRetry) {
  const base = normalizeBackend(backendUrl);
  const url = `${base}/studio/status/${code}`;
  const res = await fetchBackend(url, {}, { onRetry });
  return res.json();
}

async function backendSendBuild(backendUrl, code, systemName, files, projectId, onRetry) {
  const base = normalizeBackend(backendUrl);
  const url = `${base}/studio/build`;
  const res = await fetchBackend(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, system_name: systemName, files, project_id: projectId }),
  }, { onRetry });
  return res.json();
}

async function backendBuildHistory(backendUrl, code) {
  const base = normalizeBackend(backendUrl);
  const res = await fetchBackend(`${base}/studio/builds/${code}`);
  return res.json();
}

// Calls the Asset Resolution Engine (project cache -> GitHub -> web search).
// Never returns a fabricated assetId — see server/assetResolution.js.
async function backendResolveAsset(backendUrl, { name, type, searchTerm, description, existingAssets }, onRetry) {
  const base = normalizeBackend(backendUrl);
  const res = await fetchBackend(`${base}/assets/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, type, searchTerm, description, existingAssets }),
  }, { onRetry });
  return res.json();
}

// Phase 2 — Quality Decision Engine. Consumes the current Asset Manifest
// as-is (whatever Phase 1 already resolved) — does not trigger any new
// search. Returns REUSE/MODIFY/GENERATE/PROCEDURAL/OPTIONAL_MISSING/
// BLOCK_BUILD per asset with scores and a reason.
async function backendDecideQuality(backendUrl, assets, onRetry) {
  const base = normalizeBackend(backendUrl);
  const res = await fetchBackend(`${base}/quality/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assets }),
  }, { onRetry });
  return res.json();
}

// Real diagnostic: hits /api/health and classifies the failure precisely —
// HTTP error vs network error vs (if applicable) CSP block — instead of
// guessing. Returns a structured result the UI renders honestly.
async function diagnoseBackend(backendUrl, onRetry) {
  const base = normalizeBackend(backendUrl);
  const url = `${base}/health`;
  console.log("[Forge AI] Diagnostic — health check URL:", url);
  try {
    const res = await fetchBackend(url, {}, { onRetry });
    const body = await res.json().catch(() => null);
    return { kind: "ok", detail: body };
  } catch (e) {
    if (e.httpStatus) {
      return { kind: "http_error", detail: `Le backend répond mais renvoie une erreur HTTP ${e.httpStatus}.` };
    }
    console.warn("[Forge AI] Diagnostic — fetch threw:", e.message);
    const violation = recentCspViolationFor(url);
    if (violation) {
      return {
        kind: "csp_blocked",
        detail: `Bloqué par une politique de sécurité (CSP) du navigateur/de l'hébergeur : ${violation.blockedURI} — la requête n'a jamais quitté le navigateur.`,
      };
    }
    return {
      kind: "network_error",
      detail: `Échec réseau après réessais (${e.message}). Cause probable : CORS (vérifie CORS_ORIGIN sur Render), backend qui n'a jamais fini de démarrer, ou URL incorrecte.`,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Storage helpers — plain localStorage (this build runs outside the  */
/*  Claude artifact sandbox, so window.storage is not available here). */
/* ------------------------------------------------------------------ */
async function loadProjects() {
  try {
    const raw = localStorage.getItem("forge:projects");
    return raw ? JSON.parse(raw) : [];
  } catch (_) {
    return [];
  }
}
async function saveProjects(projects) {
  try {
    localStorage.setItem("forge:projects", JSON.stringify(projects));
  } catch (_) {}
}

/* ------------------------------------------------------------------ */
/*  Root component                                                     */
/* ------------------------------------------------------------------ */
export default function ForgeAI() {
  const [view, setView] = useState("dashboard");
  const [projects, setProjects] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [toast, setToast] = useState(null);
  const [backendUrl, setBackendUrlState] = useState(DEFAULT_BACKEND_URL);
  AI_BACKEND_URL = DEFAULT_BACKEND_URL;

  useEffect(() => {
    (async () => {
      const p = await loadProjects();
      setProjects(p);
      if (p.length) setActiveId(p[0].id);
      try {
        const saved = localStorage.getItem("forge:backendUrl");
        const url = saved || DEFAULT_BACKEND_URL;
        setBackendUrlState(url);
        AI_BACKEND_URL = url;
      } catch (_) {}
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (loaded) saveProjects(projects);
  }, [projects, loaded]);

  function setBackendUrl(url) {
    setBackendUrlState(url);
    AI_BACKEND_URL = url;
    try { localStorage.setItem("forge:backendUrl", url); } catch (_) {}
  }

  const showToast = useCallback((msg, kind = "info") => {
    setToast({ msg, kind, id: uid() });
    setTimeout(() => setToast((t) => (t && t.msg === msg ? null : t)), 3200);
  }, []);

  const activeProject = projects.find((p) => p.id === activeId) || null;

  function updateActiveProject(patch) {
    setProjects((prev) =>
      prev.map((p) => (p.id === activeId ? { ...p, ...patch(p) } : p))
    );
  }

  function createProject(name, promptSeed) {
    const proj = {
      id: uid(),
      name: name || "Nouveau projet",
      prompt: promptSeed || "",
      createdAt: Date.now(),
      steps: {}, // key -> { status: 'pending'|'done', output }
      remaining: STEP_DEFS.map((s) => s.key),
      system: null, // structured generated system
      chat: [],
      versions: [],
      connectionCode: genConnectionCode(),
    };
    setProjects((prev) => [proj, ...prev]);
    setActiveId(proj.id);
    setView("builder");
    return proj.id;
  }

  function deleteProject(id) {
    setProjects((prev) => prev.filter((p) => p.id !== id));
    if (activeId === id) setActiveId(null);
  }

  return (
    <div className="forge-root">
      <style>{`
        ${FONT_IMPORT}
        .forge-root {
          --void: #0a0c10;
          --surface: #12151b;
          --surface2: #191d25;
          --border: #262b34;
          --text: #eceef2;
          --muted: #8a93a3;
          --ember: #ff7a32;
          --ember2: #ffb347;
          --violet: #8b7cff;
          --success: #3ddc97;
          --danger: #ff5c6c;
          font-family: 'Inter', -apple-system, sans-serif;
          background: var(--void);
          color: var(--text);
          min-height: 100%;
          display: flex;
          width: 100%;
          position: relative;
          overflow: hidden;
        }
        .forge-root * { box-sizing: border-box; }
        .fdisplay { font-family: 'Space Grotesk', 'Inter', sans-serif; }
        .fmono { font-family: 'JetBrains Mono', monospace; }
        .scrollbar::-webkit-scrollbar { width: 8px; height: 8px; }
        .scrollbar::-webkit-scrollbar-thumb { background: var(--border); border-radius: 8px; }
        .scrollbar::-webkit-scrollbar-track { background: transparent; }
        @keyframes emberPulse {
          0%, 100% { opacity: .55; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.15); }
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .spin { animation: spin 1s linear infinite; }
        .ember-dot {
          width: 8px; height: 8px; border-radius: 50%;
          background: radial-gradient(circle at 30% 30%, var(--ember2), var(--ember));
          box-shadow: 0 0 12px 2px rgba(255,122,50,.55);
          animation: emberPulse 1.8s ease-in-out infinite;
        }
        .glass {
          background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01));
          border: 1px solid var(--border);
          backdrop-filter: blur(6px);
        }
        .btn-ember {
          background: linear-gradient(135deg, var(--ember), #e85f1c);
          color: #140900;
          font-weight: 600;
          border: none;
        }
        .btn-ember:hover { filter: brightness(1.08); }
        .btn-ghost {
          background: var(--surface2);
          border: 1px solid var(--border);
          color: var(--text);
        }
        .btn-ghost:hover { border-color: #3a4150; }
        .btn-violet {
          background: linear-gradient(135deg, var(--violet), #6a5acd);
          color: #fff; border: none; font-weight: 600;
        }
        .nav-item {
          display: flex; align-items: center; gap: 10px;
          padding: 9px 12px; border-radius: 10px; cursor: pointer;
          color: var(--muted); font-size: 13.5px; font-weight: 500;
          transition: all .15s ease;
        }
        .nav-item:hover { background: var(--surface2); color: var(--text); }
        .nav-item.active {
          background: linear-gradient(90deg, rgba(255,122,50,.14), rgba(255,122,50,.03));
          color: var(--text);
          border-left: 2px solid var(--ember);
          padding-left: 10px;
        }
        input, textarea, select {
          background: var(--surface2);
          border: 1px solid var(--border);
          color: var(--text);
          border-radius: 10px;
          outline: none;
          font-family: inherit;
        }
        input:focus, textarea:focus, select:focus { border-color: var(--ember); }
        .card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; }
        .tag {
          font-size: 11px; padding: 2px 8px; border-radius: 999px;
          border: 1px solid var(--border); color: var(--muted);
        }
      `}</style>

      <Sidebar view={view} setView={setView} projectName={activeProject?.name} />

      <main className="scrollbar" style={{ flex: 1, overflowY: "auto", padding: "28px 34px", minWidth: 0 }}>
        {view === "dashboard" && (
          <Dashboard
            projects={projects}
            onOpen={(id) => { setActiveId(id); setView("builder"); }}
            onCreate={createProject}
          />
        )}
        {view === "projects" && (
          <ProjectsView
            projects={projects}
            onOpen={(id) => { setActiveId(id); setView("builder"); }}
            onDelete={deleteProject}
            onCreate={createProject}
          />
        )}
        {(view === "builder" || view === "combat" || view === "vfx") && (
          <BuilderView
            project={activeProject}
            focus={view}
            createProject={createProject}
            update={updateActiveProject}
            showToast={showToast}
            backendUrl={backendUrl}
          />
        )}
        {view === "code" && (
          <CodeView project={activeProject} showToast={showToast} />
        )}
        {view === "debugger" && (
          <DebuggerView project={activeProject} update={updateActiveProject} showToast={showToast} />
        )}
        {view === "studio" && (
          <StudioView
            project={activeProject}
            showToast={showToast}
            backendUrl={backendUrl}
            setBackendUrl={setBackendUrl}
          />
        )}
        {view === "history" && <HistoryView project={activeProject} update={updateActiveProject} />}
        {view === "settings" && (
          <SettingsView showToast={showToast} backendUrl={backendUrl} setBackendUrl={setBackendUrl} />
        )}
      </main>

      {toast && (
        <div style={{
          position: "fixed", bottom: 24, right: 28, zIndex: 50,
          padding: "12px 16px", borderRadius: 12,
          background: toast.kind === "error" ? "rgba(255,92,108,.15)" : "rgba(61,220,151,.12)",
          border: `1px solid ${toast.kind === "error" ? "#ff5c6c55" : "#3ddc9755"}`,
          color: toast.kind === "error" ? "#ff9aa4" : "#8ff4c9",
          fontSize: 13, maxWidth: 360, display: "flex", gap: 8, alignItems: "flex-start",
        }}>
          {toast.kind === "error" ? <AlertTriangle size={16} style={{ marginTop: 1, flexShrink: 0 }} /> : <CheckCircle2 size={16} style={{ marginTop: 1, flexShrink: 0 }} />}
          <span>{toast.msg}</span>
        </div>
      )}
    </div>
  );
}

function genConnectionCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/* ------------------------------------------------------------------ */
/*  Sidebar                                                            */
/* ------------------------------------------------------------------ */
function Sidebar({ view, setView, projectName }) {
  return (
    <aside style={{
      width: 232, flexShrink: 0, borderRight: "1px solid var(--border)",
      background: "var(--surface)", padding: "20px 14px", display: "flex", flexDirection: "column",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 8px 22px" }}>
        <div style={{
          width: 34, height: 34, borderRadius: 10,
          background: "linear-gradient(135deg, var(--ember), var(--violet))",
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: "0 0 18px rgba(255,122,50,.35)",
        }}>
          <Flame size={18} color="#0a0c10" strokeWidth={2.5} />
        </div>
        <div>
          <div className="fdisplay" style={{ fontSize: 16, fontWeight: 700, lineHeight: 1 }}>FORGE AI</div>
          <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>Build anything in Roblox with AI.</div>
        </div>
      </div>

      <nav style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {NAV.map((n) => (
          <div key={n.id} className={`nav-item ${view === n.id ? "active" : ""}`} onClick={() => setView(n.id)}>
            <n.icon size={16} strokeWidth={2} />
            {n.label}
          </div>
        ))}
      </nav>

      <div style={{ marginTop: "auto", paddingTop: 16 }}>
        {projectName && (
          <div className="tag" style={{ display: "block", marginBottom: 10, padding: "8px 10px", borderRadius: 10 }}>
            <div style={{ fontSize: 10, opacity: .7, marginBottom: 2 }}>PROJET ACTIF</div>
            <div style={{ color: "var(--text)", fontSize: 12.5, fontWeight: 500 }}>{projectName}</div>
          </div>
        )}
        <div style={{ fontSize: 10.5, color: "var(--muted)", padding: "0 8px", lineHeight: 1.5 }}>
          Génération IA réelle via l'API Anthropic. Aucune étape affichée n'est simulée.
        </div>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/*  Dashboard                                                           */
/* ------------------------------------------------------------------ */
function Dashboard({ projects, onOpen, onCreate }) {
  const [prompt, setPrompt] = useState("");
  return (
    <div style={{ maxWidth: 980 }}>
      <div style={{ marginBottom: 26 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span className="ember-dot" />
          <span style={{ fontSize: 12, color: "var(--muted)", letterSpacing: .5 }}>FORGE AI — ROBLOX COPILOT</span>
        </div>
        <h1 className="fdisplay" style={{ fontSize: 34, fontWeight: 700, margin: 0 }}>
          Décris ton système. On le forge.
        </h1>
        <p style={{ color: "var(--muted)", fontSize: 14.5, marginTop: 8, maxWidth: 620 }}>
          Web swing, combat anime, capacités de type domaine — décris ta mécanique en langage naturel,
          Forge AI construit l'architecture Luau complète : serveur, client, VFX, SFX, animations.
        </p>
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 26 }}>
        <textarea
          rows={4}
          placeholder="Ex: Crée les pouvoirs de Spider-Man avec une toile qui s'accroche aux bâtiments, un déplacement rapide vers la cible, une hitbox et un cooldown de 5 secondes."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          style={{ width: "100%", padding: 14, fontSize: 14, resize: "vertical" }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12, gap: 10 }}>
          <button
            className="btn-ember"
            style={{ padding: "10px 20px", borderRadius: 10, fontSize: 13.5, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
            onClick={() => onCreate(prompt.slice(0, 42) || "Nouveau système", prompt)}
            disabled={!prompt.trim()}
          >
            <Wand2 size={15} /> GENERATE
          </button>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <h2 className="fdisplay" style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Projets récents</h2>
      </div>
      {projects.length === 0 ? (
        <div className="card" style={{ padding: 30, textAlign: "center", color: "var(--muted)", fontSize: 13.5 }}>
          Aucun projet pour l'instant. Décris un système ci-dessus pour créer ton premier build.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
          {projects.slice(0, 6).map((p) => (
            <div key={p.id} className="card" style={{ padding: 16, cursor: "pointer" }} onClick={() => onOpen(p.id)}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{p.name}</div>
                <ChevronRight size={15} color="var(--muted)" />
              </div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                {p.prompt || "—"}
              </div>
              <div style={{ marginTop: 12, display: "flex", gap: 6 }}>
                <span className="tag">{p.system?.files?.length || 0} fichiers</span>
                <span className="tag">{p.remaining?.length ? `${p.remaining.length} étapes restantes` : "complet"}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Projects list view                                                 */
/* ------------------------------------------------------------------ */
function ProjectsView({ projects, onOpen, onDelete, onCreate }) {
  const [name, setName] = useState("");
  return (
    <div style={{ maxWidth: 900 }}>
      <h1 className="fdisplay" style={{ fontSize: 24, fontWeight: 700, marginBottom: 16 }}>My Projects</h1>
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <input placeholder="Nom du projet" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, padding: "10px 14px", fontSize: 13.5 }} />
        <button className="btn-ember" style={{ padding: "10px 16px", borderRadius: 10, fontSize: 13, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
          onClick={() => { onCreate(name || "Nouveau projet", ""); setName(""); }}>
          <Plus size={15} /> Nouveau projet
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {projects.map((p) => (
          <div key={p.id} className="card" style={{ padding: 14, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ cursor: "pointer", flex: 1 }} onClick={() => onOpen(p.id)}>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>{p.name}</div>
              <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 2 }}>
                {new Date(p.createdAt).toLocaleString("fr-FR")} · {p.system?.files?.length || 0} fichiers
              </div>
            </div>
            <button className="btn-ghost" style={{ padding: 8, borderRadius: 8, cursor: "pointer" }} onClick={() => onDelete(p.id)}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {projects.length === 0 && <div style={{ color: "var(--muted)", fontSize: 13 }}>Aucun projet.</div>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Builder view — real phased generation                              */
/* ------------------------------------------------------------------ */
function BuilderView({ project, focus, createProject, update, showToast, backendUrl }) {
  const [prompt, setPrompt] = useState(project?.prompt || "");
  const [busy, setBusy] = useState(false);
  const [busyStep, setBusyStep] = useState(null);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [buildResult, setBuildResult] = useState(null); // { status, error, fileCount, id }
  const [blockedAssets, setBlockedAssets] = useState(null); // placeholder issues blocking send
  const chatEndRef = useRef(null);

  async function sendToStudio() {
    if (!project?.system?.files?.length) return;
    if (!backendUrl) {
      showToast("Configure d'abord l'URL du backend dans la page Roblox Studio.", "error");
      return;
    }

    // Hard safety gate: never send a placeholder-looking Asset ID to Roblox
    // Studio, regardless of what the model claimed. Deterministic, not
    // dependent on the LLM having followed instructions correctly.
    const placeholderIssues = findPlaceholderIssues(project.system.files);
    if (placeholderIssues.length) {
      setBlockedAssets(placeholderIssues);
      showToast(`🔴 Envoi bloqué : ${placeholderIssues.length} référence(s) d'asset placeholder détectée(s). Corrige-les d'abord (voir détail ci-dessous).`, "error");
      return;
    }

    // Same failure mode as the backend's own check (path/name/type required
    // per file) — catch it client-side first so the error names the exact
    // file instead of a bare 400 with nothing actionable.
    const malformedFiles = project.system.files
      .map((f, i) => ({ index: i, name: f?.name || "(sans nom)", missing: ["path", "name", "type"].filter((k) => !f || !f[k]) }))
      .filter((f) => f.missing.length > 0);
    if (malformedFiles.length) {
      setBlockedAssets(malformedFiles.map((f) => ({ path: "?", name: f.name, field: `champs manquants: ${f.missing.join(", ")}` })));
      showToast(`🔴 Envoi bloqué : ${malformedFiles.length} fichier(s) incomplet(s) (path/name/type manquant). Régénère l'étape concernée ou corrige via le chat.`, "error");
      return;
    }
    setBlockedAssets(null);

    // Fail fast with a specific message instead of letting an invalid
    // payload round-trip to the backend and come back as a generic 400.
    if (!project.connectionCode) {
      showToast("🔴 Envoi bloqué : ce projet n'a pas de code de connexion (donnée ancienne/corrompue). Recrée le projet.", "error");
      return;
    }
    const systemName = project.system.system_name || project.name || "Système Forge AI";
    if (!project.system.system_name) {
      console.warn("[Forge AI] system_name manquant dans project.system — fallback appliqué:", systemName);
    }

    setSending(true);
    setBuildResult(null);
    try {
      const r = await backendSendBuild(
        backendUrl, project.connectionCode, systemName, project.system.files, project.id,
        (attempt, total, reason) => showToast(`Réveil du backend... tentative ${attempt}/${total} (${reason})`)
      );
      const fileCount = project.system.files.length;
      if (r.connected) {
        showToast("🟢 Build envoyé à Roblox Studio");
      } else {
        showToast("🟡 Build ajouté à la file d'attente — sera livré à la reconnexion du plugin");
      }
      setBuildResult({ id: r.build_id, status: r.connected ? "sent" : "queued", fileCount });
      // Poll for the plugin's real result (delivered/failed) for a short while.
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts += 1;
        try {
          const hist = await backendBuildHistory(backendUrl, project.connectionCode);
          const b = (hist.builds || []).find((x) => x.id === r.build_id);
          if (b && (b.status === "delivered" || b.status === "failed")) {
            setBuildResult({ id: b.id, status: b.status, fileCount: b.created_count ?? b.file_count ?? fileCount, error: b.error });
            clearInterval(poll);
          }
        } catch (_) {}
        if (attempts >= 10) clearInterval(poll); // ~30s ceiling
      }, 3000);
    } catch (e) {
      if (e.body?.code === "PLACEHOLDER_ASSET_ID" && Array.isArray(e.body.detail)) {
        setBlockedAssets(e.body.detail);
        showToast("🔴 Le backend a refusé le build : référence(s) d'asset placeholder détectée(s).", "error");
      } else if (e.body?.code === "MALFORMED_FILE" && Array.isArray(e.body.detail)) {
        setBlockedAssets(e.body.detail.map((d) => ({ path: `fichier #${d.index}`, name: d.name, field: `champs manquants: ${d.missing.join(", ")}` })));
        showToast("🔴 Le backend a refusé le build : fichier(s) incomplet(s) (voir détail ci-dessous).", "error");
      } else {
        showToast(`Échec de l'envoi : ${e.message}`, "error");
      }
    } finally {
      setSending(false);
    }
  }

  useEffect(() => { setPrompt(project?.prompt || ""); }, [project?.id]);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [project?.chat?.length]);

  if (!project) {
    return (
      <EmptyBuilder
        prompt={prompt}
        setPrompt={setPrompt}
        onCreate={() => createProject(prompt.slice(0, 42) || "Nouveau système", prompt)}
      />
    );
  }

  async function runAnalysis() {
    setBusy(true); setBusyStep("analysis");
    try {
      const text = await callClaude(
        [{ role: "user", content: `Demande utilisateur : "${prompt}"\n\nAnalyse cette demande de système Roblox en 4-6 lignes : mécaniques, contrôles, dépendances techniques. Réponds en texte simple, pas de JSON.` }],
        { json: false }
      );
      update((p) => ({
        prompt,
        steps: { ...p.steps, analysis: { status: "done", output: text } },
        remaining: p.remaining.filter((s) => s !== "analysis"),
      }));
      showToast("Analyse terminée.");
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setBusy(false); setBusyStep(null);
    }
  }

  async function runArchitecture() {
    setBusy(true); setBusyStep("architecture");
    try {
      const schema = `{"system_name": "...", "summary": "...", "files": [{"path":"...", "type":"Script|LocalScript|ModuleScript|Folder|RemoteEvent|RemoteFunction", "name":"...", "code":"..."}], "abilities": [{"name":"...", "description":"...", "keybind":"...", "cooldown":0, "damage":0, "range":0}], "assets": [{"name":"...", "type":"animation|sfx|vfx|mesh|texture", "status":"PROCEDURAL|MISSING_ASSET|OPTIONAL_MISSING", "assetId": null}], "warnings": ["..."]}`;
      const analysisCtx = project.steps?.analysis?.output ? `Analyse préalable : ${project.steps.analysis.output}\n\n` : "";
      const result = await callClaude([{
        role: "user",
        content: `${analysisCtx}Demande : "${prompt}"\n\nGénère l'architecture Roblox de base et UN SEUL fichier Luau court (20-30 lignes max) mais réellement fonctionnel et prioritaire (le plus important pour cette mécanique). Commentaires brefs. Réponds STRICTEMENT avec ce schéma JSON, sans aucun texte autour, JSON complet et valide obligatoire :\n${schema}\n\nTu pourras ajouter d'autres fichiers ensuite via les étapes suivantes ou le chat. Rappel : jamais de faux Asset ID ni de texte placeholder dans "code".`,
      }]);
      const placeholderIssues = findPlaceholderIssues(result.files);
      const malformedFiles = findMalformedFiles(result.files);
      if (placeholderIssues.length || malformedFiles.length) {
        result.validation = {
          errors: [
            ...placeholderIssues.map((i) => `PLACEHOLDER_ASSET_ID: ${i.path}/${i.name} (${i.field}) contient une référence d'asset placeholder — corrige avant d'envoyer à Roblox Studio.`),
            ...malformedFiles.map((f) => `MALFORMED_FILE: ${f.name} — champ(s) manquant(s) : ${f.missing.join(", ")}. Corrige via le chat avant d'envoyer à Roblox Studio.`),
          ],
          warnings: [], suggestions: [],
        };
      }
      update((p) => ({
        system: result,
        steps: { ...p.steps, architecture: { status: "done" } },
        remaining: p.remaining.filter((s) => s !== "architecture"),
        versions: [...(p.versions || []), { id: uid(), label: "v1 — Architecture", system: result, ts: Date.now() }],
      }));
      showToast("Architecture et fichiers de base générés.");
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setBusy(false); setBusyStep(null);
    }
  }

  async function runFollowStep(stepKey) {
    if (!project.system) { showToast("Génère d'abord l'architecture.", "error"); return; }
    setBusy(true); setBusyStep(stepKey);
    const instructions = {
      vfx: `Ajoute UN SEUL fichier ModuleScript VFX court (ParticleEmitter/Beam/Trail configurés, synchronisé avec les événements de gameplay — priorise le procédural, aucun asset externe requis normalement). Réponds en JSON: {"new_files":[{...}], "vfx":["..."], "assets":[{"name":"...","type":"vfx","status":"PROCEDURAL|MISSING_ASSET|OPTIONAL_MISSING","assetId":null}]}`,
      sfx: `Ajoute UN SEUL fichier de configuration SFX court (des objets Sound, SANS assigner de SoundId — laisse-le absent/vide, chaque son nécessitant un vrai asset externe doit être déclaré dans "assets" avec status MISSING_ASSET). Réponds en JSON: {"new_files":[{...}], "sfx":["..."], "assets":[{"name":"...","type":"sfx","status":"MISSING_ASSET|OPTIONAL_MISSING","assetId":null}]}`,
      animations: `Ajoute UN SEUL fichier court regroupant les Animation objects nécessaires (SANS assigner d'AnimationId — laisse-le absent/vide) et leur lecture, plus une déclaration "assets" pour chaque animation avec status MISSING_ASSET puisqu'aucun ID vérifié n'est disponible. Réponds en JSON: {"new_files":[{...}], "animations":["..."], "assets":[{"name":"...","type":"animation","status":"MISSING_ASSET|OPTIONAL_MISSING","assetId":null}]}`,
      validation: `Relis les fichiers existants (résumé fourni) et retourne une validation courte (3-5 points max par catégorie), en signalant explicitement tout Asset ID suspect/inventé que tu repérerais. Réponds en JSON: {"errors":["..."], "warnings":["..."], "suggestions":["..."]}`,
    };
    try {
      const filesSummary = project.system.files.map((f) => `${f.path}/${f.name} (${f.type})`).join(", ");
      const result = await callClaude([{
        role: "user",
        content: `Système : "${project.system.system_name}". Demande initiale : "${prompt}". Fichiers existants : ${filesSummary}.\n\n${instructions[stepKey]}\n\nSois extrêmement concis. Code réellement fonctionnel uniquement, JSON complet et valide. Rappel : jamais de faux Asset ID ni de texte placeholder dans "code" ou "properties".`,
      }]);

      update((p) => {
        const sys = { ...p.system };
        if (result.new_files) sys.files = [...sys.files, ...result.new_files];
        if (result.vfx) sys.vfx = [...(sys.vfx || []), ...result.vfx];
        if (result.sfx) sys.sfx = [...(sys.sfx || []), ...result.sfx];
        if (result.animations) sys.animations = [...(sys.animations || []), ...result.animations];
        if (result.assets) sys.assets = [...(sys.assets || []), ...result.assets];

        // Deterministic safety net: scan every file (old + new) for
        // placeholder-looking asset references regardless of what the
        // model claims — this is what actually enforces the no-fake-ID rule.
        const placeholderIssues = findPlaceholderIssues(sys.files);
        const malformedFiles = findMalformedFiles(sys.files);
        const llmErrors = result.errors || [];
        const llmWarnings = result.warnings || [];
        const llmSuggestions = result.suggestions || [];
        if (llmErrors.length || llmWarnings.length || llmSuggestions.length || placeholderIssues.length || malformedFiles.length) {
          sys.validation = {
            errors: [
              ...llmErrors,
              ...placeholderIssues.map((i) => `PLACEHOLDER_ASSET_ID: ${i.path}/${i.name} (${i.field}) contient une référence d'asset placeholder — corrige avant d'envoyer à Roblox Studio.`),
              ...malformedFiles.map((f) => `MALFORMED_FILE: ${f.name} — champ(s) manquant(s) : ${f.missing.join(", ")}. Corrige via le chat avant d'envoyer à Roblox Studio.`),
            ],
            warnings: llmWarnings,
            suggestions: llmSuggestions,
          };
        }

        return {
          system: sys,
          steps: { ...p.steps, [stepKey]: { status: "done" } },
          remaining: p.remaining.filter((s) => s !== stepKey),
          versions: [...(p.versions || []), { id: uid(), label: `v${(p.versions?.length || 0) + 2} — ${STEP_DEFS.find(s => s.key === stepKey)?.label}`, system: sys, ts: Date.now() }],
        };
      });
      showToast(`${STEP_DEFS.find((s) => s.key === stepKey)?.label} terminé.`);
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setBusy(false); setBusyStep(null);
    }
  }

  async function sendChat() {
    if (!chatInput.trim() || !project.system) return;
    const userMsg = chatInput.trim();
    setChatInput("");
    update((p) => ({ chat: [...(p.chat || []), { role: "user", text: userMsg, id: uid() }] }));
    setChatBusy(true);
    try {
      const filesSummary = project.system.files.map((f) => `${f.path}/${f.name}: ${f.code.slice(0, 160).replace(/\n/g, " ")}...`).join("\n");
      const result = await callClaude([{
        role: "user",
        content: `Système actuel "${project.system.system_name}". Fichiers :\n${filesSummary}\n\nDemande de modification : "${userMsg}"\n\nModifie UNIQUEMENT ce qui est nécessaire, au maximum 1-2 fichiers courts. Réponds en JSON: {"reply": "explication courte en français", "updated_files": [{"path":"...","type":"...","name":"...","code":"..."}], "new_files": [{...}]}. "updated_files" remplace des fichiers existants (même path+name), "new_files" en ajoute. JSON complet et valide obligatoire.`,
      }]);
      update((p) => {
        let files = [...p.system.files];
        (result.updated_files || []).forEach((uf) => {
          const idx = files.findIndex((f) => f.path === uf.path && f.name === uf.name);
          if (idx >= 0) files[idx] = uf; else files.push(uf);
        });
        (result.new_files || []).forEach((nf) => files.push(nf));

        const placeholderIssues = findPlaceholderIssues(files);
        const malformedFiles = findMalformedFiles(files);
        const sys = { ...p.system, files };
        if (placeholderIssues.length || malformedFiles.length) {
          sys.validation = {
            ...(p.system.validation || { warnings: [], suggestions: [] }),
            errors: [
              ...((p.system.validation && p.system.validation.errors) || []),
              ...placeholderIssues.map((i) => `PLACEHOLDER_ASSET_ID: ${i.path}/${i.name} (${i.field}) contient une référence d'asset placeholder — corrige avant d'envoyer à Roblox Studio.`),
              ...malformedFiles.map((f) => `MALFORMED_FILE: ${f.name} — champ(s) manquant(s) : ${f.missing.join(", ")}. Corrige via le chat avant d'envoyer à Roblox Studio.`),
            ],
          };
        }

        return {
          system: sys,
          chat: [...(p.chat || []), {
            role: "assistant",
            text: (result.reply || "Modifications appliquées.")
              + (placeholderIssues.length ? " ⚠️ Un Asset ID placeholder a été détecté et signalé dans la validation — corrige-le avant d'envoyer à Roblox Studio." : "")
              + (malformedFiles.length ? ` ⚠️ ${malformedFiles.length} fichier(s) incomplet(s) (champ manquant) — signalé dans la validation.` : ""),
            id: uid(),
          }],
        };
      });
    } catch (e) {
      update((p) => ({ chat: [...(p.chat || []), { role: "assistant", text: `Erreur : ${e.message}`, id: uid() }] }));
    } finally {
      setChatBusy(false);
    }
  }

  const remaining = project.remaining || [];

  return (
    <div style={{ maxWidth: 1040 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <h1 className="fdisplay" style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{project.name}</h1>
        <div style={{ display: "flex", gap: 6 }}>
          {project.system && <span className="tag">{project.system.files.length} fichiers</span>}
          <span className="tag">{remaining.length === 0 ? "Build complet" : `${remaining.length} étape(s) restante(s)`}</span>
        </div>
      </div>

      <div className="card" style={{ padding: 18, marginBottom: 18 }}>
        <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} style={{ width: "100%", padding: 12, fontSize: 13.5 }} placeholder="Describe what you want to build..." />
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button className="btn-ember" style={{ padding: "9px 16px", borderRadius: 9, fontSize: 13, display: "flex", alignItems: "center", gap: 6, cursor: "pointer", opacity: busy ? .6 : 1 }}
            disabled={busy || !prompt.trim()} onClick={runAnalysis}>
            {busyStep === "analysis" ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />} ANALYZE
          </button>
          <button className="btn-violet" style={{ padding: "9px 16px", borderRadius: 9, fontSize: 13, display: "flex", alignItems: "center", gap: 6, cursor: "pointer", opacity: busy ? .6 : 1 }}
            disabled={busy || !prompt.trim()} onClick={runArchitecture}>
            {busyStep === "architecture" ? <Loader2 size={14} className="spin" /> : <Zap size={14} />} BUILD ARCHITECTURE
          </button>
        </div>
      </div>

      {project.steps?.analysis?.output && (
        <div className="card" style={{ padding: 16, marginBottom: 18 }}>
          <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 6, letterSpacing: .4 }}>ANALYSE</div>
          <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{project.steps.analysis.output}</div>
        </div>
      )}

      {/* Progress / remaining steps */}
      <div className="card" style={{ padding: 16, marginBottom: 18 }}>
        <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 10, letterSpacing: .4 }}>PROGRESSION</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {STEP_DEFS.map((s) => {
            const done = project.steps?.[s.key]?.status === "done";
            const isRemaining = remaining.includes(s.key);
            const canRun = s.key === "analysis" ? true : s.key === "architecture" ? !!project.steps?.analysis || true : !!project.system;
            return (
              <div key={s.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                  {done ? <CheckCircle2 size={15} color="var(--success)" /> : <Circle size={15} color="var(--muted)" />}
                  <span style={{ color: done ? "var(--text)" : "var(--muted)" }}>{s.label}</span>
                </div>
                {!done && s.key !== "analysis" && s.key !== "architecture" && (
                  <button className="btn-ghost" style={{ padding: "5px 12px", borderRadius: 8, fontSize: 11.5, cursor: canRun ? "pointer" : "not-allowed", display: "flex", alignItems: "center", gap: 5, opacity: canRun ? 1 : .4 }}
                    disabled={!canRun || busy} onClick={() => runFollowStep(s.key)}>
                    {busyStep === s.key ? <Loader2 size={12} className="spin" /> : <ArrowRight size={12} />} Continue
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {project.system && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              className="btn-violet"
              style={{ padding: "9px 18px", borderRadius: 9, fontSize: 13, display: "flex", alignItems: "center", gap: 6, cursor: "pointer", opacity: sending ? .6 : 1 }}
              disabled={sending}
              onClick={sendToStudio}
            >
              {sending ? <Loader2 size={14} className="spin" /> : <Link2 size={14} />} SEND TO ROBLOX STUDIO
            </button>
          </div>

          {blockedAssets && (
            <div className="card" style={{ padding: 14, marginTop: 10, borderColor: "#3a2020" }}>
              <div style={{ display: "flex", gap: 10 }}>
                <ShieldAlert size={16} color="var(--danger)" style={{ flexShrink: 0, marginTop: 1 }} />
                <div style={{ fontSize: 12.5, lineHeight: 1.7 }}>
                  <strong style={{ color: "var(--danger)" }}>Envoi bloqué — référence(s) d'asset placeholder détectée(s) :</strong>
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18, color: "var(--muted)" }}>
                    {blockedAssets.map((i, idx) => (
                      <li key={idx}><span className="fmono">{i.path}/{i.name}</span> — champ <span className="fmono">{i.field}</span></li>
                    ))}
                  </ul>
                  <div style={{ marginTop: 6, color: "var(--muted)" }}>Corrige via le chat ci-dessous (ex: "remplace l'ID de {blockedAssets[0]?.name} par un asset réel") ou régénère l'étape concernée, puis renvoie.</div>
                </div>
              </div>
            </div>
          )}

          {project.system.assets?.some((a) => a.status === "MISSING_ASSET") && !blockedAssets && (
            <div className="card" style={{ padding: 12, marginTop: 10, borderColor: "#3a3020" }}>
              <div style={{ display: "flex", gap: 8, fontSize: 12, color: "var(--muted)", alignItems: "flex-start" }}>
                <AlertTriangle size={14} color="var(--ember2)" style={{ flexShrink: 0, marginTop: 1 }} />
                <span>{project.system.assets.filter((a) => a.status === "MISSING_ASSET").length} asset(s) sans ID vérifié (voir manifeste ci-dessous) — les instances seront créées mais incomplètes (pas de son/animation) tant que tu n'auras pas fourni un vrai Asset ID. L'envoi reste autorisé.</span>
              </div>
            </div>
          )}

          {buildResult && (
            <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end" }}>
              <div className="card" style={{ padding: "10px 14px", fontSize: 12.5, display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
                {buildResult.status === "sent" && <span>🟢 Build envoyé — {buildResult.fileCount} fichier(s), en attente de confirmation du plugin...</span>}
                {buildResult.status === "queued" && <span>🟡 Build en file d'attente — {buildResult.fileCount} fichier(s), sera livré à la reconnexion du plugin</span>}
                {buildResult.status === "delivered" && <span style={{ color: "var(--success)" }}>🟢 Build livré — {buildResult.fileCount} fichier(s) créés/mis à jour dans Studio</span>}
                {buildResult.status === "failed" && <span style={{ color: "var(--danger)" }}>🔴 Build échoué{buildResult.error ? ` — ${buildResult.error}` : ""}</span>}
              </div>
            </div>
          )}
        </div>
      )}

      {project.system && (
        <GeneratedSystemPanel
          system={project.system}
          backendUrl={backendUrl}
          onAssetResolved={(name, type, patch) => {
            update((p) => ({
              system: {
                ...p.system,
                assets: (p.system.assets || []).map((a) =>
                  a.name === name && a.type === type ? { ...a, ...patch } : a
                ),
              },
            }));
          }}
        />
      )}

      {project.system && (
        <div className="card" style={{ padding: 16, marginTop: 18 }}>
          <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 10, letterSpacing: .4 }}>AI CHAT — ITÉRER SUR LE SYSTÈME</div>
          <div style={{ maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, marginBottom: 10 }} className="scrollbar">
            {(project.chat || []).map((m) => (
              <div key={m.id} style={{
                alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                background: m.role === "user" ? "rgba(139,124,255,.14)" : "var(--surface2)",
                border: "1px solid var(--border)", borderRadius: 10, padding: "8px 12px", fontSize: 13, maxWidth: "80%",
              }}>{m.text}</div>
            ))}
            <div ref={chatEndRef} />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input placeholder="Ex: Ajoute une traînée au dash." value={chatInput} onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendChat()} style={{ flex: 1, padding: "9px 12px", fontSize: 13 }} />
            <button className="btn-ember" style={{ padding: "9px 14px", borderRadius: 9, cursor: "pointer", opacity: chatBusy ? .6 : 1 }} disabled={chatBusy} onClick={sendChat}>
              {chatBusy ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyBuilder({ prompt, setPrompt, onCreate }) {
  return (
    <div style={{ maxWidth: 700, marginTop: 40 }}>
      <h1 className="fdisplay" style={{ fontSize: 24, fontWeight: 700 }}>AI Builder</h1>
      <p style={{ color: "var(--muted)", fontSize: 13.5, marginBottom: 16 }}>Aucun projet actif. Décris ce que tu veux construire pour en démarrer un.</p>
      <textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe what you want to build..." style={{ width: "100%", padding: 14, fontSize: 14 }} />
      <button className="btn-ember" style={{ marginTop: 12, padding: "10px 20px", borderRadius: 10, fontSize: 13.5, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }} disabled={!prompt.trim()} onClick={onCreate}>
        <Wand2 size={15} /> GENERATE
      </button>
    </div>
  );
}

function GeneratedSystemPanel({ system, backendUrl, onAssetResolved }) {
  const [decisions, setDecisions] = useState(null); // Map name::type -> decision object
  const [evaluating, setEvaluating] = useState(false);
  const [evalError, setEvalError] = useState(null);

  async function evaluateQuality() {
    if (!backendUrl || !system.assets?.length) return;
    setEvaluating(true); setEvalError(null);
    try {
      const r = await backendDecideQuality(backendUrl, system.assets);
      const map = {};
      (r.decisions || []).forEach((d) => { map[`${d.asset_name}::${d.asset_type}`] = d; });
      setDecisions(map);
    } catch (e) {
      setEvalError(e.message);
    } finally {
      setEvaluating(false);
    }
  }

  return (
    <div className="card" style={{ padding: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <div>
          <div className="fdisplay" style={{ fontSize: 17, fontWeight: 700 }}>{system.system_name || "Système généré"}</div>
          <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 4 }}>{system.summary}</div>
        </div>
      </div>
      {system.abilities?.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, color: "var(--muted)", letterSpacing: .4, marginBottom: 6 }}>CAPACITÉS</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {system.abilities.map((a, i) => (
              <div key={i} className="tag" style={{ padding: "6px 10px", borderRadius: 8, fontSize: 12 }}>
                <strong>{a.name}</strong>{a.keybind ? ` · ${a.keybind}` : ""}{a.cooldown ? ` · CD ${a.cooldown}s` : ""}
              </div>
            ))}
          </div>
        </div>
      )}
      {system.assets?.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <div style={{ fontSize: 11, color: "var(--muted)", letterSpacing: .4 }}>ASSET MANIFEST</div>
            <button
              onClick={evaluateQuality}
              disabled={evaluating || !backendUrl}
              className="btn-ghost"
              style={{ padding: "4px 10px", borderRadius: 7, fontSize: 10.5, cursor: "pointer", display: "flex", alignItems: "center", gap: 5, opacity: !backendUrl ? .5 : 1 }}
              title={!backendUrl ? "Configure d'abord l'URL du backend" : "Décider REUSE/MODIFY/GENERATE/PROCEDURAL pour chaque asset"}
            >
              {evaluating ? <Loader2 size={11} className="spin" /> : "🧪"} Évaluer la stratégie
            </button>
          </div>
          {evalError && <div style={{ fontSize: 11, color: "var(--danger)", marginBottom: 6 }}>{evalError}</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {system.assets.map((a, i) => (
              <AssetRow
                key={i}
                asset={a}
                backendUrl={backendUrl}
                onResolved={(patch) => onAssetResolved && onAssetResolved(a.name, a.type, patch)}
                decision={decisions ? decisions[`${a.name}::${a.type}`] : null}
              />
            ))}
          </div>
        </div>
      )}
      {(system.vfx?.length > 0 || system.sfx?.length > 0 || system.animations?.length > 0) && (
        <div style={{ display: "flex", gap: 20, marginTop: 14, flexWrap: "wrap" }}>
          {system.vfx?.length > 0 && <MiniList title="VFX" items={system.vfx} />}
          {system.sfx?.length > 0 && <MiniList title="SFX" items={system.sfx} />}
          {system.animations?.length > 0 && <MiniList title="ANIMATIONS" items={system.animations} />}
        </div>
      )}
      {system.validation && (
        <div style={{ marginTop: 14, display: "flex", gap: 16, flexWrap: "wrap" }}>
          <MiniList title="ERRORS" items={system.validation.errors} tone="danger" />
          <MiniList title="WARNINGS" items={system.validation.warnings} tone="warn" />
          <MiniList title="SUGGESTIONS" items={system.validation.suggestions} />
        </div>
      )}
      {system.warnings?.length > 0 && <MiniList title="WARNINGS" items={system.warnings} tone="warn" />}
    </div>
  );
}

function AssetRow({ asset, backendUrl, onResolved, decision }) {
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState(null); // resolution response (candidates, providersChecked, etc.)
  const [expanded, setExpanded] = useState(false);
  const [decisionExpanded, setDecisionExpanded] = useState(false);
  const [err, setErr] = useState(null);

  const cfg = {
    VERIFIED: { icon: "✅", color: "var(--success)", label: "Vérifié" },
    FOUND_UNVERIFIED: { icon: "🔎", color: "var(--ember2)", label: "Trouvé, non vérifié" },
    PROCEDURAL: { icon: "🔧", color: "var(--violet)", label: "Procédural (aucun asset requis)" },
    OPTIONAL_MISSING: { icon: "➖", color: "var(--muted)", label: "Facultatif absent" },
    MISSING_ASSET: { icon: "⚠️", color: "var(--ember2)", label: "Asset manquant" },
    INVALID: { icon: "❌", color: "var(--danger)", label: "Invalide" },
  }[asset.status] || { icon: "❔", color: "var(--muted)", label: asset.status || "Inconnu" };

  const decisionCfg = {
    REUSE: { color: "var(--success)", bg: "rgba(61,220,151,.12)" },
    MODIFY: { color: "var(--ember2)", bg: "rgba(255,179,71,.12)" },
    GENERATE: { color: "var(--violet)", bg: "rgba(139,124,255,.12)" },
    PROCEDURAL: { color: "var(--violet)", bg: "rgba(139,124,255,.12)" },
    OPTIONAL_MISSING: { color: "var(--muted)", bg: "rgba(138,147,163,.10)" },
    BLOCK_BUILD: { color: "var(--danger)", bg: "rgba(255,92,108,.14)" },
  };

  const canSearch = asset.status === "MISSING_ASSET" || asset.status === "OPTIONAL_MISSING";

  async function doSearch() {
    if (!backendUrl) { setErr("Configure d'abord l'URL du backend (page Roblox Studio)."); return; }
    setSearching(true); setErr(null);
    try {
      const r = await backendResolveAsset(backendUrl, { name: asset.name, type: asset.type, searchTerm: asset.name });
      setResult(r);
      setExpanded(true);
    } catch (e) {
      setErr(e.message);
    } finally {
      setSearching(false);
    }
  }

  const [justUsed, setJustUsed] = useState(null);

  function useCandidate(c) {
    onResolved && onResolved({ status: c.status, assetId: c.assetId, source: c.source, sourceUrl: c.sourceUrl, license: c.license });
    setJustUsed(c);
    setExpanded(false);
  }

  return (
    <div style={{ borderRadius: 8, background: "var(--surface2)", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, padding: "6px 10px" }}>
        <span>{cfg.icon}</span>
        <span style={{ fontWeight: 600 }}>{asset.name}</span>
        <span className="tag" style={{ fontSize: 10 }}>{asset.type}</span>
        <span style={{ color: cfg.color, marginLeft: "auto", fontSize: 11.5 }}>{cfg.label}</span>
        {asset.assetId && <span className="fmono" style={{ fontSize: 10.5, color: "var(--muted)" }}>{asset.assetId}</span>}
        {asset.sourceUrl && (
          <a href={asset.sourceUrl} target="_blank" rel="noreferrer" style={{ color: "var(--violet)", fontSize: 10.5 }}>source</a>
        )}
        {decision && (
          <span
            onClick={() => setDecisionExpanded((e) => !e)}
            style={{
              padding: "2px 8px", borderRadius: 999, fontSize: 10, fontWeight: 700, cursor: "pointer",
              color: (decisionCfg[decision.decision] || {}).color || "var(--muted)",
              background: (decisionCfg[decision.decision] || {}).bg || "transparent",
            }}
            title={`Priorité : ${decision.priority}`}
          >
            {decision.decision}
          </span>
        )}
        {canSearch && (
          <button
            onClick={doSearch}
            disabled={searching}
            className="btn-ghost"
            style={{ padding: "3px 8px", borderRadius: 6, fontSize: 10.5, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}
          >
            {searching ? <Loader2 size={11} className="spin" /> : "🔍"} Search
          </button>
        )}
        {result && (
          <button onClick={() => setExpanded((e) => !e)} className="btn-ghost" style={{ padding: "3px 6px", borderRadius: 6, fontSize: 10.5, cursor: "pointer" }}>
            {expanded ? "▲" : "▼"}
          </button>
        )}
      </div>

      {decisionExpanded && decision && (
        <div style={{ padding: "0 10px 10px", fontSize: 11, color: "var(--muted)", lineHeight: 1.6 }}>
          <div>{decision.reason}</div>
          <div style={{ marginTop: 4, display: "flex", gap: 12, flexWrap: "wrap" }}>
            <span>Qualité: {decision.quality_score}</span>
            <span>Compatibilité: {decision.compatibility_score}</span>
            <span>Fit visuel: {decision.visual_fit_score}</span>
            <span>Fit fonctionnel: {decision.functional_fit_score}</span>
          </div>
        </div>
      )}

      {err && <div style={{ padding: "0 10px 8px", fontSize: 11, color: "var(--danger)" }}>{err}</div>}

      {justUsed && (
        <div style={{ padding: "0 10px 8px", fontSize: 11, color: "var(--muted)", lineHeight: 1.6 }}>
          Manifeste mis à jour ({justUsed.status}, non injecté automatiquement dans le code par sécurité — pas de correspondance
          garantie champ-par-champ). Va dans le chat et demande : <span className="fmono">"Utilise l'ID {justUsed.assetId || "trouvé"} pour {asset.name}"</span> pour l'appliquer réellement au fichier concerné.
        </div>
      )}

      {expanded && result && (
        <div style={{ padding: "0 10px 10px", borderTop: "1px solid var(--border)", marginTop: 2, paddingTop: 8 }}>
          <div style={{ fontSize: 10.5, color: "var(--muted)", marginBottom: 6 }}>
            Providers consultés : {result.providersChecked?.map((p) => `${p.provider}${p.available ? "" : " (indisponible)"}`).join(", ") || "—"}
          </div>
          {result.candidates?.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {result.candidates.map((c, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, padding: "5px 8px", background: "var(--surface)", borderRadius: 6 }}>
                  <span style={{ flex: 1 }}>{c.name} <span style={{ color: "var(--muted)" }}>· {c.source}</span></span>
                  {c.assetId && <span className="fmono" style={{ fontSize: 10, color: "var(--muted)" }}>{c.assetId}</span>}
                  {c.sourceUrl && <a href={c.sourceUrl} target="_blank" rel="noreferrer" style={{ fontSize: 10, color: "var(--violet)" }}>voir</a>}
                  <button onClick={() => useCandidate(c)} className="btn-ember" style={{ padding: "3px 8px", borderRadius: 5, fontSize: 10, cursor: "pointer" }}>Utiliser</button>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 11, color: "var(--muted)" }}>Aucun candidat trouvé — reste MISSING_ASSET. {result.rawSummary}</div>
          )}
        </div>
      )}
    </div>
  );
}

function MiniList({ title, items, tone }) {
  if (!items || items.length === 0) return null;
  const color = tone === "danger" ? "var(--danger)" : tone === "warn" ? "var(--ember2)" : "var(--muted)";
  return (
    <div style={{ minWidth: 160 }}>
      <div style={{ fontSize: 11, color, letterSpacing: .4, marginBottom: 6 }}>{title}</div>
      <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12.5, color: "var(--text)", lineHeight: 1.7 }}>
        {items.map((it, i) => <li key={i}>{it}</li>)}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Code viewer                                                        */
/* ------------------------------------------------------------------ */
function CodeView({ project, showToast }) {
  const files = project?.system?.files || [];
  const [selected, setSelected] = useState(0);

  if (!project || files.length === 0) {
    return <div style={{ color: "var(--muted)", fontSize: 13.5 }}>Aucun fichier généré pour l'instant. Va dans AI Builder pour générer un système.</div>;
  }
  const file = files[selected];

  function copy() {
    navigator.clipboard.writeText(file.code).then(() => showToast("Code copié."));
  }
  function download() {
    const blob = new Blob([file.code], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${file.name}.lua`; a.click();
    URL.revokeObjectURL(url);
  }
  function downloadAll() {
    const manifest = files.map((f) => `-- ${f.path}/${f.name}.lua (${f.type})\n${f.code}`).join("\n\n" + "-".repeat(60) + "\n\n");
    const blob = new Blob([manifest], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${project.system.system_name || "forge_system"}.lua`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ display: "flex", gap: 16, height: "calc(100vh - 100px)" }}>
      <div className="card scrollbar" style={{ width: 260, flexShrink: 0, padding: 10, overflowY: "auto" }}>
        <div style={{ fontSize: 11, color: "var(--muted)", padding: "6px 8px", letterSpacing: .4 }}>ARBORESCENCE</div>
        {files.map((f, i) => (
          <div key={i} onClick={() => setSelected(i)} style={{
            display: "flex", alignItems: "center", gap: 8, padding: "8px 8px", borderRadius: 8, cursor: "pointer", fontSize: 12.5,
            background: selected === i ? "var(--surface2)" : "transparent", color: selected === i ? "var(--text)" : "var(--muted)",
          }}>
            <FileCode2 size={14} />
            <div style={{ overflow: "hidden" }}>
              <div style={{ whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>{f.name}</div>
              <div style={{ fontSize: 10, opacity: .6 }}>{f.path}</div>
            </div>
          </div>
        ))}
        <button className="btn-ghost" style={{ width: "100%", marginTop: 10, padding: "8px", borderRadius: 8, fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }} onClick={downloadAll}>
          <Download size={13} /> Tout télécharger
        </button>
      </div>

      <div className="card" style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
          <div className="fmono" style={{ fontSize: 12.5, color: "var(--muted)" }}>{file.path}/{file.name}.lua</div>
          <div style={{ display: "flex", gap: 6 }}>
            <span className="tag">{file.type}</span>
            <button className="btn-ghost" style={{ padding: "5px 10px", borderRadius: 7, cursor: "pointer", display: "flex", alignItems: "center", gap: 5, fontSize: 11.5 }} onClick={copy}><Copy size={12} /> Copy</button>
            <button className="btn-ghost" style={{ padding: "5px 10px", borderRadius: 7, cursor: "pointer", display: "flex", alignItems: "center", gap: 5, fontSize: 11.5 }} onClick={download}><Download size={12} /> Download</button>
          </div>
        </div>
        <pre className="fmono scrollbar" style={{ flex: 1, margin: 0, padding: 18, fontSize: 12.5, lineHeight: 1.6, overflow: "auto", color: "#c9d1d9" }}>{file.code}</pre>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Debugger — Fix With AI                                             */
/* ------------------------------------------------------------------ */
function DebuggerView({ project, update, showToast }) {
  const [error, setError] = useState("");
  const [fileIdx, setFileIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const files = project?.system?.files || [];

  async function fix() {
    if (!error.trim() || files.length === 0) return;
    setBusy(true); setResult(null);
    try {
      const file = files[fileIdx];
      const r = await callClaude([{
        role: "user",
        content: `Fichier ${file.path}/${file.name} (${file.type}) :\n\`\`\`lua\n${file.code}\n\`\`\`\n\nErreur/warning Roblox rencontrée :\n"${error}"\n\nDiagnostique la cause et corrige. Réponds en JSON: {"diagnosis":"...", "fixed_code":"..."}`,
      }]);
      setResult(r);
    } catch (e) {
      showToast(e.message, "error");
    } finally {
      setBusy(false);
    }
  }

  function accept() {
    update((p) => {
      const files2 = [...p.system.files];
      files2[fileIdx] = { ...files2[fileIdx], code: result.fixed_code };
      return { system: { ...p.system, files: files2 } };
    });
    showToast("Correctif appliqué.");
    setResult(null); setError("");
  }

  if (!project || files.length === 0) {
    return <div style={{ color: "var(--muted)", fontSize: 13.5 }}>Génère d'abord un système dans AI Builder pour utiliser le débogueur.</div>;
  }

  return (
    <div style={{ maxWidth: 900 }}>
      <h1 className="fdisplay" style={{ fontSize: 22, fontWeight: 700, marginBottom: 16 }}>Auto Debugger</h1>
      <div className="card" style={{ padding: 18 }}>
        <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 6 }}>FICHIER CONCERNÉ</div>
        <select value={fileIdx} onChange={(e) => setFileIdx(Number(e.target.value))} style={{ width: "100%", padding: "9px 12px", fontSize: 13, marginBottom: 14 }}>
          {files.map((f, i) => <option key={i} value={i}>{f.path}/{f.name}</option>)}
        </select>
        <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 6 }}>ERREUR / STACK TRACE</div>
        <textarea rows={4} value={error} onChange={(e) => setError(e.target.value)} placeholder='Ex: Infinite yield possible on ReplicatedStorage:WaitForChild("WebSystem")' style={{ width: "100%", padding: 12, fontSize: 13 }} className="fmono" />
        <button className="btn-ember" style={{ marginTop: 12, padding: "9px 18px", borderRadius: 9, fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, opacity: busy ? .6 : 1 }} disabled={busy || !error.trim()} onClick={fix}>
          {busy ? <Loader2 size={14} className="spin" /> : <Bug size={14} />} FIX WITH AI
        </button>
      </div>

      {result && (
        <div className="card" style={{ padding: 18, marginTop: 16 }}>
          <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 6 }}>DIAGNOSTIC</div>
          <div style={{ fontSize: 13, marginBottom: 14, lineHeight: 1.6 }}>{result.diagnosis}</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <div style={{ fontSize: 11, color: "var(--danger)", marginBottom: 6 }}>BEFORE</div>
              <pre className="fmono scrollbar" style={{ fontSize: 11.5, background: "var(--surface2)", padding: 10, borderRadius: 8, maxHeight: 260, overflow: "auto" }}>{files[fileIdx].code}</pre>
            </div>
            <div>
              <div style={{ fontSize: 11, color: "var(--success)", marginBottom: 6 }}>AFTER</div>
              <pre className="fmono scrollbar" style={{ fontSize: 11.5, background: "var(--surface2)", padding: 10, borderRadius: 8, maxHeight: 260, overflow: "auto" }}>{result.fixed_code}</pre>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button className="btn-ember" style={{ padding: "8px 16px", borderRadius: 8, fontSize: 12.5, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }} onClick={accept}><Check size={13} /> Accept Changes</button>
            <button className="btn-ghost" style={{ padding: "8px 16px", borderRadius: 8, fontSize: 12.5, cursor: "pointer" }} onClick={() => setResult(null)}>Reject</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Studio connector — honest, no fake connection                      */
/* ------------------------------------------------------------------ */
const PLUGIN_SOURCE = `--[[
    FORGE AI — Roblox Studio Plugin
    Real bridge: polls the Forge AI backend every 5s, pulls queued builds,
    creates/updates the described instances at their exact path, and reports
    the result back to the backend.
    Install: File > Advanced > Open Plugins Folder, drop this .lua file in.
]]

local HttpService = game:GetService("HttpService")

local SETTING_BACKEND = "ForgeAI_BackendURL"
local SETTING_CODE = "ForgeAI_ConnectionCode"

local function loadSetting(key, default)
    local ok, value = pcall(function() return plugin:GetSetting(key) end)
    if ok and value ~= nil then return value end
    return default
end
local function saveSetting(key, value)
    pcall(function() plugin:SetSetting(key, value) end)
end

local backendUrl = loadSetting(SETTING_BACKEND, "")
local connectionCode = loadSetting(SETTING_CODE, "")

local toolbar = plugin:CreateToolbar("Forge AI")
local toggleButton = toolbar:CreateButton("ForgeAI", "Ouvrir Forge AI", "")
toggleButton.ClickableWhenViewportHidden = true

local widgetInfo = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, false, false, 340, 320, 300, 260)
local widget = plugin:CreateDockWidgetPluginGui("ForgeAIWidget", widgetInfo)
widget.Title = "Forge AI"
toggleButton.Click:Connect(function() widget.Enabled = not widget.Enabled end)

local root = Instance.new("Frame")
root.Size = UDim2.fromScale(1, 1)
root.BackgroundColor3 = Color3.fromRGB(15, 17, 21)
root.BorderSizePixel = 0
root.Parent = widget

local layout = Instance.new("UIListLayout")
layout.Padding = UDim.new(0, 8)
layout.SortOrder = Enum.SortOrder.LayoutOrder
layout.Parent = root

local padding = Instance.new("UIPadding")
padding.PaddingTop = UDim.new(0, 12)
padding.PaddingLeft = UDim.new(0, 12)
padding.PaddingRight = UDim.new(0, 12)
padding.PaddingBottom = UDim.new(0, 12)
padding.Parent = root

local function makeLabel(text, order, size, color)
    local lbl = Instance.new("TextLabel")
    lbl.Size = UDim2.new(1, 0, 0, size or 18)
    lbl.BackgroundTransparency = 1
    lbl.Text = text
    lbl.TextColor3 = color or Color3.fromRGB(230, 232, 236)
    lbl.Font = Enum.Font.Gotham
    lbl.TextSize = 13
    lbl.TextXAlignment = Enum.TextXAlignment.Left
    lbl.LayoutOrder = order
    lbl.Parent = root
    return lbl
end
local function makeTextBox(placeholder, order, initialValue)
    local box = Instance.new("TextBox")
    box.Size = UDim2.new(1, 0, 0, 30)
    box.BackgroundColor3 = Color3.fromRGB(25, 29, 37)
    box.BorderColor3 = Color3.fromRGB(38, 43, 52)
    box.TextColor3 = Color3.fromRGB(230, 232, 236)
    box.PlaceholderText = placeholder
    box.Text = initialValue or ""
    box.Font = Enum.Font.Code
    box.TextSize = 13
    box.ClearTextOnFocus = false
    box.LayoutOrder = order
    box.Parent = root
    return box
end
local function makeButton(text, order, bgColor)
    local btn = Instance.new("TextButton")
    btn.Size = UDim2.new(1, 0, 0, 32)
    btn.BackgroundColor3 = bgColor or Color3.fromRGB(255, 122, 50)
    btn.TextColor3 = Color3.fromRGB(15, 10, 5)
    btn.Font = Enum.Font.GothamBold
    btn.Text = text
    btn.TextSize = 13
    btn.LayoutOrder = order
    btn.Parent = root
    return btn
end

makeLabel("FORGE AI", 1, 22, Color3.fromRGB(255, 150, 90)).Font = Enum.Font.GothamBold
local statusLabel = makeLabel("\\u{1F534} Not Connected", 2, 18)
makeLabel("Backend URL", 3, 14, Color3.fromRGB(140, 148, 160))
local backendBox = makeTextBox("https://ton-backend.exemple.com/api", 4, backendUrl)
makeLabel("Connection Code", 5, 14, Color3.fromRGB(140, 148, 160))
local codeBox = makeTextBox("ABCDEFGH", 6, connectionCode)
local testButton = makeButton("Test Connection", 7, Color3.fromRGB(60, 66, 78))
local syncButton = makeButton("Sync Now", 8, Color3.fromRGB(255, 122, 50))
local lastBuildLabel = makeLabel("Last build: —", 9, 16, Color3.fromRGB(140, 148, 160))
local logLabel = makeLabel("", 10, 60, Color3.fromRGB(140, 148, 160))
logLabel.TextWrapped = true
logLabel.Size = UDim2.new(1, 0, 0, 80)

local function log(msg)
    logLabel.Text = os.date("%H:%M:%S") .. "  " .. msg
    print("[Forge AI] " .. msg)
end
local function setConnected(isConnected)
    if isConnected then
        statusLabel.Text = "\\u{1F7E2} Connected"
        statusLabel.TextColor3 = Color3.fromRGB(120, 220, 170)
    else
        statusLabel.Text = "\\u{1F534} Not Connected"
        statusLabel.TextColor3 = Color3.fromRGB(230, 120, 130)
    end
end

local SERVICES = {
    ReplicatedStorage = function() return game:GetService("ReplicatedStorage") end,
    ReplicatedFirst = function() return game:GetService("ReplicatedFirst") end,
    ServerScriptService = function() return game:GetService("ServerScriptService") end,
    ServerStorage = function() return game:GetService("ServerStorage") end,
    StarterPlayer = function() return game:GetService("StarterPlayer") end,
    StarterGui = function() return game:GetService("StarterGui") end,
    StarterPack = function() return game:GetService("StarterPack") end,
    Workspace = function() return game:GetService("Workspace") end,
    Lighting = function() return game:GetService("Lighting") end,
    SoundService = function() return game:GetService("SoundService") end,
    MaterialService = function() return game:GetService("MaterialService") end,
    TextChatService = function() return game:GetService("TextChatService") end,
}
local VALUE_TYPES = { StringValue = true, BoolValue = true, IntValue = true, NumberValue = true, ObjectValue = true }
local SCRIPT_TYPES = { Script = true, LocalScript = true, ModuleScript = true }

local function splitPath(path)
    local parts = {}
    for part in string.gmatch(path, "[^/]+") do table.insert(parts, part) end
    return parts
end
local function getOrCreateFolder(parent, name)
    local child = parent:FindFirstChild(name)
    if child then return child end
    local folder = Instance.new("Folder")
    folder.Name = name
    folder.Parent = parent
    return folder
end
local function resolveContainer(path)
    local segments = splitPath(path)
    if #segments == 0 then error("Chemin vide") end
    local serviceFn = SERVICES[segments[1]]
    if not serviceFn then error("Service Roblox inconnu ou non supporté : '" .. tostring(segments[1]) .. "'") end
    local current = serviceFn()
    for i = 2, #segments do current = getOrCreateFolder(current, segments[i]) end
    return current
end
local function hasPlaceholderAsset(text)
    if type(text) ~= "string" then return false end
    return text:find("YOUR_ASSET_ID_HERE") ~= nil
        or text:find("YOUR_ANIMATION_ID_HERE") ~= nil
        or text:find("rbxassetid://0000000000") ~= nil
end
local function createOrUpdateInstance(file)
    if not file.path or not file.type or not file.name then error("Descripteur de fichier invalide") end
    local container = resolveContainer(file.path)
    local existing = container:FindFirstChild(file.name)
    local inst
    if existing then
        if existing.ClassName ~= file.type then
            error(string.format("'%s' existe déjà avec un type différent (%s attendu, %s trouvé)", file.name, file.type, existing.ClassName))
        end
        inst = existing
    else
        local ok, created = pcall(Instance.new, file.type)
        if not ok then error("Type d'instance non supporté : '" .. tostring(file.type) .. "'") end
        inst = created
        inst.Name = file.name
        inst.Parent = container
    end
    if SCRIPT_TYPES[file.type] then
        local content = file.code
        if content == nil then content = file.source end
        if content ~= nil then
            inst.Source = content
            if hasPlaceholderAsset(content) then
                warn(string.format("[Forge AI] '%s' contient un Asset ID placeholder — ce build aurait dû être bloqué par le backend.", file.name))
            end
        end
    end
    if VALUE_TYPES[file.type] and file.value ~= nil then pcall(function() inst.Value = file.value end) end
    if file.properties then
        local failedProps = {}
        for key, value in pairs(file.properties) do
            local ok = pcall(function() inst[key] = value end)
            if not ok then table.insert(failedProps, key) end
        end
        if #failedProps > 0 then
            error(string.format("'%s' créé mais %d propriété(s) invalide(s) : %s", file.name, #failedProps, table.concat(failedProps, ", ")))
        end
    end
    return file.path .. "/" .. file.name
end
local function processBuild(build)
    local created, success, errorMsg = {}, true, nil
    for _, file in ipairs(build.files or {}) do
        local ok, resultOrErr = pcall(createOrUpdateInstance, file)
        if ok then table.insert(created, resultOrErr) else success = false; errorMsg = tostring(resultOrErr); break end
    end
    lastBuildLabel.Text = "Last build: " .. tostring(build.system_name) .. (success and " OK" or " ECHEC")
    log((success and "Build OK: " or "Build ECHEC: ") .. tostring(build.system_name) .. (errorMsg and (" — " .. errorMsg) or ""))
    local base = backendBox.Text
    pcall(function()
        HttpService:PostAsync(base .. "/studio/build/" .. tostring(build.id) .. "/result",
            HttpService:JSONEncode({ success = success, created = created, errors = errorMsg and { errorMsg } or {} }),
            Enum.HttpContentType.ApplicationJson)
    end)
end

local running = false
local function heartbeatOnce()
    local base, code = backendBox.Text, codeBox.Text
    if base == "" or code == "" then setConnected(false); log("Renseigne l'URL du backend et le code."); return end
    local ok, response = pcall(function()
        return HttpService:PostAsync(base .. "/studio/heartbeat/" .. code,
            HttpService:JSONEncode({ studio_version = version(), place_id = tostring(game.PlaceId), job_id = game.JobId }),
            Enum.HttpContentType.ApplicationJson)
    end)
    if not ok then setConnected(false); log("Heartbeat échoué : " .. tostring(response)); return end
    local decodeOk, data = pcall(HttpService.JSONDecode, HttpService, response)
    if not decodeOk then setConnected(false); log("Réponse backend invalide."); return end
    setConnected(true)
    if data.builds and #data.builds > 0 then
        log(#data.builds .. " build(s) reçu(s).")
        for _, build in ipairs(data.builds) do processBuild(build) end
    end
end
local function startLoop()
    if running then return end
    running = true
    task.spawn(function() while running do heartbeatOnce(); task.wait(5) end end)
end
plugin.Unloading:Connect(function() running = false end)

testButton.MouseButton1Click:Connect(function()
    saveSetting(SETTING_BACKEND, backendBox.Text); saveSetting(SETTING_CODE, codeBox.Text)
    log("Test de connexion en cours..."); heartbeatOnce(); startLoop()
end)
syncButton.MouseButton1Click:Connect(function()
    saveSetting(SETTING_BACKEND, backendBox.Text); saveSetting(SETTING_CODE, codeBox.Text)
    log("Synchronisation manuelle..."); heartbeatOnce()
end)
backendBox.FocusLost:Connect(function() saveSetting(SETTING_BACKEND, backendBox.Text) end)
codeBox.FocusLost:Connect(function() saveSetting(SETTING_CODE, codeBox.Text) end)

if backendUrl ~= "" and connectionCode ~= "" then startLoop()
else log("Renseigne l'URL du backend et le code, puis clique sur Test Connection.") end
`;

function StudioView({ project, showToast, backendUrl, setBackendUrl }) {
  const [urlInput, setUrlInput] = useState(backendUrl || "");
  const [registering, setRegistering] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [status, setStatus] = useState(null); // real backend status response
  const [statusError, setStatusError] = useState(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnosis, setDiagnosis] = useState(null);
  const [wakeStatus, setWakeStatus] = useState(null); // "Réveil du backend... (2/3)"
  const pollRef = useRef(null);

  useEffect(() => { setUrlInput(backendUrl || ""); }, [backendUrl]);

  useEffect(() => {
    if (!backendUrl || !project?.connectionCode) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    async function poll() {
      try {
        const s = await backendStatus(backendUrl, project.connectionCode, (attempt, total, reason) => {
          if (!cancelled) setWakeStatus(`Réveil du backend... tentative ${attempt}/${total} (${reason})`);
        });
        if (!cancelled) { setStatus(s); setStatusError(null); setWakeStatus(null); }
      } catch (e) {
        if (!cancelled) { setStatusError({ message: e.message, httpStatus: e.httpStatus }); setStatus(null); setWakeStatus(null); }
      }
    }
    poll();
    pollRef.current = setInterval(poll, 4000);
    return () => { cancelled = true; clearInterval(pollRef.current); };
  }, [backendUrl, project?.connectionCode]);

  async function doRegister() {
    if (!urlInput.trim() || !project) return;
    setRegistering(true);
    setWakeStatus(null);
    try {
      await backendRegister(urlInput, project.connectionCode, project.id, (attempt, total, reason) => {
        setWakeStatus(`Réveil du backend... tentative ${attempt}/${total} (${reason})`);
      });
      setBackendUrl(urlInput.trim());
      setRegistered(true);
      showToast("Projet enregistré auprès du backend.");
    } catch (e) {
      const detail = e.httpStatus
        ? `Erreur HTTP ${e.httpStatus} — le backend a répondu, regarde ses logs Render pour la cause exacte.`
        : `${e.message} — clique sur "Diagnose Connection" ci-dessous pour identifier la cause exacte.`;
      showToast(`Échec de l'enregistrement : ${detail}`, "error");
    } finally {
      setRegistering(false);
      setWakeStatus(null);
    }
  }

  async function doDiagnose() {
    if (!urlInput.trim()) return;
    setDiagnosing(true);
    setDiagnosis(null);
    setWakeStatus(null);
    try {
      const result = await diagnoseBackend(urlInput, (attempt, total, reason) => {
        setWakeStatus(`Réveil du backend... tentative ${attempt}/${total} (${reason})`);
      });
      setDiagnosis(result);
    } finally {
      setDiagnosing(false);
      setWakeStatus(null);
    }
  }

  function downloadPlugin() {
    const blob = new Blob([PLUGIN_SOURCE], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "ForgeAI.server.lua"; a.click();
    URL.revokeObjectURL(url);
  }
  function copyPlugin() {
    navigator.clipboard.writeText(PLUGIN_SOURCE).then(() => showToast("Code du plugin copié."));
  }

  if (!project) {
    return <div style={{ color: "var(--muted)", fontSize: 13.5 }}>Crée ou ouvre un projet pour configurer la connexion Roblox Studio.</div>;
  }

  const connected = !!status?.connected;
  const timeAgo = status?.last_seen ? Math.round((Date.now() - status.last_seen) / 1000) : null;

  return (
    <div style={{ maxWidth: 780 }}>
      <h1 className="fdisplay" style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>Roblox Studio Connection</h1>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 18 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: connected ? "var(--success)" : "var(--danger)", display: "inline-block" }} />
        <span style={{ fontSize: 13, color: "var(--muted)" }}>
          {connected ? `Connected — dernier heartbeat il y a ${timeAgo}s` : backendUrl ? "Not Connected — en attente d'un heartbeat réel du plugin" : "Not Connected — configure d'abord un backend"}
        </span>
      </div>

      {wakeStatus && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, fontSize: 12.5, color: "var(--ember2)" }}>
          <Loader2 size={13} className="spin" /> {wakeStatus}
        </div>
      )}

      {statusError && (
        <div className="card" style={{ padding: 14, marginBottom: 16, borderColor: "#3a2020" }}>
          <div style={{ display: "flex", gap: 10 }}>
            <AlertTriangle size={16} color="var(--danger)" style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.6 }}>
              {statusError.httpStatus ? (
                <>Le backend a répondu avec une erreur HTTP <strong>{statusError.httpStatus}</strong>. Regarde les logs Render pour la cause exacte côté serveur — ce n'est pas un problème réseau/CORS.</>
              ) : (
                <>Impossible de joindre le backend après plusieurs tentatives ({statusError.message}). Vérifie : (1) l'URL est exactement <code className="fmono">.../api</code>, (2) <code className="fmono">CORS_ORIGIN</code> sur Render autorise ce domaine ({typeof window !== "undefined" ? window.location.origin : "cette origine"}), (3) le service Render n'est pas en erreur (logs Render). Utilise <strong>Diagnose Connection</strong> ci-dessous pour un diagnostic précis.</>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 18, marginBottom: 18 }}>
        <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 6 }}>BACKEND URL</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={urlInput} onChange={(e) => setUrlInput(e.target.value)} placeholder="https://forge-ai-backend-xxxx.onrender.com/api" style={{ flex: 1, padding: "9px 12px", fontSize: 13 }} className="fmono" />
          <button className="btn-ember" style={{ padding: "9px 16px", borderRadius: 9, fontSize: 13, cursor: "pointer", opacity: registering ? .6 : 1 }} disabled={registering || !urlInput.trim()} onClick={doRegister}>
            {registering ? <Loader2 size={14} className="spin" /> : "Register project"}
          </button>
          <button className="btn-ghost" style={{ padding: "9px 14px", borderRadius: 9, fontSize: 13, cursor: "pointer", opacity: diagnosing ? .6 : 1, display: "flex", alignItems: "center", gap: 6 }} disabled={diagnosing || !urlInput.trim()} onClick={doDiagnose}>
            {diagnosing ? <Loader2 size={14} className="spin" /> : <Terminal size={14} />} Diagnose Connection
          </button>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 8, lineHeight: 1.6 }}>
          Déploie <code className="fmono">/server</code> (voir README) puis colle son URL ici. Sans backend déployé, ce statut
          restera honnêtement à "Not Connected" — aucune simulation.
        </div>

        {diagnosis && (
          <div style={{
            marginTop: 12, padding: 12, borderRadius: 10, fontSize: 12.5, lineHeight: 1.6,
            background: diagnosis.kind === "ok" ? "rgba(61,220,151,.08)" : "rgba(255,92,108,.08)",
            border: `1px solid ${diagnosis.kind === "ok" ? "#3ddc9740" : "#ff5c6c40"}`,
          }}>
            {diagnosis.kind === "ok" && <><CheckCircle2 size={13} style={{ verticalAlign: -2, marginRight: 6 }} color="var(--success)" />Le backend répond correctement à <code className="fmono">/api/health</code>. Le problème n'est donc pas côté serveur.</>}
            {diagnosis.kind === "http_error" && <>{diagnosis.detail}</>}
            {diagnosis.kind === "csp_blocked" && <><ShieldAlert size={13} style={{ verticalAlign: -2, marginRight: 6 }} color="var(--danger)" />{diagnosis.detail} C'est inattendu sur un déploiement Vercel standard — vérifie qu'aucune Content-Security-Policy custom n'a été ajoutée (ni dans <code className="fmono">vercel.json</code>, ni via une extension navigateur/bloqueur de pub qui pourrait cibler onrender.com).</>}
            {diagnosis.kind === "network_error" && <><AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 6 }} color="var(--ember2)" />{diagnosis.detail}</>}
          </div>
        )}
      </div>

      {status && (
        <div className="card" style={{ padding: 18, marginBottom: 18 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <StatusField label="Connection Code" value={project.connectionCode} mono />
            <StatusField label="Last Seen" value={status.last_seen ? `${timeAgo}s ago` : "jamais"} />
            <StatusField label="Builds Queued" value={String(status.queued_count ?? 0)} />
            <StatusField label="Last Build" value={status.last_build ? `${status.last_build.system_name} (${status.last_build.status})` : "—"} />
          </div>
          {status.last_error && (
            <div style={{ marginTop: 12, fontSize: 12, color: "var(--danger)" }}>Last Error: {status.last_error}</div>
          )}
        </div>
      )}

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}><Terminal size={14} /> Plugin Roblox Studio (fichier complet)</div>
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn-ghost" style={{ padding: "6px 10px", borderRadius: 7, fontSize: 11.5, cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }} onClick={copyPlugin}><Copy size={12} /> Copy Plugin Code</button>
            <button className="btn-ember" style={{ padding: "6px 10px", borderRadius: 7, fontSize: 11.5, cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }} onClick={downloadPlugin}><Download size={12} /> Download Plugin</button>
          </div>
        </div>
        <pre className="fmono scrollbar" style={{ margin: 0, padding: 16, fontSize: 11, lineHeight: 1.6, overflow: "auto", maxHeight: 300, color: "#c9d1d9" }}>{PLUGIN_SOURCE}</pre>
      </div>

      <div className="card" style={{ padding: 16, marginTop: 18, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 11.5, color: "var(--muted)" }}>CONNECTION CODE (projet : {project.name})</div>
          <div className="fmono" style={{ fontSize: 16, letterSpacing: 2, marginTop: 4 }}>{project.connectionCode}</div>
        </div>
        <button className="btn-ghost" style={{ padding: "8px 12px", borderRadius: 8, fontSize: 12, cursor: "pointer" }} onClick={() => { navigator.clipboard.writeText(project.connectionCode); showToast("Code copié."); }}>
          <Copy size={13} />
        </button>
      </div>
    </div>
  );
}

function StatusField({ label, value, mono }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: "var(--muted)", marginBottom: 4 }}>{label}</div>
      <div className={mono ? "fmono" : ""} style={{ fontSize: 13 }}>{value}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  History / versioning                                               */
/* ------------------------------------------------------------------ */
function HistoryView({ project, update }) {
  if (!project || !project.versions?.length) {
    return <div style={{ color: "var(--muted)", fontSize: 13.5 }}>Aucun historique pour l'instant.</div>;
  }
  function restore(v) {
    update(() => ({ system: v.system }));
  }
  return (
    <div style={{ maxWidth: 760 }}>
      <h1 className="fdisplay" style={{ fontSize: 22, fontWeight: 700, marginBottom: 16 }}>History</h1>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {[...project.versions].reverse().map((v) => (
          <div key={v.id} className="card" style={{ padding: 14, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{v.label}</div>
              <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{new Date(v.ts).toLocaleString("fr-FR")} · {v.system?.files?.length || 0} fichiers</div>
            </div>
            <button className="btn-ghost" style={{ padding: "7px 14px", borderRadius: 8, fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }} onClick={() => restore(v)}>
              <RefreshCw size={12} /> Restore
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Settings                                                           */
/* ------------------------------------------------------------------ */
function SettingsView({ showToast, backendUrl, setBackendUrl }) {
  const [input, setInput] = useState(backendUrl || "");
  useEffect(() => { setInput(backendUrl || ""); }, [backendUrl]);

  return (
    <div style={{ maxWidth: 640 }}>
      <h1 className="fdisplay" style={{ fontSize: 22, fontWeight: 700, marginBottom: 16 }}>Settings</h1>
      <div className="card" style={{ padding: 18, marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>AI Provider</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="AI_PROVIDER" value="google (gemini)" />
          <Field label="AI_MODEL" value="piloté par GEMINI_MODEL sur le backend" />
          <Field label="AI_MAX_OUTPUT_TOKENS" value={String(4096)} />
          <Field label="AI_MAX_BUDGET" value="dépend de ton quota Gemini" />
        </div>
        <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 12, lineHeight: 1.6 }}>
          La génération passe par ton propre backend (<code className="fmono">/api/generate</code>), qui appelle
          l'API Gemini avec ta clé <code className="fmono">GEMINI_API_KEY</code>. Le nom exact du modèle Gemini
          utilisé se configure côté backend via la variable d'environnement <code className="fmono">GEMINI_MODEL</code>
          (Render → Environment), pas ici.
        </div>
      </div>

      <div className="card" style={{ padding: 18, marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Roblox Studio Bridge</div>
        <div style={{ fontSize: 10.5, color: "var(--muted)", marginBottom: 6 }}>FORGE_BACKEND_URL</div>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="https://ton-backend.exemple.com/api" className="fmono" style={{ flex: 1, padding: "8px 10px", fontSize: 12 }} />
          <button className="btn-ghost" style={{ padding: "8px 14px", borderRadius: 8, fontSize: 12, cursor: "pointer" }} onClick={() => { setBackendUrl(input.trim()); showToast("Backend URL sauvegardée."); }}>Save</button>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 8, lineHeight: 1.6 }}>
          Pointe vers ton backend Node/Express déployé (dossier <code className="fmono">/server</code>). Utilisé par la page
          Roblox Studio pour le statut de connexion réel et l'envoi de builds. Laisse vide si tu n'as pas encore déployé de backend.
        </div>
      </div>

      <div className="card" style={{ padding: 18 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Stockage</div>
        <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.6 }}>
          Tes projets sont sauvegardés localement à cet artefact (stockage personnel, non partagé avec d'autres utilisateurs).
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 10.5, color: "var(--muted)", marginBottom: 4 }}>{label}</div>
      <div className="fmono" style={{ background: "var(--surface2)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", fontSize: 12 }}>{value}</div>
    </div>
  );
}
