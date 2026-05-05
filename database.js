const sqlite3 = require('sqlite3').verbose();
const path = require('path');

class UserDatabase {
    constructor(dbPath = './bot_data.db') {
        this.db = new sqlite3.Database(dbPath);
        this.db.run(`PRAGMA journal_mode = WAL`);
        this.initTables();
    }

    initTables() {
        this.db.run(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY,
                username TEXT,
                firstName TEXT,
                lastName TEXT,
                role TEXT CHECK(role IN ('regular', 'trial')),
                expiresAt TEXT,
                trialExpiresAt TEXT,
                hadTrial INTEGER DEFAULT 0,
                lastPackage TEXT,
                createdAt TEXT,
                updatedAt TEXT,
                notifiedExpiry INTEGER DEFAULT 0
            )
        `);
        this.db.run(`
            CREATE TABLE IF NOT EXISTS pending_payment (
                id INTEGER PRIMARY KEY,
                username TEXT,
                firstName TEXT,
                lastName TEXT,
                packageKey TEXT,
                requestedAt TEXT
            )
        `);
    }

    getUser(userId) {
        return new Promise((resolve, reject) => {
            this.db.get(`SELECT * FROM users WHERE id = ?`, [userId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    saveUser(user) {
        return new Promise((resolve, reject) => {
            this.db.run(`
                INSERT OR REPLACE INTO users 
                (id, username, firstName, lastName, role, expiresAt, trialExpiresAt, hadTrial, lastPackage, createdAt, updatedAt, notifiedExpiry)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                user.id, user.username, user.firstName, user.lastName,
                user.role, user.expiresAt, user.trialExpiresAt,
                user.hadTrial ? 1 : 0, user.lastPackage,
                user.createdAt, user.updatedAt, user.notifiedExpiry ? 1 : 0
            ], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    getAllUsers() {
        return new Promise((resolve, reject) => {
            this.db.all(`SELECT * FROM users`, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    addPendingPayment(payment) {
        return new Promise((resolve, reject) => {
            this.db.run(`
                INSERT OR REPLACE INTO pending_payment 
                (id, username, firstName, lastName, packageKey, requestedAt)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [payment.id, payment.username, payment.firstName, payment.lastName, payment.packageKey, payment.requestedAt], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }
}

module.exports = { UserDatabase };
