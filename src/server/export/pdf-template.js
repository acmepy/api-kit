/** Default pdfmake document definition. Returns a fresh, editable template. */
export function createExportPdfTemplate({ title = "Exportación", columns = [], data = [] } = {}) {
  const numeric = column => ["INTEGER", "NUMBER", "DECIMAL"].includes(column.type)
    || (!column.type && data.some(row => typeof row[column.name] === "number"));
  const weights = columns.map(column => Number(column.maxLength) > 0 ? Number(column.maxLength)
    : Number(column.precision) > 0 ? Number(column.precision)
      : column.type === "BOOLEAN" ? 6 : Math.max((column.title || column.name).length, 12));
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  const formats = columns.map(column => {
    const scale = column.type === "INTEGER" ? 0 : column.scale ?? (column.type === "DECIMAL" ? 2 : undefined);
    return new Intl.NumberFormat("es-PY", scale === undefined ? {} : { minimumFractionDigits: scale, maximumFractionDigits: scale });
  });
  return {
    pageSize: "A4",
    pageOrientation: columns.length > 5 ? "landscape" : "portrait",
    pageMargins: [36, 60, 36, 48],
    defaultStyle: { font: "Roboto", fontSize: 9 },
    styles: {
      heading: { fontSize: 14, bold: true, color: "#243447" },
      tableHeader: { bold: true, color: "#243447", fillColor: "#eef2f6" },
    },
    header: () => ({ text: title, style: "heading", margin: [36, 22, 36, 0] }),
    footer: (page, pages) => ({ text: `${page} / ${pages}`, alignment: "right", fontSize: 8, color: "#666666", margin: [36, 16, 36, 0] }),
    content: columns.length ? [{
      layout: "lightHorizontalLines",
      table: {
        headerRows: 1,
        widths: weights.map(weight => `${weight / totalWeight * 100}%`),
        body: [
          columns.map(column => ({ text: column.title || column.name, style: "tableHeader", alignment: numeric(column) ? "right" : "left" })),
          ...data.map(record => columns.map((column, index) => {
            const value = record[column.name];
            if (typeof value === "boolean") return booleanSymbol(value);
            if (numeric(column)) return { text: value == null || value === "" ? "" : formats[index].format(value), alignment: "right" };
            return exportValue(value);
          })),
        ],
      },
    }] : [{ text: "Sin columnas para exportar" }],
  };
}

function booleanSymbol(value) {
  // Roboto lacks these glyphs. Native pdfmake paths preserve their appearance on every host.
  return { margin: [0, 1, 0, 0], canvas: value
    ? [{ type: "polyline", points: [{ x: 1, y: 5 }, { x: 4, y: 8 }, { x: 11, y: 1 }], lineWidth: 1.8 }]
    : [{ type: "line", x1: 2, y1: 1, x2: 10, y2: 9, lineWidth: 1.8 }, { type: "line", x1: 2, y1: 9, x2: 10, y2: 1, lineWidth: 1.8 }] };
}

export function exportValue(value) {
  if (value == null) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
