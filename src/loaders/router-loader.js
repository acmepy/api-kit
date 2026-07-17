import path from "node:path";
import { importModule, fileExists } from "../utils/import-module.js";
import { camelCase } from "../utils/naming.js";
import { BaseRouter } from "../base/base-router.js";

export async function loadRouter({ moduleName, service, config, routeRegistry, routersDir }) {
  if (routersDir) {
    const filePath = path.join(routersDir, `${camelCase(moduleName)}.router.js`);
    if (await fileExists(filePath)) {
      const RouterClass = await importModule(filePath);
      if (typeof RouterClass === "function") {
        const router = new RouterClass({ service, config, routeRegistry });
        router.build();
        return router;
      }
    }
  }

  const router = new BaseRouter({ service, config, routeRegistry });
  router.build();
  return router;
}
