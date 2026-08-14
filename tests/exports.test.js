import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("package exports", () => {
  it("exposes server, client and cli subpaths", async () => {
    const server = await import("api/server");
    const client = await import("api/client");
    const cli = await import("api/cli");

    assert.equal(typeof server.createApi, "function");
    assert.equal(typeof client.createApiClient, "function");
    assert.equal(typeof cli.runApiKitCli, "function");
  });

  it("does not expose the package root", async () => {
    await assert.rejects(
      () => import("api"),
      /ERR_PACKAGE_PATH_NOT_EXPORTED|No "exports" main defined|Package subpath '\.' is not defined/
    );
  });
});
