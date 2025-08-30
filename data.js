
require('dotenv').config(); // only for local dev; Render/Railway/Vercel use env vars
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

// ---------- CORS ----------
// Use FRONTEND_ORIGIN in production; fallback to localhost for local dev
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:3000';
app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }));
app.use(express.json());

// ---------- DB pool (supports DATABASE_URL or individual env vars) ----------
let pool;

try {
  let sslOptions;
  if (process.env.DB_SSL === 'true') {
    const certPath = path.resolve(__dirname, 'certs', 'aiven-ca.pem');
    if (fs.existsSync(certPath)) {
      sslOptions = {
        ca: fs.readFileSync(certPath),
        rejectUnauthorized: true,
      };
      console.log('🔐 Using Aiven CA certificate for SSL');
    } else {
      sslOptions = { rejectUnauthorized: true };
      console.log('🔐 Using default SSL (no CA file found)');
    }
  }

  if (process.env.DATABASE_URL) {
    const dbUrl = new URL(process.env.DATABASE_URL);
    pool = mysql.createPool({
      host: dbUrl.hostname,
      port: dbUrl.port ? Number(dbUrl.port) : 3306,
      user: decodeURIComponent(dbUrl.username),
      password: decodeURIComponent(dbUrl.password),
      database: dbUrl.pathname.replace('/', ''),
      waitForConnections: true,
      connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
      ssl: sslOptions,
    });
  } else {
    pool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || 'root',
      database: process.env.DB_NAME || 'pulse_new',
      waitForConnections: true,
      connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
      ssl: sslOptions,
    });
  }
} catch (err) {
  console.error('❌ Error creating DB pool:', err);
  process.exit(1);
}

// Test connection
pool.getConnection()
  .then(conn => {
    console.log('✅ MySQL connected to Aiven successfully!');
    conn.release();
  })
  .catch(err => {
    console.error('❌ Failed to connect to Aiven MySQL:', err.message);
    process.exit(1);
  });

// ---------- Health check ----------
app.get('/healthz', (_, res) => res.send('ok'));

// ---------- Helper: computeAggregates ----------
function computeAggregates(node) {
  const childrenKeys = Object.keys(node.children);
  if (childrenKeys.length === 0) {
    const totalSales = node.sales.reduce((sum, s) => sum + (s.sales || 0), 0);
    node.totalSales = totalSales;
    return { amount: node.amount, sales: totalSales };
  }

  let sumAmount = 0;
  let count = 0;
  let sumSales = 0;

  for (const childName of childrenKeys) {
    const child = node.children[childName];
    const childResult = computeAggregates(child);

    sumAmount += childResult.amount;
    sumSales += childResult.sales;
    count++;
  }

  node.amount = count > 0 ? Math.round(sumAmount / count) : 0;
  node.sales = sumSales;
  node.totalSales = sumSales;

  return { amount: node.amount, sales: node.sales };
}

// ---------- Hierarchy API ----------
app.get("/hierarchy/:emp", async (req, res) => {
  const emp = req.params.emp;
  const query = `
    WITH RECURSIVE downline AS (
      SELECT Emp_Code, Emp_Name, Role, Reporting_Manager, Territory
      FROM employee_details
      WHERE Emp_Name = ?

      UNION ALL

      SELECT e.Emp_Code, e.Emp_Name, e.Role, e.Reporting_Manager, e.Territory
      FROM employee_details e
      JOIN downline d ON e.Reporting_Manager_Code = d.Emp_Code
    )
    SELECT d.Emp_Code, d.Emp_Name, d.Reporting_Manager, d.Role, d.Territory,
           IFNULL(c.Coverage, 0) AS amount,
           s.ProductName, s.Sales
    FROM downline d
    LEFT JOIN coverage_details c ON d.Emp_Code = c.Emp_Code
    LEFT JOIN sales1 s ON d.Emp_Code = s.Emp_Code;
  `;
  try {
    const [rows] = await pool.query(query, [emp]);

    const map = {};
    const root = {};
    const salesByEmp = {};

    rows.forEach(r => {
      if (!salesByEmp[r.Emp_Code]) salesByEmp[r.Emp_Code] = [];
      if (r.ProductName) {
        salesByEmp[r.Emp_Code].push({
          productName: r.ProductName,
          sales: r.Sales
        });
      }
    });

    rows.forEach(r => {
      const amount = r.Role === "BE" ? r.amount : 0;
      if (!map[r.Emp_Name]) {
        map[r.Emp_Name] = {
          amount,
          territory: r.Territory || null,
          role: r.Role || null,
          children: {},
          sales: r.Role === "BE" ? (salesByEmp[r.Emp_Code] || []) : []
        };
      }
    });

    rows.forEach(r => {
      if (r.Emp_Name === emp) {
        root[r.Emp_Name] = map[r.Emp_Name];
      } else if (map[r.Reporting_Manager]) {
        map[r.Reporting_Manager].children[r.Emp_Name] = map[r.Emp_Name];
      }
    });

    for (const top in root) {
      computeAggregates(root[top]);
    }

    res.json(root);
  } catch (err) {
    console.error("❌ Error in /hierarchy:", err);
    res.status(500).send("Error fetching hierarchy");
  }
});

// ---------- Employees ----------
app.get('/employees', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT Emp_Name AS name, Role, Emp_Code, Territory 
      FROM employee_details
      ORDER BY Emp_Name
    `);
    res.json(rows);
  } catch (err) {
    console.error('Error /employees:', err);
    res.status(500).send("Error");
  }
});

// ---------- Commitments insert ----------
app.post('/putData', async (req, res) => {
  try {
    const dataToInsert = req.body;
    const dataArray = Array.isArray(dataToInsert) ? dataToInsert : [dataToInsert];

    if (dataArray.length === 0) {
      return res.status(400).send('No data received');
    }

    const values = dataArray.map(row => [
      row.metric,
      row.sender,
      row.sender_code,
      row.sender_territory,
      row.receiver,
      row.receiver_code,
      row.receiver_territory,
      row.goal,
      row.received_date,
      row.goal_date,
      row.receiver_commit_date || null,
      row.commitment
    ]);

    const query = `
      INSERT INTO commitments (
        metric,
        sender,
        sender_code,
        sender_territory,
        receiver,
        receiver_code,
        receiver_territory,
        goal,
        received_date,
        goal_date,
        receiver_commit_date,
        commitment
      ) VALUES ?
    `;

    await pool.query(query, [values]);
    return res.status(201).send('success');
  } catch (err) {
    console.error('Error /putData:', err);
    return res.status(500).send('Internal Server Error');
  }
});

// ---------- Escalations insert ----------
app.post('/putEscalations', async (req, res) => {
  try {
    const dataToInsert = req.body;
    const dataArray = Array.isArray(dataToInsert) ? dataToInsert : [dataToInsert];

    if (dataArray.length === 0) {
      return res.status(400).send('No data received');
    }

    const values = dataArray.map(row => [
      row.metric,
      row.message,
      row.role,
      row.employee_name,
      row.territory_code,
      row.employee_code,
      row.entry_date
    ]);

    const query = `
      INSERT INTO escalations (
        metric,
        message,
        role,
        employee_name,
        territory_code,
        employee_code,
        entry_date
      ) VALUES ?
    `;

    await pool.query(query, [values]);
    return res.status(201).send('success');
  } catch (err) {
    console.error('Error /putEscalations:', err);
    return res.status(500).send('Internal Server Error');
  }
});

// ---------- Get commitments by territory ----------
app.get('/getData/:receiver_territory', async (req, res) => {
  try {
    const { receiver_territory } = req.params;
    if (!receiver_territory) {
      return res.status(400).send('receiver_territory is required');
    }

    const query = `
      SELECT 
        metric,
        sender,
        sender_code,
        sender_territory,
        receiver,
        receiver_code,
        receiver_territory,
        goal,
        received_date,
        goal_date,
        receiver_commit_date,
        commitment
      FROM commitments
      WHERE receiver_territory = ?
    `;
    const [rows] = await pool.query(query, [receiver_territory]);

    if (rows.length === 0) {
      return res.status(404).send('No data found for this territory');
    }
    return res.status(200).json(rows);
  } catch (err) {
    console.error('Error /getData:', err);
    return res.status(500).send('Internal Server Error');
  }
});

// ---------- Update receiver commit date ----------
app.put('/updateReceiverCommitDate', async (req, res) => {
  try {
    const { metric, sender_code, receiver_code, receiver_commit_date } = req.body;
    if (!metric || !sender_code || !receiver_code || !receiver_commit_date) {
      return res.status(400).send('metric, sender_code, receiver_code, and receiver_commit_date are required');
    }

    const query = `
      UPDATE commitments
      SET receiver_commit_date = ?
      WHERE metric = ? AND sender_code = ? AND receiver_code = ?
    `;

    const [result] = await pool.query(query, [
      receiver_commit_date,
      metric,
      sender_code,
      receiver_code
    ]);

    if (result.affectedRows === 0) {
      return res.status(404).send('No matching commitment found');
    }

    res.status(200).send('Date updated successfully');
  } catch (err) {
    console.error('Error /updateReceiverCommitDate:', err);
    res.status(500).send('Internal Server Error');
  }
});

// ---------- Add disclosure ----------
app.post("/addEscalation", async (req, res) => {
  try {
    const {
      metric,
      sender,
      sender_code,
      sender_territory,
      from,
      to,
      received_date,
      goal_date,
      message
    } = req.body;

    if (
      !metric ||
      !sender ||
      !sender_code ||
      !sender_territory ||
      from === undefined ||
      to === undefined ||
      !received_date ||
      !goal_date
    ) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const query = `
      INSERT INTO disclosures
      (metric, sender, sender_code, sender_territory, \`from\`, \`to\`, received_date, goal_date, message) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const values = [metric, sender, sender_code, sender_territory, from, to, received_date, goal_date, message || null];
    await pool.query(query, values);
    res.status(201).json({ message: "Commitment added successfully" });
  } catch (error) {
    console.error("Error /addEscalation:", error);
    res.status(500).json({ error: "Database error" });
  }
});

// ---------- Insert info ----------
app.post('/putInfo', async (req, res) => {
  try {
    const dataToInsert = req.body;
    const dataArray = Array.isArray(dataToInsert) ? dataToInsert : [dataToInsert];

    if (dataArray.length === 0) {
      return res.status(400).send('No data received');
    }

    const values = dataArray.map(row => [
      row.sender,
      row.sender_code,
      row.sender_territory,
      row.receiver,
      row.receiver_code,
      row.receiver_territory,
      row.received_date,
      row.message
    ]);

    const query = `
      INSERT INTO information (
        sender,
        sender_code,
        sender_territory,
        receiver,
        receiver_code,
        receiver_territory,
        received_date,
        message
      ) VALUES ?
    `;

    await pool.query(query, [values]);
    return res.status(201).send('success');
  } catch (err) {
    console.error('Error /putInfo:', err);
    return res.status(500).send('Internal Server Error');
  }
});

// ---------- Filter data (VALIDATE metric to prevent injection) ----------
const ALLOWED_METRICS = ['Coverage', 'coverage', 'some_numeric_column']; // <- Replace with your actual numeric columns
app.post("/filterData", async (req, res) => {
  try {
    const { metric, from, to } = req.body;
    if (!metric || from === undefined || to === undefined) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (!ALLOWED_METRICS.includes(metric)) {
      return res.status(400).json({ error: "Invalid metric" });
    }

    const query = `
      SELECT Territory_Name, Emp_Code, Employee_Name, \`${metric}\`
      FROM coverage_details
      WHERE \`${metric}\` BETWEEN ? AND ?
    `;
    const [rows] = await pool.query(query, [from, to]);
    res.json(rows);
  } catch (error) {
    console.error("Error /filterData:", error);
    res.status(500).json({ error: "Database error" });
  }
});

// ---------- Messages by territory ----------
app.post("/getMessagesByTerritory", async (req, res) => {
  try {
    const { receiver_territory } = req.body;
    if (!receiver_territory) {
      return res.status(400).json({ error: "receiver_territory is required" });
    }

    const query = `
      SELECT * 
      FROM information
      WHERE receiver_territory = ?
    `;
    const [rows] = await pool.query(query, [receiver_territory]);
    res.json({ results: rows });
  } catch (error) {
    console.error("Error /getMessagesByTerritory:", error);
    res.status(500).json({ error: "Database error" });
  }
});

// ---------- Graceful shutdown handlers ----------
process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at:', p, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception thrown:', err);
});



// -----------------------------------------------------------------------------------
// ---------- API 1: Table 1 (Stockist, Product, Sales) ----------
app.post('/getTable1', async (req, res) => {
  try {
    const { territory } = req.body;
    if (!territory) return res.status(400).json({ error: 'territory is required' });

    const [rows] = await pool.query(
      `SELECT Stockist, ProductName, Sales 
       FROM sales1 
       WHERE Territory = ?`,
      [territory]
    );

    res.json({ results: rows });
  } catch (err) {
    console.error('Error /getTable1:', err);
    res.status(500).json({ error: 'Database error' });
  }
});


// ---------- API 2: Table 2 (Pivot Summary View) ----------

app.post('/getTable2', async (req, res) => {
  try {
    const { territory } = req.body;
    if (!territory) return res.status(400).json({ error: 'territory is required' });

    const [rows] = await pool.query(
      `SELECT Stockist, ProductName, Sales 
       FROM sales1 
       WHERE Territory = ?`,
      [territory]
    );

    // Pivot transformation in JS
    const pivot = {};
    rows.forEach(r => {
      if (!pivot[r.ProductName]) {
        pivot[r.ProductName] = { ProductName: r.ProductName, GrandTotal: 0 };
      }
      pivot[r.ProductName][r.Stockist] = r.Sales;
      pivot[r.ProductName].GrandTotal += r.Sales;
    });

    res.json({ results: Object.values(pivot) });
  } catch (err) {
    console.error('Error /getTable2:', err);
    res.status(500).json({ error: 'Database error' });
  }
});


// ---------- Start server ----------
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
