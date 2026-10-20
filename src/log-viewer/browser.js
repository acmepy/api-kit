export function viewerBrowser() {
  const base = document.body.dataset.base;
  const page = document.body.dataset.page;
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const file = params.get("file") || "";
  let request = null;
  let cursor = null;
  let nextCursor = null;
  const history = [];
  let metadata = null;
  let timer;
  let transactionLimit = 100;

  const node = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  const bytes = value => value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1048576).toFixed(1)} MB`;
  async function get(endpoint, query) {
    request?.abort();
    request = new AbortController();
    const response = await fetch(`${base}${endpoint}${query ? `?${query}` : ""}`, { signal: request.signal, headers: { Accept: "application/json" } });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || "No se pudo cargar el log");
    return result;
  }
  function error(cause) {
    if (cause.name === "AbortError") return;
    $("error").textContent = cause.message;
    $("error").hidden = false;
    $("status").textContent = "No se pudo actualizar";
  }
  function options(id, values) {
    const select = $(id);
    const value = select.value;
    select.replaceChildren(new Option(id === "level" ? "Todos los niveles" : "Todos los orígenes", ""));
    for (const item of values) select.add(new Option(item, item));
    if (value && !values.includes(value)) select.add(new Option(value, value));
    select.value = value;
  }
  async function files() {
    $("error").hidden = true;
    $("status").textContent = "Buscando archivos…";
    try {
      const result = await get("/api/files");
      $("files").replaceChildren();
      $("file-count").textContent = result.files.length;
      $("status").textContent = `${result.files.length} ${result.files.length === 1 ? "archivo disponible" : "archivos disponibles"}`;
      $("empty").hidden = result.files.length > 0;
      for (const file of result.files) {
        const link = node("a", undefined, "file-card");
        link.href = `${base}/view?${new URLSearchParams({ file: file.name })}`;
        const icon = node("span", "\u21b3", "file-icon");
        const content = node("div");
        content.append(node("h2", file.name), node("p", `${bytes(file.size)} · Modificado ${new Date(file.modifiedAt).toLocaleString()}`));
        link.append(icon, content, node("span", "Abrir \u2192", "file-open"));
        $("files").append(link);
      }
    } catch (cause) { error(cause); }
  }
  function filterTransaction(txId) {
    $("txId").value = txId;
    restart();
    $("txId").focus();
  }
  function renderSummary(result) {
    const levels = [...new Set(["ERROR", "INFO", "TRACE", ...result.facets.levels])];
    $("level-summary").replaceChildren(...levels.map(level => {
      const button = node("button", undefined, `level-card level-card-${level.toLowerCase()}`);
      button.type = "button";
      button.setAttribute("aria-pressed", String($("level").value === level));
      button.append(node("span", level), node("strong", (result.summary.byLevel[level] || 0).toLocaleString()));
      button.title = `Filtrar por ${level}`;
      button.addEventListener("click", () => {
        const value = $("level").value === level ? "" : level;
        if (value && ![...$("level").options].some(option => option.value === value)) {
          $("level").add(new Option(level, level));
        }
        $("level").value = value;
        restart();
      });
      return button;
    }));
    $("tx-total").textContent = result.summary.transactions.toLocaleString();
    $("tx-unassigned").textContent = `${result.summary.withoutTxId.toLocaleString()} entradas sin txId`;
    renderTransactions();
  }
  function renderTransactions() {
    if (!metadata) return;
    const search = $("tx-search").value.trim().toLowerCase();
    const onlyErrors = $("tx-errors-only").checked;
    const transactions = metadata.transactions.filter(transaction => (
      (!search || transaction.txId.toLowerCase().includes(search)) && (!onlyErrors || transaction.errorCount > 0)
    ));
    $("tx-list").replaceChildren(...transactions.slice(0, transactionLimit).map(transaction => {
      const button = node("button", undefined, "transaction");
      button.type = "button";
      button.title = transaction.txId;
      button.setAttribute("aria-pressed", String(transaction.txId.toLowerCase() === $("txId").value.toLowerCase()));
      const details = node("span", undefined, "transaction-meta");
      details.append(node("span", `${transaction.count} ${transaction.count === 1 ? "entrada" : "entradas"}`));
      if (transaction.errorCount) details.append(node("span", `${transaction.errorCount} ${transaction.errorCount === 1 ? "error" : "errores"}`, "transaction-errors"));
      button.append(node("code", transaction.txId), details);
      if (transaction.timestamp) button.append(node("small", transaction.timestamp));
      button.addEventListener("click", () => filterTransaction(transaction.txId));
      return button;
    }));
    $("tx-none").hidden = transactions.length > 0;
    $("tx-more").hidden = transactions.length <= transactionLimit;
    $("tx-shown").textContent = `${Math.min(transactionLimit, transactions.length)} / ${transactions.length}`;
  }
  function render(entry) {
    const tr = node("tr");
    tr.append(node("td", entry.line, "line-number"));
    tr.append(node("td", entry.timestamp || "—", "timestamp"));
    const level = node("td");
    level.append(node("span", entry.level, `badge level-${entry.level.toLowerCase()}`));
    const source = node("td");
    source.append(node("span", entry.source, "source"));
    if (entry.scope) source.append(node("small", entry.scope, "scope"));
    const tx = node("td");
    if (entry.txId) {
      const button = node("button", entry.txId, "tx-link");
      button.title = entry.txId + " - " + "Ver todas las entradas de esta transacción";
      button.addEventListener("click", () => filterTransaction(entry.txId));
      tx.append(button);
    } else { tx.append(node("span", "—", "muted")); }
    const message = node("td", undefined, "message");
    const details = node("details");
    details.open = $("expand").checked;
    const summary = node("summary", entry.message.split("\n")[0]);
    details.append(summary, node("pre", entry.raw));
    message.append(details);
    tr.append(level, source, tx, message);
    return tr;
  }
  async function entries() {
    $("error").hidden = true;
    $("status").textContent = "Leyendo archivo…";
    const query = new URLSearchParams({ file });
    for (const field of ["level", "source", "txId"]) if ($(field).value) query.set(field, $(field).value);
    const address = new URLSearchParams(query);
    if (cursor !== null) query.set("before", cursor);
    window.history.replaceState(null, "", `${location.pathname}?${address}`);
    try {
      const result = await get("/api/entries", query);
      metadata = result;
      nextCursor = result.nextCursor;
      options("level", result.facets.levels);
      options("source", result.facets.sources);
      renderSummary(result);
      $("entries").replaceChildren(...result.entries.map(render));
      $("total").textContent = result.total.toLocaleString();
      $("matched").textContent = result.matched.toLocaleString();
      $("file-size").textContent = bytes(result.file.size);
      $("file-updated").textContent = new Date(result.file.modifiedAt).toLocaleString();
      $("empty").hidden = result.entries.length > 0;
      $("status").textContent = `${result.entries.length} entradas · Más recientes primero`;
      $("older").disabled = nextCursor === null;
      $("newer").disabled = history.length === 0;
      $("page-number").textContent = `Página ${history.length + 1}`;
      $("active-tx").hidden = !$("txId").value;
      $("active-tx-value").textContent = $("txId").value;
    } catch (cause) { error(cause); }
  }
  function restart() {
    clearTimeout(timer);
    cursor = null;
    history.length = 0;
    entries();
  }
  $("refresh").addEventListener("click", () => page === "files" ? files() : restart());
  if (page === "files") { files(); return; }
  if (window.matchMedia("(max-width: 1100px)").matches) $("tx-panel").open = false;
  for (const id of ["tx-search", "tx-errors-only"]) $(id).addEventListener(id === "tx-search" ? "input" : "change", () => {
    transactionLimit = 100;
    renderTransactions();
  });
  $("tx-more").addEventListener("click", () => { transactionLimit += 100; renderTransactions(); });
  $("filename").textContent = file;
  for (const field of ["level", "source", "txId"]) {
    const value = params.get(field) || "";
    if (field !== "txId" && value) $(field).add(new Option(value, value));
    $(field).value = value;
    $(field).addEventListener(field === "txId" ? "input" : "change", () => {
      clearTimeout(timer);
      timer = setTimeout(restart, field === "txId" ? 300 : 0);
    });
  }
  $("filters").addEventListener("submit", event => { event.preventDefault(); clearTimeout(timer); restart(); });
  $("clear").addEventListener("click", () => {
    clearTimeout(timer);
    for (const field of ["level", "source", "txId"]) $(field).value = "";
    restart();
  });
  $("clear-tx").addEventListener("click", () => filterTransaction(""));
  $("copy-tx").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("txId").value);
      $("copy-tx").textContent = "Copiado";
      setTimeout(() => { $("copy-tx").textContent = "Copiar txId"; }, 1500);
    } catch { $("status").textContent = "Selecciona el txId para copiarlo"; }
  });
  $("older").addEventListener("click", () => {
    if (nextCursor === null) return;
    history.push(cursor);
    cursor = nextCursor;
    entries();
  });
  $("newer").addEventListener("click", () => { cursor = history.pop() ?? null; entries(); });
  $("expand").addEventListener("change", event => {
    for (const details of $("entries").querySelectorAll("details")) details.open = event.target.checked;
  });
  $("download").addEventListener("click", () => {
    if (!metadata) return;
    const blob = new Blob([metadata.entries.map(entry => entry.raw).reverse().join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = node("a");
    link.href = url;
    link.download = `filtrado-${file}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  entries();
}
