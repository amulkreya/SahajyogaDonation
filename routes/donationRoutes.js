import express from "express";
import pool from "../config/db.js";
import { isAuthenticated } from "../middleware/auth.js";

const router = express.Router();

/*
====================================================
SEARCH DONOR BY MOBILE  (existing)
====================================================
*/
router.get("/donors/search", isAuthenticated, async (req, res) => {
  const { mobile } = req.query;
  try {
    let query = `SELECT id, first_name, last_name, email, mobile FROM donors WHERE mobile = $1`;
    let values = [mobile];
    if (req.session.user.role === "CenterAdmin") {
      query += " AND center_id = $2";
      values.push(req.session.user.center_id);
    }
    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (err) {
    console.error("Donor search error:", err);
    res.status(500).json({ error: "Search failed" });
  }
});


/*
====================================================
GET DONATIONS LIST  (existing)
====================================================
*/
router.get("/donations-list", isAuthenticated, async (req, res) => {
  const { year } = req.query;
  const page = parseInt(req.query.page) || 1;
  const limit = 5;
  const offset = (page - 1) * limit;

  try {
    let baseQuery = `FROM donations d JOIN donors dn ON d.donor_id = dn.id LEFT JOIN programs p ON d.program_id = p.id`;
    let conditions = [];
    let values = [];

    if (req.session.user.role === "CenterAdmin") {
      conditions.push(`d.center_id = $${values.length + 1}`);
      values.push(req.session.user.center_id);
    }
    if (year && year !== "All") {
      conditions.push(`EXTRACT(YEAR FROM d.donation_date) = $${values.length + 1}`);
      values.push(year);
    }

    let whereClause = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
    const totalResult = await pool.query(`SELECT COUNT(*) ${baseQuery} ${whereClause}`, values);
    const total = parseInt(totalResult.rows[0].count);

    const dataQuery = `
      SELECT d.id, d.receipt_number, d.donation_amount, d.donation_date,
             d.payment_mode, d.remarks, dn.first_name, dn.last_name, dn.mobile, p.program_name
      ${baseQuery} ${whereClause}
      ORDER BY d.donation_date DESC, d.id DESC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}`;

    values.push(limit, offset);
    const result = await pool.query(dataQuery, values);

    res.json({ data: result.rows, total, page, totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error("Donation list error:", err);
    res.status(500).json({ error: "Error fetching donations" });
  }
});


/*
====================================================
CREATE SINGLE DONATION  (existing)
====================================================
*/
router.post("/donations/new", isAuthenticated, async (req, res) => {
  const { donor_id, program_id, donation_amount, donation_date, payment_mode, remarks } = req.body;
  try {
    await pool.query(
      `INSERT INTO donations (donor_id, program_id, donation_amount, donation_date, payment_mode, remarks, center_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [donor_id, program_id, donation_amount, donation_date, payment_mode, remarks, req.session.user.center_id]
    );
    res.redirect("/donations-page");
  } catch (err) {
    console.error("Donation create error:", err);
    res.status(500).send("Donation creation failed");
  }
});


/*
====================================================
★ NEW — BULK / MULTI DONATION  ★
POST /donations/bulk
Body: { donation_date, program_id, donations: [{donor_id, amount, mode, remarks}] }
Returns: { saved: [{receipt_number, donor_name, amount}] }
====================================================
*/
router.post("/donations/bulk", isAuthenticated, async (req, res) => {
  const { donation_date, program_id, donations } = req.body;

  // Basic validation
  if (!donation_date || !program_id || !Array.isArray(donations) || donations.length === 0) {
    return res.status(400).json({ error: "Missing required fields: donation_date, program_id, donations[]" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const saved = [];

    for (const d of donations) {
      const { donor_id, amount, mode, remarks } = d;

      if (!donor_id || !amount || parseFloat(amount) <= 0) {
        throw new Error(`Invalid donation data: donor_id=${donor_id}, amount=${amount}`);
      }

      // Generate receipt number: RCP-YYYYMMDD-HHMMSS-random4
      const now = new Date();
      const pad = n => String(n).padStart(2, "0");
      const datePart = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}`;
      const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const rand = Math.floor(1000 + Math.random() * 9000);
      const receipt_number = `RCP-${datePart}-${timePart}-${rand}`;

      // Insert donation
      await client.query(
        `INSERT INTO donations
           (donor_id, program_id, donation_amount, donation_date,
            payment_mode, remarks, center_id, receipt_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          donor_id,
          program_id,
          parseFloat(amount),
          donation_date,
          mode || "Cash",
          remarks || null,
          req.session.user.center_id,
          receipt_number
        ]
      );

      // Fetch donor name for response
      const donorRes = await client.query(
        "SELECT first_name, last_name FROM donors WHERE id = $1",
        [donor_id]
      );
      const donor = donorRes.rows[0];

      saved.push({
        receipt_number,
        donor_name: donor ? `${donor.first_name} ${donor.last_name}` : "Unknown",
        amount: parseFloat(amount)
      });

      // Small delay to ensure unique timestamps in receipt numbers
      await new Promise(r => setTimeout(r, 2));
    }

    await client.query("COMMIT");

    res.json({
      success: true,
      count: saved.length,
      saved
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Bulk donation error:", err);
    res.status(500).json({ error: err.message || "Bulk donation failed" });
  } finally {
    client.release();
  }
});


/*
====================================================
★ NEW — CREATE DONOR VIA API (for inline modal) ★
POST /donors/new-api
Same as /donors/new but returns JSON instead of redirect
====================================================
*/
router.post("/donors/new-api", isAuthenticated, async (req, res) => {
  const { first_name, last_name, email, mobile, city, state, remarks } = req.body;
  const donorId = "DN" + Date.now();

  if (!first_name || !last_name || !mobile) {
    return res.status(400).json({ error: "First Name, Last Name and Mobile are mandatory." });
  }
  if (!/^[0-9]{10}$/.test(mobile)) {
    return res.status(400).json({ error: "Mobile number must be exactly 10 digits." });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Invalid email format." });
  }

  try {
    const result = await pool.query(
      `INSERT INTO donors (donor_id, first_name, last_name, email, mobile, city, state, remarks, center_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, donor_id, first_name, last_name, mobile, email`,
      [
        donorId,
        first_name.trim(),
        last_name.trim(),
        email || null,
        mobile,
        city || null,
        state || null,
        remarks || null,
        req.session.user.center_id
      ]
    );

    res.json(result.rows[0]);

  } catch (err) {
    if (err.code === "23505") {
      return res.status(400).json({ error: "This mobile number is already registered in your center." });
    }
    console.error("Donor API create error:", err);
    res.status(500).json({ error: "Donor creation failed." });
  }
});


/*
====================================================
UPDATE DONATION  (existing)
====================================================
*/
router.post("/donations/update/:id", isAuthenticated, async (req, res) => {
  const donationId = req.params.id;
  const { program_id, donation_amount, donation_date, payment_mode, remarks } = req.body;

  try {
    if (!donation_amount || parseFloat(donation_amount) <= 0) {
      return res.status(400).send("Donation amount must be greater than zero.");
    }

    let query = `UPDATE donations SET program_id=$1, donation_amount=$2, donation_date=$3, payment_mode=$4, remarks=$5 WHERE id=$6`;
    let values = [program_id, donation_amount, donation_date, payment_mode, remarks || null, donationId];

    if (req.session.user.role === "CenterAdmin") {
      query += " AND center_id = $7";
      values.push(req.session.user.center_id);
    }

    await pool.query(query, values);
    res.redirect("/donations-page");
  } catch (err) {
    console.error("Donation update error:", err);
    res.status(500).send("Donation update failed.");
  }
});


/*
====================================================
GET SINGLE DONATION  (existing)
====================================================
*/
router.get("/donations/:id", isAuthenticated, async (req, res) => {
  const donationId = req.params.id;
  try {
    let query = `
      SELECT d.*, dn.first_name, dn.last_name, dn.mobile, p.program_name
      FROM donations d
      JOIN donors dn ON d.donor_id = dn.id
      LEFT JOIN programs p ON d.program_id = p.id
      WHERE d.id = $1`;
    let values = [donationId];

    if (req.session.user.role === "CenterAdmin") {
      query += " AND d.center_id = $2";
      values.push(req.session.user.center_id);
    }

    const result = await pool.query(query, values);
    if (!result.rows.length) return res.status(404).json({ error: "Donation not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Fetch donation error:", err);
    res.status(500).json({ error: "Error fetching donation" });
  }
});


/*
====================================================
EXPORT DONATIONS CSV  (existing)
====================================================
*/
router.get("/donations-export", isAuthenticated, async (req, res) => {
  const { year } = req.query;
  try {
    let baseQuery = `FROM donations d JOIN donors dn ON d.donor_id = dn.id LEFT JOIN programs p ON d.program_id = p.id`;
    let conditions = [];
    let values = [];

    if (req.session.user.role === "CenterAdmin") {
      conditions.push(`d.center_id = $${values.length + 1}`);
      values.push(req.session.user.center_id);
    }
    if (year && year !== "All") {
      conditions.push(`EXTRACT(YEAR FROM d.donation_date) = $${values.length + 1}`);
      values.push(year);
    }

    let whereClause = conditions.length ? " WHERE " + conditions.join(" AND ") : "";

    const query = `
      SELECT d.receipt_number, dn.first_name, dn.last_name, p.program_name,
             d.donation_amount, d.donation_date, d.payment_mode, d.remarks
      ${baseQuery} ${whereClause}
      ORDER BY d.donation_date DESC`;

    const result = await pool.query(query, values);
    if (!result.rows.length) return res.send("No data available");

    const headers = ["Receipt Number","First Name","Last Name","Program","Amount","Donation Date","Payment Mode","Remarks"].join(",");
    const rows = result.rows.map(r =>
      [r.receipt_number, r.first_name, r.last_name, r.program_name,
       r.donation_amount, r.donation_date, r.payment_mode, r.remarks]
        .map(val => `"${val ?? ""}"`).join(",")
    );

    const csv = [headers, ...rows].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=donations.csv");
    res.send(csv);
  } catch (err) {
    console.error("Donation export error:", err);
    res.status(500).send("CSV export failed");
  }
});

export default router;
