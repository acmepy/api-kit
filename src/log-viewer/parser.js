const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const HEADER = /^\[(?<timestamp>\d{4}-\d{2}-\d{2}[ T][^\]]+)\]\s*\[(?<level>[A-Z]+)\]\s*(?:\[(?<source>[^\]]+)\]\s*)?(?<message>.*)$/i;
const BARE_TX = new RegExp(`^(?:\\[(${UUID})\\]|(${UUID}))(?:\\s|$)`, "i");
const JSON_TX = /"txId"\s*:\s*"((?:\\.|[^"\\])*)"/;
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function metadata(text) {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    try { return JSON.parse(text.slice(start)); } catch { /* Look for trailing JSON metadata. */ }
  }
  return null;
}

export function extractDurationMs(text, scope, structured = metadata(text)) {
  let duration = structured?.sqlDurationMs ?? structured?.operationDurationMs ?? structured?.durationMs;
  if (!structured) {
    // Some loggers remove JSON escapes from quoted SQL. Read the trailing timing field anyway.
    const fields = [...text.matchAll(/"(?:sqlDurationMs|operationDurationMs|durationMs)"\s*:\s*(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s*[,}])/g)];
    if (fields.length) duration = Number(fields.at(-1)[1]);
  }
  if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0) return duration;
  if (scope === "request") {
    const legacy = /^\S+\s+(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|CONNECT|TRACE)\s+\S+\s+\d{3}\s+(\d+(?:\.\d+)?)\s+\d+(?:\s|$)/.exec(text);
    if (legacy) return Number(legacy[1]);
  }
  return null;
}

export function extractTxId(text) {
  const json = JSON_TX.exec(text);
  if (json) {
    try { return JSON.parse(`"${json[1]}"`); } catch { /* Keep looking in the prefix. */ }
  }
  const match = BARE_TX.exec(text);
  return match?.[1] || match?.[2] || null;
}

/** Returns null for continuation lines; never associates unrelated entries by time. */
export function parseLogLine(line) {
  const clean = line.replace(ANSI, "");
  const match = HEADER.exec(clean);
  if (!match) return null;
  const { timestamp, level, source } = match.groups;
  let { message } = match.groups;
  let scope = null;
  const bracket = /^\[([^\]]+)\]\s*/.exec(message);
  if (bracket && !BARE_TX.test(bracket[0])) {
    scope = bracket[1];
    message = message.slice(bracket[0].length);
  }
  const txId = extractTxId(message);
  const leading = BARE_TX.exec(message);
  if (leading) message = message.slice(leading[0].length);
  else if (txId && message.startsWith(`${txId} `)) message = message.slice(txId.length + 1);
  const structured = metadata(message);
  scope ||= structured?.type || null;
  const durationMs = extractDurationMs(message, scope, structured);
  return { timestamp, level: level.toUpperCase(), source: source || "Sin origen", scope, txId, message, durationMs };
}
