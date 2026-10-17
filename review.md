# 🔍 ReviewBuddy Report

> **3 issues** found across **1 file** in 8.9s

| Detail | Value |
|--------|-------|
| Provider | gemini |
| Model | `gemini-3.8-flash` |
| Date | 17/10/2026, 10:58:55 am |
| Files reviewed | 1 |

---

## `src/services/orders.js`

| Line | Severity | Issue |
|------|----------|-------|
| 4 | 🔴 **SECURITY** | Hardcoded live API key in source code. Store secrets in environment variables or a secrets manager instead. |
| 15 | 🔴 **SECURITY** | SQL query built via string concatenation is vulnerable to SQL injection. Use parameterized queries ($1) instead. |
| 22 | 🟠 **BUG** | Off-by-one error in loop condition (`<=` instead of `<`). This will access an out-of-bounds element (`undefined`), resulting in `total` becoming `NaN`.<br>**Fix:** `for (let i = 0; i < numbers.length; i++) {` |
