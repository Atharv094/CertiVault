process.env.NODE_ENV = "test";
process.env.RATE_LIMIT_MAX = "15";
process.env.RATE_LIMIT_WINDOW_MS = "60000";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import http from "http";

let baseUrl: string;
let server: http.Server;
let mongoServer: MongoMemoryServer;
let disconnectDB: () => Promise<void>;

before(async () => {
  // Start in-memory MongoDB
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();

  // Dynamically import db config to prevent env validation before process.env is set
  const { connectDB, disconnectDB: dDB } = await import("../../src/config/db.js");
  disconnectDB = dDB;

  // Connect Mongoose to it
  await connectDB(mongoUri);

  // Start Express App
  const { createApp } = await import("../../src/app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address && typeof address === "object") {
    baseUrl = `http://127.0.0.1:${address.port}`;
  } else {
    throw new Error("Failed to get server port");
  }
});

after(async () => {
  // Close Express Server
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

  // Disconnect Database
  await disconnectDB();

  // Stop in-memory MongoDB
  await mongoServer.stop();
});

test("GET /health/live reports process liveness", async () => {
  const response = await fetch(`${baseUrl}/health/live`);

  assert.equal(response.status, 200);
  const body: any = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(typeof body.version, "string");
  assert.ok(body.version.length > 0);
  assert.equal(typeof body.uptimeSeconds, "number");
  assert.ok(body.uptimeSeconds >= 0);
  assert.match(response.headers.get("x-request-id") || "", /^[0-9a-f-]{36}$/);
  assert.match(response.headers.get("x-response-time") || "", /^\d+(\.\d+)?ms$/);
});

test("GET /health/ready reports readiness", async () => {
  const response = await fetch(`${baseUrl}/health/ready`, {
    headers: { "X-Request-Id": "test-request-id" },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-request-id"), "test-request-id");
  assert.match(response.headers.get("x-response-time"), /^\d+(\.\d+)?ms$/);
  const body = await response.json();
  assert.equal(body.status, "ready");
  assert.equal(typeof body.version, "string");
  assert.ok(body.version.length > 0);
  assert.deepEqual(body.checks, { mongo: "healthy", redis: "disabled" });
});

test("unknown routes return a normalized error", async () => {
  const response = await fetch(`${baseUrl}/missing`);
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error.code, "ROUTE_NOT_FOUND");
  assert.equal(body.error.message, "Route GET /missing was not found");
  assert.equal(body.requestId, response.headers.get("x-request-id"));
  assert.match(response.headers.get("x-response-time"), /^\d+(\.\d+)?ms$/);
});

test("GET /api returns root API info", async () => {
  const response = await fetch(`${baseUrl}/api`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.service, "CertiVault API");
  assert.equal(body.status, "running");
  assert.equal(body.links.liveness, "/health/live");
  assert.match(response.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
});

test("Request-ID: preserves client-provided X-Request-Id header", async () => {
  const customId = "my-custom-request-id-123";
  const response = await fetch(`${baseUrl}/health/live`, {
    headers: { "X-Request-Id": customId },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-request-id"), customId);
});

test("Request-ID: generates a valid UUID X-Request-Id when missing", async () => {
  const response = await fetch(`${baseUrl}/health/live`);

  assert.equal(response.status, 200);
  const requestId = response.headers.get("x-request-id");
  assert.match(requestId, /^[0-9a-f-]{36}$/);
});

test("Request-ID: echoes client-provided request ID in error response body", async () => {
  const customId = "error-custom-request-id";
  const response = await fetch(`${baseUrl}/missing`, {
    headers: { "X-Request-Id": customId },
  });

  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.requestId, customId);
  assert.equal(response.headers.get("x-request-id"), customId);
});

test("returns HTTP 400 with normalized error when JSON is malformed", async () => {
  const response = await fetch(`${baseUrl}/api/documents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Request-Id": "json-error-id",
    },
    body: "{ malformed json }",
  });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "BAD_REQUEST");
  assert.equal(body.error.message, "Malformed JSON payload");
  assert.equal(body.requestId, "json-error-id");
  assert.equal(body.error.stack, undefined);
});

test("global rate limiter: returns HTTP 429 after exceeding limit", async () => {
  let exceeded = false;
  let status429Count = 0;
  
  for (let i = 0; i < 25; i++) {
    const response = await fetch(`${baseUrl}/api`, {
      headers: { "X-Forwarded-For": "1.1.1.1" },
    });
    if (response.status === 429) {
      exceeded = true;
      status429Count++;
      const body: any = await response.json();
      assert.equal(body.error.code, "RATE_LIMIT_EXCEEDED");
      assert.equal(body.error.message, "Too many requests, please try again later.");
      assert.ok(body.requestId);
    }
  }
  assert.ok(exceeded, "Rate limit should have been exceeded");
  assert.ok(status429Count > 0, "Should have received at least one 429");
});

test("auth rate limiter: returns HTTP 429 after exceeding limit", async () => {
  let exceeded = false;
  let status429Count = 0;

  for (let i = 0; i < 15; i++) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "2.2.2.2",
      },
      body: JSON.stringify({ email: "invalid-email-format", password: "short" }),
    });

    if (response.status === 429) {
      exceeded = true;
      status429Count++;
      const body: any = await response.json();
      assert.equal(body.error.code, "AUTH_RATE_LIMIT_EXCEEDED");
      assert.equal(body.error.message, "Too many authentication attempts, please try again later.");
      assert.ok(body.requestId);
    }
  }
  assert.ok(exceeded, "Auth rate limit should have been exceeded");
  assert.ok(status429Count > 0, "Should have received at least one 429");
});
