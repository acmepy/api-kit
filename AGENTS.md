# Dependencias externas

- Las dependencias externas son la fuente de verdad de su API, sus tipos, sus nombres y sus convenciones.
- No crear aliases, adaptadores de compatibilidad ni conversiones de nombres para ajustar una dependencia al código del proyecto.
- Cuando una dependencia cambie o exponga una interfaz distinta, actualizar el código consumidor y sus pruebas para usar esa interfaz directamente.
