require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

const SYSTEM_PROMPT = `You are a professional nutritionist AI. When given a food image, analyze it and return ONLY a JSON object with no extra text, no markdown, no backticks.

Return exactly this shape:
{
  "foods": [
    { "name": "string", "portion": "string", "calories": number, "protein": number, "carbs": number, "fat": number }
  ],
  "totals": { "calories": number, "protein": number, "carbs": number, "fat": number },
  "confidence": "low" | "medium" | "high",
  "notes": "string (brief caveat about estimation accuracy)"
}

Rules:
- All macros in grams
- Calories as kcal integer
- Be realistic with portions based on visual cues
- If no food is detected, return foods as empty array and zero totals
- confidence reflects how clearly the food is visible/identifiable`;

// Middleware to verify Supabase JWT token
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  console.log("Auth header:", authHeader ? authHeader.substring(0, 30) + "..." : "MISSING");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  const token = authHeader.split(" ")[1];
  const { data: { user }, error } = await supabase.auth.getUser(token);
  console.log("User:", user ? user.email : "NULL", "Error:", error ? error.message : "none");
  if (error || !user) {
    return res.status(401).json({ error: "Invalid token" });
  }
  req.user = user;
  next();
}

// Get or create user profile
async function getProfile(userId, email) {
  let { data: profile, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single();

  if (!profile) {
    const today = new Date().toISOString().split("T")[0];
    const { data: newProfile } = await supabase
      .from("profiles")
      .insert({ id: userId, email, scans_today: 0, last_scan_date: today })
      .select()
      .single();
    return newProfile;
  }
  return profile;
}

// GET /api/profile - get current user's scan count
app.get("/api/profile", requireAuth, async (req, res) => {
  try {
    const profile = await getProfile(req.user.id, req.user.email);
    const today = new Date().toISOString().split("T")[0];

    // Reset scans if it's a new day
    if (profile.last_scan_date !== today) {
      const { data: updated } = await supabase
        .from("profiles")
        .update({ scans_today: 0, last_scan_date: today })
        .eq("id", req.user.id)
        .select()
        .single();
      return res.json({ scans_today: 0, scans_limit: 3 });
    }

    res.json({ scans_today: profile.scans_today, scans_limit: 3 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/analyze - analyze food image
app.post("/api/analyze", requireAuth, async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: "No image provided" });

    const profile = await getProfile(req.user.id, req.user.email);
    const today = new Date().toISOString().split("T")[0];

    // Calculate scans used today. my email gets unlimited
    let scansToday = profile.scans_today;
    if (profile.last_scan_date !== today) scansToday = 0;

    if (scansToday >= 3 && req.user.email !== "ebaduk117@gmail.com") {
      return res.status(403).json({ error: "Daily limit reached. Come back tomorrow for 3 more free scans!" });
    }

    // Call Hack Club AI
    const aiRes = await fetch("https://ai.hackclub.com/proxy/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.HACKCLUB_API_KEY}`
      },
      body: JSON.stringify({
        model: "~anthropic/claude-sonnet-latest",
        max_tokens: 1000,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
              { type: "text", text: "Analyze this food image and return the JSON nutrition estimate." }
            ]
          }
        ]
      })
    });

    const aiData = await aiRes.json();
    if (!aiRes.ok) throw new Error(aiData.error?.message || "AI API error");

    const raw = aiData.choices[0].message.content;
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    // Deduct scan
    await supabase
      .from("profiles")
      .update({ scans_today: scansToday + 1, last_scan_date: today })
      .eq("id", req.user.id);

    res.json({ result: parsed, scans_today: scansToday + 1, scans_limit: 3 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`CalorieSnap backend running on port ${PORT}`));