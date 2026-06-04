import test from "node:test";
import assert from "node:assert/strict";

import {
  buildHeaders,
  buildPayload,
  buildToolCatalog,
  estimateJsonTokens,
  judgeDeferral,
  normalizeUsage,
  renderMarkdownSummary,
  resolveIntervalMs,
} from "./validator_lib.mjs";

test("buildToolCatalog keeps the catalog compact and unique", () => {
  const catalog = buildToolCatalog({
    toolCount: 8,
    targetTopic: "project orbit delayed orders",
    namePrefix: "alpha"
  });

  assert.equal(catalog.length, 8);
  assert.match(catalog[0].name, /alpha_project_orbit_orders/);
  assert.ok(new Set(catalog.map((tool) => tool.name)).size === 8);
  assert.ok(estimateJsonTokens(catalog) < 1000);
});

test("buildPayload creates inline mode without defer_loading", () => {
  const payload = buildPayload({
    model: "deepseek-v4-flash",
    runId: "inline-1",
    mode: "inline",
    toolCatalog: buildToolCatalog({ toolCount: 6 })
  });

  assert.equal(payload.tools.length, 6);
  assert.ok(payload.tools.every((tool) => tool.defer_loading !== true));
  assert.deepEqual(payload.cache_control, { type: "ephemeral" });
});

test("buildPayload creates defer_only mode with deferred tools", () => {
  const payload = buildPayload({
    model: "deepseek-v4-flash",
    runId: "defer-1",
    mode: "defer_only",
    toolCatalog: buildToolCatalog({ toolCount: 6 })
  });

  assert.equal(payload.tools.length, 6);
  assert.ok(payload.tools.every((tool) => tool.defer_loading === true));
});

test("buildPayload creates defer_search mode with a search tool plus deferred tools", () => {
  const payload = buildPayload({
    model: "deepseek-v4-flash",
    runId: "defer-search-1",
    mode: "defer_search",
    toolCatalog: buildToolCatalog({ toolCount: 6 })
  });

  assert.equal(payload.tools[0].type, "tool_search_tool_regex_20251119");
  assert.equal(payload.tools[0].name, "tool_search_tool_regex");
  assert.ok(payload.tools.slice(1).every((tool) => tool.defer_loading === true));
});

test("normalizeUsage supports Anthropic-style usage fields", () => {
  assert.deepEqual(
    normalizeUsage({
      input_tokens: 9,
      cache_creation_input_tokens: 420,
      cache_read_input_tokens: 111
    }),
    {
      processedTokens: 429,
      cacheReadTokens: 111,
      totalTokens: 540
    }
  );
});

test("normalizeUsage supports DeepSeek-style prompt cache fields", () => {
  assert.deepEqual(
    normalizeUsage({
      prompt_cache_miss_tokens: 1224,
      prompt_cache_hit_tokens: 1222
    }),
    {
      processedTokens: 1224,
      cacheReadTokens: 1222,
      totalTokens: 2446
    }
  );
});

test("judgeDeferral reports unsupported when processed tokens stay similar", () => {
  const verdict = judgeDeferral({
    inlineUsage: { processedTokens: 420 },
    deferUsage: { processedTokens: 401 }
  });

  assert.equal(verdict.status, "unsupported");
});

test("resolveIntervalMs defaults to 5 seconds and validates overrides", () => {
  assert.equal(resolveIntervalMs(undefined), 5000);
  assert.equal(resolveIntervalMs("7000"), 7000);
  assert.throws(() => resolveIntervalMs("0"), /positive number/);
});

test("buildHeaders supports x-api-key and bearer auth", () => {
  const xApiKeyHeaders = buildHeaders(
    { auth: { type: "x-api-key" }, default_headers: { "anthropic-version": "2023-06-01" } },
    "abc"
  );
  const bearerHeaders = buildHeaders({ auth: { type: "bearer" } }, "xyz");

  assert.equal(xApiKeyHeaders["x-api-key"], "abc");
  assert.equal(xApiKeyHeaders["anthropic-version"], "2023-06-01");
  assert.equal(bearerHeaders.authorization, "Bearer xyz");
});

test("renderMarkdownSummary includes the final verdict and endpoint", () => {
  const markdown = renderMarkdownSummary({
    profile: "deepseek",
    label: "DeepSeek 官方 Anthropic 接口",
    endpoint: "https://api.deepseek.com/anthropic/v1/messages",
    model: "deepseek-v4-flash",
    toolCount: 8,
    intervalMs: 5000,
    controlCacheObserved: true,
    deferAccepted: true,
    deferSearchAccepted: false,
    inlineControlFirst: { usage: { processedTokens: 886, cacheReadTokens: 0 }, status: 200 },
    inlineControlSecond: { usage: { processedTokens: 118, cacheReadTokens: 768 }, status: 200 },
    freshInline: { usage: { processedTokens: 888, cacheReadTokens: 0 }, status: 200 },
    freshDeferOnly: { usage: { processedTokens: 888, cacheReadTokens: 0 }, status: 200 },
    deferSearchProbe: { ok: false, status: 400, error: { message: "bad request" } },
    verdict: { status: "unsupported", reductionRatio: 0 }
  });

  assert.match(markdown, /DeepSeek 官方 Anthropic 接口/);
  assert.match(markdown, /https:\/\/api\.deepseek\.com\/anthropic\/v1\/messages/);
  assert.match(markdown, /unsupported/);
});
