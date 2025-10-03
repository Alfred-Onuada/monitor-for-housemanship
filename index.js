const { config } = require("dotenv");
config();

const express = require("express");
const { createClient } = require("redis");
const { Resend } = require("resend");

const API_URL = process.env.API_URL;
const REDIS_KEY = process.env.REDIS_KEY;
const PORT = process.env.PORT || 3000;
const JWT = process.env.JWT;

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM;
const MAIL_TO = process.env.MAIL_TO;

const app = express();
const redisClient = createClient({url:process.env.REDIS_URL});

redisClient.on("error", (err) => {
  console.error("Redis error", err);
});

async function fetchSchools() {
  console.log("Fetching school list from remote API");
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tid: 1, jwt: JWT }),
  });

  if (!response.ok) {
    throw new Error(`Remote API returned ${response.status}`);
  }

  const payload = await response.json();
  console.log(
    "Remote API responded with",
    Array.isArray(payload) ? `${payload.length} entries` : typeof payload,
  );
  const names = Array.isArray(payload)
    ? payload.map((entry) => entry.centerName).filter(Boolean)
    : [];

  return Array.from(new Set(names)).sort();
}

function diffLists(previous, current) {
  const previousSet = new Set(previous);
  const currentSet = new Set(current);

  const added = current.filter((name) => !previousSet.has(name));
  const removed = previous.filter((name) => !currentSet.has(name));

  return { added, removed };
}

function canSendMail() {
  return Boolean(RESEND_API_KEY && MAIL_FROM && MAIL_TO);
}

async function sendChangeEmail({ added, removed, current, checkedAt }) {
  if (!canSendMail()) {
    console.warn("Email notification skipped; Resend configuration incomplete");
    return false;
  }

  const resend = new Resend(RESEND_API_KEY);

  const sections = [];
  if (added.length > 0) {
    sections.push(`Added:\n${added.map((name) => `- ${name}`).join("\n")}`);
  }
  if (removed.length > 0) {
    sections.push(`Removed:\n${removed.map((name) => `- ${name}`).join("\n")}`);
  }

  const textBody = [
    `School list changed at ${checkedAt}.`,
    sections.join("\n\n"),
    `Total available schools: ${current.length}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  console.log("Sending change notification email", {
    to: MAIL_TO,
    added: added.length,
    removed: removed.length,
  });

  await resend.emails.send({
    from: MAIL_FROM,
    to: MAIL_TO,
    subject: `School list updated (${added.length} added, ${removed.length} removed)`,
    text: textBody,
  });

  console.log("Email dispatched successfully");

  return true;
}

async function start() {
  await redisClient.connect();
  console.log("Connected to Redis and ready to accept requests");

  app.get("/", async (req, res) => {
    try {
      console.log("Received change check request");
      const current = await fetchSchools();
      const previousRaw = await redisClient.get(REDIS_KEY);
      const previous = previousRaw ? JSON.parse(previousRaw) : [];

      const { added, removed } = diffLists(previous, current);
      const changed = added.length > 0 || removed.length > 0;
      console.log("Comparison complete", {
        previousCount: previous.length,
        currentCount: current.length,
        added: added.length,
        removed: removed.length,
        changed,
      });
      const checkedAt = new Date().toISOString();

      let emailSent = false;
      if (changed) {
        console.log("Change detected; preparing email notification");
        try {
          emailSent = await sendChangeEmail({
            added,
            removed,
            current,
            checkedAt,
          });
        } catch (emailErr) {
          console.error("Failed to send change notification", emailErr);
        }
      } else {
        console.log("No changes detected; email not sent");
      }

      await redisClient.set(REDIS_KEY, JSON.stringify(current));
      console.log("Current school list cached in Redis");

      res.json({
        changed,
        added,
        removed,
        count: current.length,
        checkedAt,
        emailSent,
      });
      console.log("Response sent", { changed, emailSent, checkedAt });
    } catch (err) {
      console.error("Monitor failed", err);
      res.status(500).json({ error: "Failed to fetch school list" });
    }
  });

  app.listen(PORT, () => {
    console.log(`Monitor listening on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Startup failed", err);
  process.exit(1);
});
