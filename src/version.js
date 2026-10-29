import packageInfo from "../package.json" with { type: "json" };

export const version = packageInfo.version;
