import { ValidationError } from "../errors/validation-error.js";

export function parseCsv(input) {
  if (typeof input !== "string") throw new ValidationError("CSV requiere texto");
  const text = input.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [], value = "", quoted = false, closed = false;
  const field = () => { row.push(value); value = ""; closed = false; };
  const record = () => { const present = row.length > 0 || value !== "" || closed; field(); if (present) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else value += char;
    } else if (char === ",") field();
    else if (char === "\n" || char === "\r") { record(); if (char === "\r" && text[i + 1] === "\n") i++; }
    else if (char === '"' && value === "" && !closed) quoted = true;
    else if (closed || char === '"') throw new ValidationError("CSV invalido: comillas inesperadas");
    else value += char;
  }
  if (quoted) throw new ValidationError("CSV invalido: comillas sin cerrar");
  if (value !== "" || row.length || closed) record();
  const headers = rows.shift()?.map(header => header.trim()) || [];
  if (headers.some(header => !header) || new Set(headers).size !== headers.length) throw new ValidationError("CSV requiere encabezados no vacios y sin duplicados");
  return rows.map((cells, index) => {
    if (cells.length !== headers.length) throw new ValidationError(`CSV: cantidad de columnas incorrecta en el registro ${index + 1}`);
    return Object.fromEntries(headers.map((header, i) => [header, cells[i]]));
  });
}

export function encodeCsv(rows, columns) {
  const cell = value => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return `\uFEFF${[columns.map(cell), ...rows.map(row => columns.map(name => cell(typeof row[name] === "object" && row[name] !== null ? JSON.stringify(row[name]) : row[name])))].map(row => row.join(",")).join("\r\n")}\r\n`;
}
