import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("package exports", () => {
  it("exposes server, client and cli subpaths", async () => {
    const server = await import("api-kit/server");
    const client = await import("api-kit/client");
    const cli = await import("api-kit/cli");

    assert.equal(typeof server.createApiKit, "function");
    assert.equal(typeof client.createApiKitClient, "function");
    assert.equal(typeof cli.runApiKitCli, "function");
  });

  it("does not expose the package root", async () => {
    await assert.rejects(
      () => import("api-kit"),
      /ERR_PACKAGE_PATH_NOT_EXPORTED|No "exports" main defined|Package subpath '\.' is not defined/
    );
  });
});
