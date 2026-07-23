const https = require("https");
const { URL } = require("url");

/**
 * Pluggable SMS sender.
 *
 * Provider is chosen with SMS_PROVIDER:
 *   - 'log'    (default) — no real delivery; the message is logged to the server console.
 *                          Use this until a real gateway is connected. In this mode the OTP
 *                          code is also surfaced to the client so the flow stays testable.
 *   - 'twilio' — Twilio REST API. Needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM.
 *   - 'http'   — Generic JSON webhook. POSTs { to, text } to SMS_HTTP_URL
 *                (optional bearer via SMS_HTTP_TOKEN).
 *
 * Adding a provider later is just env config — no code change required.
 */

const getEnv = (key) => String(process.env[key] || "").trim();

const getProvider = () => (getEnv("SMS_PROVIDER") || "log").toLowerCase();

/** @returns {Error|null} null when the active provider is ready to send. */
const getSmsConfigError = () => {
  const provider = getProvider();

  if (provider === "log") {
    return null;
  }

  if (provider === "twilio") {
    const missing = [
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_FROM",
    ].filter((key) => !getEnv(key));
    if (missing.length) {
      return new Error(`Missing Twilio configuration: ${missing.join(", ")}`);
    }
    return null;
  }

  if (provider === "http") {
    if (!getEnv("SMS_HTTP_URL")) {
      return new Error("Missing SMS_HTTP_URL for the http SMS provider");
    }
    return null;
  }

  return new Error(
    `Unknown SMS_PROVIDER "${provider}". Use log, twilio, or http.`,
  );
};

/** True when SMS will not actually be delivered (so callers can fall back / expose dev code). */
const isSmsDeliverable = () => getProvider() !== "log" && !getSmsConfigError();

const postJson = (urlString, body, headers = {}) =>
  new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
          else
            reject(
              new Error(
                `SMS HTTP provider responded ${res.statusCode}: ${data}`,
              ),
            );
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });

const postForm = (urlString, form, headers = {}) =>
  new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const payload = new URLSearchParams(form).toString();
    const req = https.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
          else reject(new Error(`Twilio responded ${res.statusCode}: ${data}`));
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });

const sendViaTwilio = async ({ to, text }) => {
  const sid = getEnv("TWILIO_ACCOUNT_SID");
  const token = getEnv("TWILIO_AUTH_TOKEN");
  const from = getEnv("TWILIO_FROM");
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  await postForm(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    { To: to, From: from, Body: text },
    { Authorization: `Basic ${auth}` },
  );
};

const sendViaHttp = async ({ to, text }) => {
  const httpToken = getEnv("SMS_HTTP_TOKEN");
  await postJson(
    getEnv("SMS_HTTP_URL"),
    { to, text },
    httpToken ? { Authorization: `Bearer ${httpToken}` } : {},
  );
};

/**
 * Send an SMS. Throws if a configured provider fails.
 * In 'log' mode it never throws — it just records the message.
 */
const sendSms = async ({ to, text }) => {
  const provider = getProvider();

  if (provider === "log") {
    console.log(`[SMS:log] to=${to} :: ${text}`);
    return { delivered: false, provider };
  }

  const configError = getSmsConfigError();
  if (configError) {
    throw configError;
  }

  if (provider === "twilio") {
    await sendViaTwilio({ to, text });
  } else if (provider === "http") {
    await sendViaHttp({ to, text });
  }

  return { delivered: true, provider };
};

module.exports = {
  getProvider,
  getSmsConfigError,
  isSmsDeliverable,
  sendSms,
};
