export default [{
  name: "facturas",
  modelName: "FacturaTenant",
  tableName: "facturas",
  tenant: true,
  timestamps: false,
  attributes: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    codEmpresa: { type: "integer", allowNull: false },
    cliente: { type: "string", maxLength: 100, allowNull: false },
  },
  details: [{
    name: "items",
    modelName: "ItemTenant",
    tableName: "factura_items",
    tenant: true,
    timestamps: false,
    attributes: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      codEmpresa: { type: "integer", allowNull: false },
      facturaId: { type: "integer", allowNull: false, create: false, update: false },
      articulo: { type: "string", maxLength: 100, allowNull: false },
      cantidad: { type: "integer", min: 1, allowNull: false },
    },
  }],
}];
