import { readFile } from "node:fs/promises";

const configPath = process.argv[2] || "router.config.json";
const config = JSON.parse(await readFile(configPath, "utf8"));
const baseUrl = `http://${config.listen?.host || "127.0.0.1"}:${config.listen?.port || 8787}`;
const gatewayApiKey = config.gatewayApiKey;

for (const model of Object.keys(config.models || {})) {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${gatewayApiKey}`
    },
    body: JSON.stringify({
      model,
      max_tokens: 32,
      stream: false,
      messages: [{ role: "user", content: "Reply with the model name you are serving." }]
    })
  });

  const text = await response.text();
  console.log(`\n[${model}] ${response.status}`);
  console.log(text.slice(0, 1000));
}
