import assert from "node:assert/strict"
import test from "node:test"

import { classifyProxyLog } from "../../src/logger.ts"

test("classifies authentication failures as error", () => {
  assert.equal(classifyProxyLog("[PROXY] authentication failed"), "error")
  assert.equal(classifyProxyLog("[PROXY] credentials invalid"), "error")
  assert.equal(classifyProxyLog("[PROXY] Token expired"), "error")
  assert.equal(classifyProxyLog("[PROXY] not logged in"), "error")
})

test("classifies HTTP 401/402 and billing/subscription issues as error", () => {
  assert.equal(classifyProxyLog("[PROXY] 401 unauthorized"), "error")
  assert.equal(classifyProxyLog("[PROXY] 402 payment required"), "error")
  assert.equal(classifyProxyLog("[PROXY] billing issue"), "error")
  assert.equal(classifyProxyLog("[PROXY] subscription inactive"), "error")
})

test("classifies crashes and exit codes as error", () => {
  assert.equal(classifyProxyLog("[PROXY] process crashed"), "error")
  assert.equal(classifyProxyLog("[PROXY] exited with code 1"), "error")
  assert.equal(classifyProxyLog("[PROXY] exit with code 137"), "error")
  assert.equal(classifyProxyLog("[PROXY] unhealthy"), "error")
})

test("classifies rate limits and transient outages as warn", () => {
  assert.equal(classifyProxyLog("[PROXY] rate limit hit"), "warn")
  assert.equal(classifyProxyLog("[PROXY] 429 Too Many Requests"), "warn")
  assert.equal(classifyProxyLog("[PROXY] overloaded"), "warn")
  assert.equal(classifyProxyLog("[PROXY] 503 service unavailable"), "warn")
  assert.equal(classifyProxyLog("[PROXY] stale session detected"), "warn")
  assert.equal(classifyProxyLog("[PROXY] request timed out"), "warn")
})

test("falls back to debug for neutral messages", () => {
  assert.equal(classifyProxyLog("[PROXY] starting on port 3456"), "debug")
  assert.equal(classifyProxyLog("[PROXY] received request"), "debug")
  assert.equal(classifyProxyLog(""), "debug")
  assert.equal(classifyProxyLog("some random text"), "debug")
})

test("pattern matching is case-insensitive", () => {
  assert.equal(classifyProxyLog("[PROXY] AUTHENTICATION FAILED"), "error")
  assert.equal(classifyProxyLog("[PROXY] Rate Limit Exceeded"), "warn")
})

test("when error and warn keywords both appear, error wins", () => {
  // "expired" is an error signal; "rate limit" is a warn signal. The loader
  // checks errors first so we should see error here.
  assert.equal(
    classifyProxyLog("[PROXY] token expired; rate limit backing off"),
    "error",
  )
})
