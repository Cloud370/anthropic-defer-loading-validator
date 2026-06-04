#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

import {
  buildHeaders,
  buildPayload,
  buildToolCatalog,
  estimateJsonTokens,
  judgeDeferral,
  normalizeUsage,
  renderMarkdownSummary,
  resolveIntervalMs,
  summarizeRun,
} from "./validator_lib.mjs";

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) {
    return fallback;
  }
  return args[index + 1];
};

const profilePath = new URL(readArg("--profile", "./profiles/deepseek.json"), import.meta.url);
const toolCount = Number(readArg("--tool-count", "8"));
const intervalMs = resolveIntervalMs(readArg("--interval-ms", "5000"));
const runScope = readArg("--run-scope", `run${Date.now().toString(36)}`);
const outputPath = new URL(readArg("--output", "./validation.last.json"), import.meta.url);
const summaryPath = new URL(readArg("--summary-md", "./validation.summary.md"), import.meta.url);
const targetTopic = readArg("--target-topic", "project orbit delayed orders");

if (!Number.isInteger(toolCount) || toolCount <= 0) {
  console.error("--tool-count must be a positive integer.");
  process.exit(1);
}

const profile = JSON.parse(await readFile(profilePath, "utf8"));
const apiKey = process.env[profile.auth?.env ?? ""];

if (!apiKey) {
  console.error(`Missing API key. Set environment variable ${profile.auth?.env}.`);
  process.exit(1);
}

profile.run_scope = runScope;

const controlCatalog = buildToolCatalog({ toolCount, targetTopic, namePrefix: `${runScope}_control` });
const freshInlineCatalog = buildToolCatalog({ toolCount, targetTopic, namePrefix: `${runScope}_alpha` });
const freshDeferCatalog = buildToolCatalog({ toolCount, targetTopic, namePrefix: `${runScope}_beta` });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendRequest({ label, payload, useAdvancedToolBeta = false }) {
  const headers = buildHeaders(profile, apiKey, useAdvancedToolBeta);

  const response = await fetch(profile.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw_text: text };
  }

  return {
    label,
    ok: response.ok,
    status: response.status,
    provider: body.provider ?? null,
    stopReason: body.stop_reason ?? null,
    usage: normalizeUsage(body.usage ?? {}),
    rawUsage: body.usage ?? null,
    contentTypes: Array.isArray(body.content) ? body.content.map((block) => block.type) : [],
    text: Array.isArray(body.content)
      ? body.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")
      : null,
    error: body.error ?? null,
    metadata: body.metadata ?? null,
    rawBody: body,
  };
}

function printResult(result) {
  console.log(
    [
      `${result.label}:`,
      `status=${result.status}`,
      `processed=${result.usage.processedTokens}`,
      `cache_read=${result.usage.cacheReadTokens}`,
      `stop=${result.stopReason ?? "(none)"}`,
    ].join(" "),
  );
  if (!result.ok) {
    console.log(`  error: ${JSON.stringify(result.error ?? result.rawBody)}`);
    if (result.metadata) {
      console.log(`  metadata: ${JSON.stringify(result.metadata)}`);
    }
    return;
  }
  console.log(`  raw_usage: ${JSON.stringify(result.rawUsage)}`);
  console.log(`  content_types: ${result.contentTypes.join(", ") || "(none)"}`);
  console.log(`  text: ${result.text ?? ""}`);
}

function buildRequest(mode, runId, toolCatalog) {
  return buildPayload({
    model: profile.model,
    runId: `${runScope}-${runId}`,
    mode,
    toolCatalog,
    targetTopic,
    includeTopLevelCacheControl: Boolean(profile.top_level_cache_control),
    provider: profile.provider,
  });
}

const inlineControlPayload = buildRequest("inline", "inline-control", controlCatalog);
const freshInlinePayload = buildRequest("inline", "fresh-inline-a", freshInlineCatalog);
const freshDeferOnlyPayload = buildRequest("defer_only", "fresh-defer-b", freshDeferCatalog);
const deferSearchProbePayload = buildRequest(
  "defer_search",
  "probe-defer-search",
  freshDeferCatalog.slice(0, 2),
);

console.log("=".repeat(72));
console.log("Anthropic-compatible defer_loading validator");
console.log("=".repeat(72));
console.log(`profile: ${profile.id} (${profile.label})`);
console.log(`endpoint: ${profile.endpoint}`);
console.log(`model: ${profile.model}`);
console.log(`run_scope: ${runScope}`);
console.log(`tool_count: ${toolCount}`);
console.log(`interval_ms: ${intervalMs}`);
console.log(`inline_payload_estimate: ${estimateJsonTokens(inlineControlPayload)} tokens`);
console.log(`defer_only_payload_estimate: ${estimateJsonTokens(freshDeferOnlyPayload)} tokens`);
console.log(`output: ${outputPath.pathname}`);

let deferSearchProbe = {
  label: "defer_search_probe",
  ok: false,
  status: 0,
  provider: null,
  stopReason: null,
  usage: { processedTokens: 0, cacheReadTokens: 0, totalTokens: 0 },
  rawUsage: null,
  contentTypes: [],
  text: null,
  error: { message: "probe disabled by profile" },
  metadata: null,
  rawBody: null,
};

if (profile.defer_search_probe?.enabled) {
  console.log("\n--- Probe: defer_search request surface ---");
  if (profile.defer_search_probe.tool_search_type && profile.defer_search_probe.tool_search_type !== "tool_search_tool_regex_20251119") {
    deferSearchProbePayload.tools[0].type = profile.defer_search_probe.tool_search_type;
  }
  if (profile.defer_search_probe.tool_search_name && profile.defer_search_probe.tool_search_name !== "tool_search_tool_regex") {
    deferSearchProbePayload.tools[0].name = profile.defer_search_probe.tool_search_name;
  }
  deferSearchProbe = await sendRequest({
    label: "defer_search_probe",
    payload: deferSearchProbePayload,
    useAdvancedToolBeta: true,
  });
  printResult(deferSearchProbe);
}

console.log("\n--- Control: inline cache pair ---");
const inlineControlFirst = await sendRequest({
  label: "inline_control_first",
  payload: inlineControlPayload,
});
printResult(inlineControlFirst);

await sleep(intervalMs);

const inlineControlSecond = await sendRequest({
  label: "inline_control_second",
  payload: inlineControlPayload,
});
printResult(inlineControlSecond);

console.log("\n--- Fresh comparison ---");
const freshInline = await sendRequest({
  label: "fresh_inline",
  payload: freshInlinePayload,
});
printResult(freshInline);

const freshDeferOnly = await sendRequest({
  label: "fresh_defer_only",
  payload: freshDeferOnlyPayload,
});
printResult(freshDeferOnly);

const verdict = judgeDeferral({
  inlineUsage: freshInline.usage,
  deferUsage: freshDeferOnly.usage,
});

console.log("\n--- Verdict ---");
console.log(JSON.stringify(verdict, null, 2));

const summary = summarizeRun({
  profile,
  inlineControlFirst,
  inlineControlSecond,
  freshInline,
  freshDeferOnly,
  deferSearchProbe,
  verdict,
  toolCount,
  intervalMs,
});

await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
await writeFile(summaryPath, renderMarkdownSummary(summary), "utf8");

console.log(`\nSaved JSON summary to ${outputPath.pathname}`);
console.log(`Saved Markdown summary to ${summaryPath.pathname}`);
