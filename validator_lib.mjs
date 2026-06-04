const DEFAULT_TOPIC = "project orbit delayed orders";
const DEFAULT_INTERVAL_MS = 5000;

export function buildToolCatalog({ toolCount = 8, targetTopic = DEFAULT_TOPIC, namePrefix = "lookup" }) {
  if (!Number.isInteger(toolCount) || toolCount <= 0) {
    throw new Error("toolCount must be a positive integer");
  }

  return Array.from({ length: toolCount }, (_, index) => ({
    name:
      index === 0
        ? `${namePrefix}_project_orbit_orders_${index}`
        : `${namePrefix}_reference_orders_${index}`,
    description:
      index === 0
        ? `Lookup ${targetTopic} by region and status.`
        : `Lookup unrelated order archive slice ${index}.`,
    input_schema: {
      type: "object",
      properties: {
        region: { type: "string", description: "Region code." },
        status: { type: "string", description: "Order status." }
      },
      required: ["region"]
    }
  }));
}

export function buildPayload({
  model,
  runId,
  mode,
  toolCatalog,
  targetTopic = DEFAULT_TOPIC,
  includeTopLevelCacheControl = true,
  provider = null
}) {
  if (mode !== "inline" && mode !== "defer_only" && mode !== "defer_search") {
    throw new Error("mode must be 'inline', 'defer_only', or 'defer_search'");
  }

  const tools =
    mode === "inline"
      ? toolCatalog
      : mode === "defer_only"
        ? toolCatalog.map((tool) => ({ ...tool, defer_loading: true }))
        : [
            {
              type: "tool_search_tool_regex_20251119",
              name: "tool_search_tool_regex"
            },
            ...toolCatalog.map((tool) => ({ ...tool, defer_loading: true }))
          ];

  const payload = {
    model,
    max_tokens: 48,
    system: [
      {
        type: "text",
        text: `[run:${runId}] Validate whether deferred tools stay out of the cacheable prefix for ${targetTopic}.`
      }
    ],
    messages: [
      {
        role: "user",
        content: "Reply with ok only. Do not call any tool."
      }
    ],
    tools
  };

  if (includeTopLevelCacheControl) {
    payload.cache_control = { type: "ephemeral" };
  }

  if (provider) {
    payload.provider = provider;
  }

  return payload;
}

export function estimateJsonTokens(value) {
  return Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
}

export function normalizeUsage(usage = {}) {
  if (
    Object.prototype.hasOwnProperty.call(usage, "prompt_cache_miss_tokens") ||
    Object.prototype.hasOwnProperty.call(usage, "prompt_cache_hit_tokens")
  ) {
    const promptCacheMissTokens = Number(usage.prompt_cache_miss_tokens ?? 0);
    const promptCacheHitTokens = Number(usage.prompt_cache_hit_tokens ?? 0);

    return {
      processedTokens: promptCacheMissTokens,
      cacheReadTokens: promptCacheHitTokens,
      totalTokens: promptCacheMissTokens + promptCacheHitTokens
    };
  }

  const inputTokens = Number(usage.input_tokens ?? 0);
  const cacheCreationInputTokens = Number(usage.cache_creation_input_tokens ?? 0);
  const cacheReadInputTokens = Number(usage.cache_read_input_tokens ?? 0);

  return {
    processedTokens: inputTokens + cacheCreationInputTokens,
    cacheReadTokens: cacheReadInputTokens,
    totalTokens: inputTokens + cacheCreationInputTokens + cacheReadInputTokens
  };
}

export function judgeDeferral({ inlineUsage, deferUsage }) {
  const inlineProcessed = Number(inlineUsage.processedTokens ?? 0);
  const deferProcessed = Number(deferUsage.processedTokens ?? 0);
  const reductionRatio = inlineProcessed > 0 ? (inlineProcessed - deferProcessed) / inlineProcessed : 0;

  let status = "ambiguous";
  if (reductionRatio > 0.35) {
    status = "supported";
  } else if (Math.abs(reductionRatio) < 0.1) {
    status = "unsupported";
  }

  return {
    status,
    inlineProcessed,
    deferProcessed,
    reductionRatio
  };
}

export function resolveIntervalMs(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_INTERVAL_MS;
  }

  const intervalMs = Number(value);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("interval must be a positive number of milliseconds");
  }

  return intervalMs;
}

export function buildHeaders(profile, apiKey, useAdvancedToolBeta = false) {
  const headers = {
    "content-type": "application/json",
    ...(profile.default_headers ?? {})
  };

  if (profile.auth?.type === "x-api-key") {
    headers["x-api-key"] = apiKey;
  } else if (profile.auth?.type === "bearer") {
    headers.authorization = `Bearer ${apiKey}`;
  } else {
    throw new Error(`Unsupported auth type: ${profile.auth?.type}`);
  }

  if (useAdvancedToolBeta && profile.defer_search_probe?.beta_header) {
    headers["anthropic-beta"] = profile.defer_search_probe.beta_header;
  }

  return headers;
}

export function summarizeRun({ profile, inlineControlFirst, inlineControlSecond, freshInline, freshDeferOnly, deferSearchProbe, verdict, toolCount, intervalMs }) {
  const controlCacheObserved = inlineControlSecond.usage.cacheReadTokens > 0;
  const deferAccepted = freshDeferOnly.ok;
  const deferSearchAccepted = deferSearchProbe.ok;

  return {
    generatedAt: new Date().toISOString(),
    profile: profile.id,
    label: profile.label,
    endpoint: profile.endpoint,
    model: profile.model,
    runScope: profile.run_scope ?? null,
    toolCount,
    intervalMs,
    controlCacheObserved,
    deferAccepted,
    deferSearchAccepted,
    inlineControlFirst,
    inlineControlSecond,
    freshInline,
    freshDeferOnly,
    deferSearchProbe,
    verdict
  };
}

export function renderMarkdownSummary(summary) {
  const lines = [];
  lines.push("## 验证结论");
  lines.push("");
  lines.push(`- Profile: \
\`${summary.profile}\` (${summary.label})`);
  lines.push(`- Base URL: \
\`${summary.endpoint}\``);
  lines.push(`- Model: \
\`${summary.model}\``);
  if (summary.runScope) {
    lines.push(`- Run scope: \
\`${summary.runScope}\``);
  }
  lines.push(`- Tool count: \
\`${summary.toolCount}\``);
  lines.push(`- Interval: \
\`${summary.intervalMs}ms\``);
  lines.push(`- 控制组 prompt cache 命中: **${summary.controlCacheObserved ? "是" : "否"}**`);
  lines.push(`- \
\`defer_loading\` 字段请求被接受: **${summary.deferAccepted ? "是" : "否"}**`);
  lines.push(`- 真正的 defer search 请求面被接受: **${summary.deferSearchAccepted ? "是" : "否"}**`);
  lines.push(`- Fresh defer 首轮是否比 inline 更小: **${summary.verdict.reductionRatio > 0 ? "是" : "否"}**`);
  lines.push(`- 最终判定: **${summary.verdict.status}**`);
  lines.push("");
  lines.push("## 关键数据");
  lines.push("");
  lines.push("| 检查项 | processed | cache_read | status |");
  lines.push("| --- | ---: | ---: | --- |");
  lines.push(`| inline_control_first | ${summary.inlineControlFirst.usage.processedTokens} | ${summary.inlineControlFirst.usage.cacheReadTokens} | ${summary.inlineControlFirst.status} |`);
  lines.push(`| inline_control_second | ${summary.inlineControlSecond.usage.processedTokens} | ${summary.inlineControlSecond.usage.cacheReadTokens} | ${summary.inlineControlSecond.status} |`);
  lines.push(`| fresh_inline | ${summary.freshInline.usage.processedTokens} | ${summary.freshInline.usage.cacheReadTokens} | ${summary.freshInline.status} |`);
  lines.push(`| fresh_defer_only | ${summary.freshDeferOnly.usage.processedTokens} | ${summary.freshDeferOnly.usage.cacheReadTokens} | ${summary.freshDeferOnly.status} |`);
  lines.push("");
  lines.push("## defer search 探测");
  lines.push("");
  if (summary.deferSearchProbe.ok) {
    lines.push(`- 请求被接受，status=\`${summary.deferSearchProbe.status}\``);
  } else {
    lines.push(`- 请求被拒绝，status=\`${summary.deferSearchProbe.status}\``);
    lines.push(`- 错误: \`${JSON.stringify(summary.deferSearchProbe.error ?? summary.deferSearchProbe.rawBody)}\``);
  }
  lines.push("");
  lines.push("## 解读");
  lines.push("");
  if (!summary.controlCacheObserved) {
    lines.push("- 控制组没有观察到 prompt cache 命中，本次运行不足以支撑 defer_loading 语义判断。");
  } else if (summary.verdict.status === "unsupported") {
    lines.push("- 控制组确认存在 prompt cache，但 fresh inline 与 fresh defer_only 的首轮 processed tokens 无差异，因此当前接口未体现 defer_loading 保护顶部 prompt cache 的语义。");
  } else if (summary.verdict.status === "supported") {
    lines.push("- fresh defer_only 明显小于 fresh inline，说明 deferred tools 很可能没有进入首轮 cacheable prefix。");
  } else {
    lines.push("- 结果介于两者之间，需要进一步缩小请求体或补充 provider 行为探测后再下结论。");
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}
