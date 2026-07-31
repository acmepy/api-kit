export const auth = {
  required: true,
  strategies: ["bearer", "basic"],
  tokenExpiresIn: "1h",
};

export const modules = [
  {
    mountPath: "/admin",
    path: "./example/public/admin",
  },
  {
    modelName: "Venta",
    tableName: "ventas",
    timestamps: true,
    attributes: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      cliente: { type: "string", maxLength: 100, allowNull: false, title: "Cliente", max: 100 },
      fecha: { type: "date", allowNull: false, title: "Fecha" },
      total: { type: "decimal", precision: 12, scale: 2, allowNull: false, defaultValue: 0, title: "Total", min: 0 },
    },
    details: [
      {
        name: "items",
        foreignKey: "ventaId",
        modelName: "VentaItem",
        tableName: "venta_items",
        timestamps: true,
        attributes: {
          id: { type: "integer", primaryKey: true, autoIncrement: true },
          ventaId: { type: "integer", allowNull: false, create: false, update: false },
          producto: { type: "string", maxLength: 120, allowNull: false, title: "Producto", max: 120 },
          cantidad: { type: "integer", allowNull: false, title: "Cantidad", min: 1 },
          precio: { type: "decimal", precision: 12, scale: 2, allowNull: false, title: "Precio", min: 0 },
        },
        removeMissing: true,
      },
      {
        name: "cobros",
        foreignKey: "ventaId",
        modelName: "VentaCobro",
        tableName: "venta_cobros",
        timestamps: true,
        attributes: {
          id: { type: "integer", primaryKey: true, autoIncrement: true },
          ventaId: { type: "integer", allowNull: false, create: false, update: false },
          medio: { type: "string", maxLength: 40, allowNull: false, title: "Medio", max: 40 },
          monto: { type: "decimal", precision: 12, scale: 2, allowNull: false, title: "Monto", min: 0 },
        },
        removeMissing: true,
      },
    ],
  },
  {
    modelName: "Cliente",
    tableName: "clientes",
    timestamps: true,
    endpoints: {
      ruc: { method: "get", path: "/ruc/:ruc", permission: "clientes.list", summary: "Buscar por RUC" },
    },
    attributes: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      ruc:{type:"string", unique:true, maxLength:20},
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
