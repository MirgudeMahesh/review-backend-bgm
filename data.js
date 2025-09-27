
require('dotenv').config(); // only for local dev; Render/Railway/Vercel use env vars
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

// ---------- CORS ----------
// Use FRONTEND_ORIGIN in production; fallback to localhost for local dev
const FRONTEND_ORIGIN = ['http://localhost:3000', 'http://192.168.0.157:3000'];
app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }));
app.use(express.json());

// ---------- LOCAL DB pool (no env) ----------
let pool;

try {
  pool = mysql.createPool({
    host: 'localhost',
    port: 3306,
    user: 'root',
    password: 'root',
    database: 'pulse_new',
    waitForConnections: true,
    connectionLimit: 20,
  });

  console.log('💻 Using LOCAL MySQL (pulse_new @ localhost)');
} catch (err) {
  console.error('❌ Error creating DB pool:', err);
  process.exit(1);
}

// Test connection
pool.getConnection()
  .then(conn => {
    console.log('✅ MySQL connected to local successfully!');
    conn.release();
  })
  .catch(err => {
    console.error('❌ Failed to connect to local MySQL:', err.message);
    process.exit(1);
  });

// ---------- Health check ----------
app.get('/healthz', (_, res) => res.send('ok'));


// ---------- Helper: computeAggregates ----------
app.post("/hierarchy", async (req, res) => {
  try {
    const { empterr } = req.body;
    if (!empterr) return res.status(400).send("empterr is required");

    // 1. Fetch hierarchy
    const [rows] = await pool.query(
      `
      WITH RECURSIVE downline AS (
        SELECT Emp_Code, Emp_Name, Reporting_Manager, Reporting_Manager_Code, Role, Territory, Area_Name
        FROM employee_details
        WHERE Territory = ?
        UNION ALL
        SELECT e.Emp_Code, e.Emp_Name, e.Reporting_Manager, e.Reporting_Manager_Code, e.Role, e.Territory, e.Area_Name
        FROM employee_details e
        INNER JOIN downline d ON e.Area_Name = d.Territory
      )
      SELECT * FROM downline
      `,
      [empterr]
    );

    if (!rows.length) return res.json({});

    // 2. Fetch sales data for BE’s
    const territories = rows.map(r => r.Territory);
    let salesByTerritory = {};
    if (territories.length > 0) {
      const [salesRows] = await pool.query(
        `
        SELECT e.Territory, s.ProductName, s.Sales
        FROM sales_data s
        JOIN employee_details e ON e.Territory = s.Territory
        WHERE e.Territory IN (?)
        `,
        [territories]
      );

      salesByTerritory = salesRows.reduce((acc, s) => {
        if (!acc[s.Territory]) acc[s.Territory] = [];
        acc[s.Territory].push({ productName: s.ProductName, sales: s.Sales });
        return acc;
      }, {});
    }

    // 3. Fetch BE metrics (Coverage, Calls, Compliance, Chemist_Calls)
    let metricsByTerritory = {};
    if (territories.length > 0) {
      const [metricRows] = await pool.query(
        `
        SELECT Territory, Coverage, Calls, Compliance, Chemist_Calls
        FROM dashboard1
        WHERE Territory IN (?)
        `,
        [territories]
      );

      metricsByTerritory = metricRows.reduce((acc, m) => {
        acc[m.Territory] = {
          Coverage: m.Coverage || 0,
          Calls: m.Calls || 0,
          Compliance: m.Compliance || 0,
          Chemist_Calls: m.Chemist_Calls || 0,
        };
        return acc;
      }, {});
    }

    // 4. Build map
    const map = {};
    rows.forEach(r => {
      map[r.Territory] = {
        empName: r.Emp_Name,
        amount: (r.Role === "BE" ||r.Role==='TE') ? 0 : 0,
        territory: r.Territory,
        role: r.Role,
        children: {},
        sales: (r.Role === "BE" ||r.Role==='TE') ? (salesByTerritory[r.Territory] || []) : [],
        salesByProduct: {},
        totalSales: 0,

        // NEW: metrics
        Coverage: (r.Role === "BE" ||r.Role==='TE') ? (metricsByTerritory[r.Territory]?.Coverage || 0) : 0,
        Calls: (r.Role === "BE" ||r.Role==='TE') ? (metricsByTerritory[r.Territory]?.Calls || 0) : 0,
        Compliance: (r.Role === "BE" ||r.Role==='TE') ? (metricsByTerritory[r.Territory]?.Compliance || 0) : 0,
        Chemist_Calls: (r.Role === "BE" ||r.Role==='TE') ? (metricsByTerritory[r.Territory]?.Chemist_Calls || 0) : 0,
      };
    });

    // 5. Link children
    let root = {};
    rows.forEach(r => {
      if (r.Territory === empterr) {
        root[r.Territory] = map[r.Territory];
      } else if (r.Area_Name) {
        const parent = rows.find(p => p.Territory === r.Area_Name);
        if (parent && map[parent.Territory]) {
          map[parent.Territory].children[r.Territory] = map[r.Territory];
        }
      }
    });

    // 6. Compute aggregates (sales + new metrics)
    function computeAggregates(node) {
      const childKeys = Object.keys(node.children);

      if (childKeys.length === 0) {
        // BE
        const salesByProduct = {};
        (node.sales || []).forEach(s => {
          salesByProduct[s.productName] =
            (salesByProduct[s.productName] || 0) + (s.sales || 0);
        });
        node.salesByProduct = salesByProduct;
        node.totalSales = Object.values(salesByProduct).reduce((a, b) => a + b, 0);
        return {
          amount: node.amount,
          salesByProduct,
          metrics: {
            Coverage: node.Coverage,
            Calls: node.Calls,
            Compliance: node.Compliance,
            Chemist_Calls: node.Chemist_Calls,
          },
        };
      }

      // Manager
      let sumAmount = 0, count = 0;
      const aggregatedSales = {};
      const metricsSum = { Coverage: 0, Calls: 0, Compliance: 0, Chemist_Calls: 0 };

      for (const key of childKeys) {
        const child = node.children[key];
        const { amount, salesByProduct, metrics } = computeAggregates(child);
        sumAmount += amount;
        count++;

        // merge sales
        for (const [prod, val] of Object.entries(salesByProduct)) {
          aggregatedSales[prod] = (aggregatedSales[prod] || 0) + val;
        }

        // sum metrics
        metricsSum.Coverage += metrics.Coverage;
        metricsSum.Calls += metrics.Calls;
        metricsSum.Compliance += metrics.Compliance;
        metricsSum.Chemist_Calls += metrics.Chemist_Calls;
      }

      node.amount = count > 0 ? Math.round(sumAmount / count) : 0;
      node.salesByProduct = aggregatedSales;
      node.totalSales = Object.values(aggregatedSales).reduce((a, b) => a + b, 0);

      // average metrics for managers
      node.Coverage = count > 0 ? Math.round(metricsSum.Coverage / count) : 0;
      node.Calls = count > 0 ? Math.round(metricsSum.Calls / count) : 0;
      node.Compliance = count > 0 ? Math.round(metricsSum.Compliance / count) : 0;
      node.Chemist_Calls = count > 0 ? Math.round(metricsSum.Chemist_Calls / count) : 0;

      return {
        amount: node.amount,
        salesByProduct: aggregatedSales,
        metrics: {
          Coverage: node.Coverage,
          Calls: node.Calls,
          Compliance: node.Compliance,
          Chemist_Calls: node.Chemist_Calls,
        },
      };
    }

    Object.values(root).forEach(r => computeAggregates(r));

    res.json(root);
  } catch (err) {
    console.error(err);
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
app.post("/hierarchy-kpi", async (req, res) => {
  try {
    const { empterr } = req.body;
    if (!empterr) return res.status(400).send("empterr is required");

    // 1. Build hierarchy using recursive CTE
    const [rows] = await pool.query(
      `
      WITH RECURSIVE downline AS (
        SELECT Emp_Code, Emp_Name, Reporting_Manager, Reporting_Manager_Code, Role, Territory, Area_Name
        FROM employee_details
        WHERE Territory = ?
        UNION ALL
        SELECT e.Emp_Code, e.Emp_Name, e.Reporting_Manager, e.Reporting_Manager_Code, e.Role, e.Territory, e.Area_Name
        FROM employee_details e
        INNER JOIN downline d ON e.Area_Name = d.Territory
      )
      SELECT * FROM downline
      `,
      [empterr]
    );

    if (!rows.length) return res.json({});

    // 2. Fetch KPI values for BE's from dashboard1
    const territories = rows.map(r => r.Territory);
    let kpiByTerritory = {};
    if (territories.length > 0) {
      const [kpiRows] = await pool.query(
        `
        SELECT Territory, Calls, Coverage, Compliance, Chemist_Calls
        FROM dashboard1
        WHERE Territory IN (?)
        `,
        [territories]
      );

      kpiByTerritory = kpiRows.reduce((acc, r) => {
        acc[r.Territory] = {
          Calls: r.Calls || 0,
          Coverage: r.Coverage || 0,
          Compliance: r.Compliance || 0,
          Chemist_Calls: r.Chemist_Calls || 0,
        };
        return acc;
      }, {});
    }

    // 3. Build map keyed by territory
    const map = {};
    rows.forEach(r => {
      map[r.Territory] = {
        empName: r.Emp_Name,
        role: r.Role,
        territory: r.Territory,
        metrics: (r.Role === "BE" ||r.Role==='TE') ? (kpiByTerritory[r.Territory] || {
          Calls: 0,
          Coverage: 0,
          Compliance: 0,
          Chemist_Calls: 0
        }) : { Calls: 0, Coverage: 0, Compliance: 0, Chemist_Calls: 0 },
        children: {}
      };
    });

    // 4. Link children to their parent
    let root = {};
    rows.forEach(r => {
      if (r.Territory === empterr) {
        root[r.Territory] = map[r.Territory];
      } else if (r.Area_Name) {
        const parent = rows.find(p => p.Territory === r.Area_Name);
        if (parent && map[parent.Territory]) {
          map[parent.Territory].children[r.Territory] = map[r.Territory];
        }
      }
    });

    // 5. Compute averages bottom-up (direct child averaging)
    function computeAverages(node) {
      const childKeys = Object.keys(node.children);

      if (childKeys.length === 0) {
        // BE → already has values
        return { ...node.metrics, count: 1 };
      }

      let totals = { Calls: 0, Coverage: 0, Compliance: 0, Chemist_Calls: 0 };
      let childCount = 0;

      for (const key of childKeys) {
        const child = node.children[key];
        const childAgg = computeAverages(child);

        // Aggregate based on **child metrics**, not leaves
        totals.Calls += child.metrics.Calls;
        totals.Coverage += child.metrics.Coverage;
        totals.Compliance += child.metrics.Compliance;
        totals.Chemist_Calls += child.metrics.Chemist_Calls;

        childCount++;
      }

      // Average across direct children
      node.metrics = {
        Calls: childCount > 0 ? Math.round(totals.Calls / childCount) : 0,
        Coverage: childCount > 0 ? Math.round(totals.Coverage / childCount) : 0,
        Compliance: childCount > 0 ? Math.round(totals.Compliance / childCount) : 0,
        Chemist_Calls: childCount > 0 ? Math.round(totals.Chemist_Calls / childCount) : 0,
      };

      return { ...totals, count: childCount };
    }

    Object.values(root).forEach(r => computeAverages(r));

    res.json(root);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching KPI hierarchy");
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
    const { metric, sender_territory, receiver_territory, receiver_commit_date } = req.body;
    if (!metric || !sender_territory || !receiver_territory || !receiver_commit_date) {
      return res.status(400).send('metric, sender_code, receiver_code, and receiver_commit_date are required');
    }

    const query = `
      UPDATE commitments
      SET receiver_commit_date = ?
      WHERE metric = ? AND sender_territory = ? AND receiver_territory = ?
    `;

    const [result] = await pool.query(query, [
      receiver_commit_date,
      metric,
      sender_territory,
      receiver_territory
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
// 📌 Get all information records
app.get('/getInfo', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM information ORDER BY received_date DESC');
    res.json(rows);
  } catch (err) {
    console.error('Error /getInfo:', err);
    res.status(500).send('Internal Server Error');
  }
});

// ---------- Insert info ----------
app.post('/putInfo', async (req, res) => {
  try {
    const data = Array.isArray(req.body) ? req.body : [req.body];

    if (data.length === 0) {
      return res.status(400).json({ error: "No data received" });
    }

    const values = data.map(row => [
      row.sender || null,
      row.sender_code || null,
      row.sender_territory || null,
      row.receiver || null,
      row.receiver_code || null,
      row.receiver_territory || null,
      row.received_date || null,
      row.message || null
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

    // ✅ Use query, not execute
    await pool.query(query, [values]);

    return res.status(201).json({ success: true, inserted: values.length });
  } catch (err) {
    console.error("Error /putInfo:", err);
    return res.status(500).json({ error: "Internal Server Error" });
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
      SELECT Territory, Emp_Code, Emp_Name, \`${metric}\`
      FROM dashboard1
      WHERE \`${metric}\` BETWEEN ? AND ?
    `;
    const [rows] = await pool.query(query, [from, to]);
    res.json(rows);
    console.log(rows)
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
      `SELECT stockistname, ProductName, Sales 
       FROM sales_data 
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
      `SELECT stockistname, ProductName, Sales 
       FROM sales_data
       WHERE Territory = ?`,
      [territory]
    );

    // Pivot transformation in JS
    const pivot = {};
    rows.forEach(r => {
      if (!pivot[r.ProductName]) {
        pivot[r.ProductName] = { ProductName: r.ProductName, GrandTotal: 0 };
      }
      pivot[r.ProductName][r.stockistname] = r.Sales;
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
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend server running on http://0.0.0.0:${PORT}`);
});
