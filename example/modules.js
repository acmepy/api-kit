export const modules = [
  { mountPath: "/basic", path: "./example/public/basic" },
  { mountPath: "/client", path: "./example/public/client" },
  { mountPath: "/vue", path: "./example/public/vue" },
  {
    modelName: "Cliente",
    tableName: "clientes",
    timestamps: true,
    attributes: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      ruc: { type: "string", maxLength: 20, unique: true, title: "RUC", regexp: "^\\d+-\\d$" },
      nombre: { type: "string", maxLength: 100, allowNull: false, title: "Nombre" },
      email: { type: "string", maxLength: 150, allowNull: true, unique: true, title: "Email", email: true },
      activo: { type: "boolean", defaultValue: true, title: "Activo" },
    },
  },
  {
    modelName: "Venta",
    tableName: "ventas",
    timestamps: true,
    attributes: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      cliente: { type: "string", maxLength: 100, allowNull: false, title: "Cliente" },
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
          producto: { type: "string", maxLength: 120, allowNull: false, title: "Producto" },
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
          medio: { type: "string", maxLength: 40, allowNull: false, title: "Medio" },
          monto: { type: "decimal", precision: 12, scale: 2, allowNull: false, title: "Monto", min: 0 },
        },
        removeMissing: true,
      },
    ],
  }
];


