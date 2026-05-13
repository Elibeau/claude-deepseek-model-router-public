const DEFAULT_MODELS = {
  "claude-opus-4-7": {
    model: "deepseek-v4-pro",
    thinking: { type: "enabled" },
    output_config: { effort: "high" }
  },
  "claude-sonnet-4-6": {
    model: "deepseek-v4-flash",
    thinking: { type: "enabled" },
    output_config: { effort: "high" }
  }
};

export function configFromEnv(env = {}) {
  const parsed = env.ROUTER_CONFIG ? JSON.parse(env.ROUTER_CONFIG) : {};
  if (env.UPSTREAM_API_KEY) {
    parsed.upstream = { ...(parsed.upstream || {}), apiKey: env.UPSTREAM_API_KEY };
  }
  if (env.GATEWAY_API_KEY) {
    parsed.gatewayApiKey = env.GATEWAY_API_KEY;
  }
  return configFromObject(parsed);
}

export function configFromObject(raw = {}) {
  return {
    gatewayApiKey: raw.gatewayApiKey || "",
    upstream: {
      baseUrl: trimTrailingSlash(raw.upstream?.baseUrl || "https://api.deepseek.com"),
      apiFormat: raw.upstream?.apiFormat || guessApiFormat(raw.upstream?.baseUrl || "https://api.deepseek.com"),
      apiKey: raw.upstream?.apiKey || "",
      authHeader: raw.upstream?.authHeader || "Authorization",
      authScheme: raw.upstream?.authScheme || "Bearer",
      extraHeaders: raw.upstream?.extraHeaders || {}
    },
    strictModelMapping: raw.strictModelMapping !== false,
    models: raw.models || DEFAULT_MODELS,
    displayNames: raw.displayNames || {},
    compatibility: {
      rewriteForcedToolChoice: raw.compatibility?.rewriteForcedToolChoice !== false,
      normalizeUnsupportedContentBlocks: raw.compatibility?.normalizeUnsupportedContentBlocks !== false,
      dropMcpServers: raw.compatibility?.dropMcpServers !== false,
      extractPdfDocuments: raw.compatibility?.extractPdfDocuments !== false,
      maxExtractedDocumentChars: Number(raw.compatibility?.maxExtractedDocumentChars || 120000)
    }
  };
}

export async function handleRequest(request, config) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return emptyResponse(204);
  }

  if (url.pathname === "/health") {
    return jsonResponse({ ok: true, models: Object.keys(config.models) });
  }

  if (url.pathname === "/v1/models" && request.method === "GET") {
    if (!isAuthorized(request, config)) return unauthorized();
    return jsonResponse(modelList(config));
  }

  if (url.pathname === "/v1/messages" && request.method === "POST") {
    if (!isAuthorized(request, config)) return unauthorized();
    return proxyMessages(request, config);
  }

  return jsonResponse({ error: { type: "not_found", message: "Unsupported route" } }, 404);
}

async function proxyMessages(request, config) {
  let anthropicBody;
  try {
    anthropicBody = await request.json();
  } catch {
    return jsonResponse({ error: { type: "invalid_request_error", message: "Request body must be JSON" } }, 400);
  }

  const aliasModel = anthropicBody.model;
  const modelSpec = config.models[aliasModel];
  if (!modelSpec && config.strictModelMapping) {
    return jsonResponse({
      error: {
        type: "invalid_request_error",
        message: `Unknown model '${aliasModel}'. Add it to models mapping to avoid accidental fallback.`
      }
    }, 400);
  }

  const upstreamModel = upstreamModelFromSpec(modelSpec, aliasModel);
  const preparedBody = await prepareAnthropicBodyForUpstream(anthropicBody, config);

  if (config.upstream.apiFormat === "anthropic") {
    return proxyAnthropicMessages(preparedBody, aliasModel, upstreamModel, modelSpec, config);
  }

  const openAiBody = applyOpenAIModelSpec(anthropicToOpenAI({
    ...preparedBody,
    model: upstreamModel
  }), modelSpec);

  const upstreamResponse = await fetch(`${config.upstream.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: upstreamHeaders(config),
    body: JSON.stringify(openAiBody)
  });

  if (!upstreamResponse.ok) {
    const errorText = await upstreamResponse.text();
    return jsonResponse({
      error: {
        type: "upstream_error",
        status: upstreamResponse.status,
        message: errorText.slice(0, 4000)
      }
    }, upstreamResponse.status);
  }

  if (openAiBody.stream) {
    return new Response(openAIStreamToAnthropicStream(upstreamResponse, aliasModel), {
      status: 200,
      headers: sseHeaders()
    });
  }

  const openAiJson = await upstreamResponse.json();
  return jsonResponse(openAIToAnthropic(openAiJson, aliasModel));
}

async function prepareAnthropicBodyForUpstream(body, config) {
  let out = {
    ...body,
    messages: Array.isArray(body.messages)
      ? await Promise.all(body.messages.map((message) => normalizeMessageForUpstream(message, config)))
      : []
  };

  if (Array.isArray(body.tools)) {
    out.tools = body.tools.map(normalizeToolDefinition).filter(Boolean);
  }

  if (config.compatibility.dropMcpServers && out.mcp_servers) {
    delete out.mcp_servers;
  }

  if (config.compatibility.rewriteForcedToolChoice) {
    out = rewriteForcedToolChoice(out);
  }

  return out;
}

async function normalizeMessageForUpstream(message, config) {
  if (!config.compatibility.normalizeUnsupportedContentBlocks) return message;
  if (!Array.isArray(message.content)) return message;

  const content = [];
  for (const block of message.content) {
    content.push(...await normalizeContentBlockForUpstream(block, config));
  }

  return {
    ...message,
    content: content.filter(Boolean)
  };
}

async function normalizeContentBlockForUpstream(block, config) {
  if (!block || typeof block !== "object") return [];

  if (block.type === "text" || block.type === "thinking") {
    return [withoutIgnoredFields(block)];
  }

  if (block.type === "tool_use") {
    return [{
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: block.input ?? {}
    }];
  }

  if (block.type === "tool_result") {
    return [{
      type: "tool_result",
      tool_use_id: block.tool_use_id,
      content: block.content ?? "",
      is_error: block.is_error
    }];
  }

  if (block.type === "mcp_tool_use" || block.type === "server_tool_use") {
    return [{
      type: "tool_use",
      id: block.id || block.tool_use_id || `toolu_${cryptoRandomId()}`,
      name: block.name || block.tool_name || block.server_name || "mcp_tool",
      input: block.input ?? {}
    }];
  }

  if (block.type === "mcp_tool_result") {
    return [{
      type: "tool_result",
      tool_use_id: block.tool_use_id || block.id,
      content: block.content ?? "",
      is_error: block.is_error
    }];
  }

  if (block.type === "document") {
    return [{ type: "text", text: await documentBlockToText(block, config) }];
  }

  if (block.type === "image") {
    return [{ type: "text", text: imageBlockPlaceholder(block) }];
  }

  if (
    block.type === "search_result" ||
    block.type === "web_search_tool_result" ||
    block.type === "code_execution_tool_result" ||
    block.type === "container_upload"
  ) {
    return [{ type: "text", text: unsupportedBlockPlaceholder(block) }];
  }

  return [{ type: "text", text: unsupportedBlockPlaceholder(block) }];
}

function normalizeToolDefinition(tool) {
  if (!tool || typeof tool !== "object") return null;
  if (!tool.name) return null;

  return {
    name: tool.name,
    description: tool.description || "",
    input_schema: tool.input_schema || { type: "object", properties: {} }
  };
}

function rewriteForcedToolChoice(body) {
  if (body.tool_choice?.type !== "tool" || !body.tool_choice.name) {
    return body;
  }

  const selectedTool = Array.isArray(body.tools)
    ? body.tools.find((tool) => tool.name === body.tool_choice.name)
    : null;

  if (!selectedTool) {
    return {
      ...body,
      tool_choice: { type: "auto" }
    };
  }

  return {
    ...body,
    tools: [selectedTool],
    tool_choice: { type: "any" }
  };
}

function withoutIgnoredFields(block) {
  const { cache_control, citations, ...rest } = block;
  return rest;
}

async function documentBlockToText(block, config) {
  const title = block.title || block.name || block.source?.filename || "document";
  const mediaType = block.source?.media_type || block.media_type || "unknown media type";

  if (block.source?.type === "text" && block.source.text) {
    return `[Document: ${title}]\n${block.source.text}`;
  }

  if (typeof block.content === "string") {
    return `[Document: ${title}]\n${block.content}`;
  }

  if (
    config.compatibility.extractPdfDocuments &&
    block.source?.type === "base64" &&
    mediaType === "application/pdf" &&
    block.source.data
  ) {
    const extracted = await extractPdfText(block.source.data, config.compatibility.maxExtractedDocumentChars);
    if (extracted) return `[PDF: ${title}]\n${extracted}`;
  }

  return `[Unsupported document omitted: ${title} (${mediaType}). DeepSeek's Anthropic-compatible API does not support document blocks directly. Extract the document text locally before sending it to this model.]`;
}

async function extractPdfText(base64Data, maxChars) {
  if (typeof Buffer === "undefined") return "";

  try {
    const imported = await import("pdf-parse");
    const parsePdf = imported.default || imported;
    const buffer = Buffer.from(String(base64Data).replace(/^data:application\/pdf;base64,/, ""), "base64");
    const result = await parsePdf(buffer);
    const text = String(result.text || "").trim();
    if (!text) return "";
    return text.length > maxChars
      ? `${text.slice(0, maxChars)}\n\n[PDF text truncated at ${maxChars} characters.]`
      : text;
  } catch {
    return "";
  }
}

function imageBlockPlaceholder(block) {
  const mediaType = block.source?.media_type || block.media_type || "unknown media type";
  return `[Unsupported image omitted: ${mediaType}. DeepSeek's Anthropic-compatible API does not support image blocks.]`;
}

function unsupportedBlockPlaceholder(block) {
  return `[Unsupported Anthropic content block omitted: ${block.type || "unknown"}. ${JSON.stringify(block).slice(0, 1000)}]`;
}

async function proxyAnthropicMessages(anthropicBody, aliasModel, upstreamModel, modelSpec, config) {
  const upstreamResponse = await fetch(`${config.upstream.baseUrl}/v1/messages`, {
    method: "POST",
    headers: upstreamHeaders(config),
    body: JSON.stringify(applyAnthropicModelSpec(anthropicBody, upstreamModel, modelSpec))
  });

  if (!upstreamResponse.ok) {
    const errorText = await upstreamResponse.text();
    return jsonResponse({
      error: {
        type: "upstream_error",
        status: upstreamResponse.status,
        message: errorText.slice(0, 4000)
      }
    }, upstreamResponse.status);
  }

  if (anthropicBody.stream) {
    return new Response(rewriteAnthropicStream(upstreamResponse, aliasModel), {
      status: upstreamResponse.status,
      headers: sseHeaders()
    });
  }

  const data = await upstreamResponse.json();
  if (data && typeof data === "object") data.model = aliasModel;
  return jsonResponse(data, upstreamResponse.status);
}

function upstreamModelFromSpec(modelSpec, aliasModel) {
  if (typeof modelSpec === "string") return modelSpec;
  if (modelSpec && typeof modelSpec === "object") {
    return modelSpec.model || modelSpec.upstreamModel || stripClaudePrefix(aliasModel);
  }
  return stripClaudePrefix(aliasModel);
}

function applyAnthropicModelSpec(body, upstreamModel, modelSpec) {
  const spec = normalizedModelSpec(modelSpec);
  const out = {
    ...body,
    model: upstreamModel
  };

  if (spec.thinking) {
    out.thinking = spec.thinking;
  }
  if (spec.output_config) {
    out.output_config = {
      ...(body.output_config || {}),
      ...spec.output_config
    };
  }

  return out;
}

function applyOpenAIModelSpec(body, modelSpec) {
  const spec = normalizedModelSpec(modelSpec);
  const out = { ...body };

  if (spec.thinking) {
    out.thinking = spec.thinking;
  }
  if (spec.reasoning_effort) {
    out.reasoning_effort = spec.reasoning_effort;
  } else if (spec.output_config?.effort) {
    out.reasoning_effort = spec.output_config.effort;
  }

  return out;
}

function normalizedModelSpec(modelSpec) {
  if (!modelSpec || typeof modelSpec === "string") return {};

  const spec = { ...modelSpec };
  if (spec.effort && !spec.output_config) {
    spec.output_config = { effort: spec.effort };
  }
  if (spec.output_config?.effort && !spec.thinking) {
    spec.thinking = { type: "enabled" };
  }
  if (spec.output_config?.effort === "xhigh") {
    spec.output_config = { ...spec.output_config, effort: "max" };
  }

  return spec;
}

function anthropicToOpenAI(body) {
  const messages = [];
  if (body.system) {
    messages.push({ role: "system", content: anthropicContentToText(body.system) });
  }
  messages.push(...anthropicMessagesToOpenAI(body.messages || []));

  const out = {
    model: body.model,
    messages,
    stream: Boolean(body.stream),
    max_tokens: body.max_tokens
  };

  copyIfPresent(body, out, "temperature");
  copyIfPresent(body, out, "top_p");
  if (body.stop_sequences) out.stop = body.stop_sequences;
  if (body.tools?.length) out.tools = body.tools.map(anthropicToolToOpenAI);
  if (body.tool_choice) out.tool_choice = anthropicToolChoiceToOpenAI(body.tool_choice);
  if (out.stream) out.stream_options = { include_usage: true };

  return out;
}

function anthropicMessagesToOpenAI(messages) {
  const out = [];

  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push({ role: message.role, content: message.content });
      continue;
    }

    const content = Array.isArray(message.content) ? message.content : [];
    const textBlocks = [];
    const imageBlocks = [];
    const toolCalls = [];
    const toolResults = [];

    for (const block of content) {
      if (block.type === "text") textBlocks.push(block.text || "");
      if (block.type === "image") imageBlocks.push(block);
      if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {})
          }
        });
      }
      if (block.type === "tool_result") {
        toolResults.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: anthropicContentToText(block.content)
        });
      }
    }

    if (message.role === "assistant") {
      const openAiMessage = {
        role: "assistant",
        content: textBlocks.join("\n") || null
      };
      if (toolCalls.length) openAiMessage.tool_calls = toolCalls;
      out.push(openAiMessage);
      continue;
    }

    if (textBlocks.length || imageBlocks.length) {
      out.push({
        role: "user",
        content: imageBlocks.length
          ? openAIUserContentParts(textBlocks, imageBlocks)
          : textBlocks.join("\n")
      });
    }
    out.push(...toolResults);
  }

  return out;
}

function openAIToAnthropic(data, aliasModel) {
  const choice = data.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];

  if (message.reasoning_content) {
    content.push({ type: "text", text: String(message.reasoning_content) });
  }
  if (message.content) {
    content.push({ type: "text", text: String(message.content) });
  }
  for (const call of message.tool_calls || []) {
    content.push({
      type: "tool_use",
      id: call.id || `toolu_${cryptoRandomId()}`,
      name: call.function?.name || "unknown_tool",
      input: safeJsonParse(call.function?.arguments || "{}", {})
    });
  }

  return {
    id: data.id || `msg_${cryptoRandomId()}`,
    type: "message",
    role: "assistant",
    model: aliasModel,
    content,
    stop_reason: mapFinishReason(choice.finish_reason, Boolean(message.tool_calls?.length)),
    stop_sequence: null,
    usage: {
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0
    }
  };
}

function openAIStreamToAnthropicStream(upstreamResponse, aliasModel) {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      let nextIndex = 0;
      let textIndex = null;
      const toolIndexes = new Map();
      let outputTokens = 0;
      let stopReason = "end_turn";

      const send = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      send("message_start", {
        type: "message_start",
        message: {
          id: `msg_${cryptoRandomId()}`,
          type: "message",
          role: "assistant",
          model: aliasModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      });

      for await (const data of iterateSseData(upstreamResponse.body)) {
        if (data === "[DONE]") break;

        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }

        if (chunk.usage?.completion_tokens) outputTokens = chunk.usage.completion_tokens;

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta || {};
        if (delta.content) {
          if (textIndex === null) {
            textIndex = nextIndex++;
            send("content_block_start", {
              type: "content_block_start",
              index: textIndex,
              content_block: { type: "text", text: "" }
            });
          }
          send("content_block_delta", {
            type: "content_block_delta",
            index: textIndex,
            delta: { type: "text_delta", text: delta.content }
          });
        }

        for (const toolCall of delta.tool_calls || []) {
          const key = String(toolCall.index ?? toolCall.id ?? toolIndexes.size);
          let toolState = toolIndexes.get(key);
          if (!toolState) {
            toolState = {
              index: nextIndex++,
              id: toolCall.id || `toolu_${cryptoRandomId()}`,
              name: toolCall.function?.name || "unknown_tool"
            };
            toolIndexes.set(key, toolState);
            send("content_block_start", {
              type: "content_block_start",
              index: toolState.index,
              content_block: {
                type: "tool_use",
                id: toolState.id,
                name: toolState.name,
                input: {}
              }
            });
          }

          if (toolCall.function?.arguments) {
            send("content_block_delta", {
              type: "content_block_delta",
              index: toolState.index,
              delta: {
                type: "input_json_delta",
                partial_json: toolCall.function.arguments
              }
            });
          }
        }

        if (choice.finish_reason) {
          stopReason = mapFinishReason(choice.finish_reason, toolIndexes.size > 0);
        }
      }

      if (textIndex !== null) {
        send("content_block_stop", { type: "content_block_stop", index: textIndex });
      }
      for (const toolState of toolIndexes.values()) {
        send("content_block_stop", { type: "content_block_stop", index: toolState.index });
      }
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens }
      });
      send("message_stop", { type: "message_stop" });
      controller.close();
    }
  });
}

async function* iterateSseData(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) yield data;
    }
  }
}

function rewriteAnthropicStream(upstreamResponse, aliasModel) {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      for await (const data of iterateSseData(upstreamResponse.body)) {
        if (data === "[DONE]") {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          continue;
        }

        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          continue;
        }

        if (parsed.model) parsed.model = aliasModel;
        if (parsed.message?.model) parsed.message.model = aliasModel;
        const event = parsed.type || "message";
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(parsed)}\n\n`));
      }
      controller.close();
    }
  });
}

function anthropicToolToOpenAI(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema || { type: "object", properties: {} }
    }
  };
}

function anthropicToolChoiceToOpenAI(choice) {
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "tool") {
    return { type: "function", function: { name: choice.name } };
  }
  return "auto";
}

function anthropicContentToText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (typeof block === "string") return block;
      if (block.type === "text") return block.text || "";
      return JSON.stringify(block);
    }).filter(Boolean).join("\n");
  }
  return JSON.stringify(content);
}

function openAIUserContentParts(textBlocks, imageBlocks) {
  const parts = textBlocks.length ? [{ type: "text", text: textBlocks.join("\n") }] : [];
  for (const image of imageBlocks) {
    if (image.source?.type === "base64") {
      parts.push({
        type: "image_url",
        image_url: {
          url: `data:${image.source.media_type};base64,${image.source.data}`
        }
      });
    }
  }
  return parts;
}

function modelList(config) {
  return {
    object: "list",
    data: Object.keys(config.models).map((id) => ({
      type: "model",
      id,
      display_name: config.displayNames[id] || id,
      created_at: "2026-01-01T00:00:00Z"
    }))
  };
}

function upstreamHeaders(config) {
  const headers = {
    "content-type": "application/json",
    ...config.upstream.extraHeaders
  };

  if (config.upstream.apiKey) {
    if (config.upstream.authHeader.toLowerCase() === "authorization") {
      headers.Authorization = `${config.upstream.authScheme} ${config.upstream.apiKey}`;
    } else {
      headers[config.upstream.authHeader] = config.upstream.apiKey;
    }
  }

  return headers;
}

function isAuthorized(request, config) {
  if (!config.gatewayApiKey) return true;
  const authorization = request.headers.get("authorization") || "";
  const xApiKey = request.headers.get("x-api-key") || "";
  return authorization === `Bearer ${config.gatewayApiKey}` || xApiKey === config.gatewayApiKey;
}

function unauthorized() {
  return jsonResponse({ error: { type: "authentication_error", message: "Invalid gateway API key" } }, 401);
}

function mapFinishReason(reason, hasToolCalls) {
  if (hasToolCalls) return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "tool_calls") return "tool_use";
  if (reason === "stop") return "end_turn";
  return reason || "end_turn";
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders()
    }
  });
}

function emptyResponse(status) {
  return new Response(null, { status, headers: corsHeaders() });
}

function sseHeaders() {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
    ...corsHeaders()
  };
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,x-api-key,content-type,anthropic-version,anthropic-beta"
  };
}

function copyIfPresent(from, to, key) {
  if (from[key] !== undefined) to[key] = from[key];
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function stripClaudePrefix(model) {
  return String(model || "").replace(/^claude[-_:]?/i, "");
}

function guessApiFormat(baseUrl) {
  return String(baseUrl || "").includes("/anthropic") ? "anthropic" : "openai";
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}


function cryptoRandomId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
