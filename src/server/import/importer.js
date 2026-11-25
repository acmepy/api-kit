import { ValidationError } from "../errors/validation-error.js";
import { tenantValues } from "../context/tenant-context.js";
import { validateResourceSchema } from "../base/nested-schema-validation.js";
import yep from "yep";

function flag(value, fallback) {
  if (value === undefined) return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new ValidationError("Las opciones atomic y preview deben ser true o false");
}

function uniqueSets(model) {
  const schema = model.seq.adapter.schemas.get(model.tableName);
  const sets = [];
  if (!model.autoIncrementAttribute && model.primaryKeyAttributes.length) sets.push(model.primaryKeyAttributes);
  for (const [name, definition] of Object.entries(model.rawAttributes)) if (definition.unique) sets.push([name]);
  for (const unique of [...(schema?.uniqueConstraints || []), ...(schema?.indexes || []).filter(index => index.unique)]) {
    sets.push(unique.columns.map(column => schema.columnToAttr[column] || column));
  }
  return [...new Map(sets.map(fields => [JSON.stringify(fields), fields])).values()];
}

function duplicateError(error) {
  return error.details?.constraint?.type === "unique" || error.details?.constraint?.type === "primaryKey"
    || ["SEQ_VALIDATION_DUPLICATE_PK", "SEQ_VALIDATION_UNIQUE"].includes(error.code)
    || error.details?.sqliteCode === "SQLITE_CONSTRAINT_PRIMARYKEY";
}

export async function importRows(service, rows, args = {}) {
  if (!Array.isArray(rows)) throw new ValidationError("El JSON debe contener un array de registros");
  const maximum = service.config.maxSize || 100;
  if (rows.length > maximum) throw new ValidationError(`La importacion admite como maximo ${maximum} registros`);
  const atomic = flag(args.query?.atomic, true);
  const preview = flag(args.query?.preview, false);
  const seq = service.seq || service.model.seq;
  const duplicates = args.query?.duplicates || "error";
  if (!["error", "skip"].includes(duplicates)) throw new ValidationError("duplicates debe ser error o skip");
  const columns = service.importColumns();
  const names = new Set(columns.map(column => column.name));
  const normalizer = yep.fromJsonSchema({ type: "object", properties: Object.fromEntries(columns.map(column => [column.name, {
    type: column.schema.type, nullable: true,
    ...(Object.hasOwn(column.schema, "default") && { default: column.schema.default }),
  }])) });
  const mapping = args.body?.mapping;
  if (mapping != null && (typeof mapping !== "object" || Array.isArray(mapping))) throw new ValidationError("mapping debe ser un objeto");
  const targets = Object.values(mapping || {}).filter(Boolean);
  if (targets.some(name => !names.has(name)) || new Set(targets).size !== targets.length) throw new ValidationError("mapping contiene atributos invalidos o repetidos");
  tenantValues(service.model, {}); // A missing session tenant is a request error, not a row error.
  const sets = uniqueSets(service.model);
  const seen = new Set();
  const comparable = (field, value) => value != null && value !== "" && (typeof value !== "object" || value instanceof Date)
    && (!["INTEGER", "NUMBER", "DECIMAL"].includes(service.model.rawAttributes[field].type.key) || Number.isFinite(Number(value)));
  const summary = { total: rows.length, created: 0, valid: 0, skipped: 0, failed: 0, rolledBack: false, preview, errors: [] };
  if (preview) {
    summary.columns = columns;
    summary.headers = [...new Set(rows.flatMap(row => row && typeof row === "object" && !Array.isArray(row) ? Object.keys(row) : []))];
    summary.rows = [];
  }
  const duplicate = async (values, transaction) => {
    for (const fields of sets) {
      if (!fields.every(field => comparable(field, values[field]))) continue;
      const key = JSON.stringify([fields, fields.map(field => {
        const value = values[field];
        return ["INTEGER", "NUMBER", "DECIMAL"].includes(service.model.rawAttributes[field].type.key) ? Number(value) : value;
      })]);
      if (seen.has(key) || await service.model.findOne({ where: Object.fromEntries(fields.map(field => [field, values[field]])), ...(transaction && { transaction }) })) return fields;
    }
    return null;
  };
  const remember = values => {
    for (const fields of sets) if (fields.every(field => values[field] != null && values[field] !== "")) {
      seen.add(JSON.stringify([fields, fields.map(field => ["INTEGER", "NUMBER", "DECIMAL"].includes(service.model.rawAttributes[field].type.key) ? Number(values[field]) : values[field])]));
    }
  };
  const prepare = record => Object.fromEntries(Object.entries(record || {}).map(([key, value]) => [mapping && Object.hasOwn(mapping, key) ? mapping[key] : key, value]).filter(([key]) => names.has(key)));
  const process = async (record, transaction) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new ValidationError("El registro debe ser un objeto");
    const input = prepare(record);
    // Empty CSV cells use defaults or required rules instead of coercing to zero/false.
    if (args.query?.type === "csv") for (const key of Object.keys(input)) if (input[key] === "") delete input[key];
    if (args.query?.type === "csv") for (const column of columns) {
      if (["JSON", "OBJECT", "ARRAY"].includes(column.type) && typeof input[column.name] === "string") {
        try { input[column.name] = JSON.parse(input[column.name]); }
        catch { throw new ValidationError("JSON invalido en una celda CSV", { errors: { [column.name]: "JSON invalido" } }); }
      }
    }
    const values = tenantValues(service.model, await normalizer.validate(input));
    const fields = await duplicate(values, transaction);
    if (fields) {
      if (duplicates === "skip") return { status: "skipped", data: input };
      throw new ValidationError("Registro duplicado", { errors: Object.fromEntries(fields.map(field => [field, "Ya existe un registro con este valor"])) });
    }
    const validated = await validateResourceSchema(service.schemas.create, values, transaction, service.model);
    for (const column of columns) if (column.required && (validated[column.name] == null || validated[column.name] === "")) {
      throw new ValidationError("Campo requerido", { errors: { [column.name]: `${column.title} es requerido` } });
    }
    if (!preview) {
      try { await service.create({ body: validated, transaction }); }
      catch (error) { if (duplicates === "skip" && duplicateError(error)) return { status: "skipped", data: validated }; throw error; }
    }
    return { status: preview ? "valid" : "created", data: validated };
  };
  const collect = async transaction => {
    for (let index = 0; index < rows.length; index++) {
      try {
        const result = !preview && !atomic
          ? await seq.transaction(tx => process(rows[index], tx))
          : await process(rows[index], transaction);
        if (result.status === "skipped") summary.skipped++;
        else { remember(tenantValues(service.model, result.data)); summary.valid++; if (!preview) summary.created++; }
        if (preview) summary.rows.push({ row: index + 1, ...result });
      } catch (error) {
        if (![400, 409].includes(error.status) && error.code !== "VALIDATION_ERROR") throw error;
        const errors = error.errors || { _error: error.message };
        summary.failed++;
        summary.errors.push({ row: index + 1, errors });
        if (preview) summary.rows.push({ row: index + 1, status: "error", data: prepare(rows[index]), errors });
      }
    }
  };
  if (preview || !atomic) await collect();
  else {
    const rollback = new Error("Importacion revertida");
    try {
      await seq.transaction(async transaction => {
        await collect(transaction);
        if (summary.failed) throw rollback;
      });
    } catch (error) {
      if (error !== rollback || error.rollbackError) throw error;
      summary.created = 0;
      summary.rolledBack = true;
    }
  }
  return { ok: summary.failed === 0, data: summary };
}
