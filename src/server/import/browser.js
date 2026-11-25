export function importBrowser() {
  const $ = id => document.getElementById(id);
  const endpoint = document.body.dataset.importUrl;
  let busy = false;
  let revision = 0;
  let approvedRevision = -1;
  let columns = [];
  const invalidate = () => { revision++; approvedRevision = -1; $("confirm").disabled = true; };
  for (const id of ["file", "token", "atomic", "duplicates"]) $(id).addEventListener("change", invalidate);
  $("file").addEventListener("change", () => { $("mapping").replaceChildren(); });
  const headers = () => ({ "Content-Type": "application/json", ...($("token").value.trim() && { Authorization: `Bearer ${$("token").value.trim()}` }) });
  const cell = (row, tag, text) => { const node = document.createElement(tag); node.textContent = text; row.append(node); return node; };
  const mapping = () => Object.fromEntries([...$("mapping").querySelectorAll("select")].map(select => [select.dataset.source, select.value]));
  const showMapping = (sources, previous) => {
    $("mapping").replaceChildren();
    for (const source of sources) {
      const label = document.createElement("label"); label.textContent = source;
      const select = document.createElement("select"); select.dataset.source = source;
      select.add(new Option("Ignorar columna", ""));
      for (const column of columns) select.add(new Option(`${column.title}${column.required ? " *" : ""} (${column.name})`, column.name));
      select.value = previous[source] ?? (columns.some(column => column.name === source) ? source : "");
      select.addEventListener("change", invalidate);
      label.append(select); $("mapping").append(label);
    }
  };
  async function submit(preview) {
    if (busy || (!preview && approvedRevision !== revision)) return;
    const file = $("file").files[0];
    if (!file) { $("message").textContent = "Selecciona un archivo JSON o CSV."; return; }
    busy = true; $("preview").disabled = true; $("confirm").disabled = true;
    const currentRevision = revision;
    try {
      const previous = mapping();
      const query = new URLSearchParams({ type: file.name.toLowerCase().endsWith(".csv") ? "csv" : "json", preview: String(preview), atomic: String($("atomic").checked), duplicates: $("duplicates").value });
      const response = await fetch(`${endpoint}?${query}`, { method: "POST", headers: headers(), body: JSON.stringify({ data: await file.text(), mapping: previous }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "No se pudo procesar el archivo");
      const data = result.data;
      $("results").hidden = false;
      $("summary").textContent = `Total: ${data.total} · Válidos: ${data.valid} · Creados: ${data.created} · Omitidos: ${data.skipped} · Errores: ${data.failed}${data.rolledBack ? " · Importación revertida" : ""}`;
      $("table-head").replaceChildren(); $("table-body").replaceChildren();
      if (preview) {
        columns = data.columns;
        showMapping(data.headers, previous);
        const header = document.createElement("tr");
        for (const title of ["Registro", "Estado", ...columns.map(column => column.title), "Errores"]) cell(header, "th", title);
        $("table-head").append(header);
        for (const row of data.rows) {
          const tr = document.createElement("tr");
          cell(tr, "td", row.row); cell(tr, "td", row.status).className = row.status;
          for (const column of columns) {
            const value = row.data?.[column.name];
            cell(tr, "td", value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value));
          }
          cell(tr, "td", Object.entries(row.errors || {}).map(([field, error]) => `${field}: ${typeof error === "object" ? JSON.stringify(error) : error}`).join("\n")).className = "error";
          $("table-body").append(tr);
        }
        approvedRevision = currentRevision;
        $("confirm").disabled = revision !== currentRevision || data.valid === 0 || ($("atomic").checked && data.failed > 0);
      } else {
        approvedRevision = -1;
        for (const error of data.errors) {
          const tr = document.createElement("tr"); cell(tr, "td", error.row); cell(tr, "td", JSON.stringify(error.errors)); $("table-body").append(tr);
        }
      }
      $("message").textContent = preview ? "Vista previa: no se guardaron registros." : data.rolledBack ? "No se guardaron registros: la importación se revirtió." : "Importación finalizada.";
    } catch (error) { approvedRevision = -1; $("message").textContent = error.message; }
    finally { busy = false; $("preview").disabled = false; }
  }
  $("preview").addEventListener("click", () => submit(true));
  $("confirm").addEventListener("click", () => submit(false));
  for (const button of document.querySelectorAll("[data-template]")) button.addEventListener("click", async () => {
    try {
      const type = button.dataset.template;
      const response = await fetch(`${document.body.dataset.templateUrl}?type=${type}`, { headers: headers() });
      if (!response.ok) throw new Error((await response.json()).message || "No se pudo descargar la plantilla");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a"); link.href = url; link.download = `plantilla.${type}`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { $("message").textContent = error.message; }
  });
}
