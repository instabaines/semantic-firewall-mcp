import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

let dbInstance;

const DATASETS = [
  {
    id: "sales-q1",
    uri: "demo://datasets/sales-q1",
    name: "Sales Q1",
    description: "Quarter 1 revenue data by region and sales rep.",
    sensitivity: "internal",
  },
  {
    id: "sales-q2",
    uri: "demo://datasets/sales-q2",
    name: "Sales Q2",
    description: "Quarter 2 revenue data by region and sales rep.",
    sensitivity: "internal",
  },
];

const SALES_ROWS = [
  ["sales-q1", "2026-01-05", "Central", "Avery", 12500, "morgan@example.com"],
  ["sales-q1", "2026-01-12", "West", "Jordan", 9800, "casey@example.com"],
  ["sales-q1", "2026-02-03", "South", "Parker", 15400, "sam@example.com"],
  ["sales-q1", "2026-02-24", "North", "Riley", 13250, "jamie@example.com"],
  ["sales-q1", "2026-03-18", "West", "Jordan", 17200, "alex@example.com"],
  ["sales-q2", "2026-04-02", "Central", "Avery", 14300, "lee@example.com"],
  ["sales-q2", "2026-04-19", "South", "Parker", 11850, "taylor@example.com"],
  ["sales-q2", "2026-05-11", "North", "Riley", 20100, "devon@example.com"],
  ["sales-q2", "2026-05-28", "West", "Jordan", 16740, "drew@example.com"],
  ["sales-q2", "2026-06-09", "Central", "Avery", 19080, "quinn@example.com"],
];

function ensureDb(config) {
  if (dbInstance) {
    return dbInstance;
  }

  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS datasets (
      id TEXT PRIMARY KEY,
      uri TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      sensitivity TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dataset_id TEXT NOT NULL,
      order_date TEXT NOT NULL,
      region TEXT NOT NULL,
      rep TEXT NOT NULL,
      amount REAL NOT NULL,
      customer_email TEXT NOT NULL,
      FOREIGN KEY(dataset_id) REFERENCES datasets(id)
    );

    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      markdown TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(dataset_id) REFERENCES datasets(id)
    );
  `);

  const datasetCount = db.prepare("SELECT COUNT(*) AS count FROM datasets").get().count;
  if (datasetCount === 0) {
    const insertDataset = db.prepare(`
      INSERT INTO datasets (id, uri, name, description, sensitivity)
      VALUES (@id, @uri, @name, @description, @sensitivity)
    `);

    const insertSale = db.prepare(`
      INSERT INTO sales (dataset_id, order_date, region, rep, amount, customer_email)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      for (const dataset of DATASETS) {
        insertDataset.run(dataset);
      }
      for (const row of SALES_ROWS) {
        insertSale.run(...row);
      }
    });
    tx();
  }

  dbInstance = db;
  return db;
}

// Restores the seed data. Used by the evaluation harness between cases so that a
// destructive call that got through in one case does not affect the next.
export function resetDb(config) {
  const db = ensureDb(config);
  db.exec("DELETE FROM reports; DELETE FROM sales; DELETE FROM datasets;");
  const insertDataset = db.prepare(`
    INSERT INTO datasets (id, uri, name, description, sensitivity)
    VALUES (@id, @uri, @name, @description, @sensitivity)
  `);
  const insertSale = db.prepare(`
    INSERT INTO sales (dataset_id, order_date, region, rep, amount, customer_email)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    DATASETS.forEach((dataset) => insertDataset.run(dataset));
    SALES_ROWS.forEach((row) => insertSale.run(...row));
  })();
}

export function closeDb() {
  dbInstance?.close();
  dbInstance = undefined;
}

// Demo protected resource store backing the MCP tools.
export function getDb(config) {
  return ensureDb(config);
}

export function listDatasets(config) {
  const db = ensureDb(config);
  return db.prepare(`
    SELECT
      d.id,
      d.uri,
      d.name,
      d.description,
      d.sensitivity,
      COUNT(s.id) AS rowCount,
      ROUND(COALESCE(SUM(s.amount), 0), 2) AS totalRevenue
    FROM datasets d
    LEFT JOIN sales s ON s.dataset_id = d.id
    GROUP BY d.id
    ORDER BY d.id
  `).all();
}

export function getDataset(config, datasetId) {
  const db = ensureDb(config);
  return db.prepare("SELECT * FROM datasets WHERE id = ?").get(datasetId);
}

export function getDatasetOverview(config, datasetId) {
  const db = ensureDb(config);
  return db.prepare(`
    SELECT
      dataset_id AS datasetId,
      COUNT(*) AS rowCount,
      ROUND(SUM(amount), 2) AS totalRevenue,
      ROUND(AVG(amount), 2) AS averageDealSize,
      MIN(order_date) AS firstOrderDate,
      MAX(order_date) AS lastOrderDate
    FROM sales
    WHERE dataset_id = ?
    GROUP BY dataset_id
  `).get(datasetId);
}

export function readDatasetRows(config, datasetId, limit = 5) {
  const db = ensureDb(config);
  return db.prepare(`
    SELECT order_date AS orderDate, region, rep, amount, customer_email AS customerEmail
    FROM sales
    WHERE dataset_id = ?
    ORDER BY order_date ASC
    LIMIT ?
  `).all(datasetId, limit);
}

export function exportCustomerEmails(config, datasetId) {
  const db = ensureDb(config);
  return db.prepare(`
    SELECT DISTINCT customer_email AS customerEmail
    FROM sales
    WHERE dataset_id = ?
    ORDER BY customer_email ASC
  `).all(datasetId);
}

export function deleteDataset(config, datasetId) {
  const db = ensureDb(config);
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM sales WHERE dataset_id = ?").run(datasetId);
    db.prepare("DELETE FROM reports WHERE dataset_id = ?").run(datasetId);
    db.prepare("DELETE FROM datasets WHERE id = ?").run(datasetId);
  });
  tx();
}

export function saveReport(config, { datasetId, objective, markdown }) {
  const db = ensureDb(config);
  const report = {
    id: crypto.randomUUID(),
    datasetId,
    objective,
    markdown,
    createdAt: new Date().toISOString(),
  };
  db.prepare(`
    INSERT INTO reports (id, dataset_id, objective, markdown, created_at)
    VALUES (@id, @datasetId, @objective, @markdown, @createdAt)
  `).run(report);
  return report;
}

export function listReports(config) {
  const db = ensureDb(config);
  return db.prepare(`
    SELECT r.id, r.dataset_id AS datasetId, r.objective, r.markdown, r.created_at AS createdAt, d.name AS datasetName
    FROM reports r
    JOIN datasets d ON d.id = r.dataset_id
    ORDER BY r.created_at DESC
  `).all();
}
