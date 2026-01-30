// Minimal Express proxy: moderation -> forward to provider -> return result
// Usage: set environment variables as described in .env.example
import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import cors from "cors";

dotenv.config();

const app = express();
app.use(express.json({ limit: "128kb" }));
app.use(cors());

// Config from env
const PORT = process.env.PORT || 3000;
const PROVIDER = (process.env.PROVIDER || "openai").toLowerCase();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const PROVIDER_CHAT_URL = process.env.PROVIDER_CHAT_URL || ""; // optional generic forward
const PROVIDER_API_KEY = process.env.PROVIDER_API_KEY || ""; // for generic forward
const MODERATION_ENABLED = (process.env.MODERATION_ENABLED || "true") === "true";
const MODERATION_API = process.env.MODERATION_API || ""; // optional (e.g., OpenAI moderation)
const LOG_DIR = process.env.LOG_DIR || "logs";

// ensure log dir
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

app.get("/api/health", (req, res) => {
  res.json({ ok: true, proxy: true, provider: PROVIDER });
});

// Basic moderation step: try an upstream moderation endpoint, or do a minimal keyword filter as fallback
async function moderateText(text) {
  if (!MODERATION_ENABLED) return { ok: true };

  // If MODERATION_API and key provided (OpenAI moderation), call it
  try {
    if (MODERATION_API && PROVIDER === "openai" && OPENAI_API_KEY) {
      const r = await fetch("https://api.openai.com/v1/moderations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({ input: text })
      });
      if (!r.ok) {
        console.warn("Moderation endpoint returned", r.status);
      }
      const j = await r.json().catch(() => null);
      // For OpenAI moderation, it has results[0].categories / flagged
      if (j && j.results && j.results[0]) {
        return { ok: !j.results[0].flagged, details: j.results[0] };
      }
    }
  } catch (err) {
    console.warn("Moderation upstream failed:", err.message);
  }

  // Fallback: simple keyword blocklist (customize as needed)
  const blocklist = ["<script>", "kill(", "rm -rf", "bomb", "terrorist"];
  const lowered = text.toLowerCase();
  for (const b of blocklist) {
    if (lowered.includes(b)) {
      return { ok: false, details: { reason: "blocklist" } };
    }
  }

  return { ok: true };
}

// Usage logger: append to logs/usage.log
function logUsage(info) {
  try {
    const line = `[${new Date().toISOString()}] ${JSON.stringify(info)}\n`;
    fs.appendFileSync(path.join(LOG_DIR, "usage.log"), line);
  } catch (err) {
    console.warn("Failed to write usage log:", err.message);
  }
}

// Chat endpoint: expects { prompt, model }
app.post("/api/chat", async (req, res) => {
  try {
    const { prompt, model } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    // Moderation
    const mod = await moderateText(prompt);
    if (!mod.ok) {
      return res.status(403).json({ error: "Content blocked by moderation", details: mod.details });
    }

    // Forward to provider
    // Example: OpenAI Chat Completions
    if (PROVIDER === "openai" && OPENAI_API_KEY) {
      const payload = {
        model: model || "gpt-4o",
        messages: [{ role: "user", content: prompt }]
      };
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify(payload)
      });

      const j = await r.json();
      // log usage if present
      if (j && j.usage) {
        logUsage({ provider: "openai", model: payload.model, usage: j.usage });
      }

      // Try to extract text
      let text = "";
      if (j && j.choices && j.choices[0]) {
        const c = j.choices[0];
        text = c.message?.content ?? c.text ?? JSON.stringify(c);
      } else if (j && j.output) {
        text = j.output;
      } else {
        text = JSON.stringify(j);
      }

      return res.json({ text, raw: j });
    }

    // Generic forward to PROVIDER_CHAT_URL if set
    if (PROVIDER_CHAT_URL && PROVIDER_API_KEY) {
      const r = await fetch(PROVIDER_CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${PROVIDER_API_KEY}`
        },
        body: JSON.stringify({ prompt, model })
      });
      const j = await r.json();
      logUsage({ provider: "generic", url: PROVIDER_CHAT_URL, responseKeys: Object.keys(j || {}) });
      return res.json(j);
    }

    return res.status(500).json({ error: "No upstream provider configured on server" });
  } catch (err) {
    console.error("Proxy error:", err);
    return res.status(500).json({ error: "Proxy internal error", message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Chat proxy running on port ${PORT}`);
  console.log(`Configured provider: ${PROVIDER}`);
});
