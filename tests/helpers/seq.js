import { afterEach } from "node:test";
import { MySQLAdapter, Seq, SQLiteAdapter } from "seq";

const openSeqs = new Set();

afterEach(closeOpenTestSeqs);

export function createTestSeq(options = {}) {
  const { adapter: _adapter, shared = false, ...seqOptions } = options;
  const seq = new Seq({
    ...seqOptions,
    adapter: createTestAdapter(),
  });

  if (!shared) trackSeq(seq);
  return seq;
}

export async function closeOpenTestSeqs() {
  const seqs = [...openSeqs];
  openSeqs.clear();
  await Promise.all(seqs.map((seq) => seq.close().catch(() => {})));
}

export function createTestAdapter() {
  if (testAdapterName() === "mysql") {
    return new MySQLAdapter({
      host: process.env.MYSQL_HOST || "localhost",
      port: numberEnv("MYSQL_PORT", 3306),
      user: process.env.MYSQL_USER || "root",
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE || "seq",
      connectTimeout: numberEnv("MYSQL_CONNECT_TIMEOUT", 10000),
      connectionLimit: numberEnv("MYSQL_CONNECTION_LIMIT", 10),
    });
  }

  return new SQLiteAdapter({ database: ":memory:" });
}

function testAdapterName() {
  const value = process.env.API_KIT_ADAPTER || process.env.SEQ_ADAPTER || (process.env.SEQ_MYSQL_TEST ? "mysql" : "sqlite");
  return String(value).toLowerCase();
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function trackSeq(seq) {
  const close = seq.close.bind(seq);
  seq.close = async () => {
    openSeqs.delete(seq);
    return close();
  };
  openSeqs.add(seq);
}
