const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const HEADER = /^\[(?<timestamp>\d{4}-\d{2}-\d{2}[ T][^\]]+)\]\s*\[(?<level>[A-Z]+)\]\s*(?:\[(?<source>[^\]]+)\]\s*)?(?<message>.*)$/i;
const BARE_TX = new RegExp(`^(?:\\[(${UUID})\\]|(${UUID}))(?:\\s|$)`, "i");
const JSON_TX = /"txId"\s*:\s*"((?:\\.|[^"\\])*)"/;
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

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
  return { timestamp, level: level.toUpperCase(), source: source || "Sin origen", scope, txId, message };
}
