import express from "express";
import { fetch, Agent } from "undici";
import { Firestore } from "@google-cloud/firestore";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

const app = express();
app.use(express.json({ limit: "1mb" }));

const port = process.env.PORT || 8080;
const projectId = process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
const tellerCertSecret = process.env.TELLER_CERT_SECRET_NAME;
const tellerKeySecret = process.env.TELLER_KEY_SECRET_NAME;

const startupConfigErrors = [];
if (!projectId) {
  startupConfigErrors.push("Missing GCP project env (GCP_PROJECT or GOOGLE_CLOUD_PROJECT)");
}
if (!tellerCertSecret || !tellerKeySecret) {
  startupConfigErrors.push("Missing TELLER_CERT_SECRET_NAME or TELLER_KEY_SECRET_NAME");
}

const firestore = new Firestore();
const secretManager = new SecretManagerServiceClient();

let cachedHttpsAgent = null;

function requireApiKey(req, res, next) {
  const expected = process.env.API_KEY;
  if (!expected) {
    return res.status(500).json({ error: "Server misconfigured: missing API_KEY" });
  }
  const given = req.get("x-api-key");
  if (!given || given !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return next();
}

function requireRuntimeConfig(req, res, next) {
  if (startupConfigErrors.length > 0) {
    return res.status(500).json({ error: startupConfigErrors.join("; ") });
  }
  return next();
}

async function accessSecret(secretName) {
  const fullName = `projects/${projectId}/secrets/${secretName}/versions/latest`;
  const [version] = await secretManager.accessSecretVersion({ name: fullName });
  const payload = version.payload?.data;
  if (!payload) {
    throw new Error(`Secret ${secretName} has no payload`);
  }
  return payload.toString("utf8");
}

async function buildHttpsAgent() {
  const certPem = await accessSecret(tellerCertSecret);
  const keyPem = await accessSecret(tellerKeySecret);

  return new Agent({
    connect: {
      cert: certPem,
      key: keyPem
    }
  });
}

async function tellerFetch(accountAccessToken, endpoint) {
  if (!cachedHttpsAgent) {
    cachedHttpsAgent = await buildHttpsAgent();
  }

  const auth = Buffer.from(`${accountAccessToken}:`).toString("base64");
  const response = await fetch(`https://api.teller.io${endpoint}`, {
    method: "GET",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json"
    },
    dispatcher: cachedHttpsAgent
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Teller request failed (${response.status}): ${body}`);
  }

  return response.json();
}

async function getUserDoc(userId) {
  const ref = firestore.collection("teller_users").doc(userId);
  const snap = await ref.get();
  return { ref, snap };
}

app.get("/", (_req, res) => {
  res.status(200).json({ ok: true, service: "familybudget-teller" });
});

app.get("/healthz", (_req, res) => {
  res.status(200).json({
    ok: true,
    config_ok: startupConfigErrors.length === 0,
    config_errors: startupConfigErrors
  });
});

app.post("/teller/enroll", requireApiKey, requireRuntimeConfig, async (req, res) => {
  try {
    const userId = String(req.body.userId || "default");
    const accessToken = String(req.body.accessToken || "").trim();

    if (!accessToken) {
      return res.status(400).json({ error: "Missing accessToken" });
    }

    const ref = firestore.collection("teller_users").doc(userId);
    await ref.set(
      {
        accessToken,
        updatedAt: new Date().toISOString()
      },
      { merge: true }
    );

    return res.status(200).json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/teller/transactions", requireApiKey, requireRuntimeConfig, async (req, res) => {
  try {
    const userId = String(req.query.userId || "default");
    const startDate = String(req.query.start_date || "").trim();

    const { snap } = await getUserDoc(userId);
    if (!snap.exists) {
      return res.status(404).json({ error: "No enrolled Teller token for user" });
    }

    const data = snap.data();
    const accessToken = String(data.accessToken || "");
    if (!accessToken) {
      return res.status(400).json({ error: "Stored access token is empty" });
    }

    const accounts = await tellerFetch(accessToken, "/accounts");
    const results = [];

    for (const account of accounts) {
      const accountId = account.id;
      const qs = startDate ? `?start_date=${encodeURIComponent(startDate)}` : "";
      const txns = await tellerFetch(accessToken, `/accounts/${accountId}/transactions${qs}`);

      for (const txn of txns) {
        results.push({
          external_id: txn.id,
          account_id: accountId,
          account_name: account.name || account.type || "Teller Account",
          amount: txn.amount,
          date: txn.date,
          description: txn.description || txn.details?.counterparty?.name || "Unknown",
          category: null,
          note: txn.details?.processing_status || null
        });
      }
    }

    return res.status(200).json({ transactions: results });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`cloud-run-teller listening on ${port}`);
});
