# 🔍 ReviewBuddy Report

> **4 issues** found across **1 file** in 87.5s

| Detail | Value |
|--------|-------|
| Provider | ollama |
| Model | `qwen2.5-coder:7b` |
| Date | 17/10/2026, 11:11:59 am |
| Files reviewed | 1 |

---

## `src/services/orders.js`

| Line | Severity | Issue |
|------|----------|-------|
| 4 | 🔴 **SECURITY** | Hardcoded API key in source code. Use environment variables.<br>**Fix:** `const PAYMENT_API_KEY = process.env.PAYMENT_API_KEY;` |
| 15 | 🔴 **SECURITY** | SQL injection vulnerability. Use parameterized queries.<br>**Fix:** `const sql = 'SELECT * FROM orders WHERE status = $1 ORDER BY created_at DESC'; const result = await db.query(sql, [status]);` |
| 22 | 🟠 **BUG** | Off-by-one error in loop. Use < instead of <=.<br>**Fix:** `for (let i = 0; i < numbers.length; i++) {` |
| 23 | 🟠 **BUG** | Unsanitized user input used in fetch body. Use parameterized queries or validate input.<br>**Fix:** `` const response = await fetch(`${PAYMENT_API_URL}/charges`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${PAYMENT_API_KEY}`, }, body: JSON.stringify({ customer: customerId, amount: amountCents }), }); `` |
