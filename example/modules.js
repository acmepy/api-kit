export const auth = {
  required: true,
  strategies: ["bearer", "basic"],
  tokenExpiresIn: "1h",
};

export const modules = [
  {
    modelName: "Cliente",
    tableName: "clientes",
    timestamps: true,
    attributes: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      nombre: { type: "string", maxLength: 100, allowNull: false, title: "Nombre", max: 100 },
      email: { type: "string", maxLength: 150, unique: true, allowNull: true, title: "Email", email: true },
      activo: { type: "boolean", defaultValue: true, title: "Activo" },
    },
  },
  {
    modelName: "Producto",
    tableName: "productos",
    timestamps: true,
    audit: false,
    attributes: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      descripcion: { type: "string", maxLength: 120, allowNull: false, title: "Nombre", max: 120 },
      precio: { type: "decimal", precision: 12, scale: 2, allowNull: false, defaultValue: 0, title: "Precio", min: 0 },
      activo: { type: "boolean", defaultValue: true, title: "Activo" },
    },
  },
  {
    modelName: "audit",
    tableName: "audit",
    timestamps: true,
    audit: false,
    endpoints: {schema: false, create: false, update: false, remove: false},
    attributes: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      txId: { type: "string", maxLength: 50, allowNull: false },
      clientIp: { type: "string", maxLength: 50, allowNull: false },
      userId: { type: "string", maxLength: 20 },
      tableName: { type: "string", maxLength: 50, allowNull: false },
      rowId: { type: "string", maxLength: 50, allowNull: false },
      action: { type: "string", maxLength: 20, allowNull: false },
      old: { type: "json" },
      new: { type: "json" },
    },
  },
];

export default modules;
