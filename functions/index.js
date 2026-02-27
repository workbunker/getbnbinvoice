const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();
const COLLECTION = "licenses";
const FREE_CREDITS = 15;
const MAX_REGISTRATIONS_PER_IP = 3;

function generateKey() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const group = () =>
    Array.from({ length: 4 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  return `GBNB-${group()}-${group()}-${group()}`;
}

function json(res, status, body) {
  res.status(status).json(body);
}

// POST /register — { email } → { success, key, credits }
exports.register = onRequest(
  { region: "europe-west1", cors: true },
  async (req, res) => {
    if (req.method !== "POST")
      return json(res, 405, { error: "method_not_allowed" });

    const email = (req.body.email || "").toString().toLowerCase().trim();
    if (!email || !email.includes("@"))
      return json(res, 400, { error: "invalid_email" });

    const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";

    const existing = await db
      .collection(COLLECTION)
      .where("email", "==", email)
      .limit(1)
      .get();

    if (!existing.empty) {
      // Return key for MVP (no email sending yet).
      // TODO: Remove key from response once email sending is added.
      const data = existing.docs[0].data();
      return json(res, 409, {
        error: "already_registered",
        message: "A key was already sent to this email",
        key: data.key,
      });
    }

    // Rate limit: max registrations per IP per day
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentFromIp = await db
      .collection(COLLECTION)
      .where("ip", "==", ip)
      .where("created_at", ">=", oneDayAgo)
      .get();

    if (recentFromIp.size >= MAX_REGISTRATIONS_PER_IP) {
      return json(res, 429, { error: "too_many_registrations" });
    }

    const key = generateKey();
    await db.collection(COLLECTION).add({
      key,
      email,
      ip,
      credits_remaining: FREE_CREDITS,
      credits_total: FREE_CREDITS,
      created_at: FieldValue.serverTimestamp(),
      last_used_at: null,
    });

    json(res, 200, { success: true, key, credits: FREE_CREDITS });
  }
);

// POST /checkCredit — { key } → { remaining, total }
exports.checkCredit = onRequest(
  { region: "europe-west1", cors: true },
  async (req, res) => {
    if (req.method !== "POST")
      return json(res, 405, { error: "method_not_allowed" });

    const key = (req.body.key || "").toString().trim();
    if (!key) return json(res, 400, { error: "missing_key" });

    const snap = await db
      .collection(COLLECTION)
      .where("key", "==", key)
      .limit(1)
      .get();
    if (snap.empty) return json(res, 404, { error: "invalid_key" });

    const data = snap.docs[0].data();
    json(res, 200, {
      remaining: data.credits_remaining,
      total: data.credits_total,
    });
  }
);

// POST /useCredit — { key, reservation_code? } → { remaining }
exports.useCredit = onRequest(
  { region: "europe-west1", cors: true },
  async (req, res) => {
    if (req.method !== "POST")
      return json(res, 405, { error: "method_not_allowed" });

    const key = (req.body.key || "").toString().trim();
    if (!key) return json(res, 400, { error: "missing_key" });
    const reservationCode = (req.body.reservation_code || "").toString().trim();

    const snap = await db
      .collection(COLLECTION)
      .where("key", "==", key)
      .limit(1)
      .get();
    if (snap.empty) return json(res, 404, { error: "invalid_key" });

    const docRef = snap.docs[0].ref;

    try {
      const remaining = await db.runTransaction(async (t) => {
        const doc = await t.get(docRef);
        const credits = doc.data().credits_remaining;
        if (credits <= 0) throw new Error("no_credits");
        t.update(docRef, {
          credits_remaining: credits - 1,
          last_used_at: FieldValue.serverTimestamp(),
        });
        return credits - 1;
      });

      // Log usage for audit trail
      await docRef.collection("usage").add({
        reservation_code: reservationCode || null,
        credits_after: remaining,
        used_at: FieldValue.serverTimestamp(),
      });

      json(res, 200, { remaining });
    } catch (e) {
      if (e.message === "no_credits")
        return json(res, 402, { error: "no_credits", remaining: 0 });
      throw e;
    }
  }
);
