
require('dotenv').config(); // only for local dev; Render/Railway/Vercel use env vars
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

// const GEMINI_API_KEY = "AIzaSyATNAvqNh49YuO5ECjn6TR-BcaAFjNC3Ws";
// const GEMINI_API_MODEL = 'gemini-2.5-flash-preview-05-20';
// const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
// const GEMINI_API_URL = `${GEMINI_API_BASE_URL}/${GEMINI_API_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
// // ---------- CORS ----------
// // Use FRONTEND_ORIGIN in production; fallback to localhost for local dev
// const FRONTEND_ORIGIN = ['http://localhost:3000', 'http://192.168.0.157:3000'];
// app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }));
// app.use(express.json());

// // ---------- LOCAL DB pool (no env) ----------
// let pool;

// try {
//   pool = mysql.createPool({
//     host: 'localhost',
//     port: 3306,
//     user: 'root',
//     password: 'root',
//     database: 'pulse_new',
//     waitForConnections: true,
//     connectionLimit: 20,
//   });

//   console.log('💻 Using LOCAL MySQL (pulse_new @ localhost)');
// } catch (err) {
//   console.error('❌ Error creating DB pool:', err);
//   process.exit(1);
// }

// // Test connection
// pool.getConnection()
//   .then(conn => {
//     console.log('✅ MySQL connected to local successfully!');
//     conn.release();
//   })
//   .catch(err => {
//     console.error('❌ Failed to connect to local MySQL:', err.message);
//     process.exit(1);
//   });

// // ---------- Health check ----------
// app.get('/healthz', (_, res) => res.send('ok'));


// ---------- Helper: computeAggregates ----------
// ---------- Hierarchy Route (Fixed) ----------
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:3000' ;
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
      connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 50),
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
      connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 50),
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
// ---------- Hierarchy Route (Fixed) ----------

app.post("/hierarchy", async (req, res) => {
  try {
    const { territory } = req.body || {};

    const [rows] = await pool.query("SELECT * FROM hierarchy_metrics_agg_rm");
    if (!rows.length) return res.json({ message: "No data found" });

    // Map by territory
    const byTerritory = {};
    rows.forEach((r) => (byTerritory[r.Territory] = r));

    const avg = (arr) =>
      arr.length ? arr.reduce((a, b) => a + (b || 0), 0) / arr.length : 0;

    function buildNode(terr) {
      const emp = byTerritory[terr];
      if (!emp) return null;

      const childRows = rows.filter(
        (r) => r.Area_Name && r.Area_Name.trim() === emp.Territory.trim()
      );

      const children = {};
      for (const c of childRows) {
        const childNode = buildNode(c.Territory);
        if (childNode) children[c.Territory] = childNode;
      }

      // Node WITHOUT ANY SALES DATA
      let node = {
        empName: emp.Emp_Name,
        territory: emp.Territory,
        role: emp.Role,
        children,
        Coverage: emp.Coverage ? parseFloat(emp.Coverage) : 0,
        Calls: emp.Calls ? parseFloat(emp.Calls) : 0,
        Compliance: emp.Compliance ? parseFloat(emp.Compliance) : 0,
        Chemist_Calls: emp.Chemist_Calls
          ? parseFloat(emp.Chemist_Calls)
          : 0,
      };

      // Aggregate ONLY non-sales fields
      if (Object.keys(children).length > 0) {
        const agg = {
          Coverage: [],
          Calls: [],
          Compliance: [],
          Chemist_Calls: [],
        };

        for (const ch of Object.values(children)) {
          agg.Coverage.push(ch.Coverage || 0);
          agg.Calls.push(ch.Calls || 0);
          agg.Compliance.push(ch.Compliance || 0);
          agg.Chemist_Calls.push(ch.Chemist_Calls || 0);
        }

        node.Coverage = Math.round(avg(agg.Coverage));
        node.Calls = Math.round(avg(agg.Calls));
        node.Compliance = Math.round(avg(agg.Compliance));
        node.Chemist_Calls = Math.round(avg(agg.Chemist_Calls));
      }

      return node;
    }

    const allTerritories = rows.map((r) => r.Territory);
    const topLevels = rows.filter((r) => !allTerritories.includes(r.Area_Name));

    const hierarchy = {};
    if (territory) {
      const node = buildNode(territory);
      if (node) hierarchy[territory] = node;
    } else {
      for (const top of topLevels) {
        const node = buildNode(top.Territory);
        if (node) hierarchy[top.Territory] = node;
      }
    }

    res.json(hierarchy);
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).send("Server error: " + err.message);
  }
});







// ---------- Employees ----------
app.get('/employees', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT Emp_Name AS name, Role, Emp_Code, Territory 
      FROM organogram
      ORDER BY Emp_Name
    `);
    res.json(rows);
  } catch (err) {
    console.error('Error /employees:', err);
    res.status(500).send("Error");
  }
});

app.get('/checkrole', async (req, res) => {
  try {
    const { territory } = req.query;

    if (!territory) {
      return res.status(400).json({ error: "territory is required" });
    }

    // Fetch role for the territory
    const [rows] = await pool.query(
      `SELECT Role FROM organogram WHERE Territory = ? LIMIT 1`,
      [territory]
    );

    if (rows.length === 0) {
      return res.json({ allowed: false }); // No match → false
    }

    const role = rows[0].Role;

    // Allowed roles list
    const allowedRoles = ['BE', 'KAE', 'TE', 'NE'];

    // true if match, false otherwise
    const isAllowed = allowedRoles.includes(role);

    res.json({ allowed: isAllowed });

  } catch (err) {
    console.error("Error /checkrole:", err);
    res.status(500).send("Server Error");
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
app.post('/dashboardData', async (req, res) => {
  try {
    const { Territory } = req.body; // 👈 Get Territory from frontend
    
    if (!Territory) {
      return res.status(400).json({ error: "Territory is required" });
    }

    const [rows] = await pool.query(
      `SELECT * FROM bgm_be_dashboard_ftm WHERE Territory = ?`,
      [Territory] // 👈 Pass safely to prevent SQL injection
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "No record found for this Territory" });
    }

    res.json(rows[0]); // 👈 Return only the first (and likely only) matching row
  } catch (error) {
    console.error("Error fetching data:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.post('/dashboardytdData', async (req, res) => {
  try {
    const { Territory } = req.body; // 👈 Get Territory from frontend
    
    if (!Territory) {
      return res.status(400).json({ error: "Territory is required" });
    }

    const [rows] = await pool.query(
      `SELECT * FROM bgm_be_dashboard_ytd WHERE Territory = ?`,
      [Territory] // 👈 Pass safely to prevent SQL injection
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "No record found for this Territory" });
    }

    res.json(rows[0]); // 👈 Return only the first (and likely only) matching row
  } catch (error) {
    console.error("Error fetching data:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


app.post('/dashboardYTD', async (req, res) => {
  try {
    const { Territory } = req.body;

    if (!Territory) {
      return res.status(400).json({ error: "Territory is required" });
    }

    const [rows] = await pool.query(
      `SELECT 
         Calls_Score,
         RCPA_Score,
         Coverage_Score,
         Compliance_Score,
         Activity_Implementation_Score,
         Secondary_Sales_growth_Score,
         MSR_Achievement_Score,
         RX_Growth_Score,
         Brand_Performance_Index_Score
       FROM bgm_be_dashboard_ytd
       WHERE Territory = ?`,
      [Territory]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "No record found for this Territory" });
    }

    const row = rows[0];

    // First set
   const totalScore1 =(
  (Number(row.Calls_Score) || 0) +
  (Number(row.RCPA_Score) || 0) +
  (Number(row.Coverage_Score) || 0) +
  (Number(row.Compliance_Score) || 0) +
  (Number(row.Activity_Implementation_Score) || 0)).toFixed(2);

const totalScore2 =(
  (Number(row.Secondary_Sales_growth_Score) || 0) +
  (Number(row.MSR_Achievement_Score) || 0) +
  (Number(row.RX_Growth_Score) || 0) +
  (Number(row.Brand_Performance_Index_Score) || 0)).toFixed(2);


    res.json({
      totalScore1: Number(parseFloat(totalScore1).toFixed(2)),
      totalScore2: Number(parseFloat(totalScore2).toFixed(2))
    });

  } catch (error) {
    console.error("Error fetching YTD data:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});


app.post('/dashboardFTD', async (req, res) => {
  try {
    const { Territory } = req.body;

    if (!Territory) {
      return res.status(400).json({ error: "Territory is required" });
    }

    const [rows] = await pool.query(
      `SELECT 
         Calls_Score,
         RCPA_Score,
         Coverage_Score,
         Compliance_Score,
         Activity_Implementation_Score,
         Secondary_Sales_growth_Score,
         MSR_Achievement_Score,
         RX_Growth_Score,
         Brand_Performance_Index_Score
       FROM bgm_be_dashboard_ftm
       WHERE Territory = ?`,
      [Territory]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "No record found for this Territory" });
    }

    const row = rows[0];

    // First set
const totalScore3 = (
  (Number(row.Calls_Score) || 0) +
  (Number(row.RCPA_Score) || 0) +
  (Number(row.Coverage_Score) || 0) +
  (Number(row.Compliance_Score) || 0) +
  (Number(row.Activity_Implementation_Score) || 0)
).toFixed(2);

const totalScore4 = (
  (Number(row.Secondary_Sales_growth_Score) || 0) +
  (Number(row.MSR_Achievement_Score) || 0) +
  (Number(row.RX_Growth_Score) || 0) +
  (Number(row.Brand_Performance_Index_Score) || 0)
).toFixed(2);


    res.json({
      totalScore3: Number(parseFloat(totalScore3).toFixed(2)),
      totalScore4: Number(parseFloat(totalScore4).toFixed(2))
    });

  } catch (error) {
    console.error("Error fetching YTD data:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// app.post("/hierarchy-kpi", async (req, res) => {
//   try {
//     const { empterr } = req.body;
//     if (!empterr) return res.status(400).send("empterr is required");

//     // 1. Build hierarchy using recursive CTE
//     const [rows] = await pool.query(
//       `
//       WITH RECURSIVE downline AS (
//         SELECT Emp_Code, Emp_Name, Reporting_Manager, Reporting_Manager_Code, Role, Territory, Area_Name
//         FROM employee_details
//         WHERE Territory = ?
//         UNION ALL
//         SELECT e.Emp_Code, e.Emp_Name, e.Reporting_Manager, e.Reporting_Manager_Code, e.Role, e.Territory, e.Area_Name
//         FROM employee_details e
//         INNER JOIN downline d ON e.Area_Name = d.Territory
//       )
//       SELECT * FROM downline
//       `,
//       [empterr]
//     );

//     if (!rows.length) return res.json({});

//     // 2. Fetch KPI values for BE's from dashboard1
//     const territories = rows.map(r => r.Territory);
//     let kpiByTerritory = {};
//     if (territories.length > 0) {
//       const [kpiRows] = await pool.query(
//         `
//         SELECT Territory, Calls, Coverage, Compliance, Chemist_Calls
//         FROM dashboard1
//         WHERE Territory IN (?)
//         `,
//         [territories]
//       );

//       kpiByTerritory = kpiRows.reduce((acc, r) => {
//         acc[r.Territory] = {
//           Calls: r.Calls || 0,
//           Coverage: r.Coverage || 0,
//           Compliance: r.Compliance || 0,
//           Chemist_Calls: r.Chemist_Calls || 0,
//         };
//         return acc;
//       }, {});
//     }

//     // 3. Build map keyed by territory
//     const map = {};
//     rows.forEach(r => {
//       map[r.Territory] = {
//         empName: r.Emp_Name,
//         role: r.Role,
//         territory: r.Territory,
//         metrics: (r.Role === "BE" ||r.Role==='TE') ? (kpiByTerritory[r.Territory] || {
//           Calls: 0,
//           Coverage: 0,
//           Compliance: 0,
//           Chemist_Calls: 0
//         }) : { Calls: 0, Coverage: 0, Compliance: 0, Chemist_Calls: 0 },
//         children: {}
//       };
//     });

//     // 4. Link children to their parent
//     let root = {};
//     rows.forEach(r => {
//       if (r.Territory === empterr) {
//         root[r.Territory] = map[r.Territory];
//       } else if (r.Area_Name) {
//         const parent = rows.find(p => p.Territory === r.Area_Name);
//         if (parent && map[parent.Territory]) {
//           map[parent.Territory].children[r.Territory] = map[r.Territory];
//         }
//       }
//     });

//     // 5. Compute averages bottom-up (direct child averaging)
//     function computeAverages(node) {
//       const childKeys = Object.keys(node.children);

//       if (childKeys.length === 0) {
//         // BE → already has values
//         return { ...node.metrics, count: 1 };
//       }

//       let totals = { Calls: 0, Coverage: 0, Compliance: 0, Chemist_Calls: 0 };
//       let childCount = 0;

//       for (const key of childKeys) {
//         const child = node.children[key];
//         const childAgg = computeAverages(child);

//         // Aggregate based on **child metrics**, not leaves
//         totals.Calls += child.metrics.Calls;
//         totals.Coverage += child.metrics.Coverage;
//         totals.Compliance += child.metrics.Compliance;
//         totals.Chemist_Calls += child.metrics.Chemist_Calls;

//         childCount++;
//       }

//       // Average across direct children
//       node.metrics = {
//         Calls: childCount > 0 ? Math.round(totals.Calls / childCount) : 0,
//         Coverage: childCount > 0 ? Math.round(totals.Coverage / childCount) : 0,
//         Compliance: childCount > 0 ? Math.round(totals.Compliance / childCount) : 0,
//         Chemist_Calls: childCount > 0 ? Math.round(totals.Chemist_Calls / childCount) : 0,
//       };

//       return { ...totals, count: childCount };
//     }

//     Object.values(root).forEach(r => computeAverages(r));

//     res.json(root);
//   } catch (err) {
//     console.error(err);
//     res.status(500).send("Error fetching KPI hierarchy");
//   }
// });







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

  // ------------------------------------temporary regarding only be data

// ---------- Get commitments by territory ----------
app.get("/getData/:territory", async (req, res) => {
  try {
    const territory = req.params.territory;

    const [rows] = await pool.query(
      `SELECT id, metric, sender, sender_territory, receiver_territory, 
              commitment, goal, received_date, goal_date, receiver_commit_date
       FROM commitments
       WHERE receiver_territory = ?`,
      [territory]
    );

    res.json(rows);
  } catch (err) {
    console.error("Error fetching commitments:", err);
    res.status(500).send("Server error");
  }
});


// ---------- Update receiver commit date ----------
app.put('/updateCommitment', async (req, res) => {
  try {
    const { id, receiver_commit_date, goal } = req.body;

    if (!id) {
      return res.status(400).send("Row ID is required");
    }

    const fields = [];
    const values = [];

    if (receiver_commit_date !== undefined) {
      fields.push("receiver_commit_date = ?");
      values.push(receiver_commit_date);
    }

    if (goal !== undefined) {
      fields.push("goal = ?");
      values.push(goal);
    }

    if (fields.length === 0) {
      return res.status(400).send("Nothing to update");
    }

    values.push(id);

    const query = `
      UPDATE commitments
      SET ${fields.join(", ")}
      WHERE id = ?
    `;

    const [result] = await pool.query(query, values);

    if (result.affectedRows === 0) {
      return res.status(404).send("No row found with this id");
    }

    res.status(200).send("Updated successfully");
  } catch (err) {
    console.error("Error /updateCommitment:", err);
    res.status(500).send("Internal Server Error");
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

const values = data.map(row => {
  let personalizedMsg = row.message;

  // Replace placeholders
  if (personalizedMsg.includes("@name")) {
    personalizedMsg = personalizedMsg.replace(/@name/g, row.receiver);
  }
  if (personalizedMsg.includes("@metric") && row.metric !== undefined) {
    personalizedMsg = personalizedMsg.replace(/@metric/g, row.metric);
  }

  return [
    row.sender || null,
    row.sender_code || null,
    row.sender_territory || null,
    row.receiver || null,
    row.receiver_code || null,
    row.receiver_territory || null,
    row.received_date || null,
    personalizedMsg || null
  ];
});



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
const ALLOWED_METRICS = ['Coverage', 'Compliance', 'Calls', 'Drs_Met']; // <- Replace with your actual numeric columns
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
       FROM sales_data_testing_7 
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


// ---------- AI Assistant Route ----------

  // ------------------------------------temporary regarding only be data


// app.post('/api/ask-ai', async (req, res) => {
//     // NOTE: 'pool' is assumed to be the connected MySQL pool instance.
//     const { question, table } = req.body;

//     // 1) Basic validation
//     if (!question || question.trim() === '') {
//         return res.status(400).json({ error: 'Question cannot be empty' });
//     }
//     if (!table || table.trim() === '') {
//         return res.status(400).json({ error: 'Table name is required' });
//     }

//     // 2) Whitelist allowed tables to prevent SQL injection on identifier
//     const allowedTables = ['employee_details', 'commitments', 'dashboard1'];
//     if (!allowedTables.includes(table)) {
//         return res.status(400).json({ error: 'Invalid table selected.' });
//     }

//     try {
//         // 3) Fetch all columns safely (identifier placeholder)
//         // This line assumes 'pool' is an active database connection pool (e.g., from mysql2/promise)
//         const [rows] = await pool.query('SELECT * FROM ??', [table]);

//         if (!rows || rows.length === 0) {
//             return res.json({ answer: `No data found in ${table}.` });
//         }

//         // 4) Convert rows to readable text for AI (cap volume to protect token usage)
//         const maxRows = 1000;
//         const limited = rows.slice(0, maxRows);
//         const formattedData = limited.map(r => JSON.stringify(r)).join('\n');

//         // 5) Build Gemini payload
//         const systemPrompt = `You are a data analyst. Answer using only the provided data from table: ${table}. If the question cannot be answered from the data, say so.`;
//         const userQuery = `Here is the ${table} data (first ${limited.length} of ${rows.length} rows):\n${formattedData}\n\nQuestion: ${question}`;

//         const payload = {
//             // User query goes into the contents array
//             contents: [{ parts: [{ text: userQuery }] }],

//             // System instructions guide the model's behavior and persona
//             systemInstruction: {
//                 parts: [{ text: systemPrompt }]
//             },

//             // Other generation configuration (optional, but good practice)
//             generationConfig: {
//                 temperature: 0.2
//             }
//         };

//         // 6) Call Gemini API (using the pre-configured URL)
//         const response = await fetch(GEMINI_API_URL, {
//             method: 'POST',
//             headers: {
//                 // No Authorization header needed; key is in the query string
//                 'Content-Type': 'application/json',
//             },
//             body: JSON.stringify(payload),
//         });

//         if (!response.ok) {
//             const errorText = await response.text();
//             console.error('Gemini API error response:', errorText);
//             // Attempt to parse JSON error if possible, otherwise send raw text
//             try {
//                 const errorData = JSON.parse(errorText);
//                 return res.status(response.status).json({ error: errorData.error?.message || 'Gemini API returned an error.' });
//             } catch {
//                 return res.status(response.status).json({ error: 'Gemini API returned an unknown error: ' + errorText });
//             }
//         }

//         const data = await response.json();

//         // Extract the generated text from the Gemini response structure
//         const answer = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No answer available.';

//         res.json({ answer });
//     } catch (err) {
//         console.error('❌ ask-ai error:', err);
//         res.status(500).json({ error: 'AI query failed due to an internal server error.' });
//     }
// });


// ---------- Start server ----------
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));