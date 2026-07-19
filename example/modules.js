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
    attributes: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      descripcion: { type: "string", maxLength: 120, allowNull: false, title: "Nombre", max: 120 },
      precio: { type: "decimal", precision: 12, scale: 2, allowNull: false, defaultValue: 0, title: "Precio", min: 0 },
      activo: { type: "boolean", defaultValue: true, title: "Activo" },
    },
  },
];

export default modules;
