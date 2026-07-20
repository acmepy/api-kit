const DEFAULT_URL = "http://localhost:3000/api";

const command = process.argv[2] || "help";
const args = process.argv.slice(3);

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

async function main() {
  const { options, positionals } = parseArgs(args);
  const baseUrl = normalizeBaseUrl(options.url || process.env.API_URL || DEFAULT_URL);

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "changes" || command === "change") {
    await printChanges(baseUrl, options.since || positionals[0] || new Date(Date.now() - 60000).toISOString());
    return;
  }

  if (command === "sse") {
    await listenSse(baseUrl);
    return;
  }

  if (command === "create-cliente") {
    await createCliente(baseUrl, {
      nombre: options.nombre || positionals[0] || `Cliente ${Date.now()}`,
      email: options.email || positionals[1] || null,
      activo: parseBooleanOption(options.activo, true),
    });
    return;
  }

  if (command === "update-cliente") {
    const id = options.id || positionals[0];
    if (!id) throw new Error("Falta el id del cliente.");
    await updateCliente(baseUrl, id, {
      nombre: options.nombre || positionals[1],
      email: options.email,
      activo: parseBooleanOption(options.activo),
    });
    return;
  }

  if (command === "delete-cliente") {
    const id = options.id || positionals[0];
    if (!id) throw new Error("Falta el id del cliente.");
    await requestJson(`${baseUrl}/clientes/${id}`, { method: "DELETE" });
    console.log(`Cliente ${id} eliminado.`);
    return;
  }

  if (command === "demo") {
    await runDemo(baseUrl);
    return;
  }

  throw new Error(`Comando no soportado: ${command}`);
}

async function printChanges(baseUrl, since) {
  const response = await requestJson(`${baseUrl}/changes?since=${encodeURIComponent(since)}`);
  console.log(JSON.stringify(response.data || [], null, 2));
}

async function listenSse(baseUrl) {
  const response = await fetch(`${baseUrl}/sse`, { headers: { Accept: "text/event-stream" } });
  if (!response.ok) throw new Error(`SSE fallo con HTTP ${response.status}`);

  console.log(`Escuchando ${baseUrl}/sse. Presiona Ctrl+C para salir.`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";

    for (const rawEvent of events) {
      const event = parseSseEvent(rawEvent);
      if (!event) continue;
      console.log(JSON.stringify(event, null, 2));
    }
  }
}

async function createCliente(baseUrl, body) {
  const response = await requestJson(`${baseUrl}/clientes`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  console.log(JSON.stringify(response.data, null, 2));
}

async function updateCliente(baseUrl, id, fields) {
  const body = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  const response = await requestJson(`${baseUrl}/clientes/${id}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  console.log(JSON.stringify(response.data, null, 2));
}

async function runDemo(baseUrl) {
  const created = await requestJson(`${baseUrl}/clientes`, {
    method: "POST",
    body: JSON.stringify({ nombre: `Demo ${Date.now()}`, email: null, activo: true }),
  });
  console.log("create:");
  console.log(JSON.stringify(created.data, null, 2));

  const updated = await requestJson(`${baseUrl}/clientes/${created.data.id}`, {
    method: "PUT",
    body: JSON.stringify({ activo: false }),
  });
  console.log("update:");
  console.log(JSON.stringify(updated.data, null, 2));
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body && { "Content-Type": "application/json" }),
      ...options.headers,
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok || body?.ok === false) {
    throw new Error(body?.message || `HTTP ${response.status}`);
  }

  return body;
}

function parseSseEvent(rawEvent) {
  const lines = rawEvent.split("\n").filter((line) => line && !line.startsWith(":"));
  if (lines.length === 0) return null;

  const type = lines.find((line) => line.startsWith("event: "))?.slice(7) || "message";
  const data = lines
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
    .join("\n");

  if (!data) return null;
  return { event: type, data: JSON.parse(data) };
}

function parseArgs(values) {
  const options = {};
  const positionals = [];

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }

    const [rawKey, inlineValue] = value.slice(2).split("=");
    const nextValue = inlineValue ?? values[index + 1];
    options[rawKey] = nextValue;
    if (inlineValue === undefined) index += 1;
  }

  return { options, positionals };
}

function normalizeBaseUrl(value) {
  return String(value).replace(/\/+$/g, "");
}

function parseBooleanOption(value, fallback) {
  if (value === undefined) return fallback;
  if (value === true || value === "true" || value === "1" || value === "si") return true;
  if (value === false || value === "false" || value === "0" || value === "no") return false;
  return fallback;
}

function printHelp() {
  console.log(`Uso:
  node example/app.js

  node example/cli.js sse
  node example/cli.js changes [since]
  node example/cli.js create-cliente [nombre] [email]
  node example/cli.js update-cliente <id> --nombre "Nuevo nombre"
  node example/cli.js delete-cliente <id>
  node example/cli.js demo

Opciones:
  --url http://localhost:3000/api
  --since 2026-07-20T12:00:00.000Z
  --nombre Ana
  --email ana@example.com
  --activo true|false
`);
}
